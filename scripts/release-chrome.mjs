import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const secrets = [];

async function request(url, options, label) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${data.error?.message ?? data.error_description ?? data.error ?? "Request failed"}`);
  return data;
}

async function release() {
  const args = process.argv.slice(2);
  const bumps = args.filter(arg => arg !== "--dry-run");
  if (bumps.length > 1 || bumps.some(arg => !["patch", "minor", "major"].includes(arg)) || new Set(args).size !== args.length) {
    throw new Error("Usage: npm run release:chrome [-- [patch|minor|major] [--dry-run]]");
  }
  const bump = bumps[0] ?? "patch";
  const dryRun = args.includes("--dry-run");
  const envFile = `${root}.env.chrome-store`;
  if (!dryRun && existsSync(envFile)) loadEnvFile(envFile);
  const config = {};
  if (!dryRun) {
    const required = ["CWS_PUBLISHER_ID", "CWS_EXTENSION_ID", "CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN"];
    secrets.push(process.env.CWS_CLIENT_SECRET?.trim(), process.env.CWS_REFRESH_TOKEN?.trim());
    for (const name of required) {
      if (!process.env[name]?.trim()) throw new Error(`Missing ${name}. See docs/releasing.md for one-time setup.`);
      config[name] = process.env[name].trim();
    }
  }

  const manifestPath = `${root}apps/chrome/public/manifest.json`;
  const original = await readFile(manifestPath, "utf8");
  const current = JSON.parse(original).version;
  if (typeof current !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(current)) {
    throw new Error("Extension version must use major.minor.patch integers.");
  }
  const parts = current.split(".").map(Number);
  if (parts.some(part => part > 65535)) throw new Error("Chrome version components must not exceed 65535.");
  const index = bump === "major" ? 0 : bump === "minor" ? 1 : 2;
  parts[index]++;
  for (let lower = index + 1; lower < parts.length; lower++) parts[lower] = 0;
  if (parts[index] > 65535) throw new Error(`Cannot increase ${bump}: Chrome version components must not exceed 65535.`);
  const next = parts.join(".");
  console.log(`Extension version: ${current} → ${next} (${bump}${dryRun ? ", dry run" : ""})`);
  let verified = false;
  try {
    await writeFile(manifestPath, original.replace(/("version"\s*:\s*")[^"]*(")/, (_match, prefix, suffix) => `${prefix}${next}${suffix}`));
    console.log("Verifying and building Jamak...");
    execFileSync("npm", ["run", "verify"], { cwd: root, stdio: "inherit" });
    verified = true;
  } finally {
    if (dryRun || !verified) await writeFile(manifestPath, original);
  }
  const dist = `${root}apps/chrome/dist`;
  const manifest = JSON.parse(await readFile(`${dist}/manifest.json`, "utf8"));
  const directory = `${root}.ralph/releases`;
  const archive = `${directory}/jamak-${manifest.version}.zip`;
  await mkdir(directory, { recursive: true });
  // zip updates existing archives; remove the old one so deleted files cannot survive.
  await rm(archive, { force: true });
  execFileSync("zip", ["-q", "-r", archive, ".", "-x", "*.DS_Store", "__MACOSX/*"], { cwd: dist, stdio: "inherit" });
  console.log(`Package: ${archive}`);
  if (dryRun) {
    console.log("Dry run complete. No authentication, upload or submission performed.");
    return;
  }

  const token = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: config.CWS_CLIENT_ID, client_secret: config.CWS_CLIENT_SECRET,
      refresh_token: config.CWS_REFRESH_TOKEN, grant_type: "refresh_token" }),
  }, "OAuth token refresh");
  if (!token.access_token) throw new Error("OAuth response did not contain an access token.");
  secrets.push(token.access_token);
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const item = `publishers/${encodeURIComponent(config.CWS_PUBLISHER_ID)}/items/${encodeURIComponent(config.CWS_EXTENSION_ID)}`;
  const endpoint = `https://chromewebstore.googleapis.com/v2/${item}`;
  console.log(`Uploading Jamak ${manifest.version}...`);
  const upload = await request(`https://chromewebstore.googleapis.com/upload/v2/${item}:upload`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: await readFile(archive),
  }, "Package upload");
  let state = upload.uploadState;
  const deadline = Date.now() + 300_000;
  while (state === "IN_PROGRESS") {
    if (Date.now() >= deadline) throw new Error("Upload processing timed out. Check the developer dashboard; no submission was made.");
    console.log("Waiting for Chrome Web Store to process the upload...");
    await setTimeout(5_000);
    const status = await request(`${endpoint}:fetchStatus`, { headers }, "Upload status");
    state = status.lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`Upload did not succeed (${state ?? "missing state"}). No submission was made.`);

  const submission = await request(`${endpoint}:publish`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }),
  }, "Review submission");
  console.log(`Review submission accepted (${submission.state ?? "see dashboard"}). Publication follows Chrome Web Store approval.`);
  console.log("Dashboard: https://chrome.google.com/webstore/devconsole");
}

try {
  await release();
} catch (error) {
  let message = error.message;
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, "[redacted]");
  console.error(`Chrome release failed: ${message}`);
  process.exitCode = 1;
}
