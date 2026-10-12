import assert from "node:assert/strict";
import { test } from "node:test";
import type { AudioChunk, MediaTargetId } from "../packages/contracts";
import { createLocalSpeechHost } from "../packages/engines-browser/local-speech";

const identity = { sessionId: "local", targetId: "tab" as MediaTargetId, epoch: 0 };
function fixture(language: "en" | "ja" = "en", confirmStart = true) {
  const instances: FakeRecognition[] = [];
  class FakeRecognition {
    static async install(options: { langs: string[]; processLocally: boolean }) { assert.equal(options.processLocally, true); return true; }
    static async available(options: { langs: string[]; processLocally: boolean }) { assert.equal(options.processLocally, true); return "available"; }
    processLocally = false; lang = ""; continuous = false; interimResults = false;
    onresult: ((event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    onstart: (() => void) | null = null;
    startedWith: MediaStreamTrack | undefined; aborts = 0;
    constructor() { instances.push(this); }
    start(track: MediaStreamTrack) { assert.equal(this.processLocally, true); this.startedWith = track; if (confirmStart) this.onstart?.(); }
    abort() { this.aborts++; }
    emit(text: string, final = false) { this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: final }] }); }
  }
  const view = Object.assign(new EventTarget(), { SpeechRecognition: FakeRecognition, isSecureContext: true, navigator: { userAgent: "Chrome/153.0.0.0" } });
  const document = Object.assign(new EventTarget(), { defaultView: view, visibilityState: "visible" });
  let track = { kind: "audio", readyState: "live" } as MediaStreamTrack;
  const diagnostics: string[] = [];
  const host = createLocalSpeechHost(document as unknown as Document, language, () => track, message => diagnostics.push(message));
  let sequence = 0; let returned = 0;
  const queued: AudioChunk[] = [];
  let waiting: ((value: IteratorResult<AudioChunk>) => void) | undefined;
  const input = { [Symbol.asyncIterator]() { return {
    next() { const value = queued.shift(); return value ? Promise.resolve({ done: false as const, value })
      : new Promise<IteratorResult<AudioChunk>>(resolve => { waiting = resolve; }); },
    async return() { returned++; waiting?.({ done: true, value: undefined }); waiting = undefined; return { done: true as const, value: undefined }; },
  }; } };
  async function feed(clockId = "clock", amplitude = 0) {
    const startMs = sequence * 32;
    const value: AudioChunk = { identity, sequence: sequence++, scope: "tab-mix", audioRange: { startMs, endMs: startMs + 32 },
      capture: { clockId, startMs, endMs: startMs + 32 }, sampleRate: 16000, channels: 1,
      sampleFormat: "pcm-f32le", pcm: new Float32Array(512).fill(amplitude).buffer };
    if (waiting) { const resolve = waiting; waiting = undefined; resolve({ done: false, value }); } else queued.push(value);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { host, input, instances, feed, document, diagnostics, api: FakeRecognition, get returned() { return returned; }, get track() { return track; }, set track(value: MediaStreamTrack) { track = value; } };
}

test("local streaming uses the authorized audio track and revises the same draft before native final", async () => {
  const f = fixture(); await f.host.prepare();
  const recognizer = f.host.createRecognizer(identity, () => {});
  const stream = recognizer.run(f.input)[Symbol.asyncIterator](); const first = stream.next();
  await f.feed(); const native = f.instances.at(-1); assert.ok(native);
  assert.equal(native.startedWith, f.track); assert.equal(native.continuous, true); assert.equal(native.interimResults, true);
  native.emit("We will meet today");
  const draft = (await first).value; assert.equal(draft?.final, false);
  const correction = stream.next(); native.emit("We will not meet today");
  const corrected = (await correction).value;
  assert.equal(corrected?.utteranceId, draft?.utteranceId); assert.equal(corrected?.sourceRevision, 2);
  assert.equal(corrected?.text, "We will not meet today");
  const final = stream.next(); native.emit("We will not meet today", true);
  assert.equal((await final).value?.final, true);
  const late = stream.next(); const callback = native.onresult;
  await recognizer.cancel(identity);
  callback?.({ resultIndex: 0, results: [{ 0: { transcript: "A late sentence must disappear" }, isFinal: true }] });
  await assert.rejects(late, /cancelled/); assert.equal(native.aborts, 1); assert.equal(f.returned, 1);
  f.host.dispose();
});

test("native speech preparation survives document visibility changes", async () => {
  const f = fixture(); f.document.visibilityState = "hidden"; f.document.dispatchEvent(new Event("visibilitychange"));
  await f.host.prepare(); const recognizer = f.host.createRecognizer(identity, () => {});
  await recognizer.close(); f.host.dispose();
});

test("installed language packs do not report running until Chrome confirms engine startup", async () => {
  const f = fixture("ja", false); await f.host.prepare();
  const states: string[] = [];
  const recognizer = f.host.createRecognizer(identity, status => states.push(status.state));
  const stream = recognizer.run(f.input)[Symbol.asyncIterator](); const next = stream.next(); void next.catch(() => {});
  try {
    await f.feed();
    assert.deepEqual(states, [], "available is model readiness, not a started recognizer");
    const native = f.instances.at(-1); assert.ok(native);
    native.onstart?.(); assert.deepEqual(states, ["running"]);
    native.emit("今日は会議をしません", true);
    assert.equal((await next).value?.text, "今日は会議をしません");
  } finally { await recognizer.close(); await stream.return?.(); f.host.dispose(); }
});

test("an available language pack followed by native startup abort never reports running", async () => {
  const f = fixture("ja", false); await f.host.prepare();
  f.api.prototype.start = function() { this.onerror?.({ error: "aborted" }); };
  const states: string[] = [];
  const recognizer = f.host.createRecognizer(identity, status => states.push(status.state));
  await assert.rejects(recognizer.run(f.input)[Symbol.asyncIterator]().next());
  assert.deepEqual(states, []);
  assert.ok(f.diagnostics.some(message => message.includes("aborted")));
  await recognizer.close(); f.host.dispose();
});

test("Japanese readiness includes the English pack Chrome needs to launch its speech service", async () => {
  const f = fixture("ja"); let englishReady = false;
  f.api.available = async options => options.langs.includes("en-US") && !englishReady ? "downloading" : "available";
  f.api.install = async options => { englishReady = options.langs.includes("en-US"); return englishReady; };
  const start = f.api.prototype.start;
  f.api.prototype.start = function(track) {
    if (!englishReady) { this.onerror?.({ error: "aborted" }); return; }
    start.call(this, track);
  };
  await f.host.prepare(); const recognizer = f.host.createRecognizer(identity, () => {});
  const stream = recognizer.run(f.input)[Symbol.asyncIterator](); const next = stream.next(); void next.catch(() => {});
  try {
    await f.feed(); f.instances.at(-1)?.emit("今日は会議をしません", true);
    assert.equal((await next).value?.text, "今日は会議をしません");
  } finally { await recognizer.close(); await stream.return?.(); f.host.dispose(); }
});

test("persistent speech host joins an unfinished popup-initiated language download", async () => {
  const f = fixture(); let installed = false; let calls = 0;
  let finish: ((value: boolean) => void) | undefined;
  f.api.available = async () => installed ? "available" : "downloading";
  f.api.install = async () => { calls++; return new Promise<boolean>(resolve => { finish = resolve; }); };
  const prepared = f.host.prepare(); void prepared.catch(() => {});
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    f.document.visibilityState = "hidden"; f.document.dispatchEvent(new Event("visibilitychange"));
    installed = true; finish?.(true); await prepared;
  } finally { f.host.dispose(); }
});

test("Japanese recognition prepares Korean bootstrap when Chrome captions use a synced Korean language", async () => {
  const f = fixture("ja"); let koreanReady = false;
  f.api.available = async options => options.langs.includes("ko-KR") && !koreanReady ? "downloading" : "available";
  f.api.install = async options => { koreanReady = options.langs.includes("ko-KR"); return koreanReady; };
  const start = f.api.prototype.start;
  f.api.prototype.start = function(track) {
    if (!koreanReady) { this.onerror?.({ error: "aborted" }); return; }
    start.call(this, track);
  };
  await f.host.prepare(); const recognizer = f.host.createRecognizer(identity, () => {});
  const stream = recognizer.run(f.input)[Symbol.asyncIterator](); const next = stream.next(); void next.catch(() => {});
  try {
    await f.feed(); f.instances.at(-1)?.emit("今日は会議をしません", true);
    assert.equal((await next).value?.text, "今日は会議をしません");
  } finally { await recognizer.close(); await stream.return?.(); f.host.dispose(); }
});

test("Japanese final token spacing preserves sentence IDs and negation", async () => {
  const f = fixture("ja"); await f.host.prepare(); const recognizer = f.host.createRecognizer(identity, () => {});
  const stream = recognizer.run(f.input)[Symbol.asyncIterator](); const first = stream.next(); await f.feed();
  const native = f.instances.at(-1); assert.ok(native);
  native.emit("今日は会議をしません明日の午後三時に駅で会いましょう");
  const firstSentence = (await first).value; const secondSentence = (await stream.next()).value;
  assert.equal(firstSentence?.text, "今日は会議をしません"); assert.equal(secondSentence?.text, "明日の午後三時に駅で会いましょう");
  const final = stream.next(); native.emit("今日 は 会議 を し ませ ん 明日 の 午後 三 時 に 駅 で 会い ましょう", true);
  const confirmed = (await final).value; assert.equal(confirmed?.utteranceId, firstSentence?.utteranceId); assert.equal(confirmed?.text, firstSentence?.text);
  assert.equal((await stream.next()).value?.utteranceId, secondSentence?.utteranceId);
  await recognizer.cancel(identity); await stream.return?.(); f.host.dispose();
});

test("local recognition fails before starting if the authorized capture track is absent", async () => {
  const f = fixture(); await f.host.prepare(); f.track = { kind: "audio", readyState: "ended" } as MediaStreamTrack;
  const recognizer = f.host.createRecognizer(identity, () => {});
  await assert.rejects(recognizer.run(f.input)[Symbol.asyncIterator]().next(), /Authorized tab audio/);
  assert.equal(f.instances.at(-1)?.startedWith, undefined); f.host.dispose();
});

test("English final whitespace preserves the draft sentence ID", async () => {
  const f = fixture(); await f.host.prepare(); const recognizer = f.host.createRecognizer(identity, () => {});
  const stream = recognizer.run(f.input)[Symbol.asyncIterator](); const first = stream.next(); await f.feed();
  const native = f.instances.at(-1); assert.ok(native);
  try {
    native.emit("We will not meet today"); const draft = (await first).value;
    const final = stream.next(); native.emit(" We will not meet today ", true);
    const confirmed = (await final).value;
    assert.equal(confirmed?.utteranceId, draft?.utteranceId);
    assert.equal(confirmed?.text, draft?.text); assert.equal(confirmed?.sourceRevision, 2);
  } finally { await recognizer.cancel(identity); await stream.return?.(); f.host.dispose(); }
});

test("native streaming still rejects PCM clock gaps and browser recognition failure", async () => {
  for (const reason of ["audio-gap", "engine-failed"]) {
    const f = fixture(); await f.host.prepare(); const recognizer = f.host.createRecognizer(identity, () => {});
    const pending = recognizer.run(f.input)[Symbol.asyncIterator]().next();
    const rejected = assert.rejects(pending, new RegExp(reason));
    await f.feed();
    if (reason === "audio-gap") await f.feed("different-clock");
    else f.instances.at(-1)?.onerror?.({ error: "audio-capture" });
    await rejected; assert.equal(f.returned, 1); f.host.dispose();
    if (reason === "engine-failed") assert.ok(f.diagnostics.some(message => message.includes("audio-capture")));
  }
});

test("unpunctuated cumulative native results split at audio pauses without losing words", async () => {
  const f = fixture(); await f.host.prepare();
  const recognizer = f.host.createRecognizer(identity, () => {});
  const stream = recognizer.run(f.input)[Symbol.asyncIterator]();
  const first = stream.next();
  await f.feed('clock', 0.05);
  const native = f.instances.at(-1); assert.ok(native);
  native.emit('we could have lunch on Sunday');
  const before = (await first).value; assert.ok(before);
  for (let i = 0; i < 12; i++) await f.feed();
  await f.feed('clock', 0.05);
  native.emit('we could have lunch on Sunday I will bring your book', true);
  const closed = (await stream.next()).value;
  const next = (await stream.next()).value;
  assert.ok(closed && next);
  assert.equal(closed.utteranceId, before.utteranceId);
  assert.notEqual(next.utteranceId, before.utteranceId);
  assert.equal(`${closed.text} ${next.text}`, 'we could have lunch on Sunday I will bring your book');
  assert.ok(next.audioRange.startMs >= closed.audioRange.endMs);
  await recognizer.close(); await stream.return?.(); f.host.dispose();
});

test("a stable closed native speech span finalizes before Chrome's cumulative result", async () => {
  for (const [language, firstText, nextText] of [["en", "We can meet tomorrow", "I will bring your book"],
    ["ja", "明日駅で会おう", "本を持っていくよ"]] as const) {
    const f = fixture(language); await f.host.prepare();
    const recognizer = f.host.createRecognizer(identity, () => {});
    const stream = recognizer.run(f.input)[Symbol.asyncIterator]();
    const first = stream.next(); await f.feed("clock", 0.05);
    const native = f.instances.at(-1); assert.ok(native);
    native.emit(firstText); const draft = (await first).value;
    for (let i = 0; i < 12; i++) await f.feed();
    await f.feed("clock", 0.05);
    native.emit(`${firstText}${language === "en" ? " " : ""}${nextText}`);
    const closed = (await stream.next()).value;
    assert.equal(closed?.utteranceId, draft?.utteranceId);
    assert.equal(closed?.text, firstText);
    assert.equal(closed?.final, true, "Stable completed span must not wait for the entire native result to finalize");
    const following = (await stream.next()).value;
    assert.equal(following?.text, nextText); assert.equal(following?.final, false);
    await recognizer.close(); await stream.return?.(); f.host.dispose();
  }
});

test("a closed native span waits for stable text after a correction", async () => {
  const f = fixture(); await f.host.prepare();
  const recognizer = f.host.createRecognizer(identity, () => {});
  const stream = recognizer.run(f.input)[Symbol.asyncIterator]();
  const first = stream.next(); await f.feed("clock", 0.05);
  const native = f.instances.at(-1); assert.ok(native);
  native.emit("We meet today"); const draft = (await first).value;
  for (let i = 0; i < 12; i++) await f.feed();
  await f.feed("clock", 0.05);
  native.emit("We meet tomorrow please bring the book");
  const corrected = (await stream.next()).value;
  assert.equal(corrected?.utteranceId, draft?.utteranceId);
  assert.equal(corrected?.text, "We meet tomorrow"); assert.equal(corrected?.final, false);
  assert.equal((await stream.next()).value?.final, false);
  native.emit("We meet tomorrow please bring the book");
  const stable = (await stream.next()).value;
  assert.equal(stable?.utteranceId, draft?.utteranceId); assert.equal(stable?.final, true);
  await recognizer.close(); await stream.return?.(); f.host.dispose();
});

test("numeric corrections keep pause boundaries and never duplicate a later let's-meet phrase", async () => {
  const f=fixture(); await f.host.prepare();
  const recognizer=f.host.createRecognizer(identity,()=>{});
  const stream=recognizer.run(f.input)[Symbol.asyncIterator](); const first=stream.next();
  await f.feed('clock',0.05); const native=f.instances.at(-1); assert.ok(native);
  native.emit('Sunday works for me is 1:30 okay'); await first;
  for(let i=0;i<12;i++)await f.feed(); await f.feed('clock',0.05);
  native.emit("Sunday works for me is 1:30 okay sure let's meet at the station");
  const closed=(await stream.next()).value;
  assert.equal(closed?.text,'Sunday works for me is 1:30 okay'); assert.equal(closed?.final,true);
  const meeting=(await stream.next()).value;
  assert.equal(meeting?.text,"sure let's meet at the station");
  native.emit("Sunday works for me is 1 30 okay let's meet at the station",true);
  const finalizedFirst=(await stream.next()).value;
  const finalizedMeeting=(await stream.next()).value;
  assert.equal(finalizedFirst?.text,'Sunday works for me is 1 30 okay');
  assert.equal(finalizedMeeting?.utteranceId,meeting?.utteranceId);
  assert.equal(finalizedMeeting?.text,"let's meet at the station");
  await recognizer.close(); await stream.return?.(); f.host.dispose();
});
