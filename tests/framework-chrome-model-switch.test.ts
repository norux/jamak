import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundChannel, controlChannel, eventChannel } from "../apps/chrome/background-protocol";

test("Advanced switches models after a running session emits its own clear event during Stop", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis,"chrome");
  let receive!: (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown)=>void)=>unknown;
  const commands: {type:string;options?:unknown}[] = [];
  const base = "chrome-extension://fixture/";
  const snapshot = {state:"idle",source:"en",message:"Stopped",captions:[]};
  const noop = {addListener(){}};
  const notifications: unknown[] = [];
  Object.defineProperty(globalThis,"chrome",{configurable:true,value:{
    runtime:{id:"fixture",getURL:(path:string)=>base+path,ContextType:{OFFSCREEN_DOCUMENT:"OFFSCREEN_DOCUMENT"},
      async getContexts(){return [{documentUrl:`${base}offscreen.html`}];},onMessage:{addListener(listener: typeof receive){receive=listener;}},
      async sendMessage(message:{channel:string;command:{type:string;options?:unknown}}){
        assert.equal(message.channel,backgroundChannel);commands.push(message.command);
        if(message.command.type === "stop") receive({channel:eventChannel,type:"clear",identity:{sessionId:"previous",targetId:"tab",epoch:0}},{id:"fixture",url:`${base}offscreen.html`},()=>{});
        return {snapshot};
      },
    },tabs:{onRemoved:noop,onUpdated:noop},notifications:{async create(id:string,options:unknown){notifications.push({id,options});return id;}},
  }});
  try {
    await import("../apps/chrome/service-worker");
    const response = await new Promise(resolve=>receive({channel:controlChannel,command:{type:"models",tabId:10,source:"en",options:{recognition:"smallFp16",translation:"hyMt2"}}},{id:"fixture",url:`${base}advanced.html?source=en&tabId=10`},resolve));
    assert.deepEqual(response,{snapshot});
    assert.deepEqual(commands.map(c=>c.type),["stop","models"],"Retiring the old caption session must not cancel the newly selected model preparation");
    assert.deepEqual(commands[1].options,{recognition:"smallFp16",translation:"hyMt2"});
    for (const type of ["status", "clear"]) receive({channel:eventChannel,type},{id:"fixture",url:`${base}offscreen.html`},()=>{});
    receive({channel:eventChannel,type:"models-ready"},{id:"fixture",url:`${base}advanced.html`},()=>{});
    assert.equal(notifications.length,0,"Status, Stop and untrusted pages never send completion notifications");
    await new Promise(resolve=>receive({channel:eventChannel,type:"models-ready"},{id:"fixture",url:`${base}offscreen.html`},resolve));
    assert.deepEqual(notifications,[{id:"jamak-models-ready",options:{type:"basic",iconUrl:`${base}icons/icon-128.png`,title:"Jamak · 모델 준비 완료",message:"다운로드와 모델 준비가 완료되었습니다. 원래 탭에서 번역을 시작하세요."}}]);
  } finally {if(original)Object.defineProperty(globalThis,"chrome",original);else Reflect.deleteProperty(globalThis,"chrome");}
});
