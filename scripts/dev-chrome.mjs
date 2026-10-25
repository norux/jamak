import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".ralph/dev");
const output = resolve(directory, "extension");
const profile = resolve(directory, "chrome-profile");
const configuration = resolve(directory, "cft-config.json");
const origin = "http://127.0.0.1:8790";
let watcher;
let server;
let browser;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([browser?.close(), watcher?.close(), server?.close()]);
  process.exit(code);
}

process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });

try {
  await access(chromium.executablePath()).catch(() => { throw new Error("Run npx playwright install chromium before npm run dev."); });
  await mkdir(directory, { recursive: true });
  server = await createServer({ configFile: false, root: resolve(root, "tests/fixtures/conversation"),
    server: { host: "127.0.0.1", port: 8790, strictPort: true } });
  await server.listen();
  watcher = await build({ configFile: resolve(root, "vite.chrome.config.ts"), logLevel: "warn",
    build: { outDir: output, watch: {} } });
  await new Promise((resolve, reject) => {
    watcher.on("event", event => {
      if (event.code === "ERROR") { console.error(event.error); reject(event.error); }
      if (event.code === "END") {
        console.log("Jamak rebuilt. Reload the extension in the test browser at chrome://extensions.");
        resolve();
      }
    });
  });
  await mkdir(profile, { recursive: true });
  const statePath = resolve(profile, "Local State");
  const state = await readFile(statePath, "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT") return {};
    throw error;
  });
  state.on_device_translation = { ...state.on_device_translation, translate_kit_registered: true,
    translate_kit_packages: { ...state.on_device_translation?.translate_kit_packages, en_ja_registered: true, en_ko_registered: true } };
  state.accessibility = { ...state.accessibility, captions: { ...state.accessibility?.captions,
    soda_registered_language_packs: [...new Set([...(state.accessibility?.captions?.soda_registered_language_packs ?? []), "ja-JP", "en-US", "ko-KR"])] } };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(configuration, JSON.stringify({
    requiredComponents: ["Chrome TranslateKit", "Chrome TranslateKit en-ja", "Chrome TranslateKit en-ko",
      "SODA Library", "SODA ja-JP Models", "SODA en-US Models", "SODA ko-KR Models"],
    requiredComponentsDir: resolve(root, ".ralph/media-framework/chrome-translation-components"),
    requiredComponentsUpdateTimeout: "120s",
  }));
  console.log("Opening an isolated Chrome for Testing. First-time language-pack downloads may take a few minutes.");
  browser = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false,
    ignoreDefaultArgs: true, handleSIGINT: false, handleSIGTERM: false, timeout: 180000,
    args: [`--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
      `--load-extension=${output}`, `--chrome-for-testing-config=${configuration}`, "about:blank"] });
  browser.on("close", () => { void stop(); });
  const extension = browser.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://"))
    ?? await browser.waitForEvent("serviceworker", { timeout: 15000 });
  // Custom launch arguments skip Playwright's startup-page wait. Creating a
  // page here races Chrome's own first window and leaves an extra blank one.
  const page = browser.pages().find(page => page.url() === "about:blank")
    ?? await browser.waitForEvent("page", { predicate: page => page.url() === "about:blank", timeout: 180000 });
  await page.waitForLoadState();
  await page.goto(`${origin}/?language=ja`);
  await Promise.all(browser.pages().filter(other => other !== page).map(other => other.close()));
  await page.bringToFront();
  console.log(`Ready: ${origin}/?language=ja\nExtension loaded: ${extension.url()}\nBuild: ${output}\nProfile: ${profile}\nUse Jamak on this tab, then play the audio. Ctrl+C closes only this test browser and server; its model cache is retained.`);
} catch (error) {
  console.error(error.message);
  await stop(1);
}
