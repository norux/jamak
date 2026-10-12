import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const credentials = {
  CWS_PUBLISHER_ID: "publisher-test", CWS_EXTENSION_ID: "extension-test", CWS_CLIENT_ID: "client-test",
  CWS_CLIENT_SECRET: "secret-test", CWS_REFRESH_TOKEN: "refresh-test",
};
const endpoint = "https://chromewebstore.googleapis.com/v2/publishers/publisher-test/items/extension-test";
const uploadUrl = `${endpoint.replace("/v2/", "/upload/v2/")}:upload`;
const oauth = { url: "https://oauth2.googleapis.com/token", method: "POST", response: { access_token: "access-test" } };
const publish = { url: `${endpoint}:publish`, method: "POST", response: { state: "PENDING_REVIEW" } };

async function runRelease(t, { args = [], responses = [], env = credentials, verifyExit = 0, envFile = false, version = "0.1.0" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jamak-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, "apps/chrome/dist");
  const publicDirectory = join(root, "apps/chrome/public");
  await mkdir(dist, { recursive: true });
  await mkdir(publicDirectory, { recursive: true });
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "bin"));
  await copyFile(new URL("../scripts/release-chrome.mjs", import.meta.url), join(root, "scripts/release-chrome.mjs"));
  await writeFile(join(publicDirectory, "manifest.json"), JSON.stringify({ manifest_version: 3, version }));
  await writeFile(join(dist, "service-worker.js"), "// fixture");
  await writeFile(join(dist, ".DS_Store"), "excluded");
  await writeFile(join(root, "bin/npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RELEASE_COMMAND_LOG"\ncp apps/chrome/public/manifest.json apps/chrome/dist/manifest.json\nexit "$RELEASE_VERIFY_EXIT"\n', { mode: 0o755 });
  if (envFile) await writeFile(join(root, ".env.chrome-store"), Object.entries(credentials).map(([key, value]) => `${key}=${value}`).join("\n"));
  await writeFile(join(root, "responses.json"), JSON.stringify(responses));
  await writeFile(join(root, "mock-fetch.mjs"), `
    import assert from "node:assert/strict";
    import { appendFileSync, readFileSync } from "node:fs";
    const responses = JSON.parse(readFileSync(new URL("./responses.json", import.meta.url)));
    globalThis.fetch = async (url, options) => {
      appendFileSync(new URL("./requests.log", import.meta.url), url + "\\n");
      const expected = responses.shift();
      assert.ok(expected, "Unexpected request; real network is disabled");
      assert.equal(url, expected.url);
      assert.equal(options.method ?? "GET", expected.method ?? "GET");
      if (url.includes("oauth2")) {
        assert.equal(options.body.get("grant_type"), "refresh_token");
        assert.equal(options.body.get("client_id"), "client-test");
        assert.equal(options.body.get("client_secret"), "secret-test");
        assert.equal(options.body.get("refresh_token"), "refresh-test");
      } else {
        assert.equal(options.headers.Authorization, "Bearer access-test");
      }
      if (url.endsWith(":upload")) {
        assert.equal(options.headers["Content-Type"], "application/zip");
        assert.equal(options.body.subarray(0, 2).toString(), "PK");
      }
      if (url.endsWith(":publish")) assert.deepEqual(JSON.parse(options.body), { publishType: "DEFAULT_PUBLISH" });
      return new Response(JSON.stringify(expected.response), { status: expected.status ?? 200 });
    };
  `);
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.startsWith("CWS_")) delete childEnv[key];
  const result = spawnSync(process.execPath, ["--import", join(root, "mock-fetch.mjs"), join(root, "scripts/release-chrome.mjs"), ...args], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...childEnv, ...env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
      RELEASE_COMMAND_LOG: join(root, "commands.log"), RELEASE_VERIFY_EXIT: String(verifyExit) },
  });
  assert.ifError(result.error);
  const requests = await readFile(join(root, "requests.log"), "utf8").catch(() => "");
  const commands = await readFile(join(root, "commands.log"), "utf8").catch(() => "");
  const manifest = JSON.parse(await readFile(join(publicDirectory, "manifest.json"), "utf8"));
  return { ...result, requests, commands, root, version: manifest.version, output: result.stdout + result.stderr };
}

test("dry run packages only dist with a root manifest and never authenticates", async t => {
  const result = await runRelease(t, { args: ["--dry-run"], env: {} });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.commands, "run verify\n");
  assert.equal(result.requests, "");
  assert.equal(result.version, "0.1.0", "Dry runs do not save the version increase");
  const archive = join(result.root, ".ralph/releases/jamak-0.1.1.zip");
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(entries, ["manifest.json", "service-worker.js"]);
  assert.equal(JSON.parse(execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" })).version, "0.1.1");
});

test("release defaults to patch and accepts patch, minor and major", async t => {
  for (const [args, version] of [[[], "1.2.4"], [["patch"], "1.2.4"], [["minor"], "1.3.0"], [["major"], "2.0.0"]]) {
    const result = await runRelease(t, { args, version: "1.2.3", responses: [oauth,
      { url: uploadUrl, method: "POST", response: { uploadState: "SUCCEEDED" } }, publish] });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.version, version);
    const archive = join(result.root, `.ralph/releases/jamak-${version}.zip`);
    assert.equal(JSON.parse(execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" })).version, version);
    assert.match(result.output, new RegExp(`Uploading Jamak ${version.replaceAll(".", "\\.")}`));
  }
});

test("dry run previews minor and major in either argument order", async t => {
  for (const [args, version] of [[["minor", "--dry-run"], "1.3.0"], [["--dry-run", "major"], "2.0.0"]]) {
    const result = await runRelease(t, { args, version: "1.2.3", env: {} });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.version, "1.2.3");
    assert.equal(result.requests, "");
    const archive = join(result.root, `.ralph/releases/jamak-${version}.zip`);
    assert.equal(JSON.parse(execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" })).version, version);
  }
});

test("invalid release arguments stop before changing versions or verifying", async t => {
  for (const args of [["other"], ["patch", "minor"], ["--dry-run", "--dry-run"]]) {
    const result = await runRelease(t, { args });
    assert.equal(result.status, 1);
    assert.match(result.output, /Usage:/);
    assert.equal(result.version, "0.1.0");
    assert.equal(result.commands, "");
    assert.equal(result.requests, "");
  }
});

test("invalid or overflowing Chrome versions stop before verification", async t => {
  for (const version of ["1.2", "1.2.3.4", "01.2.3", "1.2.3-beta", "1.2.65535", "65536.0.0"]) {
    const result = await runRelease(t, { version, args: ["--dry-run"], env: {} });
    assert.equal(result.status, 1);
    assert.match(result.output, /version/i);
    assert.equal(result.version, version);
    assert.equal(result.commands, "");
    assert.equal(result.requests, "");
  }
});

test("credentials are checked before verification or network requests", async t => {
  const result = await runRelease(t, { env: {} });
  assert.equal(result.status, 1);
  assert.match(result.output, /Missing CWS_PUBLISHER_ID/);
  assert.equal(result.commands, "");
  assert.equal(result.requests, "");
  assert.equal(result.version, "0.1.0");
});

test("failed verification prevents authentication and upload", async t => {
  for (const args of [[], ["--dry-run"]]) {
    const result = await runRelease(t, { args, verifyExit: 1 });
    assert.equal(result.status, 1);
    assert.equal(result.requests, "");
    assert.equal(result.version, "0.1.0", "Failed verification restores the original version");
  }
});

test("local env setup uploads the ZIP and submits for review", async t => {
  const result = await runRelease(t, { env: {}, envFile: true, responses: [oauth,
    { url: uploadUrl, method: "POST", response: { uploadState: "SUCCEEDED" } }, publish] });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.requests, `${oauth.url}\n${uploadUrl}\n${publish.url}\n`);
  assert.match(result.output, /Review submission accepted \(PENDING_REVIEW\)/);
  for (const secret of ["secret-test", "refresh-test", "access-test"]) assert.ok(!result.output.includes(secret));
});

test("asynchronous upload must finish before review submission", async t => {
  const result = await runRelease(t, { responses: [oauth,
    { url: uploadUrl, method: "POST", response: { uploadState: "IN_PROGRESS" } },
    { url: `${endpoint}:fetchStatus`, response: { lastAsyncUploadState: "SUCCEEDED" } }, publish] });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.requests, `${oauth.url}\n${uploadUrl}\n${endpoint}:fetchStatus\n${publish.url}\n`);
});

test("failed upload and HTTP errors never submit or print credentials", async t => {
  for (const uploadResponse of [
    { response: { uploadState: "FAILED" } },
    { status: 400, response: { error: { message: "secret-test refresh-test access-test rejected" } } },
  ]) {
    const result = await runRelease(t, { responses: [oauth, { url: uploadUrl, method: "POST", ...uploadResponse }] });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.requests, `${oauth.url}\n${uploadUrl}\n`);
    assert.equal(result.version, "0.1.1", "An upload attempt keeps its version even after failure");
    for (const secret of ["secret-test", "refresh-test", "access-test"]) assert.ok(!result.output.includes(secret));
  }
});
