import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaptionRevision, MediaTarget, SessionIdentity } from "../packages/contracts";
import { createRemoteVideoOutput, serveVideoOutput } from "../apps/chrome/overlay-channel";

const target = { id: "selected", documentId: "document", frameId: "0" } as MediaTarget;
const identity: SessionIdentity = { sessionId: "session", targetId: target.id, epoch: 0 };
const caption: CaptionRevision = { source: { identity, utteranceId: "utterance", sourceRevision: 1, language: "ja", text: "synthetic source",
  final: true, audioRange: { startMs: 0, endMs: 1000 } }, translation: { state: "pending" } };
function port() {
  const messages = new Set<(value: unknown) => void>(), disconnects = new Set<() => void>();
  const sent: Record<string, unknown>[] = []; let disconnected = 0;
  return { sent, messages, disconnects, get disconnected() { return disconnected; },
    postMessage(value: Record<string, unknown>) { sent.push(JSON.parse(JSON.stringify(value))); },
    disconnect() { disconnected++; },
    onMessage: { addListener: (fn: (value: unknown) => void) => messages.add(fn), removeListener: (fn: (value: unknown) => void) => messages.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    receive(value: unknown) { for (const listener of messages) listener(value); },
  };
}

test("overlay output clears synchronously and rejects old sessions, epochs and late captions", () => {
  const wire = port(); const failures: string[] = [];
  const output = createRemoteVideoOutput(wire as unknown as chrome.runtime.Port, message => failures.push(message));
  output.activate(target, identity); wire.receive({ version: 1, type: "ack", sequence: 0 });
  output.compare(caption); wire.receive({ version: 1, type: "ack", sequence: 1 });
  output.compare({ ...caption, source: { ...caption.source, identity: { ...identity, epoch: 1 } } });
  output.clear({ ...identity, sessionId: "old" }); assert.equal(wire.sent.length, 2);
  output.clear(identity); wire.receive({ version: 1, type: "ack", sequence: 2 });
  output.compare(caption); assert.equal(wire.sent.length, 3); assert.equal(wire.sent[2].type, "clear");
  output.dispose(); assert.equal(wire.messages.size, 0); assert.deepEqual(failures, []);
});

test("overlay channel bounds outstanding messages and wire size with explicit failure", () => {
  for (const oversized of [false, true]) {
    const wire = port(); const failures: string[] = [];
    const output = createRemoteVideoOutput(wire as unknown as chrome.runtime.Port, message => failures.push(message));
    output.activate(target, identity);
    if (oversized) output.compare({ ...caption, source: { ...caption.source, text: "a".repeat(32768) } });
    else for (let i = 0; i < 32; i++) output.compare(caption);
    assert.equal(wire.sent.length, oversized ? 1 : 32); assert.equal(wire.disconnected, 1);
    assert.match(failures[0], /overloaded/); output.compare(caption); assert.equal(failures.length, 1);
  }
});

test("overlay acknowledgement timeout and malformed acknowledgement disconnect explicitly", async () => {
  for (const malformed of [false, true]) {
    const wire = port(); const failures: string[] = [];
    const output = createRemoteVideoOutput(wire as unknown as chrome.runtime.Port, message => failures.push(message));
    output.activate(target, identity);
    if (malformed) wire.receive({ version: 1, type: "ack", sequence: 9 });
    else await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(wire.disconnected, 1); assert.match(failures[0], malformed ? /Invalid overlay/ : /1000 ms/);
  }
});

test("page output validates envelopes, selected document and exact source/translation pairing before DOM", () => {
  for (const value of [
    { version: 2, sequence: 0, type: "clear", identity },
    { version: 1, sequence: 1, type: "clear", identity },
    { version: 1, sequence: 0, type: "activate", target: { ...target, frameId: "other" }, identity },
    { version: 1, sequence: 0, type: "activate", target, identity: { ...identity, targetId: "other" } },
    { version: 1, sequence: 0, type: "activate", target: { ...target, documentId: "retired" }, identity },
    { version: 1, sequence: 0, type: "caption", caption: { ...caption, source: { ...caption.source, audioRange: { startMs: 100, endMs: 0 } } } },
    { version: 1, sequence: 0, type: "caption", caption: { ...caption, translation: { state: "paired", revision: { identity, utteranceId: "utterance", sourceRevision: 2,
      translationRevision: 1, languages: { source: "ja", target: "ko" }, text: "합성", final: true } } } },
    { version: 1, sequence: 0, type: "caption", caption: { ...caption, source: { ...caption.source, text: "a".repeat(12001) } } },
  ]) {
    const wire = port(); let unsubscribed = 0;
    serveVideoOutput(wire as unknown as chrome.runtime.Port, { resolve: () => undefined, subscribe: () => () => { unsubscribed++; } });
    wire.receive(value); assert.equal(wire.disconnected, 1); assert.equal(unsubscribed, 1); assert.equal(wire.sent.length, 0);
  }
});

test("overlay transport accepts only final empty unpaired withdrawals", () => {
  const removed = { ...caption, source: { ...caption.source, text: "", retracted: true as const } };
  for (const [input, accepted] of [[removed, true],
    [{ ...removed, source: { ...removed.source, final: false } }, false],
    [{ ...removed, source: { ...removed.source, text: "a stale hypothesis" } }, false],
    [{ ...removed, source: { ...removed.source, retracted: false } }, false]] as const) {
    const wire = port();
    const served = serveVideoOutput(wire as unknown as chrome.runtime.Port, undefined, {} as Document);
    wire.receive({ version: 1, sequence: 0, type: "caption", caption: input });
    assert.equal(wire.disconnected, accepted ? 0 : 1);
    assert.equal(wire.sent.length, accepted ? 1 : 0);
    served.dispose();
  }
});

test("overlay transport accepts Korean, English and Japanese targets and rejects unsupported languages", () => {
  for (const language of ["ko", "en", "ja", "fr"]) {
    const wire = port();
    const served = serveVideoOutput(wire as unknown as chrome.runtime.Port, undefined, {} as Document);
    const paired = { ...caption, translation: { state: "paired", revision: { identity, utteranceId: caption.source.utteranceId,
      sourceRevision: 1, translationRevision: 1, languages: { source: "ja", target: language }, text: "Translated caption", final: true } } };
    wire.receive({ version: 1, sequence: 0, type: "caption", caption: paired });
    assert.equal(wire.disconnected, language === "fr" ? 1 : 0);
    assert.equal(wire.sent.length, language === "fr" ? 0 : 1);
    served.dispose();
  }
});

test("tab page output validates mixed-input identity and forbids fabricated video ranges before DOM", () => {
  const tab = { ...target, frameId: "tab", scope: "tab-mix", tabId: 12 };
  for (const value of [
    { version: 1, sequence: 0, type: "activate", target, identity },
    { version: 1, sequence: 0, type: "activate", target: { ...tab, scope: "selected-video" }, identity },
    { version: 1, sequence: 0, type: "activate", target: { ...tab, tabId: 0 }, identity },
    { version: 1, sequence: 0, type: "activate", target: tab, identity: { ...identity, targetId: "other" } },
    { version: 1, sequence: 0, type: "caption", caption: { ...caption, videoRange: { startMs: 0, endMs: 1000 } } },
  ]) {
    const wire = port();
    serveVideoOutput(wire as unknown as chrome.runtime.Port, undefined, {} as Document);
    wire.receive(value); assert.equal(wire.disconnected, 1); assert.equal(wire.sent.length, 0);
  }
});

test("a native burst of sixteen sources and their translations cannot disconnect and restart the overlay", () => {
  const wire=port(); const failures: string[]=[];
  const output=createRemoteVideoOutput(wire as unknown as chrome.runtime.Port,message=>failures.push(message));
  output.activate(target,identity);wire.receive({version:1,type:'ack',sequence:0});
  for(let index=0;index<16;index++)output.compare({...caption,source:{...caption.source,utteranceId:`burst-${index}`}});
  for(let index=0;index<16;index++)output.compare({...caption,source:{...caption.source,utteranceId:`burst-${index}`},
    translation:{state:'paired',revision:{identity,utteranceId:`burst-${index}`,sourceRevision:1,translationRevision:1,languages:{source:'ja',target:'ko'},text:'번역',final:true}}});
  assert.equal(wire.disconnected,0,'A normal final-result burst must not clear and recreate presentation history');
  assert.deepEqual(failures,[]); assert.equal(wire.sent.length,33);
  output.dispose();
});
