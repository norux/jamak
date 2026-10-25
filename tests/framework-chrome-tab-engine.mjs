import {createReadStream} from "node:fs";
// Production popup → offscreen capture/real local speech/native Korean → page and reference.
// Synthetic fixtures; --latency checks six isolated sentences, not public videos or ten minutes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

const voxlingua = process.argv.includes("--voxlingua");
const autoLanguage = process.argv.includes("--auto-language");
if (voxlingua && !autoLanguage) throw new Error("--voxlingua requires --auto-language");
const japaneseConversation = process.argv.includes("--japanese-conversation");
const hyMt2 = process.argv.includes("--hy-mt2");
const conversation = process.argv.includes("--conversation") || japaneseConversation;
const captureLoss = process.argv.includes("--capture-loss");
const lifecycle = process.argv.includes("--lifecycle");
const latency = process.argv.includes("--latency");
const download = process.argv.includes("--download");
const installedChrome = process.argv.includes("--installed-chrome");
const userSpeechComponents = process.argv.includes("--user-speech-components");
const koreanCaptionLanguage = process.argv.includes("--korean-caption-language");
const localSpeech = !autoLanguage && !process.argv.includes("--whisper");
const modelDirectory = process.env.INTERPRETER_TEST_MODEL_DIRECTORY;
const modelFiles = [
  ["encoder_model_fp16.onnx", "interpreter-turbo-encoder-verified.onnx", 1274342603, "fdadc70836e6b028fd5e580417c312208dad073d2d01e509e2d127c1373399d8"],
  ["decoder_model_merged_fp16.onnx", "interpreter-turbo-decoder.onnx", 344227339, "fdf10afca73a0c7bf87286cfb96cf7028a9edbc9bb02512509a526f95b126c9d"],
];
if (modelDirectory) for (const [, filename, bytes, sha256] of modelFiles) {
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(resolve(modelDirectory, filename))) { hash.update(chunk); size += chunk.length; }
  assert.equal(size, bytes); assert.equal(hash.digest("hex"), sha256);
}
const output = resolve(`.ralph/media-framework/chrome-tab-engine-build${installedChrome ? "-installed" : download ? "-download" : latency ? "-latency" : !localSpeech ? "-whisper" : captureLoss ? "-loss" : ""}`);
const fixtures = JSON.parse(await readFile("tests/fixtures/video-speech/manifest.json", "utf8")).clips;
const media = new Map();
const meeting = autoLanguage ? JSON.parse(await readFile("tests/fixtures/multilingual/manifest.json", "utf8")) : undefined;
if (autoLanguage) {
  const bytes = await readFile("tests/fixtures/multilingual/meeting.wav");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), meeting.sha256);
  media.set("/meeting.wav", bytes);
}
const conversationDirectory = `tests/fixtures/conversation${japaneseConversation ? "/ja" : ""}`;
const conversationManifest = conversation ? JSON.parse(await readFile(`${conversationDirectory}/manifest.json`, "utf8")) : undefined;
if (conversation) media.set("/conversation.wav", await readFile(`${conversationDirectory}/conversation.wav`));
let latencyDirectory;
const latencyTexts = {
  ja: ["今日は会議をしません。", "明日の午後三時に駅で会いましょう。", "予約は取り消さないでください。"],
  en: ["We will not meet today.", "Let's meet at the station tomorrow at three in the afternoon.", "Please do not cancel the reservation."],
};
if (latency) {
  assert.equal(process.platform,"darwin","Latency fixture generation uses already installed macOS voices");
  latencyDirectory=await mkdtemp(resolve('.ralph/media-framework/local-speech-latency-'));
  for(const language of ['ja','en'])for(const[index,text]of latencyTexts[language].entries()) {
    const file=resolve(latencyDirectory,`${language}-${index}.wav`);
    execFileSync('/usr/bin/say',['-v',language==='ja'?'Kyoko':'Samantha','-r','180','--file-format=WAVE','--data-format=LEI16@48000','-o',file,text]);
    media.set(`/latency-${language}-${index}.wav`,await readFile(file));
  }
}
for (const fixture of fixtures) {
  const bytes = await readFile(`tests/fixtures/video-speech/${fixture.language}.webm`);
  assert.equal(bytes.length, fixture.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
  media.set(`/${fixture.language}.webm`, bytes);
}
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: { outDir: output } });
const manifest = JSON.parse(await readFile(`${output}/manifest.json`, "utf8"));
assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "tabCapture", "offscreen", "notifications"]);
assert.deepEqual(manifest.host_permissions, ["https://paddle-model-ecology.bj.bcebos.com/*"]);
assert.equal(manifest.action.default_popup, "popup.html");
const observations = { scope: latency ? "Six isolated synthetic sentences: estimated last audible PCM sample to complete Korean meaning in actual page DOM, <=1000 ms; no public-video/ten-minute acceptance"
  : "Production popup/offscreen ownership, real local streaming or turbo WebGPU/native Korean/page/reference lifetime and source retirement; no strict sentence-end latency/public-video/ten-minute acceptance",
  playbackGain: 0.005, pageErrors: [], checks: [], runs: [], qualityFailures: [], companionEndpoints: [], speechMode: localSpeech ? "Production preference: Japanese / English Chrome on-device streaming" : "Whisper snapshots", modelProvisioning: modelDirectory ? "Two SHA-256 verified official ONNX files seeded into extension cache; actual remaining model downloads and real inference" : "Official pinned model downloads and browser-managed SODA components", translatorProvisioning: hyMt2 ? "Advanced-selected pinned Hy-MT2 q4f16 WebGPU; actual downloads and streaming inference" : "Chrome-managed TranslateKit and ja/en/ko language components; no substituted translations" };
function serve(request, response) {
  const url = new URL(request.url, "http://localhost");
  const model = modelDirectory && modelFiles.find(([, filename]) => url.pathname === `/${filename}`);
  if (model) {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Access-Control-Allow-Origin": "*", "Content-Length": model[2] });
    createReadStream(resolve(modelDirectory, model[1])).pipe(response); return;
  }
  const bytes = media.get(url.pathname);
  if (bytes) {
    response.setHeader("Content-Type", url.pathname.endsWith(".wav") ? "audio/wav" : "video/webm"); response.setHeader("Accept-Ranges", "bytes");
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (start > end) { response.writeHead(416); response.end(); return; }
    if (range) { response.statusCode = 206; response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`); }
    response.setHeader("Content-Length", end - start + 1); response.end(bytes.subarray(start, end + 1)); return;
  }
  response.setHeader("Content-Type", "text/html");
  const language = url.searchParams.get("language") === "en" ? "en" : "ja";
  const mode = url.searchParams.get("mode") ?? "video";
  if (mode === "iframe") {
    response.end(`<!doctype html><title>Cross-origin tab speech</title><iframe src="http://localhost:${server.address().port}/?mode=video&language=${language}"></iframe>`); return;
  }
  response.end(`<!doctype html><meta charset="utf-8"><title>Tab speech fixture</title>
    ${mode === "web-audio" ? "" : `<${mode === "audio" ? "audio" : "video"} id="media" src="/${autoLanguage ? "meeting.wav" : conversation ? "conversation.wav" : `${language}.webm`}" controls preload="auto" ${conversation || autoLanguage ? "" : "loop"}></${mode === "audio" ? "audio" : "video"}>`}
    <button id="play">Play speech</button><script>
    play.onclick=async()=>{
      ${mode === "web-audio" ? `
      if(!globalThis.audio){globalThis.audio=new AudioContext();}await audio.resume();
      globalThis.buffer=await audio.decodeAudioData(await (await fetch(${latency} ? '/latency-${language}-'+(globalThis.latencyClip??0)+'.wav' : '/${language}.webm')).arrayBuffer());
      if(globalThis.speech)try{speech.stop()}catch{}globalThis.speech=audio.createBufferSource();speech.buffer=buffer;speech.loop=${!latency};speech.connect(audio.destination);
      if(${latency}){const samples=buffer.getChannelData(0);let last=samples.length-1;while(last>0&&Math.abs(samples[last])<0.00001)last--;const when=audio.currentTime+0.08;
        globalThis.spokenEndMs=performance.now()+80+(last+1)/buffer.sampleRate*1000;globalThis.speechSamplesEndMs=(last+1)/buffer.sampleRate*1000;speech.start(when);
      }else speech.start();`
      : "media.currentTime=0;await media.play();"}
    };
    </script>`);
}
const server = createServer(serve);
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
if (modelDirectory) manifest.content_security_policy.extension_pages += ` ${origin}`;
await writeFile(`${output}/manifest.json`,JSON.stringify(manifest));
let browserProcess; let browserExit; let browser; let profile;
try {
  for (const port of [8765, 11434]) {
    const result = await new Promise(done => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); done("listening"); });
      socket.once("error", error => done(error.code));
      socket.setTimeout(1000, () => { socket.destroy(); done("timeout"); });
    });
    observations.companionEndpoints.push({ port, result });
    assert.equal(result, "ECONNREFUSED", "Companion/Ollama must be absent; never stop user apps");
  }
  profile = voxlingua ? resolve(".ralph/media-framework/voxlingua-conversation-profile") : hyMt2 ? resolve(".ralph/media-framework/hy-mt2-conversation-profile") : await mkdtemp(resolve(".ralph/media-framework/chrome-tab-engine-profile-"));
  await mkdir(profile, { recursive: true });
  // Existing explicitly prepared CfT native components, in this disposable test
  // profile only. Chrome downloads/verifies them; no Translator results are injected.
  const components = ["Chrome TranslateKit", "Chrome TranslateKit en-ja", "Chrome TranslateKit en-ko", ...(localSpeech ? download ? ["SODA*"] : ["SODA Library", "SODA ja-JP Models", "SODA en-US Models", "SODA ko-KR Models"] : [])];
  await writeFile(resolve(profile, "Local State"), JSON.stringify({ ...(localSpeech && !download ? {accessibility:{captions:{soda_registered_language_packs:["ja-JP","en-US","ko-KR"]}}} : {}), on_device_translation: {
    translate_kit_registered: true, translate_kit_packages: { en_ja_registered: true, en_ko_registered: true },
  } }));
  const configuration = resolve(profile, "cft-config.json");
  let componentsDirectory=resolve(".ralph/media-framework/chrome-translation-components");
  if(download){
    const translationDirectory=resolve(componentsDirectory,"TranslateKit");
    componentsDirectory=resolve(profile,"components");
    await cp(translationDirectory,resolve(componentsDirectory,"TranslateKit"),{recursive:true});
  }
  await writeFile(configuration, JSON.stringify({ requiredComponents: components,
    requiredComponentsDir: componentsDirectory, requiredComponentsUpdateTimeout: "120s" }));
  observations.requiredComponents = installedChrome ? [] : components;
  if(installedChrome){
    assert.equal(process.platform,'darwin');assert.equal(download,false);
    for(const name of ['TranslateKit','SODA','SODALanguagePacks']) await cp(resolve(componentsDirectory,name),resolve(profile,name),{recursive:true});
    observations.seededComponents=['TranslateKit','SODA','SODALanguagePacks'];
    observations.modelProvisioning='Official browser-native components staged in a fresh standard Chrome profile; actual recognition and translation';
  }
  if(userSpeechComponents) {
    assert.equal(installedChrome,true);
    const userRoot=resolve(process.env.HOME,'Library/Application Support/Google/Chrome');
    for(const name of ['SODA','SODALanguagePacks']) {
      await rm(resolve(profile,name),{recursive:true,force:true});
      await cp(resolve(userRoot,name),resolve(profile,name),{recursive:true});
    }
    const state=JSON.parse(await readFile(resolve(profile,'Local State'),'utf8'));
    const captions=JSON.parse(await readFile(resolve(userRoot,'Local State'),'utf8')).accessibility.captions;
    state.accessibility.captions={soda_registered_language_packs:captions.soda_registered_language_packs};
    for(const key of ['soda_binary_path','soda_ja_jp_config_path','soda_en_us_config_path','soda_ko_kr_config_path']) {
      if(!captions[key] && key==='soda_ko_kr_config_path')continue;
      assert.ok(captions[key].startsWith(`${userRoot}/`));
      state.accessibility.captions[key]=resolve(profile,captions[key].slice(userRoot.length+1));
    }
    await writeFile(resolve(profile,'Local State'),JSON.stringify(state));
    observations.modelProvisioning='Existing official user speech components and remapped model-path preferences in a disposable profile; no personal profile data or settings changes';
  }
  if(koreanCaptionLanguage) {
    await mkdir(resolve(profile,'Default'),{recursive:true});
    await writeFile(resolve(profile,'Default','Preferences'),JSON.stringify({accessibility:{captions:{live_caption_language:'ko-KR'}},intl:{accept_languages:'ko-KR,ko,en-US,en'}}));
    observations.captionLanguage='ko-KR';
  }
  await rm(resolve(profile, "DevToolsActivePort"), { force: true });
  browserProcess = spawn(installedChrome ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath(), ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
    ...installedChrome ? [] : [`--chrome-for-testing-config=${configuration}`], "--enable-unsafe-extension-debugging", "--remote-debugging-port=0",
    "--window-position=0,30", "--window-size=700,700",
    ...(captureLoss ? ['--auto-select-tab-capture-source-by-title=Output under test', '--enable-usermedia-screen-capturing'] : []), "about:blank"], { stdio: "ignore" });
  browserExit = new Promise(done => {
    browserProcess.once("exit", (code, signal) => { observations.browserExit = { code, signal }; done(); });
    browserProcess.once("error", error => { observations.browserExit = { error: error.message }; done(); });
  });
  const deadline = performance.now() + 120000;
  let port;
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
  const cdp = await browser.newBrowserCDPSession();
  const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: output });
  const matches = worker => new URL(worker.url()).host === extensionId;
  const worker = context.serviceWorkers().find(matches) ?? await context.waitForEvent("serviceworker", { predicate: matches, timeout: 15000 });

  async function state() {
    return worker.evaluate(async () => (await chrome.runtime.sendMessage({channel:'interpreter-background-v1',command:{type:'snapshot'}}))?.snapshot);
  }
  async function waitState(predicate, timeout=120000, allowFailure=false) {
    const deadline=performance.now()+timeout;
    while(performance.now()<deadline) {
      const value=await state();
      if(value?.state==='failed'&&!allowFailure) throw Error(JSON.stringify(value));
      if(predicate(value)) return value;
      await new Promise(done=>setTimeout(done,100));
    }
    throw Error(`State timeout ${JSON.stringify(await state())}`);
  }

  async function attach(targetId) {
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:false});
    let next=0;const pending=new Map();
    cdp.on('Target.receivedMessageFromTarget',event=>{
      if(event.sessionId!==sessionId)return;
      const message=JSON.parse(event.message);if(!message.id)return;
      const operation=pending.get(message.id);pending.delete(message.id);
      if(message.error)operation.reject(Error(message.error.message));else operation.resolve(message.result);
    });
    async function send(method,params={}) {
      const id=++next;const result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
      await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})});return result;
    }
    async function evaluate(expression) {
      const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;
    }
    return {send,evaluate,close:()=>cdp.send('Target.closeTarget',{targetId}),async click(selector) {
      const rect=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el.disabled)throw Error('Disabled '+el.textContent);const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});
    }};
  }
  async function openPopup() {
    await page.bringToFront();
    const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});
    const target=targetInfos.find(value=>value.url===page.url());assert.ok(target);
    await cdp.send('Extensions.triggerAction',{id:extensionId,targetId:target.targetId});
    const deadline=performance.now()+10000;
    while(performance.now()<deadline) {
      const targets=(await cdp.send('Target.getTargets')).targetInfos;
      const popup=targets.find(value=>value.url===`chrome-extension://${extensionId}/popup.html`);
      if(popup) {
        const surface=await attach(popup.targetId);
        while(!await surface.evaluate(`document.querySelector('#status')?.textContent && document.querySelector('#status').textContent!=='연결 중…'`)) await new Promise(done=>setTimeout(done,100));
        return surface;
      }
      await new Promise(done=>setTimeout(done,100));
    }
    throw Error('No action popup');
  }

  const scenarios = autoLanguage ? [{language:"auto",mode:"audio"}] : conversation ? [{language:japaneseConversation ? "ja" : "en",mode:"audio"}] : latency ? [{language:'ja',mode:'web-audio'},{language:'en',mode:'web-audio'}] : captureLoss || lifecycle || download ? [{language:download ? 'en' : 'ja',mode:'web-audio'}] : [
    {language:'ja',mode:'video'}, {language:'en',mode:'iframe'}, {language:'en',mode:'audio'}, {language:'ja',mode:'web-audio'},
  ];
  let runtime;
  for (const scenario of scenarios) {
    const nativeSpeech = localSpeech;
    await page.goto(`${origin}/?language=${scenario.language}&mode=${scenario.mode}`);
    const source=scenario.mode==='iframe'?page.frameLocator('iframe'):page;
    let popup=await openPopup();
    if (!autoLanguage) await popup.evaluate(`document.querySelector('#language').value=${JSON.stringify(scenario.language)};document.querySelector('#language').dispatchEvent(new Event('change'))`);
    if (!runtime) {
      const targets=(await cdp.send('Target.getTargets')).targetInfos;
      const target=targets.find(value=>value.url===`chrome-extension://${extensionId}/offscreen.html`);assert.ok(target);
      runtime=await attach(target.targetId);
      if (process.env.INTERPRETER_TEST_SCREENSHOT) {
        const shot=await popup.send('Page.captureScreenshot');
        await writeFile(process.env.INTERPRETER_TEST_SCREENSHOT,Buffer.from(shot.data,'base64'));
      }
      assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:[chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]}))).length,1);
      assert.equal(await runtime.evaluate("typeof Translator"),'function');
      await runtime.evaluate(`(()=>{
        globalThis.jamakTestPlaybackGain=0.005;
        const connect=AudioNode.prototype.connect;
        AudioNode.prototype.connect=function(destination,...args){
          if(this instanceof MediaStreamAudioSourceNode && destination instanceof AudioDestinationNode){
            const gain=this.context.createGain();gain.gain.value=jamakTestPlaybackGain;
            connect.call(this,gain);connect.call(gain,destination);return destination;
          }
          return connect.call(this,destination,...args);
        };
        globalThis.runtimeObservations=[];globalThis.translationCalls=[];globalThis.localSpeechEvents=[];globalThis.captionRevisions=[];
        const sendMessage=chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage=function(message,...args){
          if(message.channel==='interpreter-event-v1'&&message.type==='caption')captionRevisions.push({atMs:performance.timeOrigin+performance.now(),source:message.caption.source,translation:message.caption.translation});
          return sendMessage(message,...args);
        };
        const Speech=globalThis.SpeechRecognition??globalThis.webkitSpeechRecognition;
        if(${localSpeech}&&Speech){
          const install=Speech.install;Speech.install=function(options){localSpeechEvents.push({type:'install',local:options.processLocally});return install.call(this,options)};
          const start=Speech.prototype.start;const abort=Speech.prototype.abort;
          Speech.prototype.start=function(track){localSpeechEvents.push({type:'start',local:this.processLocally,trackKind:track?.kind,trackState:track?.readyState});
            this.addEventListener('result',event=>{localSpeechEvents.push({type:'result',at:performance.now(),resultIndex:event.resultIndex,finals:Array.from(event.results,r=>r.isFinal),texts:Array.from(event.results,r=>r[0].transcript)});if(localSpeechEvents.length>300)localSpeechEvents.splice(1,1)});
            return start.call(this,track)};Speech.prototype.abort=function(){localSpeechEvents.push({type:'abort'});return abort.call(this)};
        }else if(Speech){Object.defineProperty(Speech,'install',{value:undefined,configurable:true});}
        const NativeWorker=Worker;let next=0;
        globalThis.Worker=class extends NativeWorker{
          constructor(...args){super(...args);this.observedId=++next;let state;
            this.addEventListener('message',({data})=>{
              if(data.type==='status'){if(state===data.status.state)return;state=data.status.state;}
              if(data.type==='result'&&typeof data.text!=='string'&&typeof data.language!=='string')return;
              runtimeObservations.push({worker:this.observedId,at:performance.now(),...data});
              if(runtimeObservations.length>300)runtimeObservations.shift();
            });}
          postMessage(message,...args){
            if(message.type==='recognize')runtimeObservations.push({type:'asr-job',worker:this.observedId,requestId:message.requestId,
              identity:message.job.identity,utteranceId:message.job.utteranceId,language:message.job.language,audioRange:message.job.audioRange,samples:message.job.pcm.length,
              inputRms:Math.sqrt(message.job.pcm.reduce((sum,sample)=>sum+sample*sample,0)/message.job.pcm.length),
              inputPeak:message.job.pcm.reduce((peak,sample)=>Math.max(peak,Math.abs(sample)),0)});
            return super.postMessage(message,...args);}
          terminate(){runtimeObservations.push({type:'terminated',worker:this.observedId});return super.terminate();}
        };
        const create=Translator.create.bind(Translator);
        Translator.create=async(...args)=>{const translator=await create(...args);const translate=translator.translate.bind(translator);
          translator.translate=async(text,...options)=>{const call={source:text};translationCalls.push(call);
            const result=await translate(text,...options);call.korean=result;return result;};
          if(translator.translateStreaming){const streaming=translator.translateStreaming.bind(translator);
            translator.translateStreaming=(text,...options)=>{const call={source:text,korean:'',chunks:0};translationCalls.push(call);
              return streaming(text,...options).pipeThrough(new TransformStream({transform(chunk,controller){call.korean+=chunk;call.chunks++;controller.enqueue(chunk);}}));};}
          return translator;};
      })()`);
      if (modelDirectory) await worker.evaluate(async ({origin,files}) => {
        const version='360ebcde2559d60bb474678be3c1de9ef347d01a';
        const cache=await caches.open(`interpreter-asr-${version}-fp16`);
        for (const [name,filename,bytes] of files) {
          const response=await fetch(`${origin}/${filename}`);assertResponse(response);
          await cache.put(`https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/${version}/onnx/${name}`,
            new Response(response.body,{headers:{'Content-Length':String(bytes)}}));
        }
        function assertResponse(response) {if(!response.ok||!response.body)throw Error('Verified test model unavailable');}
      },{origin,files:modelFiles});
    }
    if (scenario.language==='en') {
      await waitState(value=>['idle','ready'].includes(value?.state));
      await popup.evaluate("document.querySelector('#language').value='en';document.querySelector('#language').dispatchEvent(new Event('change'))");
    }
    if (localSpeech && !download && scenario === scenarios[0]) {
      console.log(JSON.stringify({phase:'initial-model-availability',state:await state(),availability:await popup.evaluate("Promise.all([Translator.availability({sourceLanguage:'ja',targetLanguage:'ko'}),(globalThis.SpeechRecognition??globalThis.webkitSpeechRecognition).available({langs:['ja-JP','en-US','ko-KR'],processLocally:true})])")}));
      if ((await state()).state === 'idle') await popup.click('#prepare');
      await waitState(value=>value?.state==='ready',600000);
      // Recreate after attaching observation hooks to the persistent runtime.
      await popup.click('#stop');await waitState(value=>value?.state==='ready');
    }
    if (autoLanguage) {
      while (await popup.evaluate("document.querySelector('#auto-detect').disabled")) await new Promise(done=>setTimeout(done,100));
      await popup.click("#auto-detect");
    }
    if(!localSpeech) await popup.evaluate('(globalThis.SpeechRecognition??globalThis.webkitSpeechRecognition).install=undefined');
    if(download){
      const before=await popup.evaluate(`(globalThis.SpeechRecognition??globalThis.webkitSpeechRecognition).available({langs:[${JSON.stringify(scenario.language==='ja'?'ja-JP':'en-US')}],processLocally:true})`);
      assert.equal(before,'downloadable','Fresh profile must not already have the local speech language pack');
      observations.checks.push(`Fresh ${scenario.language} voice pack before Prepare: ${before}`);
    }
    if (download || !localSpeech) {
      const preparingDeadline = performance.now() + 30000;
      for (;;) {
        const current = await state();
        if (current?.source === scenario.language && ['preparing','ready'].includes(current.state)) break;
        if (await popup.evaluate("!document.querySelector('#prepare').hidden && !document.querySelector('#prepare').disabled")) { await popup.click('#prepare'); break; }
        if (performance.now() > preparingDeadline) throw new Error("Selected language preparation did not start");
        await new Promise(done=>setTimeout(done,100));
      }
      await waitState(value=>value?.source===scenario.language && (value.state==='preparing' || value.state==='ready'));
    } else {
      await waitState(value=>value?.state==='ready' && value.source===scenario.language);
      assert.equal(await popup.evaluate("document.querySelector('#prepare').hidden"),true);
      observations.checks.push(`Cached ${scenario.language} speech and translator automatically ready without Prepare`);
    }
    if(nativeSpeech){
      const deadline=performance.now()+10000;let availability;
      while(performance.now()<deadline){
        availability=await popup.evaluate(`(globalThis.SpeechRecognition??globalThis.webkitSpeechRecognition).available({langs:[${JSON.stringify(scenario.language==='ja'?'ja-JP':'en-US')}],processLocally:true})`);
        if(availability==='available'||availability==='downloading')break;
        await new Promise(done=>setTimeout(done,20));
      }
      assert.ok(['available','downloading'].includes(availability),'Native speech installation must begin before closing the popup');
      if(download)assert.equal(availability,'downloading','Download lifecycle check requires an unfinished real language-pack download');
      observations.checks.push(`Popup closed with ${scenario.language} voice pack ${availability}; preparation continues after tab switch`);
      if(download)console.log(JSON.stringify({phase:'speech-download-handoff',availability}));
    }
    await popup.close();
    const switched=await context.newPage();await switched.goto('about:blank');await switched.bringToFront();
    const ready=await waitState(value=>value?.state==='ready',600000);
    if(installedChrome) {
      const captions=JSON.parse(await readFile(resolve(profile,'Local State'),'utf8')).accessibility.captions;
      console.log(JSON.stringify({phase:'prepared-speech-components',paths:Object.fromEntries(['soda_binary_path','soda_ja_jp_config_path','soda_en_us_config_path','soda_ko_kr_config_path'].map(key=>[key,captions[key]?.replace(profile,'<test-profile>')]))}));
    }
    assert.equal((await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:[chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]}))).length,1);
    await switched.close();
    console.log(JSON.stringify({phase:'hidden-ready',...scenario,message:ready.message,diagnostic:ready.diagnostic}));

    if (hyMt2 && scenario === scenarios[0]) {
      popup = await openPopup();
      const opened = context.waitForEvent("page", { predicate: p => p.url().includes("advanced.html") });
      await popup.click("#advanced");
      const advanced = await opened; await advanced.waitForLoadState();
      await advanced.locator("#translation").selectOption("hyMt2");
      const selected = await waitState(value => value?.state === "ready" && value.options?.translation === "hyMt2", 600000);
      assert.ok(selected.models.some(model => model.name.includes("Hy-MT2")));
      await advanced.screenshot({ path: resolve(".ralph/media-framework/advanced-hy-mt2-real.png") });
      await advanced.close();
      observations.checks.push("Actual Advanced selection, pinned Hy-MT2 download/preparation and independent Chrome recognition");
    }

    if (voxlingua && scenario === scenarios[0]) {
      popup = await openPopup();
      const opened = context.waitForEvent("page", { predicate: p => p.url().includes("advanced.html") });
      await popup.click("#advanced");
      const advanced = await opened; await advanced.waitForLoadState();
      if (await advanced.locator("#language-detection").inputValue() !== "voxlingua") await advanced.locator("#language-detection").selectOption("voxlingua");
      const selected = await waitState(value => value?.state === "ready" && value.options?.languageDetection === "voxlingua", 600000);
      assert.ok(selected.models.some(model => model.name.includes("VoxLingua107")));
      await advanced.close();
      observations.checks.push("Actual Advanced VoxLingua107 setting, pinned model preparation and language decisions before Whisper");
    }

    popup=await openPopup();await popup.click('#start');
    await waitState(value=>value?.state==='running');await popup.close();
    if (conversation || autoLanguage) await page.evaluate(() => {
      globalThis.captionFrames = [];
      globalThis.mediaEvents = [];
      for (const type of ['playing','ended','seeking']) media.addEventListener(type,()=>mediaEvents.push({type,atMs:performance.now(),currentTime:media.currentTime}));
      const previous = new Map();
      globalThis.captionMonitor = setInterval(() => {
        const cues = document.querySelector('[data-interpreter-overlay]')?.shadowRoot.querySelectorAll('.interpreter-live') ?? [];
        const present = new Set();
        for (const cue of cues) {
          const style = getComputedStyle(cue);
          const id = cue.dataset.utteranceId;
          present.add(id);
          if (style.visibility !== 'visible') {
            if (previous.has(id) && previous.get(id) !== 'hidden') captionFrames.push({atMs:performance.now(),text:'',utteranceId:id,hidden:true});
            previous.set(id,'hidden'); continue;
          }
          const text = cue.querySelector('span')?.textContent ?? '';
          const signature = `${text}|${style.opacity}`;
          if (previous.get(id) !== signature) captionFrames.push({atMs:performance.now(),mediaSeconds:media.currentTime,text,utteranceId:id,speakerId:cue.dataset.speakerId,opacity:style.opacity});
          previous.set(id,signature);
        }
        for (const id of previous.keys()) if (!present.has(id)) {
          captionFrames.push({atMs:performance.now(),text:'',utteranceId:id,removed:true}); previous.delete(id);
        }
      }, 25);
    });
    const playRequestedAt=performance.now();
    await source.getByRole('button',{name:'Play speech',exact:true}).click();
    if (autoLanguage) {
      const anchors = [ [/hello/i, /tomorrow/i, /station/i], [/こんにちは/, /明日/, /駅/],
        [/안녕하세요/, /내일/, /만나겠습니다/], [/please/i, /reservation/i, /thank you/i, /meeting/i],
        [/予約/, /取り消さない/, /会議/, /ありがとうございます/], [/예약/, /취소하지/, /회의/, /감사합니다/] ];
      const turnCaptions = (captions, turn) => captions.filter(caption => caption.source.language === turn.language
        && caption.source.audioRange.startMs >= turn.startSeconds * 1000 - 600 && caption.source.audioRange.startMs < turn.endSeconds * 1000);
      const deadline = performance.now() + 90000;
      while (performance.now() < deadline) {
        const current = await state();
        assert.equal(current.state, "running", current.message);
        if (await page.evaluate(() => media.ended) && meeting.turns.every((turn,index) => {
          const captions = turnCaptions(current.captions, turn);
          const text = captions.map(caption => caption.source.text).join(" ");
          return anchors[index].every(anchor => anchor.test(text)) && captions.every(caption => caption.source.final
            && caption.translation.state === "paired" && caption.translation.revision.final);
        })) break;
        await new Promise(done => setTimeout(done,250));
      }
      const completed = await state();
      const displayDeadline = performance.now() + 60000;
      while (performance.now() < displayDeadline && !await page.evaluate(ids =>
        ids.every(id => captionFrames.some(frame => frame.utteranceId === id && frame.text && frame.opacity !== "0")),
        completed.captions.map(caption => caption.source.utteranceId))) await new Promise(done => setTimeout(done,250));
      const frames = await page.evaluate(() => { clearInterval(captionMonitor); return captionFrames; });
      const result = { state: completed.state, captions: completed.captions, frames,
        workers: await runtime.evaluate("runtimeObservations"), translations: await runtime.evaluate("translationCalls") };
      await mkdir(".ralph/auto-language", {recursive:true});
      await writeFile(`.ralph/auto-language/live${voxlingua ? "-voxlingua" : ""}.json`, JSON.stringify(result,null,2));
      const starts = [/hello/i, /こんにちは/, /안녕하세요/, /please/i, /予約/, /예약/];
      for (const [index, turn] of meeting.turns.entries()) {
        const captions = turnCaptions(completed.captions, turn);
        assert.ok(captions.length, `Missing language turn ${index}: ${turn.language}`);
        const text = captions.map(caption => caption.source.text).join(" ");
        assert.match(text, starts[index], `Lost onset at turn ${index}`);
        for (const anchor of anchors[index]) assert.match(text, anchor, `Missing sentence content at turn ${index}`);
        for (const caption of captions) {
          assert.equal(caption.source.final,true,"Automatic turn drafts must reach final before Stop");
          assert.equal(caption.translation.state,"paired");
          assert.equal(caption.translation.revision.final,true);
          assert.equal(caption.translation.revision.languages.source,caption.source.language);
          assert.equal(caption.translation.revision.sourceRevision,caption.source.sourceRevision);
          assert.match(caption.translation.revision.text,/[가-힣]/);
          if (turn.language === "ko") assert.equal(caption.translation.revision.text,caption.source.text);
        }
      }
      assert.ok(frames.some(frame => frame.text && /[가-힣]/.test(frame.text)), "Actual overlay must render Korean");
      for (const caption of completed.captions) assert.ok(frames.some(frame => frame.utteranceId === caption.source.utteranceId && frame.text && frame.opacity !== "0"),
        `Caption never displayed: ${caption.source.text}`);
      for (const caption of completed.captions.filter(caption => caption.source.language === "ko")) {
        assert.equal(result.translations.some(call => call.source === caption.source.text),false,"Korean must bypass native translation");
      }
      if (voxlingua) {
        const decisions = result.workers.filter(event => event.type === "result" && typeof event.language === "string" && typeof event.text !== "string");
        for (const language of ["en", "ja", "ko"]) assert.ok(decisions.some(decision => decision.language === language), `Missing ${language} audio decision`);
        const jobs = result.workers.filter(event => event.type === "asr-job");
        assert.ok(jobs.length && jobs.every(job => ["en", "ja", "ko"].includes(job.language)), "Independent decisions must direct fixed-language ASR");
      } else assert.ok(result.workers.some(event => event.type === "asr-job" && event.language === "auto"));
      observations.runs.push({...scenario,...result});
      console.log(JSON.stringify({phase:"auto-language",captions:completed.captions.length,report:`.ralph/auto-language/live${voxlingua ? "-voxlingua" : ""}.json`}));
      popup=await openPopup();await popup.click('#stop');await waitState(value=>value?.state==='ready');await popup.close();
      await page.locator('[data-interpreter-overlay]').waitFor({state:'detached'});
      const retained = await state();
      await new Promise(done => setTimeout(done,1000));
      assert.deepEqual((await state()).captions,retained.captions);
      await page.reload();await waitState(value=>value?.state==='idle',10000,true);
      observations.checks.push("Six alternating en/ja/ko turns retain their first words, use per-turn native Korean translation, render the overlay, survive popup closure, and stop on navigation");
      continue;
    }
    if(latency){
      const measurements=[];
      const koreanChecks=[scenario.language==='ja'?['회의','않|안|없']:['오늘','만나|모임|만남','않|안|없'],['내일','오후','3|세|삼','역','만나|뵙|만납'],['예약','취소','않|마|말|안','마|말|주세요|주십시오|않도록']];
      for(let index=0;index<3;index++){
        if(index){await source.evaluate(index=>{globalThis.latencyClip=index},index);await source.getByRole('button',{name:'Play speech',exact:true}).click()}
        const measurement=await page.evaluate(async checks=>{
          const patterns=checks.map(pattern=>new RegExp(pattern));const deadline=performance.now()+10000;
          while(performance.now()<deadline){
            const text=document.querySelector('[data-interpreter-overlay]')?.shadowRoot.querySelector('.interpreter-live span')?.textContent??'';
            if(patterns.every(pattern=>pattern.test(text)))return {korean:text,rawDelayMs:performance.now()-globalThis.spokenEndMs,speechEndMs:globalThis.speechSamplesEndMs};
            await new Promise(done=>setTimeout(done,10));
          }throw Error('No complete Korean meaning in the actual page overlay');
        },koreanChecks[index]);
        measurement.delayMs=Math.max(0,measurement.rawDelayMs);measurements.push(measurement);
        console.log(JSON.stringify({phase:'sentence-end-to-overlay',language:scenario.language,index,...measurement}));
        assert.ok(measurement.delayMs<=1000,`Sentence end to Korean overlay exceeds 1 s: ${measurement.delayMs}`);
        await new Promise(done=>setTimeout(done,1500));
      }
      observations.runs.push({...scenario,measurements,captions:(await state()).captions});
      popup=await openPopup();await popup.click('#stop');await waitState(value=>value?.state==='ready');await popup.close();
      await page.locator('[data-interpreter-overlay]').waitFor({state:'detached'});continue;
    }
    if (conversation) {
      const playbackDeadline=performance.now()+(conversationManifest.durationSeconds+15)*1000;
      while(!await page.evaluate(()=>media.ended)) {
        const current=await state();
        if(current.state !== 'running') throw Error(`Caption session stopped during playback: ${current.state}: ${current.message}`);
        if(current.diagnostic?.includes('화자 구분을 사용할 수 없습니다')) throw Error(current.diagnostic);
        if(performance.now()>playbackDeadline) throw Error('Conversation playback did not end');
        await new Promise(done=>setTimeout(done,500));
      }
      await new Promise(done => setTimeout(done,45000));
      const completed = await state();
      assert.equal(completed.state,'running',`Caption session stopped at the end: ${completed.message}`);
      const captions = completed.captions;
      const frames = await page.evaluate(() => { clearInterval(captionMonitor); return captionFrames; });
      const native = await runtime.evaluate('localSpeechEvents');
      const finalSource = captions.filter(c=>c.source.final).map(c=>c.source.text).join('');
      const finalKorean = captions.filter(c=>c.source.final && c.translation.state==='paired').map(c=>c.translation.revision.text).join(' ');
      const meaning = japaneseConversation ? conversationManifest.turns.map(turn=>({reference:turn.text,
        missingSource:turn.sourceAnchors.filter(anchor=>!new RegExp(anchor).test(finalSource)),
        missingKorean:turn.koreanAnchors.filter(anchor=>!new RegExp(anchor).test(finalKorean)),
        missingKoreanDetails:(turn.koreanDetailAnchors ?? []).filter(anchor=>!new RegExp(anchor).test(finalKorean))})) : undefined;
      let accuracy;
      if (japaneseConversation) {
        const normalize = text=>[...text.normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu,'')];
        const reference = normalize(conversationManifest.turns.map(turn=>turn.text).join(''));
        const hypothesis = normalize(finalSource);
        let previous = Array.from({length:hypothesis.length+1},(_,i)=>i);
        for(let i=0;i<reference.length;i++) {
          const row=[i+1];
          for(let j=0;j<hypothesis.length;j++) row.push(Math.min(previous[j+1]+1,row[j]+1,previous[j]+Number(reference[i]!==hypothesis[j])));
          previous=row;
        }
        accuracy={metric:'CER',edits:previous[hypothesis.length],referenceUnits:reference.length,rate:previous[hypothesis.length]/reference.length};
      }
      const report = `.ralph/caption-conversation/live${japaneseConversation ? '-ja' : ''}${hyMt2 ? '-hy-mt2' : ''}.json`;
      const mediaState = await page.evaluate(()=>({currentTime:media.currentTime,duration:media.duration,ended:media.ended,loop:media.loop,events:mediaEvents}));
      const playAtMs = mediaState.events.find(event=>event.type==='playing').atMs;
      const firstSource = frames.find(frame=>frame.text && frame.opacity!=='0');
      const firstKorean = frames.find(frame=>/[가-힣]/.test(frame.text) && frame.opacity!=='0');
      const latency = {firstSourceVisibleMs:firstSource?.atMs-playAtMs,firstKoreanVisibleMs:firstKorean?.atMs-playAtMs};
      const revisions = await runtime.evaluate('captionRevisions');
      const pageTimeOrigin = await page.evaluate(()=>performance.timeOrigin);
      const seenDrafts = new Set();
      const drafts = revisions.filter(revision=>{
        const key=JSON.stringify([revision.source.utteranceId,revision.source.sourceRevision]);
        if(revision.source.final||seenDrafts.has(key))return false;
        seenDrafts.add(key);return true;
      });
      const confirmedDrafts = captions.filter(caption=>caption.source.final&&drafts.some(draft=>draft.source.utteranceId===caption.source.utteranceId));
      const visibleDrafts = confirmedDrafts.filter(caption=>{
        const final=revisions.find(revision=>revision.source.utteranceId===caption.source.utteranceId&&revision.source.final);
        return frames.some(frame=>frame.utteranceId===caption.source.utteranceId&&frame.text&&frame.opacity!=='0'&&frame.atMs+pageTimeOrigin<final.atMs);
      });
      const firstTurnKorean = frames.filter(frame => frame.mediaSeconds >= conversationManifest.turns[0].startSeconds
        && frame.mediaSeconds < conversationManifest.turns[0].endSeconds && /[가-힣]/u.test(frame.text) && frame.opacity !== '0');
      const firstTurnUpdates = new Map();
      for (const frame of firstTurnKorean) {
        const texts = firstTurnUpdates.get(frame.utteranceId) ?? new Set(); texts.add(frame.text); firstTurnUpdates.set(frame.utteranceId, texts);
      }
      const firstTurnKoreanUpdates = Math.max(0, ...[...firstTurnUpdates.values()].map(texts => texts.size));
      const streaming = {drafts:drafts.length,confirmedDrafts:confirmedDrafts.length,visibleBeforeFinal:visibleDrafts.length,
        withdrawnDrafts:new Set(revisions.filter(revision=>revision.source.retracted).map(revision=>revision.source.utteranceId)).size,
        firstTurnKoreanUpdates, firstTurnKoreanFrames: firstTurnKorean, passed: firstTurnKoreanUpdates >= 2};
      const remainingOverlay = await page.evaluate(()=>Array.from(document.querySelector('[data-interpreter-overlay]')?.shadowRoot.querySelectorAll('.interpreter-live')??[]).map(row=>row.dataset.utteranceId));
      const result = {state:completed.state,fixtureSha256:createHash('sha256').update(media.get('/conversation.wav')).digest('hex'),mediaState,pageTimeOrigin,latency,streaming,remainingOverlay,revisions,captions,frames,native,meaning,accuracy,diagnostic:(await state()).diagnostic,workers:await runtime.evaluate("runtimeObservations")};
      await mkdir('.ralph/caption-conversation', {recursive:true});
      await writeFile(report, JSON.stringify(result,null,2));
      assert.equal(mediaState.loop,false,'Conversation audio must not loop');
      assert.equal(mediaState.events.filter(event=>event.type==='playing').length,1,'Require a single uninterrupted conversation playback');
      assert.equal(mediaState.ended,true,'Conversation audio must remain ended during caption drain');
      assert.ok(streaming.passed, 'Korean must visibly update at least twice in the same caption while the first turn is still speaking');
      if (nativeSpeech) {
        assert.ok(native.some(event=>event.type==='start' && event.local && event.trackKind==='audio'));
        assert.ok(native.some(event=>event.type==='result' && event.finals.includes(false)), 'Native interim speech must arrive before final');
        assert.equal(result.workers.some(event=>event.type==='asr-job'),false,'Native conversation must not perform Whisper snapshot inference');
      } else {
        assert.ok(streaming.drafts>0,'Whisper must publish provisional recognition');
        assert.ok(streaming.visibleBeforeFinal>0,'A Whisper draft must be visible before confirmation of the same caption');
      }
      assert.ok(captions.length >= 8, 'Conversation must be split into readable phrases');
      assert.ok(new Set(captions.map(c=>c.source.speakerId).filter(Boolean)).size >= 2, 'Both actual voices must receive labels');
      assert.ok(captions.every(c=>c.translation.state==='paired'), 'Every final source revision must retain its matching translation');
      assert.ok(captions.every(c=>c.source.final && c.translation.revision.final && c.source.sourceRevision===c.translation.revision.sourceRevision), 'Recognition and its exact matching translation must both finish');
      assert.deepEqual(remainingOverlay, [], 'Every overlay row must drain after playback; a finished last row cannot mask stuck earlier rows');
      if (japaneseConversation) {
        assert.ok(captions.every(c=>c.source.final), 'Every Japanese phrase must reach final');
        if (accuracy.rate > 0.12) observations.qualityFailures.push({ metric: "CER", ...accuracy });
        for (const turn of meaning) {
          if (turn.missingSource.length || turn.missingKorean.length) observations.qualityFailures.push(turn);
        }
      }
      const turns = japaneseConversation ? [] : captions.filter(c=>c.source.text.split(/\s+/).length >= 10);
      if (!japaneseConversation) {
      assert.equal(turns.length,8,'All eight substantial turns must survive translation and display');
      const speakers=turns.map(c=>c.source.speakerId);
      assert.ok(speakers[0] && speakers[1] && speakers[0] !== speakers[1]);
      for(let i=0;i<speakers.length;i++)assert.equal(speakers[i],speakers[i%2],`Speaker changed identity at turn ${i}`);
      }
      const retiredSeen = new Set();
      for (const frame of frames) {
        if (frame.removed) retiredSeen.add(frame.utteranceId);
        else if (frame.text && frame.utteranceId) assert.ok(!retiredSeen.has(frame.utteranceId),`An already read caption restarted: ${frame.utteranceId}`);
      }
      const shown = new Set(frames.filter(f=>f.text && f.opacity !== '0').map(f=>f.utteranceId));
      for (const caption of captions) assert.ok(shown.has(caption.source.utteranceId), `Caption never displayed: ${caption.source.text}`);
      assert.equal(frames.filter(f=>f.text).at(-1)?.utteranceId,captions.at(-1)?.source.utteranceId,
        'The last caption must finish too; Stop cannot mask a growing display backlog');
      assert.equal(frames.at(-1)?.text,'','The last completed caption must fade while the session remains running');
      console.log(JSON.stringify({phase:'conversation',language:scenario.language,captions:captions.length,finals:captions.filter(c=>c.source.final).length,frames:frames.length,latency,accuracy,translationDetails:meaning?.filter(turn=>turn.missingKoreanDetails.length),report}));
      popup=await openPopup();await popup.click('#stop');await waitState(value=>['idle','ready'].includes(value?.state));await popup.close();
      await page.locator('[data-interpreter-overlay]').waitFor({state:'detached'});
      assert.equal(await worker.evaluate(async()=>(await chrome.tabCapture.getCapturedTabs()).some(t=>['active','pending'].includes(t.status))),false);
      const retained=await state();await new Promise(done=>setTimeout(done,1200));
      assert.deepEqual((await state()).captions,retained.captions,'Stop must reject late conversation revisions');
      continue;
    }
    const first=await waitState(value=>value?.captions.some(c=>c.translation.state==='paired'),60000);
    const firstCaptionMs=performance.now()-playRequestedAt;
    const paired=first.captions.find(c=>c.translation.state==='paired');
    console.log(JSON.stringify({phase:'first-sentence',...scenario,firstCaptionMs,source:paired.source.text,korean:paired.translation.revision.text}));
    assert.match(paired.translation.revision.text,/[가-힣]/);
    assert.equal(paired.source.language,scenario.language);
    const jobs=await runtime.evaluate('runtimeObservations');
    if(localSpeech){
      const events=await runtime.evaluate('localSpeechEvents');
      assert.ok(events.some(e=>e.type==='start'&&e.local===true&&e.trackKind==='audio'&&e.trackState==='live'));
      assert.ok(events.some(e=>e.type==='result'&&e.texts.some(text=>text.includes(paired.source.text))));
      assert.equal(jobs.some(e=>e.type==='asr-job'),false,'Local streaming does not repeat Whisper inference');
    }else{
      const result=jobs.find(e=>e.type==='result'&&e.text?.includes(paired.source.text)&&jobs.some(job=>job.type==='asr-job'
        &&job.worker===e.worker&&job.requestId===e.requestId&&job.identity.sessionId===paired.source.identity.sessionId&&job.audioRange.startMs<=paired.source.audioRange.startMs+0.001
        &&job.audioRange.endMs+0.001>=paired.source.audioRange.endMs));
      const job=jobs.find(e=>e.type==='asr-job'&&e.worker===result?.worker&&e.requestId===result?.requestId&&e.identity.sessionId===paired.source.identity.sessionId);
      assert.ok(job&&result,JSON.stringify({caption:paired,jobs}));assert.ok(result.segments?.some(segment=>segment.text.includes(paired.source.text)));
      if(observations.runs.length===0)assert.ok(jobs.some(e=>e.type==='status'&&e.status.state==='downloading'));
      assert.equal(job.samples,(job.audioRange.endMs-job.audioRange.startMs)*16);
    }
    await page.waitForFunction(()=>document.querySelector('[data-interpreter-overlay]')?.shadowRoot.querySelector('.interpreter-live span')?.textContent.match(/[가-힣]/),undefined,{timeout:10000});
    popup=await openPopup();
    const opened=context.waitForEvent('page');await popup.click('#reference');
    const reference=await opened;await popup.close();
    await reference.waitForFunction(()=>document.querySelector('#app tbody tr[data-translation-state="paired"]'));
    assert.equal(await reference.locator('button,select').count(),0,'Reference view has no execution controls');
    const rows=await reference.locator('#app tbody').innerText();await reference.close();
    const ids=new Set(first.captions.map(c=>c.source.utteranceId));
    const second=await waitState(value=>value?.captions.some(c=>!ids.has(c.source.utteranceId)&&c.translation.state==='paired'),60000);
    assert.equal(second.identity.sessionId,first.identity.sessionId);
    assert.equal(await worker.evaluate(async tabId=>(await chrome.tabCapture.getCapturedTabs()).some(t=>t.tabId===tabId&&t.status==='active'),first.tabId),true);
    popup=await openPopup();
    const reopened=context.waitForEvent('page');await popup.click('#reference');
    const restored=await reopened;await popup.close();
    await restored.waitForFunction(()=>document.querySelectorAll('#app tbody tr[data-translation-state="paired"]').length>=2);
    if(!localSpeech)assert.ok((await restored.locator('#app tbody').innerText()).includes(rows.split('\n')[0]));
    else for(const caption of first.captions)assert.ok(await restored.locator(`tr[data-utterance-id="${caption.source.utteranceId}"]`).count());
    await restored.close();
    const anchors=scenario.language==='ja'?[/会議/,/しません/,/明日/,/午後/,/3|三/,/駅/,/予約/,/取り消さない/]:[/not meet/i,/today/i,/station/i,/tomorrow/i,/three|3/i,/afternoon/i,/not cancel/i,/reservation/i];
    const quality=await waitState(value=>{const text=value?.captions.filter(c=>c.translation.state==='paired').slice(0,3).map(c=>c.source.text).join(' ');return text&&anchors.every(anchor=>anchor.test(text))},60000);
    const transcript=quality.captions.slice(0,3).map(c=>c.source.text).join(' ');
    console.log(JSON.stringify({phase:'sentence-meaning',...scenario,transcript}));
    for(const anchor of scenario.language==='ja' ? [/会議/,/しません/,/明日/,/午後/,/3|三/,/駅/,/予約/,/取り消さない/]
      : [/not meet/i,/today/i,/station/i,/tomorrow/i,/three|3/i,/afternoon/i,/not cancel/i,/reservation/i]) assert.match(transcript,anchor);
    observations.runs.push({...scenario,firstCaptionMs,captions:quality.captions,hiddenPreparation:true,referenceClosure:true,referenceRestoration:true});
    console.log(JSON.stringify({phase:'reference-independent',...scenario,paired:second.captions.filter(c=>c.translation.state==='paired').length}));
    if(captureLoss) {
      const deadline=performance.now()+60000;let pending;
      while(!localSpeech&&performance.now()<deadline) {
        const events=await runtime.evaluate('runtimeObservations');
        pending=events.find(e=>e.type==='asr-job'&&!events.some(r=>r.type==='result'&&r.worker===e.worker&&r.requestId===e.requestId));
        if(pending)break;await new Promise(done=>setTimeout(done,10));
      }
      if(!localSpeech)assert.ok(pending,'Require unfinished actual ASR before native capture loss');
      else assert.ok(quality.captions.some(c=>!c.source.final),'Require active streaming drafts before capture loss');
      const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');
      assert.equal(processInfo.find(p=>p.type==='browser').id,browserProcess.pid);
      const audio=processInfo.filter(p=>p.type==='audio.mojom.AudioService');assert.equal(audio.length,1);
      assert.equal(Number(execFileSync('ps',['-p',String(audio[0].id),'-o','ppid='],{encoding:'utf8'}).trim()),browserProcess.pid);
      process.kill(audio[0].id,'SIGTERM');
      await waitState(value=>value?.state==='idle');
      const events=await runtime.evaluate('runtimeObservations');
      if(!localSpeech){assert.ok(events.some(e=>e.type==='terminated'&&e.worker===pending.worker));assert.equal(events.some(e=>e.type==='result'&&e.worker===pending.worker&&e.requestId===pending.requestId),false);}
      else assert.ok((await runtime.evaluate('localSpeechEvents')).some(e=>e.type==='abort'));
      observations.checks.push('Owned Chrome native audio-service loss retires unfinished real ASR and capture');
    } else {
      popup=await openPopup();await popup.click('#stop');
      await waitState(value=>value?.state==='ready');await popup.close();
    }
    await page.locator('[data-interpreter-overlay]').waitFor({state:'detached'});
    assert.equal(await worker.evaluate(async()=>(await chrome.tabCapture.getCapturedTabs()).some(t=>['active','pending'].includes(t.status))),false);
    const retained=await state();await new Promise(done=>setTimeout(done,1200));
    assert.deepEqual((await state()).captions,retained.captions,'Stopped session accepts no late caption');
  }
  // Preparation is owned by the original tab even when the popup disappears.
  if (!autoLanguage) {
  let popup=await openPopup();if (!localSpeech) await popup.click('#prepare');await popup.close();
  await page.reload();await waitState(value=>value?.state==='idle',10000,true);
  popup=await openPopup();if (!localSpeech) await popup.click('#prepare');await popup.close();
  await page.close();await waitState(value=>value?.state==='idle',10000,true);
  observations.checks.push(latency
    ? 'Popup closure/tab switching completes preparation hidden; all six sentence meaning checks reach the actual page DOM within one second of estimated speech end; Stop clears the overlay; source navigation/closure stops preparation'
    : 'Popup closure/tab switching completes preparation hidden; reference closure preserves next real translated caption and page overlay; reopening restores bounded history; Stop clears overlay/capture and rejects late captions; source navigation/closure stops preparation');
  }
  assert.deepEqual(observations.pageErrors,[]);
  assert.deepEqual(observations.qualityFailures, [], "Conversation recognition/translation quality failed; flow checks are reported separately");
  console.log(JSON.stringify({passed:true,...observations}));
} catch(error) {console.error(JSON.stringify({passed:false,...observations,error:error.stack}));process.exitCode=1}
finally {await browser?.close();browserProcess?.kill();await browserExit;await new Promise(done=>server.close(done));if(profile && !hyMt2 && !voxlingua) await rm(profile,{recursive:true,force:true});if(latencyDirectory)await rm(latencyDirectory,{recursive:true,force:true})}
