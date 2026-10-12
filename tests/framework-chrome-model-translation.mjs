import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

const output = resolve(".ralph/media-framework/model-translation-build");
const webgpu = process.argv.includes("--hy-mt2");
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: {
  outDir: output, rollupOptions: { input: { translator: resolve("packages/engines-browser/model-translator.ts") },
    preserveEntrySignatures: "strict", output: { entryFileNames: "[name].js" } },
} });
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(`<button id="prepare">Prepare</button><button id="stop">Stop</button><script type="module">
      import {createModelTranslator} from '/translator.js';
      globalThis.workerMessages = [];
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); this.addEventListener('message', event => { if(event.data.type !== 'status') workerMessages.push({direction:'reply',...event.data}); }); }
        postMessage(value,...args) { workerMessages.push({direction:'request',...value}); return super.postMessage(value,...args); }
      };
      globalThis.statuses = []; globalThis.results = []; globalThis.resultTimes = []; globalThis.failure = undefined; globalThis.prepared = false;
      globalThis.host = createModelTranslator(document, {source:'auto',target:'ko'}, new URL(location.href).searchParams.get('candidate'), s => statuses.push(s));
      document.querySelector('#prepare').onclick = () => host.prepare().then(() => prepared = true, e => failure = e.message);
      document.querySelector('#stop').onclick = () => host.stop();
      globalThis.translate = async (language, text) => {
        const source = {identity:{sessionId:'model-choice',targetId:'video',epoch:1},utteranceId:language,sourceRevision:1,language,text,final:true,audioRange:{startMs:0,endMs:1000}};
        for await (const result of host.translate(source,{source:language,target:'ko'})) { results.push(result); resultTimes.push(performance.now()); }
      };
      globalThis.loaded = true;
    </script>`);
    return;
  }
  const file = resolve(output, `.${path}`);
  if (!file.startsWith(output + sep)) { response.writeHead(403); response.end(); return; }
  try {
    response.setHeader("Content-Type", ({".js":"text/javascript",".mjs":"text/javascript",".wasm":"application/wasm"})[extname(file)] ?? "application/octet-stream");
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(webgpu ? 8795 : 0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { scope: `Real pinned ONNX ${webgpu ? "Hy-MT2 q4f16 WebGPU streaming" : "q8 WASM"} models: download, English/Japanese to Korean, auto pair routing, cache reload, Stop; synthetic text, no acoustic accuracy measurement`, runs: [], errors: [] };
let browser; let profile;
try {
  profile = webgpu ? resolve(".ralph/media-framework/hy-mt2-translation-profile") : await mkdtemp(resolve(".ralph/media-framework/model-translation-profile-"));
  await mkdir(profile, { recursive: true });
  browser = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: !webgpu, ignoreHTTPSErrors: true });
  const page = await browser.newPage();
  page.on("pageerror", e => report.errors.push(e.message));
  page.on("console", e => { if(e.type() === "error") console.error(e.text()); });
  for (const candidate of webgpu ? ["hyMt2"] : ["m2m100", "nllb"]) {
    const run = { candidate }; report.runs.push(run);
    await page.goto(`${origin}/?candidate=${candidate}`); await page.waitForFunction(() => loaded);
    await page.locator("#prepare").click();
    await page.waitForFunction(() => prepared || failure, undefined, { timeout: 600000 });
    run.preparation = await page.evaluate(() => ({ prepared, failure, states: [...new Set(statuses.map(s => s.state))], last: statuses.at(-1), workerMessages }));
    assert.equal(run.preparation.failure, undefined);
    assert.equal(run.preparation.prepared, true);
    for (const [language, text] of [["en","Let's meet at the train station tomorrow."],["ja","明日は駅で会いましょう。"]]) {
      const before = await page.evaluate(() => results.length);
      const started = performance.now();
      await page.evaluate(([lang, text]) => translate(lang, text), [language, text]);
      run[language] = { result: await page.evaluate(() => results.at(-1)), inferenceMs: performance.now() - started };
      assert.match(run[language].result.text, /[가-힣]/u);
      assert.match(run[language].result.text, /내일/u);
      assert.match(run[language].result.text, /역/u);
      assert.equal(run[language].result.languages.source, language);
      assert.equal(run[language].result.sourceRevision, 1);
      if (webgpu) {
        run[language].stream = await page.evaluate(before => results.slice(before).map((revision, index) => ({ text: revision.text, final: revision.final, atMs: resultTimes[before + index] - resultTimes[before] })), before);
        assert.ok(run[language].stream.some(chunk => !chunk.final), "Must emit Korean before generation finishes");
        assert.equal(run[language].stream.at(-1).final, true);
      }
    }
    if (webgpu) {
      run.conversation = [];
      const fixture = JSON.parse(await readFile("tests/fixtures/conversation/ja/manifest.json", "utf8"));
      for (const turn of fixture.turns) {
        const started = performance.now();
        await page.evaluate(text => translate("ja", text), turn.text);
        const result = await page.evaluate(() => results.at(-1));
        const missing = turn.koreanAnchors.filter(anchor => !new RegExp(anchor, "u").test(result.text));
        const missingDetails = (turn.koreanDetailAnchors ?? []).filter(anchor => !new RegExp(anchor, "u").test(result.text));
        run.conversation.push({ source: turn.text, korean: result.text, inferenceMs: performance.now() - started, missing, missingDetails });
      }
      console.log(JSON.stringify(run.conversation));
    }
    if (webgpu) {
      const before = await page.evaluate(() => results.length);
      await page.evaluate(() => {
        globalThis.cancelled = undefined;
        void translate("ja", "明日の午後三時に駅で会いましょう。予約は取り消さないでください。予定が変わったら、出かける前にメッセージを送ってください。")
          .then(() => cancelled = "unexpected completion", error => cancelled = error.message);
      });
      await page.waitForFunction(before => results.length > before, before);
      await page.locator("#stop").click();
      await page.waitForFunction(() => cancelled);
      run.cancelled = await page.evaluate(() => cancelled);
      assert.match(run.cancelled, /Translation stopped/);
      const stoppedCount = await page.evaluate(() => results.length);
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => results.length), stoppedCount, "Stop must reject late chunks");
    } else await page.locator("#stop").click();
    assert.match(await page.evaluate(() => translate('ja','こんにちは。').then(() => 'unexpected', e => e.message)), /model-load-failed/);
    await page.reload(); await page.waitForFunction(() => loaded); await page.locator("#prepare").click();
    await page.waitForFunction(() => prepared || failure, undefined, {timeout: 120000});
    run.reloaded = await page.evaluate(() => ({prepared,failure,states:[...new Set(statuses.map(s => s.state))]}));
    assert.equal(run.reloaded.prepared, true); assert.ok(!run.reloaded.states.includes("downloading"));
    await page.evaluate(() => host.close());
    if (webgpu) assert.ok(run.conversation.every(turn => !turn.missing.length), "Japanese conversation meaning must survive translation");
    console.log(JSON.stringify(run));
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  await browser?.close(); if (profile && !webgpu) await rm(profile,{recursive:true,force:true}); await new Promise(done => server.close(done));
  await writeFile(resolve(`.ralph/media-framework/model-translation${webgpu ? "-hy-mt2" : ""}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
