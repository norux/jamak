import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

// Audit every registered shipping choice, including candidates later removed
// from the picker. Keep the acoustic and text-only measurements separate.
const mode = process.argv.includes("--translation") ? "translation" : process.argv.includes("--detection") ? "detection" : "asr";
const port = mode === "detection" ? 8797 : 8796;
const directory = resolve(".ralph/model-quality");
const output = resolve(directory, "build");
const requested = process.argv.find(argument => argument.startsWith("--candidate="))?.slice(12);
const reuseLanguages = process.argv.includes("--reuse-languages");
if (reuseLanguages && mode !== "translation") throw new Error("Language reuse checks require --translation");
const reportFile = resolve(directory, `${mode}${requested ? `-${requested}` : ""}${reuseLanguages ? "-reuse" : ""}.json`);
await mkdir(directory, { recursive: true });
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: {
  outDir: output, rollupOptions: { input: {
    detector: resolve("packages/engines-browser/language-host.ts"),
    asr: resolve("packages/engines-browser/asr-host.ts"),
    translator: resolve("packages/engines-browser/model-translator.ts"),
    native: resolve("packages/engines-browser/document-translator.ts"),
  }, preserveEntrySignatures: "strict", output: { entryFileNames: "[name].js" } },
} });
const meeting = JSON.parse(await readFile("tests/fixtures/multilingual/manifest.json", "utf8"));
const japanese = JSON.parse(await readFile("tests/fixtures/conversation/ja/manifest.json", "utf8"));
const clips = [
  ...meeting.turns.map((turn, index) => ({ ...turn, id: `meeting-${index}`, file: "multilingual/meeting.wav" })),
  ...japanese.turns.map((turn, index) => ({ ...turn, language: "ja", id: `conversation-ja-${index}`, file: "conversation/ja/conversation.wav" })),
];
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(`<button id="prepare">Prepare</button><script type="module">
      import {createLanguageHost} from '/detector.js';
      import {createAsrHost} from '/asr.js';
      import {createModelTranslator} from '/translator.js';
      import {createDocumentTranslator} from '/native.js';
      const params = new URL(location.href).searchParams;
      const candidate = params.get('candidate'); const mode = params.get('mode');
      let target = params.get('target') || 'ko';
      globalThis.selectTarget = next => { target = next; ready = false; failure = undefined; };
      globalThis.workerStats = { created: 0, prepared: 0, terminated: 0 };
      const OriginalWorker = Worker;
      globalThis.Worker = class extends OriginalWorker {
        constructor(...args) { super(...args); workerStats.created++; }
        postMessage(message, ...args) { if (message.type === 'prepare') workerStats.prepared++; return super.postMessage(message, ...args); }
        terminate() { workerStats.terminated++; return super.terminate(); }
      };
      globalThis.statuses = []; globalThis.ready = false; globalThis.failure = undefined;
      globalThis.host = mode === 'detection' ? createLanguageHost(document,s=>statuses.push(s),'offscreen') : mode === 'asr' ? createAsrHost(document,candidate,candidate.endsWith('Fp16')?'webgpu':'wasm',s=>statuses.push(s),'offscreen')
        : candidate === 'chrome' ? createDocumentTranslator(document,{source:'auto',target},s=>statuses.push(s),'offscreen')
        : createModelTranslator(document,{source:'auto',target},candidate,s=>statuses.push(s),'offscreen');
      document.querySelector('button').onclick = () => host.prepare(mode === 'translation' ? {source:'auto',target} : undefined).then(()=>ready=true,e=>failure=e.message);
      const decoded = new Map();
      globalThis.recognize = async (clip, automatic = false) => {
        if(!decoded.has(clip.file)) {
          const context = new AudioContext({sampleRate:16000});
          try { decoded.set(clip.file, await context.decodeAudioData(await(await fetch('/fixtures/'+clip.file)).arrayBuffer())); }
          finally { await context.close(); }
        }
        const buffer = decoded.get(clip.file);
        const pcm = buffer.getChannelData(0).slice(Math.round(clip.startSeconds*16000),Math.round(clip.endSeconds*16000));
        if(mode === 'detection') return host.detect(pcm);
        return host.recognize({identity:{sessionId:'audit',targetId:'fixture',epoch:0},utteranceId:clip.id,
          language:automatic?'auto':clip.language,audioRange:{startMs:0,endMs:pcm.length/16},pcm});
      };
      globalThis.translate = async clip => {
        const source = {identity:{sessionId:'audit',targetId:'fixture',epoch:0},utteranceId:clip.id,
          sourceRevision:1,language:clip.language,text:clip.text,final:true,audioRange:{startMs:0,endMs:1000}};
        const start = performance.now(); let firstMs; let result; let chunks = 0;
        for await(const revision of host.translate(source,{source:clip.language,target})) {
          firstMs ??= performance.now()-start; result = revision; chunks++;
        }
        return {result,firstMs,totalMs:performance.now()-start,chunks};
      };
      globalThis.loaded = true;
    </script>`);
    return;
  }
  const fixture = path.startsWith("/fixtures/");
  const root = fixture ? resolve("tests/fixtures") : output;
  const file = resolve(root, `.${fixture ? path.slice(9) : path}`);
  if (!file.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
  try {
    response.setHeader("Content-Type", ({ ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".wav": "audio/wav" })[extname(file)] ?? "application/octet-stream");
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(port, "127.0.0.1", done));
function errors(reference, hypothesis) {
  const normalize = text => [...text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "")];
  const ref = normalize(reference); const hyp = normalize(hypothesis);
  let previous = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    previous = row;
  }
  return { edits: previous[hyp.length], units: ref.length, cer: previous[hyp.length] / ref.length };
}
const report = { mode, date: new Date().toISOString(), scope: "Actual browser inference on synthetic checked-in turns; not live overlay latency or human evaluation", runs: [] };
let context;
try {
  const profile = resolve(directory, "profile");
  await mkdir(profile, { recursive: true });
  if (mode === "translation") {
    const path = resolve(profile, "Local State");
    const state = await readFile(path, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return {}; throw error; });
    state.on_device_translation = { ...state.on_device_translation, translate_kit_registered: true,
      translate_kit_packages: { ...state.on_device_translation?.translate_kit_packages, en_ja_registered: true, en_ko_registered: true } };
    await writeFile(path, JSON.stringify(state));
  }
  const config = resolve(directory, "cft-config.json");
  await writeFile(config, JSON.stringify({ requiredComponents: ["Chrome TranslateKit", "Chrome TranslateKit en-ja", "Chrome TranslateKit en-ko"], requiredComponentsDir: resolve(".ralph/media-framework/chrome-translation-components"), requiredComponentsUpdateTimeout: "120s" }));
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.JAMAK_CHROME_EXECUTABLE ?? chromium.executablePath(), headless: false, ignoreHTTPSErrors: true,
    ignoreDefaultArgs: mode === "translation",
    args: mode === "translation" ? [`--user-data-dir=${profile}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", `--chrome-for-testing-config=${config}`, "about:blank"] : [], timeout: 180000 });
  context.on("close", () => console.log(JSON.stringify({ phase: "browser-closed", at: new Date().toISOString() })));
  report.browser = context.browser()?.version();
  const page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 180000 });
  const candidates = mode === "asr" ? ["tiny", "base", "small", "smallFp16", "turboFp16"] : mode === "detection" ? ["voxlingua"] : ["chrome", "m2m100", "nllb", "hyMt2"];
  if (requested && !candidates.includes(requested)) throw new Error(`Unknown audit candidate: ${requested}`);
  for (const candidate of candidates.filter(candidate => !requested || candidate === requested)) for (const target of mode === "translation" ? ["ko", "en", "ja"] : ["ko"]) {
    const run = { candidate, target, results: [] }; report.runs.push(run);
    try {
      const reused = reuseLanguages && target !== "ko";
      const before = reused ? await page.evaluate(() => ({ ...workerStats, statuses: statuses.length })) : undefined;
      if (reused) await page.evaluate(target => selectTarget(target), target);
      else await page.goto(`http://127.0.0.1:${port}/?candidate=${candidate}&mode=${mode}&target=${target}`);
      await page.waitForFunction(() => globalThis.loaded);
      await page.bringToFront();
      const start = performance.now();
      await page.locator("button").click();
      await page.waitForFunction(() => ready || failure, undefined, { timeout: 600000 });
      run.preparationMs = performance.now() - start;
      const failure = await page.evaluate(() => globalThis.failure);
      if (failure) throw new Error(failure);
      if (before) {
        const after = await page.evaluate(() => ({ ...workerStats, statuses: statuses.length }));
        assert.deepEqual({ ...after, statuses: before.statuses }, before, "Changing target must retain the resident worker without preparation or termination");
        const downloads = await page.evaluate(start => statuses.slice(start).filter(status => status.state === "downloading"), before.statuses);
        assert.equal(downloads.length, 0, "Changing target must not download model files again");
        run.reuse = { before, after, downloads: downloads.length };
      }
      console.log(JSON.stringify({ candidate, phase: "ready", preparationMs: run.preparationMs }));
      const selectedClips = mode === "detection" ? clips.slice(0, 6).flatMap(clip => [1, 2, 3].map(seconds => ({ ...clip, endSeconds: Math.min(clip.endSeconds, clip.startSeconds + seconds), seconds })))
        : mode === "translation" && target !== "ko" ? clips.slice(0, 6) : clips;
      for (const clip of selectedClips) {
        if (mode === "translation" && clip.language === target) continue;
        const result = mode !== "translation" ? await page.evaluate(clip => recognize(clip), clip) : await page.evaluate(clip => translate(clip), clip);
        const row = mode === "detection" ? { expected: clip.language, seconds: clip.seconds, ...result } : mode === "asr" ? { id: clip.id, language: clip.language, reference: clip.text, text: result.revision.text, inferenceMs: result.inferenceMs,
          rtf: result.inferenceMs / ((clip.endSeconds - clip.startSeconds) * 1000), ...errors(clip.text, result.revision.text) }
          : { id: clip.id, source: clip.text, ...result, missing: (target === "ko" ? clip.koreanAnchors ?? [] : []).filter(anchor => !new RegExp(anchor, "u").test(result.result.text)),
            missingDetails: (target === "ko" ? clip.koreanDetailAnchors ?? [] : []).filter(anchor => !new RegExp(anchor, "u").test(result.result.text)) };
        run.results.push(row);
        console.log(JSON.stringify({ candidate, ...row }));
        await writeFile(reportFile, JSON.stringify(report, null, 2));
      }
      if (mode === "asr") {
        run.automatic = [];
        for (const clip of clips.slice(0, 6)) {
          const result = await page.evaluate(clip => recognize(clip, true), clip);
          run.automatic.push({ expected: clip.language, detected: result.revision.language, text: result.revision.text, inferenceMs: result.inferenceMs });
        }
      }
    } catch (error) { process.exitCode = 1; run.error = error.message; console.log(JSON.stringify({ candidate, error: error.message })); }
    finally { if (!reuseLanguages || target === "ja") await page.evaluate(() => host.dispose ? host.dispose() : host.close()).catch(() => {}); }
    await writeFile(reportFile, JSON.stringify(report, null, 2));
  }
} finally {
  await context?.close();
  await new Promise(done => server.close(done));
  await writeFile(reportFile, JSON.stringify(report, null, 2));
}
