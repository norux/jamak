import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaTargetId } from "../packages/contracts";
import { createChromeEngine } from "../apps/chrome/engine";
import { defaultModelOptions, modelOptionsKey, readModelOptions, recognitionChoices, translationChoices, validModelOptions } from "../apps/chrome/model-options";
import { asrCandidates, registeredCandidate } from "../packages/engines-browser/model";
import { createModelTranslator } from "../packages/engines-browser/model-translator";
import { translationCandidates } from "../packages/engines-browser/translation-model";

test("model settings restore Chrome defaults on invalid data and retain independent local choices", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let saved: string | null = null;
  Object.defineProperty(globalThis, "localStorage", {configurable:true,value:{getItem(key: string){ assert.equal(key, modelOptionsKey); return saved; }}});
  try {
    for (const invalid of [null, "{", '{}', '{"recognition":"tiny","translation":"remote-api"}']) {
      saved = invalid; assert.deepEqual(readModelOptions(), defaultModelOptions);
    }
    saved = JSON.stringify({recognition:"tiny",translation:"hyMt2",targetLanguage:"en",languageDetection:"voxlingua",speaker:"off"});
    assert.deepEqual(readModelOptions(),{recognition:"chrome",translation:"hyMt2",targetLanguage:"en",languageDetection:"voxlingua",speaker:"off"},"Retired recognition keeps independent target and model selections");
    for (const recognition of recognitionChoices) for (const translation of translationChoices) {
      const options = {recognition:recognition.id,translation:translation.id};
      assert.equal(validModelOptions(options),true); saved = JSON.stringify(options); assert.deepEqual(readModelOptions(),options);
      if (recognition.id !== "chrome") assert.ok(registeredCandidate(asrCandidates[recognition.id].model,asrCandidates[recognition.id].dtype).requiredBytes > 0);
      if (translation.id !== "chrome") assert.ok(registeredCandidate(translationCandidates[translation.id].model,translationCandidates[translation.id].dtype).cacheName.includes("translation"));
    }
  } finally { if(original) Object.defineProperty(globalThis,"localStorage",original); else Reflect.deleteProperty(globalThis,"localStorage"); }
});

test("engine prepares the explicit recognition and translation choices, with Chrome preferred only in default mode", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis,"Worker");
  const workers: FakeWorker[] = [];
  class FakeWorker {
    messages: {type:string;requestId:number;candidate?:string;device?:string}[] = [];
    terminated = false;
    onmessage?: (event:{data:unknown}) => void;
    constructor(readonly url: URL) {workers.push(this);}
    postMessage(message: {type:string;requestId:number;candidate?:string;device?:string}) {
      this.messages.push(message);
      queueMicrotask(() => {this.onmessage?.({data:{version:1,requestId:message.requestId,type:"ready"}});});
    }
    terminate(){this.terminated = true;}
  }
  class Speech {
    processLocally = false;
    static async available(){return "available";}
    static async install(){return true;}
  }
  const document = Object.assign(new EventTarget(), {visibilityState:"hidden",defaultView:Object.assign(new EventTarget(),{
    isSecureContext:true,navigator:{userAgent:"Chrome/153",userActivation:{isActive:false}}, SpeechRecognition:Speech,
    Translator:{async availability(){return "available";},async create(){return {async translate(){return "가짜 번역";},destroy(){}};}},
  })}) as unknown as Document;
  Object.defineProperty(globalThis,"Worker",{configurable:true,value:FakeWorker});
  try {
    for(const recognition of recognitionChoices) for(const translation of translationChoices) {
      const before = workers.length;
      const engine = createChromeEngine(document,"ja",()=>{},"offscreen",()=>undefined,{recognition:recognition.id,translation:translation.id});
      try {
        await engine.prepareFromGesture(); assert.equal(engine.ready,true);
        const owned = workers.slice(before);
        const asr = owned.find(w => w.url.pathname.endsWith("asr-worker.ts"));
        const translated = owned.find(w => w.url.pathname.endsWith("model-translator-worker.ts"));
        if(recognition.id === "chrome") {assert.equal(asr,undefined);assert.equal(owned.some(w => w.url.pathname.endsWith("vad-worker.ts")),false);assert.equal(engine.models[0].name,"Chrome SODA");}
        else {assert.equal(asr?.messages[0].candidate,recognition.id);assert.equal(asr?.messages[0].device,asrCandidates[recognition.id].dtype === "fp16" ? "webgpu":"wasm");assert.ok(!engine.models[0].name.includes("SODA"));}
        if(translation.id === "chrome") assert.equal(translated,undefined);
        else assert.equal(translated?.messages[0].candidate,translation.id);
      } finally {await engine.port.close();}
      assert.ok(workers.slice(before).every(w => w.terminated),"Switching models must release every resident worker");
    }
    for(const source of ["auto","ko"] as const) for(const translation of ["chrome","hyMt2"] as const) {
      const before = workers.length;
      const engine = createChromeEngine(document,source,()=>{},"offscreen",()=>undefined,{recognition:"smallFp16",translation});
      try {await engine.prepareFromGesture();assert.equal(workers.slice(before).find(w=>w.url.pathname.endsWith("asr-worker.ts"))?.messages[0].candidate,"smallFp16");assert.equal(workers.slice(before).some(w=>w.url.pathname.endsWith("model-translator-worker.ts")),source !== "ko" && translation !== "chrome");}
      finally {await engine.port.close();}
    }
  } finally {if(original) Object.defineProperty(globalThis,"Worker",original);else Reflect.deleteProperty(globalThis,"Worker");}
});

test("local model translator preserves revision pairing and rejects replies after Stop", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis,"Worker");
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event:{data:unknown})=>void;
    last?: {requestId:number;type:string;language?:string};
    terminated = false;
    constructor(){workers.push(this);}
    postMessage(value:{requestId:number;type:string;language?:string}){this.last=value;}
    reply(value:object){this.onmessage?.({data:{requestId:this.last?.requestId,...value}});}
    terminate(){this.terminated=true;}
  }
  Object.defineProperty(globalThis,"Worker",{configurable:true,value:FakeWorker});
  const document = Object.assign(new EventTarget(),{visibilityState:"hidden",defaultView:Object.assign(new EventTarget(),{isSecureContext:true})}) as unknown as Document;
  const host = createModelTranslator(document,{source:"auto",target:"ko"},"nllb",()=>{},"offscreen");
  const identity = {sessionId:"models",targetId:"tab" as MediaTargetId,epoch:1};
  try {
    const prepared = host.prepare();workers[0].reply({type:"ready"});await prepared;
    const source = {identity,utteranceId:"turn",sourceRevision:3,text:"明日は駅で会いましょう。",language:"ja",final:false,audioRange:{startMs:0,endMs:1000}};
    const stream = host.translate(source,{source:"ja",target:"ko"})[Symbol.asyncIterator]();
    const next = stream.next();
    assert.equal(workers[0].last?.language,"ja");workers[0].reply({type:"result",text:"내일 역에서 만나요."});
    const result = (await next).value;assert.equal(result?.sourceRevision,3);assert.equal(result?.utteranceId,"turn");assert.deepEqual(result?.identity,identity);await stream.return?.();
    const streamed = host.translate({...source,sourceRevision:4},{source:"ja",target:"ko"})[Symbol.asyncIterator]();
    const partial = streamed.next();workers[0].reply({type:"chunk",text:"내일 "});
    assert.equal((await partial).value?.final,false);
    workers[0].reply({type:"chunk",text:"내일 역"});workers[0].reply({type:"chunk",text:"내일 역에서 "});
    workers[0].reply({type:"result",text:"내일 역에서 만나요."});
    await new Promise<void>(resolve=>queueMicrotask(resolve));
    const completed = (await streamed.next()).value;
    assert.equal(completed?.text,"내일 역에서 만나요.");assert.equal(completed?.final,true);await streamed.return?.();
    const stopped = host.translate({...source,sourceRevision:4},{source:"ja",target:"ko"})[Symbol.asyncIterator]().next();
    host.stop();workers[0].reply({type:"result",text:"늦은 결과"});await assert.rejects(stopped,/Translation stopped/);assert.equal(workers[0].terminated,true);
    const restarting = host.prepare();workers[1].reply({type:"ready"});await restarting;
    workers[0].reply({type:"error",reason:"stale"});
    const current = host.translate({...source,language:"en",sourceRevision:5},{source:"en",target:"ko"})[Symbol.asyncIterator]().next();
    workers[1].reply({type:"result",text:"새 번역"});assert.equal((await current).value?.sourceRevision,5);
  } finally {await host.close();if(original) Object.defineProperty(globalThis,"Worker",original);else Reflect.deleteProperty(globalThis,"Worker");}
});
