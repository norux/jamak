// Owned, headed extension/content integration. No ASR/Translator mock is used:
// engines are deliberately not prepared. This tests real PCM transport only.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { chromium } from "playwright";
import { build } from "vite";

const output = resolve(".ralph/media-framework/chrome-channel-build");
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: { outDir: output } });
await build({ configFile: false, logLevel: "warn", build: { outDir: output, emptyOutDir: false,
  rollupOptions: { input: { channel: resolve("apps/chrome/channel.ts"), timeline: resolve("packages/core/timeline.ts") }, preserveEntrySignatures: "strict", output: { entryFileNames: "[name].js" } } } });
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
assert.equal(manifest.background.type, "module");
const contentScript = await readFile(`${output}/content.js`, "utf8");
assert.doesNotThrow(() => new Script(contentScript));
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (["/ja.webm", "/en.webm"].includes(path)) {
      const bytes = await readFile(`tests/fixtures/video-speech${path}`);
      response.setHeader("Content-Type", "video/webm"); response.setHeader("Accept-Ranges", "bytes");
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start > end) { response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }); response.end(); return; }
      if (range) { response.statusCode = 206; response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`); }
      response.setHeader("Content-Length", end - start + 1); response.end(bytes.subarray(start, end + 1)); return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Video audio acceptance</title>
      <video id="ja" title="Japanese synthetic speech" src="/ja.webm" controls preload="auto" width="320" height="180"></video>
      <video id="en" title="English synthetic speech" src="/en.webm" controls preload="auto" width="320" height="180"></video>
      <button id="play">Play both and observe output</button>
      <script>
      globalThis.ready = false;
      globalThis.tags = (samples, rate) => [6500, 9000].map(frequency => {
        let power=0, windows=0; const size=1024;
        for(let start=0; start+size<=samples.length; start+=size) {
          let sine=0, cosine=0, weight=0;
          for(let i=0;i<size;i++) {const taper=0.5-0.5*Math.cos(2*Math.PI*i/(size-1)), phase=2*Math.PI*frequency*i/rate;
            sine+=samples[start+i]*taper*Math.sin(phase); cosine+=samples[start+i]*taper*Math.cos(phase); weight+=taper;}
          power+=4*(sine*sine+cosine*cosine)/(weight*weight);windows++;
        }
        return Math.sqrt(power/windows);
      });
      play.onclick=async()=>{try {
        ja.volume=0.4; en.volume=0.25; await Promise.all([ja.play(), en.play()]);
        globalThis.stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:{suppressLocalAudioPlayback:false,
          autoGainControl:false,echoCancellation:false,noiseSuppression:false},preferCurrentTab:true});
        if(stream.getAudioTracks().length!==1)throw new Error('Missing independent output audio');
        globalThis.context=new AudioContext();globalThis.observer=context.createAnalyser();observer.fftSize=8192;
        context.createMediaStreamSource(stream).connect(observer);await context.resume();
        globalThis.ready=true;
      }catch(error){globalThis.failure=error.message}};
      globalThis.measure=async()=>{const values=[];for(let i=0;i<5;i++){
        await new Promise(done=>setTimeout(done,60));const samples=new Float32Array(observer.fftSize);
        observer.getFloatTimeDomainData(samples);values.push(tags(samples,context.sampleRate));}
        return [0,1].map(index=>values.reduce((sum,value)=>sum+value[index],0)/values.length);};
      </script>`);
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
// Keep the exact production permission mask. Native action grants this tab.
const profile = await mkdtemp(resolve(".ralph/media-framework/chrome-channel-profile-"));
let context;
const observations = { actionEntry: "test-owned selected-video action; production tab action is checked by :tab-host", pageErrors: [], productionPermissions: manifest.permissions,
  hostPermissions: manifest.host_permissions ?? [], toolbarActiveTabGrant: "native action dispatch; physical toolbar click unverified", runs: [] };
try {
  context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false,
    ignoreDefaultArgs: ["--disable-extensions", "--mute-audio"], args: [`--disable-extensions-except=${output}`, `--load-extension=${output}`,
      "--enable-unsafe-extension-debugging", "--auto-select-tab-capture-source-by-title=Video audio acceptance", "--enable-usermedia-screen-capturing"] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage(); page.on("pageerror", error => observations.pageErrors.push(error.message));
  await page.goto(origin); await page.waitForFunction(() => [...document.querySelectorAll("video")].every(video => video.readyState >= 2));
  await page.getByRole("button", { name: "Play both and observe output" }).click();
  await page.waitForFunction(() => ready || globalThis.failure, undefined, { timeout: 10000 });
  assert.equal(await page.evaluate(() => globalThis.failure), undefined);
  const baselineDeadline = performance.now() + 5000; let baseline;
  const expectedOutput = [0.06 * 0.4, 0.06 * 0.25];
  do { baseline = await page.evaluate(() => measure()); } while (baseline.some((value, i) => Math.abs(value / expectedOutput[i] - 1) >= 0.03) && performance.now() < baselineDeadline);
  assert.ok(baseline.every((value, i) => Math.abs(value / expectedOutput[i] - 1) < 0.03), `Both encoded tags must reach full native output within 5 seconds: ${JSON.stringify(baseline)}`);
  await page.bringToFront();
  // Evaluate the worker before dispatch so its action listener is registered.
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const cdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }, { exclude: true }] });
  const target = targetInfos.find(info => info.type === "tab" && info.url === `${origin}/`);
  assert.ok(target);
  const opened = context.waitForEvent("page", { timeout: 15000 }).catch(() => undefined);
  await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: target.targetId });
  const host = await opened;
  assert.ok(host, "Native extension action must open its host document");
  host.on("pageerror", error => observations.pageErrors.push(error.message));
  await host.waitForURL(`chrome-extension://${extensionId}/host.html?tab=${tabId}`);
  // Reinject only after the actual action grant, preserving the active owner.
  await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] }), tabId);
  await host.waitForFunction(() => document.querySelector('#video').options.length === 3);
  assert.equal(await host.locator('#video').inputValue(), "", "A target must be explicitly confirmed");
  assert.equal(await host.getByRole("button", { name: "모델 준비" }).isDisabled(), true);
  const id = await host.locator('#video option').nth(1).getAttribute("value");
  await host.locator('#video').selectOption(id); await host.getByRole("button", { name: "영상 선택" }).click();
  await host.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '모델 준비').disabled);
  assert.match(await host.locator('#app').textContent(), /onnx-community\/whisper-large-v3-turbo/);
  // Adapter integration in the same eligible host, without preparing engines.
  await host.evaluate(async tabId => {
    const { createRemoteVideoInput, channelName } = await import('./channel.js');
    globalThis.remote = createRemoteVideoInput(chrome.tabs.connect(tabId, {name:channelName,frameId:0}));
    globalThis.targets = await remote.discover(); globalThis.round = 0;
    globalThis.startCapture = index => {
      globalThis.chunks=[];globalThis.anchors=[];globalThis.transportError=undefined;globalThis.captureFinished=false;
      const target=targets[index].target, identity={sessionId:`transport-${++round}`,targetId:target.id,epoch:0};
      globalThis.opening = remote.input.open(target,identity).then(async value=>{
        globalThis.handle=value;
        try{for await(const event of value.events){if('type' in event)anchors.push(event);else chunks.push({event,received:performance.now()});}}
        catch(error){globalThis.transportError=error.message}finally{globalThis.captureFinished=true}
      }).catch(error=>{globalThis.transportError=error.message;globalThis.captureFinished=true});
    };
  }, tabId);
  for (const index of [0, 1]) {
    await page.evaluate(() => { ja.currentTime=1;en.currentTime=1; }); await page.waitForFunction(() => !ja.seeking && !en.seeking);
    await host.evaluate(index => startCapture(index), index);
    await page.getByRole("button", { name: "Allow selected video audio" }).click();
    await host.waitForFunction(() => chunks.length >= 24 || transportError, undefined, { timeout: 10000 });
    assert.equal(await host.evaluate(() => transportError), undefined);
    // Observe playback before copying the fixture samples through the test runner.
    const observedMediaMs = await page.evaluate(index => [ja,en][index].currentTime * 1000, index);
    const result = await host.evaluate(async index => {
      const { createTimeline } = await import('./timeline.js');
      const identity=chunks[0].event.identity, timeline=createTimeline(identity);timeline.playback(anchors[0]);
      const samples=new Float32Array(chunks.reduce((sum,{event})=>sum+event.pcm.byteLength/4,0));let offset=0;
      const order=[],mapping=[];
      for(const {event} of chunks){order.push(timeline.audio(event));mapping.push(timeline.map(event.audioRange));samples.set(new Float32Array(event.pcm),offset);offset+=event.pcm.byteLength/4;}
      return {index,chunks:chunks.length,bytes:chunks.map(({event})=>event.pcm.byteLength),sequence:chunks.map(({event})=>event.sequence),
        order,mapping,identity,sampleRate:chunks[0].event.sampleRate,pcm:Array.from(samples),
        receivedIntervals:chunks.slice(1).map((item,i)=>item.received-chunks[i].received),clocks:chunks.every(({event})=>event.capture.clockId===anchors[0].anchor.clockId)};
    }, index);
    result.mappingErrorMs = Math.abs(result.mapping.at(-1).endMs - observedMediaMs);
    assert.ok(result.mappingErrorMs < 150, `Playback anchors must map PCM to video time: ${result.mappingErrorMs} ms`);
    const tags = await page.evaluate(({ pcm, rate }) => globalThis.tags(pcm, rate), { pcm: result.pcm, rate: result.sampleRate }); delete result.pcm;
    assert.ok(Math.abs(tags[index] / 0.06 - 1) < 0.12 && tags[1-index] < 0.001, `Only the selected encoded speech tag crosses the extension port: ${JSON.stringify(tags)}`);
    assert.equal(result.order.every(value => value === "accepted"), true); assert.equal(result.clocks, true);
    assert.equal(result.bytes.every(value => value === 8192), true);
    assert.deepEqual(result.sequence, Array.from({ length: result.chunks }, (_, i) => i));
    assert.ok(result.mapping.every(value => value && value.endMs > value.startMs));
    const during = await page.evaluate(() => measure());
    await host.evaluate(() => remote.stop()); await host.waitForFunction(() => captureFinished);
    const count = await host.evaluate(() => chunks.length);
    const after = await page.evaluate(() => measure());
    assert.equal(await host.evaluate(() => chunks.length), count);
    assert.equal(await page.evaluate(() => [ja,en].every(video=>!video.paused && !video.muted)), true);
    assert.deepEqual(await page.evaluate(() => [ja.volume,en.volume]), [0.4,0.25]);
    observations.runs.push({...result,tags,duringOutputTags:during,afterOutputTags:after});
    for(const observed of [during,after]) assert.ok(observed.every((value,i)=>Math.abs(value/baseline[i]-1)<0.12), `Native playback remains at its original level: ${JSON.stringify({baseline,observed})}`);
  }
  // Stop pending permission must remove the page gate and never acquire samples.
  await host.evaluate(() => startCapture(0)); await page.getByRole('button',{name:'Allow selected video audio'}).waitFor();
  await host.evaluate(() => remote.stop()); await host.waitForFunction(() => captureFinished);
  await page.getByRole('button',{name:'Allow selected video audio'}).waitFor({state:'detached'});
  assert.equal(await host.evaluate(() => chunks.length),0);
  assert.match(await host.evaluate(() => transportError),/cancelled/);
  const priorTabIds = await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id));
  const ungranted = await context.newPage(); await ungranted.goto(`${origin}/ungranted`);
  const newTabId = await worker.evaluate(async prior => (await chrome.tabs.query({})).find(tab => !prior.includes(tab.id)).id, priorTabIds);
  await assert.rejects(worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => document.title }), newTabId), /Cannot access|permission/i);
  await ungranted.close();
  observations.ungrantedTabRejected = true;
  // Navigation destroys the actual content channel and rejects the remote host.
  await page.goto(`${origin}/replacement`);
  await assert.rejects(host.evaluate(() => remote.discover()),/context-destroyed/);
  assert.deepEqual(observations.pageErrors,[]);
  console.log(JSON.stringify({passed:true,scope:"B4 owned extension host/selection and real PCM channel; no ASR/translation/overlay acceptance",browser:context.browser().version(),...observations}));
} catch(error) {console.error(JSON.stringify({passed:false,...observations,error:error.stack}));process.exitCode=1;}
finally {await context?.close();await rm(profile,{recursive:true,force:true});await new Promise(done=>server.close(done));}
