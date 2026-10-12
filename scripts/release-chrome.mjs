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
  if (!response.ok) {
    const guidance = label === "Review submission"
      ? "\nThe package was uploaded, but review submission failed. Open the Developer Dashboard → Why can't I submit? Check Privacy permission justifications and required listing fields before retrying. Dashboard: https://chrome.google.com/webstore/devconsole"
      : "";
    throw new Error(`${label}: HTTP ${response.status}: ${data.error?.message ?? data.error_description ?? data.error ?? "Request failed"}${guidance}`);
  }
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
  if (existsSync(envFile)) loadEnvFile(envFile);
  const config = {};
  const required = ["CWS_PUBLISHER_ID", "CWS_EXTENSION_ID", "CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN"];
  secrets.push(process.env.CWS_CLIENT_SECRET?.trim(), process.env.CWS_REFRESH_TOKEN?.trim());
  for (const name of required) {
    if (!process.env[name]?.trim()) throw new Error(`Missing ${name}. See docs/releasing.md for one-time setup.`);
    config[name] = process.env[name].trim();
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
  const status = await request(`${endpoint}:fetchStatus`, { headers }, "Store status");
  if (["PENDING_REVIEW", "STAGED"].includes(status.submittedItemRevisionStatus?.state)) {
    throw new Error("An existing submission is pending review or staged. Resolve it in the Developer Dashboard before uploading another release.");
  }
  const channels = status.publishedItemRevisionStatus?.distributionChannels;
  if (!channels?.length) throw new Error("No published Chrome Web Store version is available. The local manifest will not be used as a fallback. Publish the initial item through the Developer Dashboard first.");
  const versions = channels.map(channel => {
    const version = channel.crxVersion;
    if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
      throw new Error("Published extension version must use major.minor.patch integers.");
    }
    const parts = version.split(".").map(Number);
    if (parts.some(part => part > 65535)) throw new Error("Chrome version components must not exceed 65535.");
    return parts;
  });
  versions.sort((left, right) => right[0] - left[0] || right[1] - left[1] || right[2] - left[2]);
  const parts = versions[0];
  const current = parts.join(".");
  const manifestPath = `${root}apps/chrome/public/manifest.json`;
  const original = await readFile(manifestPath, "utf8");
  const localVersion = JSON.parse(original).version;
  const index = bump === "major" ? 0 : bump === "minor" ? 1 : 2;
  parts[index]++;
  for (let lower = index + 1; lower < parts.length; lower++) parts[lower] = 0;
  if (parts[index] > 65535) throw new Error(`Cannot increase ${bump}: Chrome version components must not exceed 65535.`);
  const next = parts.join(".");
  console.log(`Published extension version: ${current} → ${next} (${bump}${dryRun ? ", dry run" : ""}; local ${localVersion})`);
  let submitted = false;
  try {
    await writeFile(manifestPath, original.replace(/("version"\s*:\s*")[^"]*(")/, (_match, prefix, suffix) => `${prefix}${next}${suffix}`));
    console.log("Verifying and building Jamak...");
    execFileSync("npm", ["run", "verify"], { cwd: root, stdio: "inherit" });
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
      console.log("Dry run complete. Remote version checked; no upload or submission performed.");
      return;
    }

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
    submitted = true;
    console.log(`Review submission accepted (${submission.state ?? "see dashboard"}). Publication follows Chrome Web Store approval.`);
    console.log("Dashboard: https://chrome.google.com/webstore/devconsole");
  } finally {
    if (dryRun || !submitted) await writeFile(manifestPath, original);
  }
}

try {
  await release();
} catch (error) {
  let message = error.message;
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, "[redacted]");
  console.error(`Chrome release failed: ${message}`);
  process.exitCode = 1;
}
