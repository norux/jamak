// Retained B4 selected-video path under a test-owned action, real selected-video PCM/ASR/native translation.
// --lifecycle adds B5 download failure, cached offline ASR/translation and active
// inference Stop/restart. --sustained also measures a continuous ten-minute
// selected-video session; B6 strict quality qualification remains separate.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { repeatSpeechVideo } from "./fixtures/video-speech/repeat.mjs";
import { chromium } from "playwright";
import { build } from "vite";

const sustained = process.argv.includes("--sustained");
const lifecycle = sustained || process.argv.includes("--lifecycle");
const longMedia = new Map();
const generatedMedia = [];
const archivedRuns = [];
const output = resolve(".ralph/media-framework/chrome-extension-build");
const fixtures = JSON.parse(await readFile("tests/fixtures/video-speech/manifest.json", "utf8")).clips;
for (const fixture of fixtures) {
  const bytes = await readFile(`tests/fixtures/video-speech/${fixture.language}.webm`);
  assert.equal(bytes.length, fixture.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
  if (sustained) {
    const remux = repeatSpeechVideo(bytes, 26);
    longMedia.set(`/${fixture.language}-sustained.webm`, remux.bytes);
    generatedMedia.push({ language:fixture.language, periods:26, periodMs:remux.periodMs, packets:remux.packets,
      bytes:remux.bytes.length, sha256:createHash("sha256").update(remux.bytes).digest("hex"), originalSha256:fixture.sha256 });
  }
}
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: { outDir: output } });
const archive = sustained ? await mkdtemp(resolve(".ralph/media-framework/chrome-extension-jobs-")) : undefined;
// Preserve selected-video regressions under a test-owned action. The default
// production action is verified separately by the tab-host harness.
await build({ configFile: false, logLevel: "warn", build: { outDir: output, emptyOutDir: false,
  rollupOptions: { input: { "service-worker": resolve("tests/fixtures/selected-action.ts") }, output: { entryFileNames: "[name].js" } } } });
const manifest = JSON.parse(await readFile(`${output}/manifest.json`, "utf8"));
assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "tabCapture", "offscreen", "notifications"]);
assert.deepEqual(manifest.host_permissions, ["https://paddle-model-ecology.bj.bcebos.com/*"]);
assert.equal(manifest.action.default_popup, "popup.html");
delete manifest.action.default_popup;
await writeFile(`${output}/manifest.json`, JSON.stringify(manifest));
assert.equal(manifest.key, undefined);
const observations = { scope: sustained
  ? "B5 real extension offline lifecycle plus ten-minute Japanese selected-video PCM → ASR → native Korean → DOM, continuous identity/queues/loss/timing/memory; B6 quality gates separate"
  : lifecycle
  ? "B5 real extension first-download failure, cached offline Japanese/English PCM → ASR → native Korean → DOM, active inference Stop/restart; no ten-minute or B6 final quality acceptance"
  : "B4 real selected-video adapter/host under test-owned action: PCM → turboFp16/WebGPU → native Korean translation → comparison/live/overlay DOM; no B5 ten-minute or B6 final quality acceptance",
  actionEntry: "test-owned selected-video action; production tab action is checked by :tab-host",
  archive, generatedMedia, pageErrors: [], consoleErrors: [], checks: [], runs: [], productionPermissions: manifest.permissions, modelRequests: [], companionEndpoints: [] };
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (["/ja.webm", "/en.webm"].includes(path) || longMedia.has(path)) {
      const bytes = longMedia.get(path) ?? await readFile(`tests/fixtures/video-speech${path}`);
      response.setHeader("Content-Type", "video/webm"); response.setHeader("Accept-Ranges", "bytes");
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start > end) { response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }); response.end(); return; }
      if (range) { response.statusCode = 206; response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`); }
      response.setHeader("Content-Length", end - start + 1); response.end(bytes.subarray(start, end + 1)); return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><meta charset="utf-8"><title>Real extension speech fixture</title>
      <video id="ja" title="Japanese synthetic speech" src="/ja.webm" controls preload="auto" width="320" height="180"></video>
      <video id="en" title="English synthetic speech" src="/en.webm" controls preload="auto" width="320" height="180"></video>
      <button id="play">Play both videos</button><script>
      ja.volume=0.4;en.volume=0.25;
      play.onclick=()=>Promise.all([ja.play(),en.play()]);
      globalThis.overlayTexts=[];
      new MutationObserver(()=>{
        const overlay=document.querySelector('[data-interpreter-overlay]');
        if(!overlay || overlay.observed)return;overlay.observed=true;
        const read=()=>{const text=overlay.shadowRoot.querySelector('.interpreter-live span')?.textContent;
          if(text && overlayTexts.at(-1)!==text)overlayTexts.push(text)};
        new MutationObserver(read).observe(overlay.shadowRoot,{subtree:true,childList:true,characterData:true});read();
      }).observe(document.documentElement,{subtree:true,childList:true});
      </script>`);
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser; let browserProcess; let browserExit; let profile; let host;
const execute = promisify(execFile);
async function sampleRss() {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,rss="]);
  const processes = stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([browserProcess.pid]);
  for (let added = true; added;) {
    added = false;
    for (const [pid,parent] of processes) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); added = true; }
  }
  return processes.filter(([pid]) => owned.has(pid)).reduce((sum,[,,rss]) => sum + rss,0);
}
try {
  for (const port of [8765, 11434]) {
    const result = await new Promise(done => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); done("listening"); });
      socket.once("error", error => done(error.code));
      socket.setTimeout(1000, () => { socket.destroy(); done("timeout"); });
    });
    observations.companionEndpoints.push({ port, result });
    assert.equal(result, "ECONNREFUSED", "Run this acceptance with companion/Ollama endpoints absent; never stop user apps");
  }
  profile = await mkdtemp(resolve(".ralph/media-framework/chrome-extension-profile-"));
  // Same explicit native-component preparation as the accepted B3 CfT harness.
  // Chrome downloads/verifies components; no translated text/readiness is injected.
  const components = ["Chrome TranslateKit", "Chrome TranslateKit en-ja", "Chrome TranslateKit en-ko"];
  await writeFile(resolve(profile, "Local State"), JSON.stringify({ on_device_translation: {
    translate_kit_registered: true, translate_kit_packages: { en_ja_registered: true, en_ko_registered: true },
  } }));
  const configuration = resolve(profile, "cft-config.json");
  await writeFile(configuration, JSON.stringify({ requiredComponents: components,
    requiredComponentsDir: resolve(".ralph/media-framework/chrome-translation-components"), requiredComponentsUpdateTimeout: "120s" }));
  observations.requiredComponents = components;
  browserProcess = spawn(chromium.executablePath(), ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
    `--chrome-for-testing-config=${configuration}`,
    "--enable-unsafe-extension-debugging", "--remote-debugging-port=0", "--window-position=0,30", "--window-size=700,700", "about:blank"], { stdio: "ignore" });
  browserExit = new Promise(done => {
    browserProcess.once("exit", (code, signal) => { observations.browserExit = {code,signal}; done(); });
    browserProcess.once("error", error => { observations.browserExit = {error:error.message}; done(); });
  });
  let port; const deadline = performance.now() + 120000;
  while (performance.now() < deadline && browserProcess.exitCode === null) {
    try { port = (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch { await new Promise(done => setTimeout(done, 100)); }
  }
  assert.ok(port, "Owned Chromium must expose its debugging endpoint");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 120000 });
  observations.browser = browser.version(); observations.platform = `${process.platform}/${process.arch}`;
  const context = browser.contexts()[0];
  let page;
  while (performance.now() < deadline && browserProcess.exitCode === null) {
    page = context.pages()[0]; if (page) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(page, "Owned Chromium must finish native component preparation");
  console.log(JSON.stringify({ phase: "native components prepared" }));
  page.on("pageerror", error => observations.pageErrors.push(error.message));
  // Load this repository's unchanged manifest after CfT component startup,
  // through its native unpacked-extension test command in the same browser.
  const cdp = await browser.newBrowserCDPSession();
  const {id: loadedId} = await cdp.send("Extensions.loadUnpacked", {path:output});
  const matchesExtension = worker => new URL(worker.url()).host === loadedId;
  const worker = context.serviceWorkers().find(matchesExtension) ?? await context.waitForEvent("serviceworker", { predicate: matchesExtension, timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  assert.equal(extensionId, loadedId);
  const network = [];
  context.on("request", request => {
    const url = new URL(request.url());
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) network.push(url.origin + url.pathname);
    if (url.protocol === "https:" && !observations.modelRequests.includes(url.origin + url.pathname)) observations.modelRequests.push(url.origin + url.pathname);
  });
  await context.addInitScript(() => {
    // Observation only: original workers and their messages/results run unchanged.
    const NativeWorker = Worker; globalThis.engineObservations = [];
    globalThis.pcmObservations = [];
    globalThis.asrInputs = [];
    if (globalThis.chrome?.tabs?.connect) {
      const connect = chrome.tabs.connect.bind(chrome.tabs);
      chrome.tabs.connect = (...args) => {
        const port = connect(...args);
        if (args[1]?.name === "interpreter-selected-video-v1") {
          port.onMessage.addListener(message => {
            if (message.type === "event") pcmObservations.push({type:"event",at:performance.now(),number:message.number,
              streamId:message.streamId,event:typeof message.event.pcm === "string"
                ? {...message.event,pcm:undefined,bytes:atob(message.event.pcm).length} : message.event});
          });
          const send = port.postMessage.bind(port);
          port.postMessage = message => {
            if (["ack","close"].includes(message.type)) pcmObservations.push({type:message.type,at:performance.now(),number:message.number,streamId:message.streamId});
            return send(message);
          };
        }
        return port;
      };
    }
    // Copy only owned synthetic test jobs before their original transfer. Keep
    // buffers outside telemetry/DOM snapshots so measurement serialization is bounded.
    let workerId = 0;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args); const url = String(args[0]);
        this.observedId = ++workerId;
        let state;
        this.addEventListener("message", ({data}) => {
          if (data?.type === "status" && data.status?.state === state) return;
          if (data?.type === "status") state = data.status?.state;
          if (["ready", "status", "error"].includes(data?.type)) engineObservations.push({ url, workerId:this.observedId, requestId:data.requestId, at:performance.now(), type: data.type, status: data.status, reason: data.reason });
          if (data?.type === "result" && typeof data.text === "string") engineObservations.push({type:"asr-result",workerId:this.observedId,requestId:data.requestId,at:performance.now(),text:data.text,inferenceMs:data.inferenceMs});
        });
      }
      postMessage(message, ...args) {
        if (message.type === "prepare") engineObservations.push({ type: "prepare", candidate: message.candidate, device: message.device });
        if (message.type === "recognize" && globalThis.archiveAsrInputs) asrInputs.push({
          workerId:this.observedId,requestId:message.requestId,pcm:message.job.pcm.slice(),
          digest:crypto.subtle.digest("SHA-256", message.job.pcm),
        });
        if (message.type === "recognize") engineObservations.push({type:"asr-job",workerId:this.observedId,requestId:message.requestId,at:performance.now(),samples:message.job.pcm.length,
          identity:{...message.job.identity},utteranceId:message.job.utteranceId,language:message.job.language,audioRange:{...message.job.audioRange}});
        return super.postMessage(message, ...args);
      }
      terminate() {
        engineObservations.push({type:"terminated",workerId:this.observedId,at:performance.now()});
        return super.terminate();
      }
    };
  });
  await page.goto(origin); await page.waitForFunction(() => [...document.querySelectorAll("video")].every(video => video.readyState >= 2));
  console.log(JSON.stringify({ phase: "videos loaded" }));
  await page.bringToFront();
  const sourceTab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
  const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }, { exclude: true }] });
  const target = targetInfos.find(info => info.type === "tab" && info.url === `${origin}/`); assert.ok(target);
  const opened = context.waitForEvent("page", { timeout: 15000 }).catch(() => undefined);
  console.log(JSON.stringify({ phase: "native action", sourceTab: sourceTab.id }));
  let actionTimeout;
  try {
    await Promise.race([cdp.send("Extensions.triggerAction", { id: extensionId, targetId: target.targetId }),
      browserExit.then(() => {throw new Error(`Owned browser exited during native action: ${JSON.stringify(observations.browserExit)}`)}),
      new Promise((_,reject) => {actionTimeout=setTimeout(()=>reject(new Error('Native action did not respond within 15 seconds')),15000)})]);
  } finally {clearTimeout(actionTimeout)}
  console.log(JSON.stringify({ phase: "native action returned" }));
  host = await opened; assert.ok(host, "Native extension action must open its host document");
  host.on("pageerror", error => observations.pageErrors.push(error.message));
  host.on("console", message => {
    if(message.type()==='error') observations.consoleErrors.push(message.text().replace(/https?:\/\/[^\s"']+/gu,value=>{
      try{const url=new URL(value);return url.origin+url.pathname}catch{return 'remote URL'}
    }));
  });
  await host.waitForURL(`chrome-extension://${extensionId}/host.html?tab=${sourceTab.id}`);
  console.log(JSON.stringify({ phase: "host opened" }));
  // Ordinary window positioning leaves both owned documents visible. No focus/
  // visibility emulation or background engine override is used.
  await worker.evaluate(async sourceTab => {
    await chrome.windows.update(sourceTab.windowId, {left:0,top:30,width:700,height:700});
  }, sourceTab);
  await host.evaluate(async () => {
    const current = await chrome.windows.getCurrent();
    await chrome.windows.update(current.id, {left:710,top:30,width:700,height:700});
  });
  await host.waitForFunction(() => document.querySelector('#video').options.length === 3);
  observations.context = await host.evaluate(async () => ({ secure:isSecureContext, visible:document.visibilityState,
    translator:typeof Translator, gpu:!!navigator.gpu, ja:typeof Translator==='undefined'?null:await Translator.availability({sourceLanguage:'ja',targetLanguage:'ko'}),
    en:typeof Translator==='undefined'?null:await Translator.availability({sourceLanguage:'en',targetLanguage:'ko'}) }));
  assert.equal(observations.context.secure, true); assert.equal(observations.context.visible, "visible");
  assert.equal(observations.context.translator, "function"); assert.equal(observations.context.gpu, true);
  observations.checks.push("Exact production permission mask/test-owned selected-video native action grant; real secure visible extension Translator/WebGPU context");
  const prepare = host.getByRole("button", { name:"모델 준비", exact:true });
  const start = host.getByRole("button", { name:"번역 시작", exact:true });
  const stop = host.getByRole("button", { name:"중지", exact:true });
  if (lifecycle) {
    // Observe the real Stop click before production handlers invalidate resources.
    await stop.evaluate(button => button.addEventListener('click', () => {
      const status=document.querySelector('[aria-label="Jamak captions"] [role="status"]');
      globalThis.stopSnapshot = { at:performance.now(), rows:document.querySelector('#app tbody').innerText,
        queue:{pendingAudioMs:Number(status.dataset.pendingAudioMs),droppedAudioMs:Number(status.dataset.droppedAudioMs)},
        pending:engineObservations.filter(job => job.type==='asr-job' && !engineObservations.some(result =>
          result.type==='asr-result' && result.workerId===job.workerId && result.requestId===job.requestId)) };
    }, {capture:true}));
  }
  const scenarios = fixtures.map((fixture,index) => ({fixture,index,mode:'online'}));
  if (lifecycle) scenarios.push({fixture:fixtures[0],index:0,mode:'offline-stop'},
    ...fixtures.map((fixture,index) => ({fixture,index,mode:'offline-restart'})));
  if (sustained) scenarios.push({fixture:fixtures[0],index:0,mode:'sustained'});
  for (const [scenarioIndex, {index,fixture,mode}] of scenarios.entries()) {
    if (lifecycle && scenarioIndex === fixtures.length) {
      await page.waitForFunction(() => [ja,en].every(video => video.buffered.length && video.buffered.start(0)===0
        && video.buffered.end(video.buffered.length-1)>=video.duration-0.1));
      await context.setOffline(true);
      assert.equal(await host.evaluate(()=>navigator.onLine),false);
      observations.checks.push('Offline browser network enabled only after both fixture videos and native/model caches are prepared');
    }
    if (mode === 'sustained') {
      await context.setOffline(false);
      await page.evaluate(async () => {
        await Promise.all([ja,en].map(video => new Promise((done,reject) => {
          video.pause(); video.addEventListener('loadeddata',done,{once:true});
          video.addEventListener('error',()=>reject(new Error('Long remux must decode as ordinary HTTP video')),{once:true});
          video.src=`/${video.id}-sustained.webm`; video.load();
        })));
      });
      await page.waitForFunction(()=>[ja,en].every(video=>video.readyState>=2 && video.duration>=600));
      await host.waitForFunction(()=>document.querySelector('#video').options.length===3);
    }
    const run = { language:fixture.language, mode, checks:[] }; observations.runs.push(run);
    const requestsBefore = observations.modelRequests.length;
    const remoteBefore = network.filter(value=>value.startsWith('https:')).length;
    await host.locator('#language').selectOption(fixture.language);
    const id = await host.locator('#video option').nth(index+1).getAttribute('value');
    await host.locator('#video').selectOption(id); await host.getByRole('button',{name:'영상 선택'}).click();
    await prepare.waitFor({state:'visible'});
    await host.waitForFunction(() => ![...document.querySelectorAll('button')].find(b=>b.textContent==='모델 준비').disabled);
    assert.equal(await start.isDisabled(),true);
    await host.evaluate(() => {
      globalThis.rowObservations=[];
      const previous=new Set(document.querySelectorAll('#app tbody tr'));
      const read=()=>{const rows=[...document.querySelectorAll('#app tbody tr')].filter(row=>!previous.has(row)).map(row=>({
        utterance:row.dataset.utteranceId,epoch:row.dataset.epoch,sourceRevision:row.dataset.sourceRevision,
        translationRevision:row.dataset.translationRevision,state:row.dataset.translationState,
        sourceFinal:row.dataset.sourceFinal,translationFinal:row.dataset.translationFinal,
        source:row.cells[0].textContent,time:row.cells[1].textContent,korean:row.cells[2].textContent}));
        const value=JSON.stringify(rows);if(rows.length && rowObservations.at(-1)?.value!==value)rowObservations.push({at:performance.now(),value,rows});};
      globalThis.rowObserver=new MutationObserver(read);rowObserver.observe(document.querySelector('#app tbody'),{subtree:true,childList:true,characterData:true,attributes:true});
      globalThis.engineObservations=[]; globalThis.pcmObservations=[]; globalThis.asrInputs=[];
      globalThis.queueObservations=[];
      const status=document.querySelector('[aria-label="Jamak captions"] [role="status"]');
      globalThis.queueObserver=new MutationObserver(()=>queueObservations.push({at:performance.now(),state:status.dataset.state,
        pendingAudioMs:status.dataset.pendingAudioMs===''?null:Number(status.dataset.pendingAudioMs),
        droppedAudioMs:status.dataset.droppedAudioMs===''?null:Number(status.dataset.droppedAudioMs)}));
      queueObserver.observe(status,{attributes:true,childList:true,characterData:true,subtree:true});
    });
    await host.evaluate(enabled=>{globalThis.archiveAsrInputs=enabled}, Boolean(archive));
    if (lifecycle && scenarioIndex === 0) {
      const denied=[];
      const deny = route => { const url=new URL(route.request().url()); denied.push(url.origin+url.pathname); return route.abort('failed'); };
      await context.route('https://huggingface.co/**',deny);
      try {
        await prepare.click();
        await host.waitForFunction(()=>document.querySelector('#app > section').textContent.includes('Preparation failed:'),undefined,{timeout:30000});
        const failure = await host.evaluate(()=>({dom:document.querySelector('#app > section').innerText,engine:engineObservations}));
        observations.downloadFailure={...failure,denied};
        assert.ok(denied.length>0,'A real first-download request must reach the injected transport failure');
        assert.ok(failure.engine.some(event=>event.type==='status' && event.status.state==='absent'));
        assert.ok(failure.engine.some(event=>event.type==='status' && event.status.state==='failed' && event.status.reason==='download-required'));
        assert.equal(failure.engine.some(event=>event.type==='ready'),false);
        assert.equal(await start.isDisabled(),true);
        await stop.click();
        await host.waitForFunction(()=>document.querySelector('#app > section').textContent.includes('중지됨'));
        await host.waitForTimeout(500);
        assert.equal(await start.isDisabled(),true);
        assert.equal(await prepare.isEnabled(),true);
        assert.equal(await host.locator('#app tbody tr').count(),0);
        observations.checks.push('Real first-download failure is explicit, never enables Start or adds captions; Stop restores Prepare without late ready');
      } finally { await context.unroute('https://huggingface.co/**',deny); }
      await host.evaluate(()=>{engineObservations=[];rowObservations=[]});
    }
    const began=performance.now(); await prepare.click();
    await host.waitForFunction(() => ![...document.querySelectorAll('button')].find(b=>b.textContent==='번역 시작').disabled || document.querySelector('#app').textContent.includes('Preparation failed:'),undefined,{timeout:240000,polling:100});
    run.preparationMs=performance.now()-began; run.preparation=await host.locator('#app > section').first().innerText();
    run.engine=await host.evaluate(()=>engineObservations);
    console.log(JSON.stringify({preparation:run}));
    assert.equal(await start.isDisabled(),false,run.preparation);
    assert.ok(run.engine.some(event=>event.type==='prepare' && event.candidate==='turboFp16' && event.device==='webgpu'));
    assert.ok(run.engine.some(event=>event.type==='status' && event.status.model.id==='onnx-community/whisper-large-v3-turbo' && event.status.state==='ready' && event.status.requiredBytes===1621338971));
    assert.ok(run.engine.some(event=>event.type==='status' && event.status.model.id==='onnx-community/silero-vad' && event.status.state==='ready'));
    if (mode.startsWith('offline')) {
      assert.equal(run.engine.some(event=>event.type==='status' && event.status.state==='downloading'),false);
      for (const model of ['onnx-community/whisper-large-v3-turbo','onnx-community/silero-vad']) {
        assert.ok(run.engine.some(event=>event.type==='status' && event.status.model.id===model && event.status.state==='cached'));
      }
      run.checks.push('Fresh ASR/VAD workers load cached weights and native translator offline without downloading');
    }
    await page.getByRole('button',{name:'Play both videos'}).click();
    assert.equal(await host.evaluate(()=>document.visibilityState),'visible');
    run.startAt=await host.evaluate(()=>performance.now());
    await start.click(); await page.getByRole('button',{name:'Allow selected video audio'}).click();
    if (mode === 'offline-stop') {
      await host.waitForFunction(()=>engineObservations.some(job=>job.type==='asr-job' && !engineObservations.some(result=>
        result.type==='asr-result' && result.workerId===job.workerId && result.requestId===job.requestId)),undefined,{timeout:30000,polling:10});
      await stop.click();
      run.stopSnapshot=await host.evaluate(()=>stopSnapshot);
      assert.equal(run.stopSnapshot.pending.length,1,'Stop must occur during actual unfinished ASR, not after a result');
      await host.waitForFunction(()=>document.querySelector('#app > section').textContent.includes('중지됨'));
      await page.locator('[data-interpreter-overlay]').waitFor({state:'detached'});
      const retained=await host.locator('#app tbody').innerText();
      await host.waitForTimeout(2000);
      run.engine=await host.evaluate(()=>engineObservations);
      const job=run.stopSnapshot.pending[0];
      assert.ok(run.engine.some(event=>event.type==='terminated' && event.workerId===job.workerId));
      assert.equal(run.engine.some(event=>event.type==='asr-result' && event.workerId===job.workerId && event.requestId===job.requestId),false);
      assert.equal(await host.locator('#app tbody').innerText(),retained);
      assert.equal(retained,run.stopSnapshot.rows);
      assert.equal(await host.locator('#app .interpreter-live').innerText(),'');
      assert.equal(await page.locator('[data-interpreter-overlay]').count(),0);
      assert.equal(await start.isDisabled(),true); assert.equal(await prepare.isEnabled(),true);
      assert.deepEqual(await page.evaluate(()=>[ja,en].map(video=>({paused:video.paused,muted:video.muted,volume:video.volume}))),
        [{paused:false,muted:false,volume:0.4},{paused:false,muted:false,volume:0.25}]);
      run.remoteRequestsAdded=network.filter(value=>value.startsWith('https:')).length-remoteBefore;
      assert.equal(run.remoteRequestsAdded,0);
      run.checks.push('Stop during real offline ASR terminates its worker; no result, late row or live output for two seconds; playback/volumes preserved');
      await host.evaluate(()=>{rowObserver.disconnect();queueObserver.disconnect()});
      await page.evaluate(()=>{ja.pause();en.pause();ja.currentTime=0;en.currentTime=0;overlayTexts=[]});
      await page.waitForFunction(()=>!ja.seeking && !en.seeking);
      console.log(JSON.stringify({run}));
      continue;
    }
    await host.waitForFunction(() => rowObservations.some(event=>event.rows.some(row=>row.state==='paired' && row.sourceFinal==='true' && row.translationFinal==='true')),undefined,{timeout:30000});
    await page.waitForFunction(() => overlayTexts.some(text=>/[가-힣]/u.test(text)),undefined,{timeout:10000});
    run.rows=await host.evaluate(()=>rowObservations);
    run.engine=await host.evaluate(()=>engineObservations);
    run.overlayTexts=await page.evaluate(()=>overlayTexts);
    const final=run.rows.flatMap(event=>event.rows).find(row=>row.state==='paired' && row.sourceFinal==='true' && row.translationFinal==='true'); assert.ok(final);
    assert.match(final.source,fixture.language==='ja'?/[\p{Script=Hiragana}\p{Script=Han}]/u:/[a-z]/iu);
    assert.ok(run.engine.some(event=>event.type==='asr-job' && event.language===fixture.language && event.samples>0 && event.audioRange.endMs>event.audioRange.startMs));
    assert.ok(run.engine.some(event=>event.type==='asr-result' && event.text.trim()));
    assert.match(final.korean,/[가-힣]/u); assert.match(final.time,/^\d+\.\d–\d+\.\d s$/);
    const pending=run.rows.findIndex(event=>event.rows.some(row=>row.utterance===final.utterance && row.epoch===final.epoch && row.state==='pending'));
    const paired=run.rows.findIndex(event=>event.rows.some(row=>row.utterance===final.utterance && row.epoch===final.epoch && row.state==='paired'));
    assert.ok(pending>=0 && pending<paired,'Real ASR original must paint before its native translation');
    assert.ok(run.overlayTexts.some(text=>final.korean.trim().startsWith(text.trim()) && /[가-힣]/u.test(text)),'Real paired Korean must reach the selected-page overlay');
    assert.match(await host.locator('#app .interpreter-live').innerText(),/[가-힣]/u);
    run.playback=await page.evaluate(()=>[ja,en].map(video=>({paused:video.paused,muted:video.muted,volume:video.volume,time:video.currentTime})));
    assert.deepEqual(run.playback.map(video=>({paused:video.paused,muted:video.muted,volume:video.volume})),[{paused:false,muted:false,volume:0.4},{paused:false,muted:false,volume:0.25}]);
    run.checks.push('Actual final ASR/native Korean, original-first comparison/video time, host live and selected-video overlay');
    if (mode === 'offline-restart') {
      const cancelled=observations.runs.find(previous=>previous.mode==='offline-stop').stopSnapshot.pending[0];
      const job=run.engine.find(event=>event.type==='asr-job');
      assert.notEqual(job.identity.sessionId,cancelled.identity.sessionId);
      assert.notEqual(job.workerId,cancelled.workerId);
      run.checks.push('Explicit offline Prepare/Start creates fresh workers/session and real paired DOM after the cancelled session');
    }
    if (mode === 'sustained') {
      run.minutes=[]; run.memoryMetric='Owned Chromium process-tree RSS KiB, once per minute; includes shared browser/renderer/GPU pages, not isolated model allocations';
      for (let minute=1;minute<=10;minute++) {
        await host.waitForFunction(endMs=>pcmObservations.some(packet=>packet.event?.audioRange?.endMs>=endMs),minute*60000,{timeout:75000,polling:100});
        const sample=await host.evaluate(()=>({at:performance.now(),pcmEndMs:pcmObservations.filter(packet=>packet.event?.audioRange).at(-1).event.audioRange.endMs,
          jobs:engineObservations.filter(event=>event.type==='asr-job').length,results:engineObservations.filter(event=>event.type==='asr-result').length,
          paired:rowObservations.at(-1)?.rows.filter(row=>row.state==='paired').length??0,queues:queueObservations.splice(0),
          state:document.querySelector('[aria-label="Jamak captions"] [role="status"]').dataset.state}));
        sample.minute=minute; sample.rssKiB=await sampleRss();
        const queues=sample.queues.filter(value=>value.pendingAudioMs!==null);
        assert.ok(queues.length,'Every actual minute must contain queue telemetry');
        assert.ok(queues.every(value=>value.pendingAudioMs<=30000 && value.droppedAudioMs===0));
        assert.equal(sample.state,'running');
        assert.ok(sample.results>(run.minutes.at(-1)?.results??0),'Real ASR must progress every minute');
        assert.ok(sample.paired>(run.minutes.at(-1)?.paired??0),'Native Korean DOM must progress every minute');
        const {queues:_,...summary}=sample;
        summary.maxPendingAudioMs=Math.max(...queues.map(value=>value.pendingAudioMs));
        summary.finalPendingAudioMs=queues.at(-1).pendingAudioMs; summary.droppedAudioMs=queues.at(-1).droppedAudioMs;
        run.minutes.push(summary); console.log(JSON.stringify({sustainedMinute:summary}));
      }
      // Freeze one coherent host-clock snapshot after completed ASR results have
      // reached their native paired rows. Capture continues unchanged.
      const ready=await host.waitForFunction(()=>{
        const paired=rowObservations.at(-1)?.rows.filter(row=>row.state==='paired')??[];
        const complete=engineObservations.filter(event=>event.type==='asr-result').every(result=>{
          const job=engineObservations.find(event=>event.type==='asr-job' && event.workerId===result.workerId && event.requestId===result.requestId);
          return job && paired.some(row=>row.utterance===job.utteranceId && Number(row.epoch)===job.identity.epoch);
        });
        return complete ? structuredClone({at:performance.now(),engine:engineObservations,rows:rowObservations,pcm:pcmObservations}) : false;
      },undefined,{timeout:10000,polling:50});
      const measured=await ready.jsonValue(); await ready.dispose();
      run.hostElapsedMs=measured.at-run.startAt;
      assert.ok(run.hostElapsedMs>=600000,'A real ten-minute host interval is required');
      const packets=measured.pcm.filter(packet=>packet.event?.audioRange);
      assert.ok(packets.length>10000);
      const first=packets[0].event, last=packets.at(-1).event;
      assert.ok(last.audioRange.endMs-first.audioRange.startMs>=600000);
      for (const [index,packet] of packets.entries()) {
        assert.deepEqual(packet.event.identity,first.identity);
        assert.equal(packet.event.sequence,index); assert.equal(packet.event.sampleRate,first.sampleRate);
        assert.equal(packet.event.capture.clockId,first.capture.clockId);
        assert.equal(packet.event.bytes,8192);
        assert.ok(Math.abs(packet.event.bytes/4/packet.event.sampleRate*1000-(packet.event.audioRange.endMs-packet.event.audioRange.startMs))<0.001);
        if(index) assert.ok(Math.abs(packet.event.audioRange.startMs-packets[index-1].event.audioRange.endMs)<0.001);
      }
      let outstanding=0,maxOutstanding=0;
      for(const packet of measured.pcm) {
        if(packet.type==='event') outstanding++;
        if(packet.type==='ack') outstanding--;
        maxOutstanding=Math.max(maxOutstanding,outstanding);
        assert.ok(outstanding>=0 && outstanding<=4,'The production acknowledgement window remains bounded');
      }
      const jobs=measured.engine.filter(event=>event.type==='asr-job');
      const results=measured.engine.filter(event=>event.type==='asr-result');
      assert.ok(jobs.length>=30 && results.length>=30);
      const paired=measured.rows.at(-1).rows.filter(row=>row.state==='paired');
      for(const [index,job] of jobs.entries()) {
        assert.deepEqual(job.identity,first.identity); assert.equal(job.samples,(job.audioRange.endMs-job.audioRange.startMs)*16);
        assert.ok(job.audioRange.endMs-job.audioRange.startMs<=20000);
        if(index) assert.equal(job.audioRange.startMs,jobs[index-1].audioRange.endMs,'Normal speech must not silently lose context between jobs');
        const result=results.find(value=>value.workerId===job.workerId && value.requestId===job.requestId);
        if(!result) continue;
        const row=paired.find(value=>value.utterance===job.utteranceId && Number(value.epoch)===job.identity.epoch);
        assert.ok(row,'Every completed actual ASR job must reach native paired DOM');
        assert.equal(row.sourceRevision,'1'); assert.equal(row.translationRevision,`${index+1}`);
        assert.equal(row.source,result.text);
        assert.equal(row.sourceFinal,'true'); assert.equal(row.translationFinal,'true'); assert.match(row.korean,/[가-힣]/u);
      }
      const lastResultJob=jobs.find(job=>job.requestId===results.at(-1).requestId && job.workerId===results.at(-1).workerId);
      run.measurement={chunks:packets.length,sampleRate:first.sampleRate,rawSamples:packets.length*2048,
        capturedAudioMs:last.audioRange.endMs-first.audioRange.startMs,identity:first.identity,maxOutstanding,unacknowledged:outstanding,
        jobs:jobs.length,results:results.length,pairedRows:paired.length,firstAsrStartMs:jobs[0].audioRange.startMs,
        lastAsrEndMs:lastResultJob.audioRange.endMs,uncompletedTailMs:last.audioRange.endMs-lastResultJob.audioRange.endMs,
        maxInferenceMs:Math.max(...results.map(result=>result.inferenceMs)),latencies:[]};
      for(const result of results) {
        const job=jobs.find(value=>value.requestId===result.requestId && value.workerId===result.workerId);
        const delivery=packets.find(packet=>packet.event.audioRange.endMs>=job.audioRange.endMs);
        const pending=measured.rows.find(event=>event.rows.some(row=>row.utterance===job.utteranceId && row.state==='pending'));
        const final=measured.rows.find(event=>event.rows.some(row=>row.utterance===job.utteranceId && row.state==='paired'));
        assert.ok(delivery && pending && final);
        assert.ok(pending.at<final.at,'Every real source must paint before its exact native translation');
        run.measurement.latencies.push({utterance:job.utteranceId,audioEndMs:job.audioRange.endMs,
          lastPcmDeliveryToSourceMs:pending.at-delivery.at,sourceToPairedMs:final.at-pending.at});
      }
      assert.ok(run.measurement.uncompletedTailMs<=30000);
      run.playback=await page.evaluate(()=>[ja,en].map(video=>({paused:video.paused,muted:video.muted,volume:video.volume,time:video.currentTime})));
      assert.deepEqual(run.playback.map(video=>({paused:video.paused,muted:video.muted,volume:video.volume})),
        [{paused:false,muted:false,volume:0.4},{paused:false,muted:false,volume:0.25}]);
      run.checks.push('Actual ten-minute one-epoch PCM sequence/clock/ack continuity, bounded zero-loss running queues, per-minute ASR/native Korean DOM progress and original playback');
    }
    await stop.click(); await host.waitForFunction(()=>document.querySelector('#app > section').textContent.includes('중지됨'));
    await page.locator('[data-interpreter-overlay]').waitFor({state:'detached'});
    const retained=await host.locator('#app tbody').innerText();
    await host.waitForTimeout(500);
    if (mode === 'sustained') {
      run.stopSnapshot=await host.evaluate(()=>stopSnapshot);
      const after=await host.evaluate(()=>({engine:engineObservations,
        queue:{...document.querySelector('[aria-label="Jamak captions"] [role="status"]').dataset}}));
      run.afterStopQueue=after.queue;
      assert.equal(Number(after.queue.pendingAudioMs),0);
      for(const job of run.stopSnapshot.pending) {
        assert.ok(after.engine.some(event=>event.type==='terminated' && event.workerId===job.workerId));
        assert.equal(after.engine.some(event=>event.type==='asr-result' && event.workerId===job.workerId && event.requestId===job.requestId),false);
      }
      assert.ok(run.stopSnapshot.queue.pendingAudioMs<=30000);
      assert.equal(run.stopSnapshot.queue.droppedAudioMs,0);
      run.checks.push('Explicit Stop records the last running pending-audio observation, terminates unfinished inference and leaves the controller queue empty; no late captions');
    }
    assert.equal(await host.locator('#app tbody').innerText(),retained);
    assert.equal(await host.locator('#app .interpreter-live').innerText(),'');
    assert.equal(await page.locator('[data-interpreter-overlay]').count(),0);
    assert.equal(await start.isDisabled(),true);
    assert.equal(await page.evaluate(()=>[ja,en].every(video=>!video.paused && !video.muted)),true);
    run.checks.push('Stop clears both live surfaces; comparison retained; no late DOM update; original playback continues');
    await host.evaluate(()=>{rowObserver.disconnect();queueObserver.disconnect()});
    await page.evaluate(()=>{ja.pause();en.pause();ja.currentTime=0;en.currentTime=0;overlayTexts=[]});
    await page.waitForFunction(()=>!ja.seeking && !en.seeking);
    run.remoteRequestsAdded=network.filter(value=>value.startsWith('https:')).length-remoteBefore;
    if (mode.startsWith('offline')) {
      assert.equal(run.remoteRequestsAdded,0);
      assert.equal(observations.modelRequests.length,requestsBefore);
      run.checks.push('Complete cached offline PCM/ASR/native Korean/DOM run makes zero remote requests');
    }
    if (archive) {
      const engine=mode==='sustained' ? await host.evaluate(()=>engineObservations) : run.engine;
      // Only completed jobs are archived. Stop's unfinished tail stays explicit
      // in its original cancellation evidence and is never called transcribed.
      const jobs=engine.filter(event=>event.type==='asr-job');
      const completed=jobs.filter(job=>engine.some(result=>result.type==='asr-result' && result.workerId===job.workerId && result.requestId===job.requestId));
      const saved={round:scenarioIndex+1,language:fixture.language,mode,reference:fixture.text,
        fixtureSha256:fixture.sha256,identity:completed[0].identity,
        generatedMedia:mode==='sustained' ? generatedMedia.find(media=>media.language===fixture.language) : undefined,
        referenceScope:'Original labeled phrase only; remux repeats truncated encoded periods, so whole-run reference/counts are not established',jobs:[]};
      for(const [index,job] of completed.entries()) {
        const snapshot=await host.evaluate(async ({workerId,requestId})=>{
          const input=asrInputs.find(value=>value.workerId===workerId && value.requestId===requestId);
          if(!input)throw new Error('Missing original pre-transfer ASR input');
          const bytes=new Uint8Array(input.pcm.buffer);
          let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
          return {base64:btoa(binary),littleEndian:new Uint8Array(new Float32Array([1]).buffer)[3]===63,
            sha256:[...new Uint8Array(await input.digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};
        },job);
        assert.equal(snapshot.littleEndian,true);
        const bytes=Buffer.from(snapshot.base64,'base64');
        assert.equal(bytes.length,job.samples*4);
        assert.equal(createHash('sha256').update(bytes).digest('hex'),snapshot.sha256,'Archive exactly matches the original buffer hashed before transfer');
        const result=engine.find(value=>value.type==='asr-result' && value.workerId===job.workerId && value.requestId===job.requestId);
        const file=`round-${saved.round}-job-${index+1}.f32`;
        await writeFile(resolve(archive,file),bytes);
        saved.jobs.push({file,samples:job.samples,inputSha256:snapshot.sha256,utteranceId:job.utteranceId,
          audioRange:job.audioRange,originalText:result.text,originalInferenceMs:result.inferenceMs,
          latency:run.measurement?.latencies.find(value=>value.utterance===job.utteranceId)});
      }
      archivedRuns.push(saved);
      await writeFile(resolve(archive,'manifest.json'),JSON.stringify({
        scope:'Owned synthetic production-extension ASR inputs; replay reproducibility only, not whole-run accuracy or endpoint acceptance',
        format:'float32-le',sampleRate:16000,channels:1,candidate:'turboFp16',
        model:{id:'onnx-community/whisper-large-v3-turbo',version:'360ebcde2559d60bb474678be3c1de9ef347d01a',requiredBytes:1621338971},
        runs:archivedRuns,
      },null,2));
      run.archivedJobs=saved.jobs.length;
      await host.evaluate(()=>{asrInputs=[]});
    }
    console.log(JSON.stringify({run}));
  }
  assert.ok(network.every(value=>!/^https?:\/\/[^/]+:(8765|11434)(\/|$)/u.test(value)),'No companion/Ollama network use');
  assert.deepEqual(observations.pageErrors,[]);
  console.log(JSON.stringify({passed:true,...observations}));
} catch(error) {
  if(host) {
    observations.failureDom=await host.locator('body').innerText().catch(()=>undefined);
    observations.failureEngine=await host.evaluate(()=>({engine:globalThis.engineObservations,rows:globalThis.rowObservations})).catch(()=>undefined);
  }
  console.error(JSON.stringify({passed:false,...observations,error:error.stack}));process.exitCode=1;
} finally {
  browserProcess?.kill('SIGTERM');
  if (browserProcess && browserExit) {
    const force = setTimeout(() => browserProcess.kill('SIGKILL'), 5000);
    await browserExit; clearTimeout(force);
  }
  await browser?.close();
  if(profile)await rm(profile,{recursive:true,force:true});
  await new Promise(done=>server.close(done));
}
