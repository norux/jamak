// Owned extension transport + real video layout/fullscreen. Caption revisions
// are explicitly synthetic: no PCM, ASR, native translation or accuracy claim.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

const output = resolve(".ralph/media-framework/chrome-overlay-build");
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: { outDir: output } });
await build({ configFile: false, logLevel: "warn", build: { outDir: output, emptyOutDir: false,
  rollupOptions: { input: { "overlay-channel": resolve("apps/chrome/overlay-channel.ts"), channel: resolve("apps/chrome/channel.ts"), overlay: resolve("apps/chrome/overlay.ts") }, preserveEntrySignatures: "strict", output: { entryFileNames: "[name].js" } } } });
const manifest = JSON.parse(await readFile(`${output}/manifest.json`, "utf8"));
assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "tabCapture", "offscreen", "notifications"]); assert.deepEqual(manifest.host_permissions, ["https://paddle-model-ecology.bj.bcebos.com/*"]);
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path.endsWith(".webm")) { response.setHeader("Content-Type", "video/webm"); response.end(await readFile(`tests/fixtures/video-speech${path}`)); return; }
    response.setHeader("Content-Type", "text/html");
    if (path === '/embedded') {
      response.end('<!doctype html><video id="embedded" src="/en.webm" controls></video><button onclick="embedded.requestFullscreen()">Fullscreen embedded video</button>');return;
    }
    response.end(`<!doctype html><meta charset="utf-8"><title>Selected overlay fixture</title><style>
      #player {width:320px} #player:fullscreen {width:100vw;background:black} #player:fullscreen video {width:100%;height:80vh}
      video {width:320px;height:180px} body {height:1800px} </style>
      <div id="player"><video id="ja" title="Japanese fixture" src="/ja.webm" controls></video>
      <button id="containerFullscreen">Fullscreen player</button><button id="videoFullscreen">Fullscreen video</button></div>
      <video id="en" title="English fixture" src="/en.webm" controls></video>
      <script>containerFullscreen.onclick=()=>player.requestFullscreen();videoFullscreen.onclick=()=>ja.requestFullscreen();</script>`);
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
// Explicit localhost permission in the ignored test copy only; this is not
// evidence of the shipping toolbar's activeTab grant and is no user-profile bypass.
manifest.host_permissions = [`${origin}/*`]; await writeFile(`${output}/manifest.json`, JSON.stringify(manifest));
const profile = await mkdtemp(resolve(".ralph/media-framework/chrome-overlay-profile-"));
let context;
const observations = { scope: "B4 synthetic accepted-caption revisions over real extension ports and video overlay DOM; no ASR/translation/PCM acceptance",
  pageErrors: [], checks: [], toolbarActiveTabGrant: "unverified" };
try {
  context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false,
    ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${output}`, `--load-extension=${output}`] });
  observations.browser = context.browser().version(); observations.platform = `${process.platform}/${process.arch}`;
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage(); page.on("pageerror", error => observations.pageErrors.push(error.message));
  await page.goto(origin); await page.waitForFunction(() => ja.readyState >= 2 && en.readyState >= 2);
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url === `${origin}/`).id, origin);
  await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] }), tabId);
  const host = await context.newPage(); host.on("pageerror", error => observations.pageErrors.push(error.message));
  await host.goto(`chrome-extension://${extensionId}/host.html?tab=${tabId}`);
  await host.waitForFunction(() => document.querySelector('#video').options.length === 3);
  assert.match(await host.locator("#fullscreen-support").textContent(), /비디오·플레이어 전체화면/);
  await host.evaluate(async tabId => {
    const { createRemoteVideoOutput, overlayChannelName } = await import('./overlay-channel.js');
    globalThis.failures = [];
    globalThis.display = createRemoteVideoOutput(chrome.tabs.connect(tabId, {name:overlayChannelName,frameId:0}), error => failures.push(error));
  }, tabId);
  await host.waitForFunction(() => document.querySelector('#connection').textContent.includes('overlay disconnected'));
  assert.equal(await host.locator('#video').isDisabled(), true, 'A lost overlay requires reopening the host before another selection');
  assert.equal(await host.locator('#confirm').isDisabled(), true);
  assert.equal(await host.locator('#language').isDisabled(), true);
  // Obtain opaque target/document identity through the actual catalog channel,
  // without opening audio or preparing engines.
  await host.evaluate(async tabId => {
    const { createRemoteVideoInput, channelName } = await import('./channel.js');
    globalThis.remote = createRemoteVideoInput(chrome.tabs.connect(tabId, {name:channelName,frameId:0}));
    globalThis.targets = await remote.discover(); globalThis.target = targets[0].target;
    globalThis.identity = {sessionId:'overlay-synthetic',targetId:target.id,epoch:0};
    globalThis.source = {identity,utteranceId:'caption',sourceRevision:1,text:'<img src=x onerror=alert(1)> synthetic original',final:false,
      language:'ja',audioRange:{startMs:0,endMs:1000}};
    globalThis.sendPending = () => display.compare({source,translation:{state:'pending'},videoRange:{startMs:12000,endMs:13000}});
    globalThis.sendPair = (text,revision=1) => display.compare({source,translation:{state:'paired',revision:{identity,utteranceId:source.utteranceId,
      sourceRevision:source.sourceRevision,translationRevision:revision,languages:{source:'ja',target:'ko'},text,final:source.final}}});
    display.activate(target,identity);sendPending();
  }, tabId);
  const cue = page.locator('[data-interpreter-overlay] .interpreter-live span').first();
  await cue.waitFor(); await page.waitForFunction(() => document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live span').textContent.includes('synthetic'));
  assert.equal(await page.locator('[data-interpreter-overlay] img').count(), 0);
  const geometry = await page.evaluate(() => {const a=ja.getBoundingClientRect(),b=document.querySelector('[data-interpreter-overlay]').getBoundingClientRect();return {video:{left:a.left,top:a.top,width:a.width,height:a.height},overlay:{left:b.left,top:b.top,width:b.width,height:b.height}}});
  assert.deepEqual(geometry.video, geometry.overlay); observations.geometry = geometry;
  await page.evaluate(() => {ja.style.width='280px';window.scrollTo(0,40)});
  await page.waitForFunction(() => {
    const a=ja.getBoundingClientRect(),b=document.querySelector('[data-interpreter-overlay]').getBoundingClientRect();
    return a.width===280 && a.left===b.left && a.top===b.top && a.width===b.width && a.height===b.height;
  });
  await page.evaluate(() => {ja.style.width='320px';window.scrollTo(0,0)});
  await page.waitForFunction(() => document.querySelector('[data-interpreter-overlay]').getBoundingClientRect().width===320);
  observations.checks.push('Owned overlay follows selected-video resize and page scroll without changing the video element');
  await host.evaluate(() => sendPair('합성 번역 결과')); await page.waitForFunction(() => document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live span').textContent==='합성 번역 결과');
  const compact = await cue.evaluate(element => {
    const box = element.getBoundingClientRect();
    const host = element.getRootNode().host.getBoundingClientRect();
    return { width: box.width, left: box.left, right: box.right, bottom: box.bottom,
      hostWidth: host.width, hostLeft: host.left, hostRight: host.right, hostBottom: host.bottom };
  });
  assert.ok(compact.width < compact.hostWidth * 0.9, 'Short captions must have a compact background');
  assert.ok(compact.left > compact.hostLeft && compact.right < compact.hostRight, 'Captions must stay inside the player');
  assert.ok(compact.bottom <= compact.hostBottom - 48, 'Captions must sit above playback controls');
  await host.evaluate(() => { source={...source,sourceRevision:2,final:true};sendPending();sendPair('긴 최종 번역 '.repeat(80),2); });
  await page.waitForFunction(() => document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live span').textContent.startsWith('긴 최종'));
  const initial = await cue.textContent(); assert.ok(initial.length > 0 && initial.length < '긴 최종 번역 '.repeat(80).trim().length);
  await page.waitForFunction(initial => document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live span').textContent !== initial, initial, {timeout:7500});
  const next = await cue.textContent(); assert.equal(initial+next, '긴 최종 번역 '.repeat(80).trim().slice(0, initial.length+next.length));
  observations.parts = {first:initial.length,second:next.length};
  observations.checks.push('Selected-video geometry, safe original-first text, exact paired revisions, measured two-line sequential final replay');
  await page.bringToFront();
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  assert.equal(await page.evaluate(() => document.fullscreenEnabled), true);
  await page.getByRole('button',{name:'Fullscreen player',exact:true}).click();
  await page.waitForFunction(() => document.fullscreenElement?.id==='player' && document.querySelector('[data-interpreter-overlay]').matches(':popover-open'));
  assert.equal(await page.locator('[data-interpreter-overlay]').evaluate(node=>getComputedStyle(node).display), 'flex');
  await page.evaluate(() => document.exitFullscreen()); await page.waitForFunction(() => !document.fullscreenElement);
  await page.getByRole('button',{name:'Fullscreen video',exact:true}).click();
  await page.waitForFunction(() => document.fullscreenElement===ja && document.querySelector('[data-interpreter-overlay]').matches(':popover-open'), undefined, {timeout:5000});
  assert.equal(await page.locator('[data-interpreter-overlay]').evaluate(node=>getComputedStyle(node).display), 'flex');
  await page.screenshot({path:'.ralph/media-framework/selected-video-fullscreen.png'});
  assert.equal(await page.evaluate(() => document.elementFromPoint(innerWidth/2,innerHeight/2)===ja),true,'The caption layer must not intercept video input');
  await page.evaluate(() => document.exitFullscreen()); await page.waitForFunction(() => !document.fullscreenElement);
  await page.waitForFunction(() => !document.querySelector('[data-interpreter-overlay]').hasAttribute('popover'));
  await host.evaluate(() => display.clear(identity)); await page.locator('[data-interpreter-overlay]').waitFor({state:'detached'});
  await host.evaluate(() => sendPair('late after Stop',3)); assert.equal(await page.locator('[data-interpreter-overlay]').count(),0);
  observations.checks.push('Container and video-only fullscreen keep the overlay in the top layer; Stop removes it and blocks late results');
  await host.evaluate(() => {identity={...identity,sessionId:'restart'};source={...source,identity,sourceRevision:1};display.activate(target,identity);sendPending()});
  await cue.waitFor();
  await page.evaluate(() => ja.remove()); await page.locator('[data-interpreter-overlay]').waitFor({state:'detached'});
  await host.waitForFunction(() => failures.length===1); assert.match(await host.evaluate(() => failures[0]),/context-destroyed/);
  assert.equal(await page.locator('[data-interpreter-overlay]').count(),0); assert.equal(await page.locator('#en').count(),1);
  observations.checks.push('Restart and selected element invalidation remove resources, fail visibly, and never switch to the other video');
  // Shipping whole-tab presentation also covers a cross-origin video iframe.
  const tabPage=await context.newPage();tabPage.on('pageerror',error=>observations.pageErrors.push(error.message));
  await tabPage.goto(`${origin}/?tab-fullscreen`);
  const captionTabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,tabPage.url());
  const tabCue=tabPage.locator('[data-interpreter-overlay] .interpreter-live span').first();
  await worker.evaluate(async tabId => {
    await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},files:['tab-content.js']});
    globalThis.tabFailures=[];globalThis.tabAcks=[];globalThis.tabSequence=0;
    globalThis.tabPort=chrome.tabs.connect(tabId,{name:'interpreter-tab-overlay-v1',frameId:0});
    tabPort.onDisconnect.addListener(()=>tabFailures.push('disconnected'));
    tabPort.onMessage.addListener(message=>tabAcks.push(message.sequence));
    globalThis.tabIdentity={sessionId:'tab-fullscreen',targetId:'tab-fullscreen',epoch:0};
    globalThis.sendTab=(id,text,revision=1)=>tabPort.postMessage({version:1,sequence:tabSequence++,type:'caption',caption:{source:{identity:tabIdentity,utteranceId:id,sourceRevision:revision,
      language:'en',text:'Synthetic fullscreen source',final:false,audioRange:{startMs:id==='one'?0:1000,endMs:id==='one'?1000:2000}},
      translation:{state:'paired',revision:{identity:tabIdentity,utteranceId:id,sourceRevision:revision,translationRevision:revision,
        languages:{source:'en',target:'ko'},text,final:false}}}});
    tabPort.postMessage({version:1,sequence:tabSequence++,type:'activate',identity:tabIdentity,
      target:{id:tabIdentity.targetId,documentId:'fixture',frameId:'tab',scope:'tab-mix',tabId}});
    sendTab('one','전체화면 첫 자막');sendTab('two','전체화면 다음 자막');
  },captionTabId);
  await tabPage.waitForFunction(() => document.querySelector('[data-interpreter-overlay]')?.shadowRoot.querySelectorAll('.interpreter-live').length===2);
  await tabPage.evaluate(origin => {
    const button=document.createElement('button');button.textContent='Fullscreen tab video';button.onclick=()=>en.requestFullscreen();document.body.append(button);
    const frame=document.createElement('iframe');frame.id='embedded-frame';frame.allowFullscreen=true;
    frame.src=`${origin.replace('127.0.0.1','localhost')}/embedded`;document.body.append(frame);
  },origin);
  await tabPage.getByRole('button',{name:'Fullscreen tab video',exact:true}).click();
  await tabPage.waitForFunction(() => document.fullscreenElement===en && document.querySelector('[data-interpreter-overlay]').matches(':popover-open'));
  await worker.evaluate(() => sendTab('two','전체화면에서도 교정된 자막',2));
  await tabPage.waitForFunction(() => document.querySelector('[data-interpreter-overlay]').shadowRoot.textContent.includes('전체화면에서도 교정된 자막'));
  await tabPage.screenshot({path:'.ralph/media-framework/tab-video-fullscreen.png'});
  const fullGeometry=await tabCue.evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}});
  assert.ok(fullGeometry.left>=0 && fullGeometry.right<=fullGeometry.width && fullGeometry.top>=0 && fullGeometry.bottom<=fullGeometry.height-48);
  assert.equal(await tabPage.evaluate(() => document.elementFromPoint(innerWidth/2,innerHeight/2)===en),true);
  await tabPage.evaluate(() => document.exitFullscreen());
  await tabPage.waitForFunction(() => !document.fullscreenElement && !document.querySelector('[data-interpreter-overlay]').hasAttribute('popover'));
  await tabPage.frameLocator('#embedded-frame').getByRole('button',{name:'Fullscreen embedded video',exact:true}).click();
  await tabPage.waitForFunction(() => document.fullscreenElement?.id==='embedded-frame' && document.querySelector('[data-interpreter-overlay]').matches(':popover-open'));
  await worker.evaluate(() => sendTab('two','임베드 영상 전체화면 자막',3));
  await tabPage.waitForFunction(() => document.querySelector('[data-interpreter-overlay]').shadowRoot.textContent.includes('임베드 영상 전체화면 자막'));
  await tabPage.screenshot({path:'.ralph/media-framework/tab-iframe-fullscreen.png'});
  await worker.evaluate(() => tabPort.postMessage({version:1,sequence:tabSequence++,type:'caption',caption:{
    source:{identity:tabIdentity,utteranceId:'one',sourceRevision:2,language:'en',text:'',final:true,retracted:true,audioRange:{startMs:0,endMs:1000}},translation:{state:'pending'}}}));
  await tabPage.waitForFunction(() => {
    const rows=document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelectorAll('.interpreter-live');
    return rows.length===1 && rows[0].dataset.utteranceId==='two';
  });
  assert.deepEqual(await worker.evaluate(() => tabFailures),[], 'A withdrawal must cross the shipping port without disconnecting');
  await worker.evaluate(() => tabPort.postMessage({version:1,sequence:tabSequence++,type:'clear',identity:tabIdentity}));
  await tabPage.locator('[data-interpreter-overlay]').waitFor({state:'detached'});
  assert.equal(await tabPage.locator(':popover-open').count(),0,'Stop must remove the fullscreen top layer');
  await worker.evaluate(() => sendTab('two','late after fullscreen Stop',4));
  const ackDeadline=performance.now()+5000;
  while(!await worker.evaluate(() => tabAcks.at(-1)===tabSequence-1)) {
    assert.ok(performance.now()<ackDeadline,'Late caption must be acknowledged after fullscreen Stop');
    await new Promise(done=>setTimeout(done,20));
  }
  assert.equal(await tabPage.locator('[data-interpreter-overlay]').count(),0);
  assert.deepEqual(await worker.evaluate(() => tabFailures),[]);
  await tabPage.evaluate(() => document.exitFullscreen());await tabPage.waitForFunction(() => !document.fullscreenElement);
  await tabPage.close();
  observations.checks.push('Shipping whole-tab port preserves stacked captions and corrections over video and cross-origin iframe fullscreen, restores inline output, passes pointer input, and removes the top layer on Stop');
  // Production history UI, with synthetic background snapshots/events only.
  const historyPage=await context.newPage();historyPage.on('pageerror',error=>observations.pageErrors.push(error.message));
  await historyPage.addInitScript(() => {
    const identity={sessionId:'history-withdrawal',targetId:'tab',epoch:0};
    const caption=id=>({source:{identity,utteranceId:id,sourceRevision:1,text:`original ${id}`,language:'ja',final:id==='final',audioRange:{startMs:0,endMs:1000}},translation:{state:'pending'}});
    globalThis.historySnapshot={message:'Synthetic history',captions:[caption('draft'),caption('final')]};
    chrome.runtime.sendMessage=async()=>({snapshot:historySnapshot});
    chrome.runtime.onMessage.addListener=listener=>{globalThis.historyChanged=listener;};
  });
  await historyPage.goto(`chrome-extension://${extensionId}/tab-host.html`);
  await historyPage.locator('tr[data-utterance-id="draft"]').waitFor();
  await historyPage.evaluate(() => {
    const draft=historySnapshot.captions.shift();
    historyChanged({channel:'interpreter-event-v1',type:'caption',caption:{source:{...draft.source,sourceRevision:2,text:'',final:true,retracted:true},translation:{state:'pending'}}},{id:chrome.runtime.id});
  });
  await historyPage.locator('tr[data-utterance-id="draft"]').waitFor({state:'detached'});
  assert.equal(await historyPage.locator('tr[data-utterance-id="final"]').count(),1, 'Withdrawals must preserve confirmed history');
  await historyPage.close();
  observations.checks.push('A withdrawal crosses the shipping fullscreen port and removes its row; the production history window removes withdrawn drafts while preserving confirmed entries');
  // The reference document is an actual browser DOM; these captions are synthetic.
  const liveTiming = await host.evaluate(async () => {
    const {createVideoOverlay}=await import('./overlay.js');
    const live=createVideoOverlay(document,null,identity);
    const caption=(id,start,text,revision=1)=>({source:{...source,utteranceId:id,sourceRevision:revision,final:true,audioRange:{startMs:start,endMs:start+1000}},
      translation:{state:'paired',revision:{identity,utteranceId:id,sourceRevision:revision,translationRevision:revision,languages:{source:'ja',target:'ko'},text,final:true}}});
    const read=()=>document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live span')?.textContent??'';
    live.compare(caption('old',0,'이전 문장'));await new Promise(done=>setTimeout(done,30));
    if(read()!=='이전 문장')throw Error('Initial whole-tab caption is missing');
    const started=performance.now();live.compare(caption('latest',1000,'최신 문장'));
    if(read()!=='이전 문장')throw Error('New translation discarded an unread sentence');
    const stacked=Array.from(document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelectorAll('.interpreter-live span:not(.interpreter-measure)')).map(span=>span.textContent);
    if(stacked.join('|')!=='이전 문장|최신 문장')throw Error('Ready translation must immediately stack below the previous caption');
    const deadline=started+5000;while(read()!=='최신 문장'&&performance.now()<deadline)await new Promise(done=>setTimeout(done,10));
    const delayMs=performance.now()-started;
    if(read()!=='최신 문장')throw Error('Queued translation never became visible');
    live.compare(caption('old',0,'이전 문장의 늦은 수정',2));await new Promise(done=>setTimeout(done,220));
    if(read()!=='최신 문장')throw Error('An older correction displaced the live caption');
    live.clear();if(read()!=='')throw Error('Stop must clear the current whole-tab caption');
    live.dispose();return {delayMs};
  });
  observations.liveTiming=liveTiming;
  observations.checks.push('Whole-tab captions stack ready translations immediately, preserve each reading time, retire in order, and clear on Stop');
  assert.deepEqual(observations.pageErrors,[]);
  console.log(JSON.stringify({passed:true,...observations}));
} catch(error) { console.error(JSON.stringify({passed:false,...observations,error:error.stack}));process.exitCode=1; }
finally {await context?.close();await rm(profile,{recursive:true,force:true});await new Promise(done=>server.close(done));}
