import assert from "node:assert/strict";
import { test } from "node:test";
import type { AudioChunk, CaptionRevision, EngineCapabilities, InterpretationEngine, InterpretationEvent, MediaTarget, MediaTargetId, PlaybackEvent, SessionIdentity, SessionStatus, TranscriptRevision, TranslationRevision, VideoInput } from "../packages/contracts";
import { createAudioQueue } from "../packages/core/audio-queue";
import { createRevisionStore } from "../packages/core/revision-store";
import { createSessionController } from "../packages/core/session-controller";
import { createTimeline } from "../packages/core/timeline";

const target: MediaTarget = { id: "video" as MediaTargetId, documentId: "doc", frameId: "frame" };
const identity: SessionIdentity = { sessionId: "s1", targetId: target.id, epoch: 0 };
const limits = { maxChunkBytes: 400, maxAudioQueueMs: 200, maxPendingUtterances: 3, maxTranslationJobs: 2, maxStoredCaptions: 3 };
const languages = { source: "ja", target: "ko" };

test("withdrawn hypotheses leave history and fence stale source, translation and speaker updates", () => {
  const store = createRevisionStore(identity, 300);
  const first = source(); store.accept({ type: "transcript", revision: first });
  store.accept({ type: "translation", revision: translation() });
  const removed = { ...source(2, true), text: "", retracted: true as const };
  for (const revision of [{ ...removed, final: false }, { ...removed, text: "still present" }, { ...removed, identity: { ...identity, epoch: 1 } }]) {
    assert.equal(store.accept({ type: "transcript", revision }), undefined);
  }
  assert.equal(store.snapshot().length, 1);
  assert.ok(store.accept({ type: "transcript", revision: removed }));
  assert.deepEqual(store.snapshot(), []);
  assert.equal(store.accept({ type: "transcript", revision: source(3, true) }), undefined);
  assert.equal(store.accept({ type: "translation", revision: translation(2, 2, true) }), undefined);
  assert.equal(store.accept({ type: "speaker", identity, utteranceId: first.utteranceId, speakerId: 1 }), undefined);
  assert.ok(store.accept({ type: "transcript", revision: source(1, true, identity, "confirmed") }));
  assert.equal(store.accept({ type: "transcript", revision: { ...removed, utteranceId: "confirmed" } }), undefined,
    "A provisional withdrawal cannot erase a confirmed sentence");
});
const capabilities: EngineCapabilities = {
  availability: { state: "available" }, pipeline: "separate-asr-translation", asrOnlyUpdates: true,
  languages, models: [], limits,
};

function audio(sequence = 0, session = identity): AudioChunk {
  return { identity: session, scope: "selected-video", sequence,
    audioRange: { startMs: sequence * 100, endMs: (sequence + 1) * 100 },
    capture: { clockId: "capture", startMs: 1000 + sequence * 100, endMs: 1100 + sequence * 100 },
    sampleRate: 1000, channels: 1, sampleFormat: "pcm-s16le", pcm: new ArrayBuffer(200) };
}

function source(revision = 1, final = false, session = identity, utteranceId = "u1"): TranscriptRevision {
  return { identity: session, utteranceId, sourceRevision: revision, final, text: `source ${revision}`, language: "ja", audioRange: { startMs: 0, endMs: 100 } };
}

function translation(sourceRevision = 1, translationRevision = 1, final = false, session = identity): TranslationRevision {
  return { identity: session, utteranceId: "u1", sourceRevision, translationRevision, final, text: `translation ${translationRevision}`, languages };
}

function playback(type: PlaybackEvent["type"], session = identity, sequence = 0): PlaybackEvent {
  return { identity: session, sequence, type, anchor: { clockId: "capture", monotonicMs: 1000, mediaTimeMs: 9000, playbackRate: 2 } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function stream<T>() {
  const values: T[] = [];
  let waiter: ((value: IteratorResult<T>) => void) | undefined;
  let ended = false;
  return {
    push(value: T) {
      if (waiter) { const receive = waiter; waiter = undefined; receive({ done: false, value }); }
      else values.push(value);
    },
    close() { ended = true; waiter?.({ done: true, value: undefined }); waiter = undefined; },
    events: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = values.shift();
            if (value !== undefined) return Promise.resolve({ done: false, value });
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => { waiter = resolve; });
          },
        };
      },
    },
  };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Expected asynchronous state was not reached");
}

function harness() {
  const captions: CaptionRevision[] = [];
  const statuses: SessionStatus[] = [];
  const cleared: SessionIdentity[] = [];
  const inputs: { identity: SessionIdentity; feed: ReturnType<typeof stream<AudioChunk | PlaybackEvent>>; closes: number }[] = [];
  const engines: {
    port: InterpretationEngine; feed: ReturnType<typeof stream<InterpretationEvent>>;
    preparations: SessionIdentity[]; cancelled: SessionIdentity[]; closes: number; feeds: ReturnType<typeof stream<InterpretationEvent>>[];
  }[] = [];
  let nextPreparation: Promise<void> | undefined;
  let nextOpen: Promise<void> | undefined;
  let nextProbe: Promise<EngineCapabilities> | undefined;
  let sessionNumber = 0;
  const input: VideoInput = {
    async probe() { return { state: "available" }; },
    async open(_target, session) {
      const pending = nextOpen;
      nextOpen = undefined;
      const opened = { identity: session, feed: stream<AudioChunk | PlaybackEvent>(), closes: 0 };
      inputs.push(opened);
      await pending;
      return { events: opened.feed.events, async close() { opened.closes++; opened.feed.close(); } };
    },
  };
  const controller = createSessionController({
    input,
    createSessionId: () => `s${++sessionNumber}`,
    createEngine() {
      const pendingPrepare = nextPreparation;
      const pendingProbe = nextProbe;
      nextPreparation = undefined;
      nextProbe = undefined;
      const record = {
        feed: stream<InterpretationEvent>(), feeds: [] as ReturnType<typeof stream<InterpretationEvent>>[],
        preparations: [] as SessionIdentity[], cancelled: [] as SessionIdentity[], closes: 0,
        port: {} as InterpretationEngine,
      };
      record.port = {
        async probe() { return pendingProbe ? await pendingProbe : capabilities; },
        async prepare(session) { record.preparations.push(session); await pendingPrepare; },
        run() {
          record.feed = stream<InterpretationEvent>();
          record.feeds.push(record.feed);
          return record.feed.events;
        },
        async cancel(session) { record.cancelled.push(session); },
        async close() { record.closes++; },
      };
      engines.push(record);
      return record.port;
    },
    onCaption: (caption) => captions.push(caption),
    onClear: (session) => cleared.push(session),
    onStatus: (status) => statuses.push(status),
  });
  return { controller, captions, statuses, cleared, inputs, engines, input,
    prepareLater(promise: Promise<void>) { nextPreparation = promise; },
    openLater(promise: Promise<void>) { nextOpen = promise; },
    probeLater(promise: Promise<EngineCapabilities>) { nextProbe = promise; },
  };
}

test("audio queue enforces byte/duration bounds, reports exact loss and wakes consumers on close", async () => {
  const queue = createAudioQueue(identity, limits);
  assert.deepEqual(queue.push(audio()), { state: "accepted" });
  assert.deepEqual(queue.push(audio(1)), { state: "accepted" });
  assert.equal(queue.pendingMs, 200);
  assert.deepEqual(queue.push(audio(2)), { state: "overflow", droppedMs: 300 });
  assert.equal(queue.pendingMs, 0);
  const iterator = queue.stream[Symbol.asyncIterator]();
  const waiting = iterator.next();
  assert.deepEqual(queue.push(audio(3)), { state: "accepted" });
  assert.equal((await waiting).value?.sequence, 3);
  assert.equal(queue.pendingMs, 0);
  const stopped = iterator.next();
  queue.close();
  queue.close();
  assert.equal((await stopped).done, true);
  assert.deepEqual(queue.push(audio()), { state: "rejected" });
  const small = createAudioQueue(identity, { ...limits, maxChunkBytes: 100 });
  assert.deepEqual(small.push(audio()), { state: "overflow", droppedMs: 100 });
  assert.throws(() => createAudioQueue(identity, { ...limits, maxAudioQueueMs: Infinity }));
});

test("queue rejects stale identity and malformed PCM instead of counting them as captured audio", () => {
  const queue = createAudioQueue(identity, limits);
  for (const chunk of [audio(0, { ...identity, epoch: 1 }), { ...audio(), sampleRate: NaN },
    { ...audio(), pcm: new ArrayBuffer(199) }, { ...audio(), sequence: -1 },
    { ...audio(), capture: { clockId: "capture", startMs: 0, endMs: 5 } }]) {
    assert.deepEqual(queue.push(chunk), { state: "rejected" });
  }
  assert.equal(queue.pendingMs, 0);
});

test("timeline maps only one clock and continuous epoch; seek invalidates old anchors and audio", () => {
  const timeline = createTimeline(identity);
  assert.equal(timeline.playback(playback("play")), true);
  assert.equal(timeline.audio(audio()), "accepted");
  assert.deepEqual(timeline.map({ startMs: 0, endMs: 100 }), { startMs: 9000, endMs: 9200 });
  assert.equal(timeline.audio(audio()), "stale");
  assert.equal(timeline.audio(audio(2)), "gap");
  assert.equal(timeline.audio({ ...audio(1), capture: { clockId: "other", startMs: 1100, endMs: 1200 } }), "gap");
  const next = timeline.advance();
  assert.equal(next.epoch, 1);
  assert.equal(timeline.audio(audio()), "stale");
  assert.equal(timeline.map({ startMs: 0, endMs: 100 }), undefined);
  assert.equal(timeline.playback(playback("play", next)), true);
  assert.equal(timeline.audio({ ...audio(0, next), capture: { clockId: "other", startMs: 10, endMs: 110 } }), "accepted");
  assert.equal(timeline.map({ startMs: 0, endMs: 100 }), undefined, "Different process clocks cannot be subtracted");
  assert.equal(timeline.playback(playback("seek", next)), false, "Late playback sequence cannot replace anchor");
});

test("revision store pairs exact revisions, permits final correction, rejects stale/final regression and malformed atomic pairs", () => {
  const store = createRevisionStore(identity, 3);
  const acceptSource = (revision: TranscriptRevision) => store.accept({ type: "transcript", revision });
  const acceptTranslation = (revision: TranslationRevision) => store.accept({ type: "translation", revision });
  assert.equal(acceptSource(source())?.translation.state, "pending");
  assert.equal(acceptTranslation(translation())?.translation.state, "paired");
  assert.equal(acceptSource(source(2))?.translation.state, "pending");
  assert.equal(acceptTranslation(translation(1, 2)), undefined);
  assert.equal(acceptTranslation(translation(2, 2))?.translation.state, "paired");
  assert.equal(acceptSource(source(1)), undefined);
  assert.equal(acceptSource(source(3, true))?.source.final, true);
  assert.equal(acceptSource(source(4, false)), undefined);
  assert.equal(acceptTranslation(translation(3, 3, true))?.translation.state, "paired");
  assert.equal(acceptTranslation(translation(3, 4, false)), undefined);
  assert.ok(acceptSource(source(4, true)));
  assert.equal(acceptTranslation(translation(4, 3, true)), undefined, "Pending source must retain translation revision watermark");
  assert.equal(acceptTranslation(translation(4, 4, false))?.translation.state, "paired", "A new source revision starts its own translation stream");
  assert.equal(acceptTranslation(translation(4, 5, true))?.translation.state, "paired");
  assert.equal(store.accept({ type: "paired-caption", caption: { source: source(5, true), translation: { state: "paired", revision: translation(4, 5, true) } } }), undefined);
  assert.equal(store.snapshot()[0].source.sourceRevision, 4, "Invalid pair must not partly update source");
  assert.ok(store.accept({ type: "paired-caption", caption: { source: source(5, true), translation: { state: "paired", revision: translation(5, 6, true) } } }));
  assert.equal(acceptSource(source(6, true, { ...identity, epoch: 9 })), undefined);
  assert.equal(acceptTranslation({ ...translation(5, 5, true), languages: { source: "en", target: "ko" } }), undefined);
  assert.equal(acceptSource({ ...source(6, true), sourceRevision: NaN }), undefined);
});

test("revision history is bounded, retains prior epochs and cannot resurrect an evicted utterance", () => {
  const store = createRevisionStore(identity, 2);
  for (let index = 0; index < 3; index++) {
    store.accept({ type: "transcript", revision: { ...source(1, true, identity, `u${index}`), audioRange: { startMs: index * 100, endMs: (index + 1) * 100 } } });
  }
  assert.deepEqual(store.snapshot().map((caption) => caption.source.utteranceId), ["u1", "u2"]);
  assert.equal(store.accept({ type: "transcript", revision: source(2, true, identity, "u0") }), undefined);
  const next = { ...identity, epoch: 1 };
  store.activate(next);
  assert.equal(store.accept({ type: "transcript", revision: source(2, true) }), undefined);
  assert.ok(store.accept({ type: "transcript", revision: source(1, false, next) }));
  assert.equal(store.snapshot().length, 2);
});

test("Stop during preparation invalidates synchronously and never opens input after late completion", async () => {
  const h = harness();
  const preparation = deferred<void>();
  h.prepareLater(preparation.promise);
  const started = h.controller.start(target, languages);
  await until(() => h.engines[0].preparations.length === 1);
  const stopped = h.controller.stop();
  assert.equal(h.controller.identity, undefined);
  await stopped;
  assert.equal(h.engines[0].closes, 1);
  preparation.resolve();
  await started;
  assert.equal(h.inputs.length, 0);
  await h.controller.stop();
  assert.equal(h.engines[0].closes, 1, "Cleanup is idempotent");
});

test("Stop while input opens closes the late session handle exactly once", async () => {
  const h = harness();
  const opening = deferred<void>();
  h.openLater(opening.promise);
  const started = h.controller.start(target, languages);
  await until(() => h.inputs.length === 1);
  await h.controller.stop();
  opening.resolve();
  await started;
  assert.equal(h.inputs[0].closes, 1);
  assert.equal(h.statuses.filter((status) => status.state === "running").length, 0);
});

test("consecutive Start isolates engines/settings and drops late preparation and old events", async () => {
  const h = harness();
  const preparation = deferred<void>();
  h.prepareLater(preparation.promise);
  const first = h.controller.start(target, languages);
  await until(() => h.engines[0].preparations.length === 1);
  await h.controller.start(target, { source: "en", target: "ko" });
  assert.equal(h.controller.identity?.sessionId, "s2");
  assert.equal(h.engines[0].closes, 1);
  assert.equal(h.engines[1].closes, 0);
  preparation.resolve();
  await first;
  assert.equal(h.inputs.length, 1);
  h.engines[1].feed.push({ type: "transcript", revision: source() });
  const next = h.controller.identity as SessionIdentity;
  h.engines[1].feed.push({ type: "transcript", revision: { ...source(1, false, next), language: "en" } });
  await until(() => h.captions.length === 1);
  assert.equal(h.captions[0].source.identity.sessionId, "s2");
  await h.controller.stop();
  assert.equal(h.inputs[0].closes, 1);
});

test("seek cancels old epoch before awaiting cleanup and rejects late results; pause/resume retains history", async () => {
  const h = harness();
  await h.controller.start(target, languages);
  const first = h.controller.identity as SessionIdentity;
  h.inputs[0].feed.push(playback("play", first));
  h.inputs[0].feed.push(audio(0, first));
  h.engines[0].feed.push({ type: "transcript", revision: source(1, true, first) });
  await until(() => h.captions.length === 1);
  const seek = h.controller.playback(playback("seek", first, 1));
  assert.equal(h.controller.identity?.epoch, 1, "Epoch changes synchronously before engine cancellation");
  h.engines[0].feed.push({ type: "transcript", revision: source(2, true, first) });
  await seek;
  assert.equal(h.inputs[0].closes, 1);
  assert.deepEqual(h.engines[0].cancelled[0], first);
  assert.equal(h.captions.length, 1);
  const second = h.controller.identity as SessionIdentity;
  await h.controller.playback(playback("pause", second));
  assert.equal(h.statuses.at(-1)?.state, "paused");
  assert.equal(h.inputs[1].closes, 1);
  assert.equal(h.controller.snapshot().length, 1);
  await h.controller.playback(playback("play", h.controller.identity as SessionIdentity));
  assert.equal(h.controller.identity?.epoch, 3);
  assert.equal(h.inputs.length, 3);
  await h.controller.stop();
  assert.equal(h.controller.snapshot().length, 1, "Stop retains comparison history");
});

test("rate/source changes and suspension invalidate inference, reprobe on resume and clear overlay", async () => {
  const h = harness();
  let probes = 0;
  h.input.probe = async () => { probes++; return { state: "available" }; };
  await h.controller.start(target, languages);
  for (const type of ["rate", "source"] as const) {
    const old = h.controller.identity as SessionIdentity;
    await h.controller.playback(playback(type, old));
    assert.equal(h.controller.identity?.epoch, old.epoch + 1);
  }
  await h.controller.suspend();
  assert.equal(h.statuses.at(-1)?.reason, "suspended");
  assert.equal(h.inputs.length, 3);
  await h.controller.playback(playback("play", h.controller.identity as SessionIdentity));
  assert.equal(probes, 4);
  assert.equal(h.cleared.length, 4);
  await h.controller.stop();
});

test("overload and sample gaps report loss, pause without retries and require explicit resume", async () => {
  for (const gap of [false, true]) {
    const h = harness();
    await h.controller.start(target, languages);
    const first = h.controller.identity as SessionIdentity;
    h.inputs[0].feed.push(audio(0, first));
    h.inputs[0].feed.push(audio(gap ? 2 : 1, first));
    if (!gap) h.inputs[0].feed.push(audio(2, first));
    await until(() => h.statuses.some((status) => status.reason === (gap ? "audio-gap" : "overloaded")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.controller.identity?.epoch, 1);
    assert.equal(h.inputs[0].closes, 1);
    assert.equal(h.inputs.length, 1, "Loss must not trigger unbounded automatic preparation/capture retries");
    assert.equal(h.statuses.at(-1)?.state, "paused");
    const loss = h.statuses.find((status) => status.reason === (gap ? "audio-gap" : "overloaded"));
    assert.equal(loss?.queue?.droppedAudioMs, 300);
    h.engines[0].feed.push({ type: "transcript", revision: source(1, true, first) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.captions.length, 0);
    await h.controller.playback(playback("play", h.controller.identity as SessionIdentity));
    assert.equal(h.inputs.length, 2);
    await h.controller.stop();
  }
});

test("unavailable media and late probe cannot open capture; cleanup failures are observable and still close engine", async () => {
  const h = harness();
  h.input.probe = async () => ({ state: "unavailable", reason: "media-access-denied", message: "No sample route" });
  await h.controller.start(target, languages);
  assert.equal(h.statuses.at(-1)?.state, "unavailable");
  assert.equal(h.inputs.length, 0);
  await h.controller.stop();
  const late = harness();
  const probing = deferred<EngineCapabilities>();
  late.probeLater(probing.promise);
  const started = late.controller.start(target, languages);
  await until(() => late.statuses.some((status) => status.state === "probing"));
  await late.controller.stop();
  probing.resolve(capabilities);
  await started;
  assert.equal(late.inputs.length, 0);
  const broken = harness();
  await broken.controller.start(target, languages);
  broken.engines[0].port.cancel = () => { throw new Error("cancel failed"); };
  await assert.rejects(broken.controller.stop(), /cancel failed/);
  assert.equal(broken.inputs[0].closes, 1);
  assert.equal(broken.engines[0].closes, 1);
  assert.equal(broken.statuses.at(-1)?.state, "failed");
});

test("synthetic input traverses queue/engine/store with video times and matching language pair; Stop fences late captions", async () => {
  const feed = stream<AudioChunk | PlaybackEvent>();
  const received: AudioChunk[] = [];
  const captions: CaptionRevision[] = [];
  const statuses: SessionStatus[] = [];
  const controller = createSessionController({
    input: {
      async probe() { return { state: "available" }; },
      async open() { return { events: feed.events, async close() { feed.close(); } }; },
    },
    createSessionId: () => identity.sessionId,
    createEngine: () => ({
      async probe() { return capabilities; },
      async prepare() {},
      async *run(chunks) {
        for await (const chunk of chunks) {
          received.push(chunk);
          yield { type: "transcript", revision: { ...source(), language: "en" } };
          yield { type: "transcript", revision: source() };
          yield { type: "translation", revision: { ...translation(), languages: { source: "ja", target: "en" } } };
          yield { type: "translation", revision: translation() };
        }
        yield { type: "transcript", revision: source(2, true) };
      },
      async cancel() {},
      async close() {},
    }),
    onCaption: (caption) => captions.push(caption), onClear() {}, onStatus: (status) => statuses.push(status),
  });
  await controller.start(target, languages);
  feed.push(playback("play"));
  feed.push(audio());
  await until(() => captions.length === 2);
  assert.equal(received.length, 1);
  assert.equal(received[0].pcm.byteLength, 200);
  assert.equal(captions[0].translation.state, "pending");
  assert.equal(captions[1].translation.state, "paired");
  assert.deepEqual(captions[1].videoRange, { startMs: 9000, endMs: 9200 });
  await controller.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(captions.length, 2);
  assert.equal(statuses.at(-1)?.state, "idle");
});

test("automatic sessions accept each supported source language while retaining exact translation pairing", async () => {
  const h = harness();
  const automatic = { source: "auto", target: "ko" };
  h.probeLater(Promise.resolve({ ...capabilities, languages: automatic }));
  await h.controller.start(target, automatic);
  const session = h.controller.identity as SessionIdentity;
  try {
    for (const [index, language] of ["en", "ja", "ko"].entries()) {
      const original = { ...source(1, true, session, `turn-${index}`), language,
        audioRange: { startMs: index * 100, endMs: (index + 1) * 100 } };
      h.engines[0].feed.push({ type: "transcript", revision: original });
      h.engines[0].feed.push({ type: "translation", revision: { ...translation(1, 1, true, session),
        utteranceId: original.utteranceId, languages: { source: language, target: "ko" } } });
    }
    h.engines[0].feed.push({ type: "transcript", revision: { ...source(1, true, session, "unsupported"), language: "fr" } });
    await until(() => h.controller.snapshot().filter(caption => caption.translation.state === "paired").length === 3);
    const captions = h.controller.snapshot();
    assert.deepEqual(captions.map(caption => caption.source.language), ["en", "ja", "ko"]);
    assert.ok(captions.every(caption => caption.translation.state === "paired"
      && caption.source.language === caption.translation.revision.languages.source));
  } finally { await h.controller.stop(); }
});
