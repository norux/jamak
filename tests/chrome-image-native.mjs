import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

// Real TranslateKit for the image adapter's three targets and PNG renderer.
// OCR and the actual extension page/drag flow are checked separately by
// chrome-image-browser.mjs; this harness does not substitute fake translations.
const output = resolve(".ralph/image-native-build");
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: {
  outDir: output, rollupOptions: { input: { translator: resolve("packages/engines-browser/document-translator.ts"), renderer: resolve("apps/chrome/image-render.ts") },
    preserveEntrySignatures: "strict", output: { entryFileNames: "[name].js" } },
} });
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<meta charset="utf-8"><button id="translate">Translate</button><canvas id="preview"></canvas><script type="module">
      import {createDocumentTranslator} from '/translator.js';
      import {drawImageTranslations} from '/renderer.js';
      const params = new URL(location.href).searchParams;
      const source = params.get('source'), target = params.get('target');
      const text = source === 'ja' ? '明日また会いましょう。' : 'Hello world';
      const host = createDocumentTranslator(document, {source, target}, () => {});
      document.querySelector('#translate').onclick = async () => {
        try {
          await host.prepare();
          let translation = '';
          for await (const revision of host.translate({identity:{sessionId:'image-native',targetId:'image',epoch:1},utteranceId:'line',sourceRevision:1,language:source,text,final:true,audioRange:{startMs:0,endMs:0}},{source,target})) translation = revision.text;
          const original = document.createElement('canvas'); original.width = 600; original.height = 180;
          const context = original.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0,0,600,180); context.fillStyle = 'black'; context.font = '28px system-ui'; context.fillText(text,30,60);
          const bitmap = await createImageBitmap(original);
          drawImageTranslations(document.querySelector('#preview'),[{source:text,translation,score:1,x:30,y:200,width:500,height:30,positioned:true}],bitmap);
          bitmap.close(); globalThis.result = {source,target,text,translation,png:document.querySelector('#preview').toDataURL('image/png')};
        } catch(error) { globalThis.failure = error.message; }
        finally { await host.close(); }
      };
      globalThis.loaded = true;
    </script>`); return;
  }
  const file = resolve(output, `.${path}`);
  if (!file.startsWith(output + sep)) { response.writeHead(403); response.end(); return; }
  try { response.setHeader("Content-Type", ({ ".js": "text/javascript", ".mjs": "text/javascript" })[extname(file)] ?? "application/octet-stream"); response.end(await readFile(file)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const profile = await mkdtemp(resolve(".ralph/image-native-profile-"));
let context;
const report = { scope: "Real Chrome TranslateKit en→ko, en→ja, ja→en and PNG rendering; OCR/page labels checked separately", results: [] };
try {
  await writeFile(resolve(profile, "Local State"), JSON.stringify({ on_device_translation: { translate_kit_registered: true, translate_kit_packages: { en_ja_registered: true, en_ko_registered: true } } }));
  const config = resolve(profile, "cft-config.json");
  await writeFile(config, JSON.stringify({ requiredComponents: ["Chrome TranslateKit", "Chrome TranslateKit en-ja", "Chrome TranslateKit en-ko"],
    requiredComponentsDir: resolve(process.env.JAMAK_TRANSLATION_COMPONENTS_DIR ?? ".ralph/image-native-components"), requiredComponentsUpdateTimeout: "120s" }));
  context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, ignoreDefaultArgs: true,
    args: ["--headless", "--no-sandbox", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, `--chrome-for-testing-config=${config}`, "about:blank"], timeout: 180000 });
  const page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 30000 });
  for (const [source, target, pattern] of [["en", "ko", /안녕|세계/u], ["en", "ja", /こんにちは|ハロー|世界/u], ["ja", "en", /tomorrow/i]]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?source=${source}&target=${target}`);
    await page.waitForFunction(() => globalThis.loaded);
    assert.equal(await page.evaluate(() => "Translator" in window), true, "Native TranslateKit must be exposed");
    await page.locator("#translate").click();
    await page.waitForFunction(() => globalThis.result || globalThis.failure, null, { timeout: 120000 });
    assert.equal(await page.evaluate(() => globalThis.failure), undefined);
    const { png, ...result } = await page.evaluate(() => globalThis.result);
    assert.match(result.translation, pattern);
    if (target === "en") assert.match(result.translation, /see|meet/i);
    await writeFile(resolve(`.ralph/image-native-${target}.png`), Buffer.from(png.split(",")[1], "base64"));
    report.results.push(result); console.log(JSON.stringify(result));
  }
  await writeFile(resolve(".ralph/image-native-report.json"), JSON.stringify({ passed: true, ...report }, null, 2));
} finally { await context?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(profile, { recursive: true, force: true }); }
