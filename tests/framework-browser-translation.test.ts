import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaptionRevision, MediaTargetId, TextTranslator, TranscriptRevision, TranslationRevision } from "../packages/contracts";
import { createDocumentTranslator } from "../packages/engines-browser/document-translator";
import { createTranslationQueue } from "../packages/engines-browser/translation-queue";
import { createRevisionStore } from "../packages/core/revision-store";

const identity = { sessionId: "translation-test", targetId: "video" as MediaTargetId, epoch: 1 };
const pair = { source: "ja", target: "ko" };
const source = (utteranceId = "one", sourceRevision = 1, final = false): TranscriptRevision => ({
  identity: { ...identity }, utteranceId, sourceRevision, final, language: "ja", text: `synthetic ${sourceRevision}`,
  audioRange: { startMs: utteranceId === "one" ? 0 : 1000, endMs: 2000 },
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("a final filler correction withdraws the displayed draft and rejects its in-flight translation", async () => {
  const captions: CaptionRevision[] = []; const calls: TranscriptRevision[] = [];
  const pending = deferred<void>();
  const queue = createTranslationQueue(identity, pair, {
    async *translate(input, languages) {
      calls.push(input); await pending.promise;
      yield { identity, utteranceId: input.utteranceId, sourceRevision: input.sourceRevision,
        translationRevision: 1, languages, text: "늦은 번역", final: input.final };
    }, async cancel() { pending.resolve(); }, async close() {},
  }, 16, 300, caption => captions.push(caption), reason => assert.fail(reason));
  try {
    queue.accept({ ...source(), text: "それから本" });
    assert.equal(queue.accept({ ...source("one", 2, true), text: "ええ" }), true);
    assert.equal(captions.at(-1)?.source.retracted, true);
    pending.resolve(); await queue.whenIdle();
    assert.equal(calls.length, 1); assert.equal(captions.length, 2);
    assert.deepEqual(queue.snapshot(), []);
  } finally { await queue.cancel(); }
});

test("native translation streams paired drafts before completion and aborts on Stop", async () => {
  const f = fixture("offscreen");
  let controller!: ReadableStreamDefaultController<string>;
  let signal!: AbortSignal;
  Object.assign(f.native, { translateStreaming(_text: string, options: { signal: AbortSignal }) {
    signal = options.signal;
    return new ReadableStream<string>({ start(value) { controller = value; } });
  } });
  try {
    const prepared = f.host.prepare(); f.loads[0].resolve(f.native); await prepared;
    const stream = f.host.translate(source("one", 3, true), pair)[Symbol.asyncIterator]();
    const first = stream.next(); controller.enqueue("내일 ");
    const draft = (await first).value;
    assert.equal(draft?.text, "내일 "); assert.equal(draft?.final, false);
    assert.equal(draft?.sourceRevision, 3); assert.equal(f.calls.length, 0);
    const second = stream.next(); controller.enqueue("만나요.");
    assert.equal((await second).value?.text, "내일 만나요.");
    const finished = stream.next(); controller.close();
    assert.equal((await finished).value?.final, true); await stream.return?.();
    const stopped = f.host.translate(source("one", 4, true), pair)[Symbol.asyncIterator]().next();
    f.host.stop(); assert.equal(signal.aborted, true);
    await assert.rejects(stopped, /Abort/);
  } finally { await f.host.close(); }
});

test("a corrected final source accepts its own translation stream but rejects obsolete chunks", () => {
  const store = createRevisionStore(identity, 10);
  const first = source("one", 1, true);
  store.accept({ type: "transcript", revision: first });
  const translated = { identity, utteranceId: "one", sourceRevision: 1, translationRevision: 1, languages: pair, text: "첫 번역", final: true };
  store.accept({ type: "translation", revision: translated });
  store.accept({ type: "transcript", revision: source("one", 2, true) });
  assert.equal(store.accept({ type: "translation", revision: { ...translated, translationRevision: 2, final: false } }), undefined);
  const corrected = store.accept({ type: "translation", revision: { ...translated, sourceRevision: 2, translationRevision: 3, text: "교정 중", final: false } });
  assert.equal(corrected?.translation.state, "paired");
});

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Fake native API/translation tests verify contracts, never real accuracy.
function fixture(execution: "foreground" | "offscreen" = "foreground", selectedPair = pair) {
  const loads: ReturnType<typeof deferred<{ translate: (text: string, options: { signal: AbortSignal }) => Promise<string>; destroy: () => void }>>[] = [];
  const calls: { text: string; signal: AbortSignal; result: ReturnType<typeof deferred<string>> }[] = [];
  const signals: AbortSignal[] = [];
  const progresses: ((event: { loaded: number }) => void)[] = [];
  let destroyed = 0;
  const native = { translate(text: string, options: { signal: AbortSignal }) {
    const result = deferred<string>(); calls.push({ text, signal: options.signal, result }); return result.promise;
  }, destroy() { destroyed++; } };
  const document = Object.assign(new EventTarget(), { visibilityState: "visible", defaultView: Object.assign(new EventTarget(), {
    isSecureContext: true, navigator: { userActivation: { isActive: true } }, Translator: {
      async availability() { return "downloadable"; },
      create(options: { signal: AbortSignal; monitor: (monitor: { addEventListener: (type: string, handler: (event: { loaded: number }) => void) => void }) => void }) {
        signals.push(options.signal); options.monitor({ addEventListener(_type, handler) { progresses.push(handler); } });
        const result = deferred<typeof native>(); loads.push(result); return result.promise;
      },
    },
  }) });
  const statuses: { state: string; progress?: number; reason?: string }[] = [];
  const host = createDocumentTranslator(document as unknown as Document, selectedPair, status => statuses.push(status), execution);
  return { host, document, loads, native, calls, signals, progresses, statuses, destroyed: () => destroyed };
}

test("automatic translator prepares both native pairs once and reuses them when language changes", async () => {
  const f = fixture("offscreen", { source: "auto", target: "ko" });
  try {
    const prepared = f.host.prepare();
    assert.equal(f.loads.length, 2, "Both create calls must begin within the preparation gesture");
    f.loads.forEach(load => { load.resolve(f.native); }); await prepared;
    for (const [index, language] of ["en", "ja", "en"].entries()) {
      const input = { ...source(`turn-${index}`, 1, true), language };
      const stream = f.host.translate(input, { source: language, target: "ko" })[Symbol.asyncIterator]();
      const next = stream.next(); f.calls[index].result.resolve(`번역 ${index}`);
      const result = (await next).value;
      assert.equal(result?.languages.source, language); await stream.return?.();
    }
    assert.equal(f.loads.length, 2, "Switching language cannot reload a prepared translator");
  } finally { await f.host.close(); }
  assert.equal(f.destroyed(), 2);
});

test("a failed automatic preparation destroys the ready pair and rejects a late second pair", async () => {
  const f = fixture("offscreen", { source: "auto", target: "ko" });
  try {
    const prepared = f.host.prepare();
    f.loads[0].resolve(f.native); await tick();
    f.loads[1].reject(new Error("Second pair failed"));
    await assert.rejects(prepared, /Second pair failed/);
    assert.equal(f.destroyed(), 1);
    assert.ok(f.signals.every(signal => signal.aborted));
    const next = f.host.prepare(); f.host.stop();
    f.loads[2].resolve(f.native); f.loads[3].resolve(f.native);
    await assert.rejects(next, /Abort/); await tick();
    assert.equal(f.destroyed(), 3);
  } finally { await f.host.close(); }
});

test("late cancelled automatic preparation cannot destroy replacement translators", async () => {
  const f = fixture("offscreen", { source: "auto", target: "ko" });
  try {
    const old = f.host.prepare(); f.host.stop();
    const current = f.host.prepare();
    f.loads[2].resolve(f.native); f.loads[3].resolve(f.native); await current;
    f.loads[0].resolve(f.native); f.loads[1].resolve(f.native);
    await assert.rejects(old, /Abort/); await tick();
    assert.equal(f.destroyed(), 2, "Only the cancelled operation's late pairs are destroyed");
    const stream = f.host.translate({ ...source(), language: "en" }, { source: "en", target: "ko" })[Symbol.asyncIterator]();
    const next = stream.next(); f.calls[0].result.resolve("새 번역기");
    assert.equal((await next).value?.text, "새 번역기"); await stream.return?.();
  } finally { await f.host.close(); }
  assert.equal(f.destroyed(), 4);
});

test("offscreen Translator prepares and translates while hidden, with explicit Stop cancellation", async () => {
  const f = fixture("offscreen");
  f.document.visibilityState = "hidden"; f.document.defaultView.navigator.userActivation.isActive = false;
  try {
    const prepared = f.host.prepare();
    assert.equal(f.loads.length, 1, "Native create still enforces Chrome's platform gesture/download policy");
    f.document.dispatchEvent(new Event("visibilitychange"));
    f.loads[0].resolve(f.native); await prepared;
    const stream = f.host.translate(source(), pair)[Symbol.asyncIterator]();
    const result = stream.next(); f.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(f.calls[0].signal.aborted, false);
    f.calls[0].result.resolve("숨겨진 문서의 번역");
    assert.equal((await result).value?.text, "숨겨진 문서의 번역"); await stream.return?.();
    const interrupted = f.host.translate(source("two"), pair)[Symbol.asyncIterator]().next();
    f.host.stop(); assert.equal(f.calls[1].signal.aborted, true);
    f.calls[1].result.resolve("늦은 번역"); await assert.rejects(interrupted, /Abort/);
  } finally { await f.host.close(); }
});

test("document Translator probes real API states without creation and preserves synchronous activation", async () => {
  const f = fixture();
  try {
    assert.equal((await f.host.probe()).state, "download-required"); assert.equal(f.loads.length, 0);
    f.document.defaultView.navigator.userActivation.isActive = false;
    await assert.rejects(f.host.prepare(), /Press Prepare/); assert.equal(f.loads.length, 0);
    f.document.defaultView.navigator.userActivation.isActive = true;
    const prepared = f.host.prepare();
    assert.equal(f.loads.length, 1, "Create happens before the activation task can finish");
    await assert.rejects(f.host.prepare(), /Stop before/);
    for (const loaded of [-1, Number.NaN, 1.1, 0, 0.5, 1]) f.progresses[0]({ loaded });
    assert.deepEqual(f.statuses.filter(s => s.progress !== undefined).map(s => s.progress), [0, 0.5, 1]);
    assert.equal(f.statuses.some(s => s.state === "ready"), false, "Progress 1 is not a loaded translator");
    f.loads[0].resolve(f.native); await prepared; assert.equal(f.statuses.at(-1)?.state, "ready");
    const input = source(); const iterator = f.host.translate(input, pair)[Symbol.asyncIterator](); const result = iterator.next();
    (input.identity as { epoch: number }).epoch = 9;
    f.calls[0].result.resolve("합성 번역");
    const translated = (await result).value as TranslationRevision;
    assert.deepEqual(translated.identity, identity); assert.equal(translated.sourceRevision, 1);
    assert.equal(translated.final, true, "Generation completion is independent of provisional recognition");
    assert.equal(translated.translationRevision, 1); assert.deepEqual(translated.languages, pair);
    await iterator.return?.();
    await assert.rejects(f.host.translate(source(), { source: "ja", target: "en" })[Symbol.asyncIterator]().next(), /language-pair-unsupported/);
    await assert.rejects(f.host.translate({ ...source(), text: "x".repeat(16385) }, pair)[Symbol.asyncIterator]().next(), /Invalid translation source/);
  } finally { await f.host.close(); }
});

test("document Translator retains preparation and ready resources across hidden tabs, but pagehide still cancels", async () => {
  const f = fixture();
  try {
    const prepared = f.host.prepare();
    f.document.visibilityState = "hidden"; f.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(f.signals[0].aborted, false);
    f.loads[0].resolve(f.native); await prepared;
    f.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(f.destroyed(), 0);
    await assert.rejects(f.host.translate(source(), pair)[Symbol.asyncIterator]().next(), /execution-context-unavailable/);
    f.document.visibilityState = "visible"; f.document.dispatchEvent(new Event("visibilitychange"));
    f.document.defaultView.Translator.availability = async () => "available";
    assert.equal((await f.host.probe()).state, "available");
    const stream = f.host.translate(source(), pair)[Symbol.asyncIterator]();
    const translated = stream.next(); f.calls[0].result.resolve("돌아온 뒤 번역");
    assert.equal((await translated).value?.text, "돌아온 뒤 번역"); await stream.return?.();
    f.host.stop();
    const closing = f.host.prepare();
    f.document.defaultView.dispatchEvent(new Event("pagehide"));
    assert.equal(f.signals[1].aborted, true);
    f.loads[1].resolve(f.native); await assert.rejects(closing, { name: "AbortError" });
    assert.equal(f.destroyed(), 2);
  } finally { await f.host.close(); }
});

test("document Translator cancels matching epochs, suppresses late preparation/results and destroys only owned instances", async () => {
  const f = fixture();
  try {
    const preparing = f.host.prepare(); f.host.stop();
    assert.equal(f.signals[0].aborted, true);
    const statusCount = f.statuses.length;
    f.progresses[0]({ loaded: 1 }); f.loads[0].resolve(f.native);
    await assert.rejects(preparing, { name: "AbortError" }); assert.equal(f.destroyed(), 1);
    assert.equal(f.statuses.length, statusCount);
    const prepared = f.host.prepare(); f.loads[1].resolve(f.native); await prepared;
    const iterator = f.host.translate(source(), pair)[Symbol.asyncIterator](); const late = iterator.next();
    await assert.rejects(f.host.translate(source("two"), pair)[Symbol.asyncIterator]().next(), /overloaded/);
    await f.host.cancel({ ...identity, epoch: 2 }); assert.equal(f.calls[0].signal.aborted, false);
    await f.host.cancel(identity); assert.equal(f.calls[0].signal.aborted, true);
    const next = f.host.translate(source("two", 2, true), pair)[Symbol.asyncIterator](); const nextResult = next.next();
    f.calls[0].result.resolve("late"); await assert.rejects(late, { name: "AbortError" });
    f.calls[1].result.resolve("current"); assert.equal(((await nextResult).value as TranslationRevision).sourceRevision, 2); await next.return?.();
    const hidden = f.host.translate(source(), pair)[Symbol.asyncIterator]().next();
    f.document.visibilityState = "hidden"; f.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(f.calls[2].signal.aborted, true); f.calls[2].result.resolve("hidden"); await assert.rejects(hidden, { name: "AbortError" });
    assert.equal((await f.host.probe()).state, "unavailable");
    f.document.visibilityState = "visible";
    await assert.rejects(f.host.translate(source(), pair)[Symbol.asyncIterator]().next(), /model-load-failed/);
    const failed = f.host.prepare(); f.loads[2].reject(new DOMException("unsupported", "NotSupportedError"));
    await assert.rejects(failed, { name: "NotSupportedError" }); assert.equal(f.statuses.at(-1)?.reason, "language-pair-unsupported");
    await f.host.close(); await f.host.close(); await assert.rejects(f.host.prepare(), /execution-context-unavailable/);
  } finally { await f.host.close(); }
});

test("document Translator reports missing API, unsupported pair and unavailable capability without fallback", async () => {
  const f = fixture();
  try {
    f.document.defaultView.Translator.availability = async () => "unavailable";
    assert.deepEqual(await f.host.probe(), { state: "unavailable", reason: "language-pair-unsupported", message: "Browser cannot translate this language pair" });
    const other = createDocumentTranslator(f.document as unknown as Document, { source: "fr", target: "ko" }, () => {});
    assert.deepEqual(await other.probe(), { state: "unavailable", reason: "language-pair-unsupported", message: "Only Japanese/English to Korean is supported by this adapter" }); await assert.rejects(other.prepare(), /language-pair-unsupported/); await other.close();
    Reflect.deleteProperty(f.document.defaultView, "Translator");
    assert.deepEqual(await f.host.probe(), { state: "unavailable", reason: "execution-context-unavailable", message: "Translator requires an eligible visible secure document" }); await assert.rejects(f.host.prepare(), /execution-context-unavailable/);
    assert.equal(f.loads.length, 0);
  } finally { await f.host.close(); }
});

function queued(limit = 3) {
  const calls: { source: TranscriptRevision; result: ReturnType<typeof deferred<string>> }[] = [];
  const captions: CaptionRevision[] = []; const failures: string[] = []; let revision = 0; let cancellations = 0;
  const translator: TextTranslator = { async *translate(source, languages) {
    const result = deferred<string>(); calls.push({ source, result });
    yield { identity: source.identity, utteranceId: source.utteranceId, sourceRevision: source.sourceRevision,
      translationRevision: ++revision, languages, text: await result.promise, final: source.final };
  }, async cancel() { cancellations++; }, async close() {} };
  const queue = createTranslationQueue(identity, pair, translator, limit, 300, caption => captions.push(caption), reason => failures.push(reason));
  return { queue, calls, captions, failures, cancellations: () => cancellations };
}

test("unchanged recognition finals reuse completed translation, including an in-flight stream", async () => {
  for (const confirmDuringGeneration of [false, true]) {
    const result = deferred<void>(); const calls: TranscriptRevision[] = []; const captions: CaptionRevision[] = [];
    const queue = createTranslationQueue(identity, pair, {
      streaming: true,
      async *translate(input, languages) {
        calls.push(input); await result.promise;
        yield { identity, utteranceId: input.utteranceId, sourceRevision: input.sourceRevision,
          translationRevision: calls.length, languages, text: "내일 만나요", final: true };
      }, async cancel() {}, async close() {},
    }, 2, 300, caption => captions.push(caption), reason => assert.fail(reason));
    queue.accept(source());
    if (!confirmDuringGeneration) { result.resolve(); await queue.whenIdle(); }
    queue.accept({ ...source("one", 2, true), text: source().text });
    result.resolve(); await queue.whenIdle();
    assert.equal(calls.length, 1, "Final confirmation must not run the model again for identical text");
    const completed = captions.at(-1); assert.equal(completed?.source.final, true);
    assert.equal(completed?.source.sourceRevision, 2);
    assert.equal(completed?.translation.state === "paired" ? completed.translation.revision.sourceRevision : undefined, 2);
    assert.equal(completed?.translation.state === "paired" ? completed.translation.revision.final : undefined, true);
    queue.accept(source("one", 3, true)); await queue.whenIdle();
    assert.equal(calls.length, 2, "A text correction still requires new inference");
    await queue.cancel();
  }
});

test("streaming translation stays paired while growing ASR drafts queue behind it", async () => {
  const chunks: ReturnType<typeof deferred<string>>[] = [];
  const calls: TranscriptRevision[] = [];
  const captions: CaptionRevision[] = [];
  let revision = 0;
  const translator: TextTranslator & { streaming: boolean } = {
    streaming: true,
    async *translate(input, languages) {
      calls.push(input);
      for (let index = 0; index < 2; index++) {
        const chunk = deferred<string>(); chunks.push(chunk);
        yield { identity, utteranceId: input.utteranceId, sourceRevision: input.sourceRevision,
          translationRevision: ++revision, languages, text: await chunk.promise, final: index === 1 && input.final };
      }
    }, async cancel() {}, async close() {},
  };
  const queue = createTranslationQueue(identity, pair, translator, 2, 300, caption => captions.push(caption), reason => assert.fail(reason));
  queue.accept(source());
  queue.accept(source("one", 2)); queue.accept(source("one", 3));
  chunks[0].resolve("먼저 "); await tick();
  const first = captions.find(caption => caption.translation.state === "paired");
  assert.equal(first?.source.sourceRevision, 1, "The pinned source must receive Korean while speech continues");
  assert.equal(first?.source.final, false);
  chunks[1].resolve("먼저 번역"); await tick();
  assert.equal(calls[1].sourceRevision, 3, "Coalesce incoming recognition corrections without starving the active stream");
  assert.equal(queue.accept(source("one", 2)), false, "Queued source revisions cannot go backwards");
  queue.accept(source("one", 4, true));
  chunks[2].resolve("교정 중 "); await tick();
  chunks[3].resolve("교정 중 번역"); await tick();
  assert.equal(calls[2].sourceRevision, 4);
  chunks[4].resolve("최종 "); await tick(); chunks[5].resolve("최종 번역");
  await queue.whenIdle();
  assert.equal(captions.at(-1)?.source.sourceRevision, 4);
  assert.ok(captions.every(caption => caption.translation.state !== "paired" || caption.source.sourceRevision === caption.translation.revision.sourceRevision));
});

test("streaming language corrections bypass Korean immediately and reject the old language", async () => {
  const chunks: ReturnType<typeof deferred<string>>[] = [];
  const calls: TranscriptRevision[] = [];
  const captions: CaptionRevision[] = [];
  let revision = 10;
  const translator: TextTranslator = { streaming: true, async *translate(input, languages) {
    calls.push(input);
    for (let index = 0; index < 2; index++) {
      const chunk = deferred<string>(); chunks.push(chunk);
      yield { identity, utteranceId: input.utteranceId, sourceRevision: input.sourceRevision,
        translationRevision: ++revision, languages, text: await chunk.promise, final: input.final && index === 1 };
    }
  }, async cancel() {}, async close() {} };
  const queue = createTranslationQueue(identity, { source: "auto", target: "ko" }, translator, 2, 300,
    caption => captions.push(caption), reason => assert.fail(reason));
  queue.accept(source()); chunks[0].resolve("일본어 번역"); await tick();
  queue.accept({ ...source("one", 2), language: "ko", text: "한국어 교정" });
  const korean = captions.at(-1);
  assert.equal(korean?.translation.state === "paired" ? korean.translation.revision.text : undefined, "한국어 교정");
  queue.accept(source("one", 3, true));
  const corrected = captions.at(-1);
  assert.equal(corrected?.source.sourceRevision, 3, "Returning to Japanese must retire the previously pinned language");
  chunks[1].resolve("폐기할 일본어"); await tick();
  assert.equal(captions.at(-1), corrected);
  chunks[2].resolve("다시 번역 중"); await tick(); chunks[3].resolve("다시 번역 완료");
  await queue.whenIdle();
  assert.deepEqual(calls.map(input => input.language), ["ja", "ja"]);
  const last = captions.at(-1);
  assert.equal(last?.translation.state === "paired" ? last.translation.revision.text : undefined, "다시 번역 완료");
});

test("translation queue skips filler-only speech but preserves meaningful short and mixed speech", async () => {
  const f = queued();
  for (const text of ["えー…", "うーん、ああ〜", "う～ん…", "ん〜", "おー！", "あー えっと…", " … "]) {
    assert.equal(f.queue.accept({ ...source(), text, final: true }), false, text);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.captions.length, 0);
  assert.equal(f.queue.snapshot().length, 0);
  for (const text of ["はい。", "いいえ。", "うん。", "ううん。", "あの", "ああ、予約は取り消さないでください。", "音", "海"]) {
    assert.equal(f.queue.accept({ ...source(text), text, final: true }), true, text);
    f.calls.at(-1)?.result.resolve("의미 있는 번역");
    await f.queue.whenIdle();
  }
  assert.equal(f.calls.length, 8);
  assert.deepEqual(f.failures, []);
});

test("English and Korean fillers skip translation without removing short answers or real sentences", async () => {
  for (const [language, fillers, meaningful] of [
    ["en", ["Um…", "uh, hmm~", "Oh!", "ahhh", "erm…"], ["No.", "Yes.", "Oh no!", "Um, please do not cancel it.", "umbrella"]],
    ["ko", ["음~", "오~", "어…", "흠, 음…"], ["네.", "아니요.", "오, 예약은 취소하지 마세요.", "음악", "오늘"]],
  ] as const) {
    const calls: string[] = [];
    const translator: TextTranslator = { async *translate(source, languages) {
      calls.push(source.text);
      yield { identity, utteranceId: source.utteranceId, sourceRevision: 1, translationRevision: 1, languages, text: "meaningful", final: true };
    }, async cancel() {}, async close() {} };
    const queue = createTranslationQueue(identity, { source: language, target: "ko" }, translator, 4, 300, () => {}, () => assert.fail("Unexpected failure"));
    for (const text of fillers) assert.equal(queue.accept({ ...source(), language, text, final: true }), false, text);
    for (const text of meaningful) {
      assert.equal(queue.accept({ ...source(text), language, text, final: true }), true, text);
      await queue.whenIdle();
    }
    assert.deepEqual(calls, language === "ko" ? [] : [...meaningful]);
    if (language === "ko") assert.deepEqual(queue.snapshot().map(caption => caption.translation.state === "paired" ? caption.translation.revision.text : undefined), [...meaningful]);
  }
});

test("translation queue paints sources first, coalesces revisions, prioritizes finals and rejects stale pairs", async () => {
  const f = queued(4);
  assert.equal(f.queue.accept(source()), true); assert.equal(f.captions[0].translation.state, "pending");
  assert.equal(f.queue.accept(source("one", 2)), true); assert.equal(f.queue.accept(source("one", 3)), true);
  assert.equal(f.queue.accept(source("two")), true); assert.equal(f.queue.accept(source("three", 1, true)), true);
  assert.equal(f.calls.length, 1);
  f.calls[0].result.resolve("stale"); await tick();
  assert.equal(f.captions.filter(c => c.translation.state === "paired").length, 0);
  assert.equal(f.calls[1].source.utteranceId, "three", "Final bypasses queued partials");
  f.calls[1].result.resolve("final"); await tick();
  assert.equal(f.calls[2].source.sourceRevision, 3, "Only the newest queued revision executes");
  f.calls[2].result.resolve("latest"); await tick(); f.calls[3].result.resolve("two"); await tick();
  assert.equal(f.calls.length, 4); assert.deepEqual(f.failures, []);
  assert.equal(f.queue.accept(source("three", 2, false)), false, "Final cannot regress to partial");
  assert.equal(f.queue.accept({ ...source("three", 2, true), identity: { ...identity, epoch: 0 } }), false);
  assert.equal(f.queue.snapshot().find(c => c.source.utteranceId === "one")?.source.sourceRevision, 3);
  const lateSource = source("late", 1, true); assert.equal(f.queue.accept(lateSource), true);
  await f.queue.cancel(); await f.queue.cancel(); f.calls[4].result.resolve("after Stop"); await tick();
  assert.equal(f.cancellations(), 1); assert.equal(f.queue.accept(source("new")), false);
  assert.equal(f.queue.snapshot().find(c => c.source.utteranceId === "late")?.translation.state, "pending");
});

test("translation queue evicts queued provisional work before finals and reports a full final queue", async () => {
  const f = queued(2);
  f.queue.accept(source()); f.queue.accept(source("two"));
  assert.equal(f.queue.accept(source("three", 1, true)), true);
  assert.equal(f.queue.accept(source("four", 1, true)), false); assert.deepEqual(f.failures, ["overloaded"]);
  f.calls[0].result.resolve("one"); await tick(); assert.equal(f.calls[1].source.utteranceId, "three");
  f.calls[1].result.reject(new Error("native failure")); await tick();
  assert.deepEqual(f.failures, ["overloaded", "engine-failed"]); assert.equal(f.calls.length, 2);
  await f.queue.cancel();
});

test("a final revision of the active utterance fits a one-utterance queue", async () => {
  const f = queued(1);
  assert.equal(f.queue.accept(source()), true);
  assert.equal(f.queue.accept(source("one", 2, true)), true);
  assert.deepEqual(f.failures, []);
  f.calls[0].result.resolve("obsolete"); await tick();
  assert.equal(f.calls[1].source.sourceRevision, 2); assert.equal(f.calls[1].source.final, true);
  f.calls[1].result.resolve("final"); await tick();
  assert.equal(f.queue.snapshot()[0].translation.state, "paired");
  await f.queue.cancel();
});

test("translation idle wait includes queued finals and releases immediately on cancellation", async () => {
  const f = queued(2);
  await f.queue.whenIdle();
  f.queue.accept(source("one", 1, true)); f.queue.accept(source("two", 1, true));
  let settled = false; const waiting = f.queue.whenIdle().then(() => { settled = true; });
  f.calls[0].result.resolve("one"); await tick(); assert.equal(settled, false);
  f.calls[1].result.resolve("two"); await waiting; assert.equal(settled, true);
  f.queue.accept(source("three", 1, true));
  const cancelled = f.queue.whenIdle(); await f.queue.cancel(); await cancelled;
  f.calls[2].result.resolve("late"); await tick();
  assert.equal(f.queue.snapshot().find(c => c.source.utteranceId === "three")?.translation.state, "pending");
});


test("Japanese ASR phrase breaks preserve one complete translation revision", async () => {
  const f = fixture();
  try {
    const prepared = f.host.prepare(); f.loads[0].resolve(f.native); await prepared;
    const input = { ...source("phrases", 2, true), text: "今日は会議をしません 明日午後三時に駅で会いましょう 予約は取り消さないでください" };
    const iterator = f.host.translate(input, pair)[Symbol.asyncIterator](); const pending = iterator.next();
    assert.equal(f.calls[0].text, "今日は会議をしません");
    f.calls[0].result.resolve("오늘 회의하지 않습니다."); await tick();
    assert.equal(f.calls[1].text, "明日午後三時に駅で会いましょう");
    f.calls[1].result.resolve("내일 오후 세 시에 역에서 만납시다."); await tick();
    assert.equal(f.calls[2].text, "予約は取り消さないでください");
    f.calls[2].result.resolve("예약을 취소하지 마세요.");
    const translated = (await pending).value as TranslationRevision;
    assert.equal(translated.text, "오늘 회의하지 않습니다. 내일 오후 세 시에 역에서 만납시다. 예약을 취소하지 마세요.");
    assert.equal(translated.sourceRevision, 2); assert.equal(translated.final, true);
    assert.equal(translated.translationRevision, 1); assert.deepEqual(translated.identity, identity);
    assert.equal((await iterator.next()).done, true);
    assert.equal(input.text, "今日は会議をしません 明日午後三時に駅で会いましょう 予約は取り消さないでください");
    assert.ok(f.calls.every(call => call.signal === f.calls[0].signal));
  } finally { await f.host.close(); }
});

test("Japanese ASCII question marks preserve the following sentence in translation", async () => {
  const f = fixture();
  try {
    const prepared = f.host.prepare(); f.loads[0].resolve(f.native); await prepared;
    const iterator = f.host.translate({ ...source(), text: "日曜日の午後1時半はどう? 駅の東口で待ち合わせよう!" }, pair)[Symbol.asyncIterator]();
    const pending = iterator.next();
    assert.equal(f.calls[0].text, "日曜日の午後1時半はどう?");
    f.calls[0].result.resolve("일요일 오후 1시 반은 어때?"); await tick();
    assert.equal(f.calls[1].text, "駅の東口で待ち合わせよう!");
    f.calls[1].result.resolve("역 동쪽 출구에서 만나자!");
    assert.equal((await pending).value?.text, "일요일 오후 1시 반은 어때? 역 동쪽 출구에서 만나자!");
    await iterator.return?.();
  } finally { await f.host.close(); }
});

test("Japanese conversational endings separate unpunctuated clauses without splitting よく or relative verbs", async () => {
  const f = fixture();
  try {
    const prepared = f.host.prepare(); f.loads[0].resolve(f.native); await prepared;
    const iterator = f.host.translate({ ...source(), text: "最近野菜をよく食べてるんだキノコのスープがあるよ予約が必要か確認しておくねまだ予約は取り消さないでね" }, pair)[Symbol.asyncIterator]();
    const pending = iterator.next();
    for (const [index, text] of ["最近野菜をよく食べてるんだ", "キノコのスープがあるよ", "予約が必要か確認しておくね", "まだ予約は取り消さないでね"].entries()) {
      assert.equal(f.calls[index].text, text);
      f.calls[index].result.resolve(`문장 ${index}`); await tick();
    }
    assert.equal((await pending).value?.text, "문장 0 문장 1 문장 2 문장 3"); await iterator.return?.();
    const conversation = f.host.translate({ ...source(), text: "1時半なら大丈夫ところでそのカフェには肉を使わない料理もあるかな" }, pair)[Symbol.asyncIterator]();
    const joined = conversation.next(); assert.equal(f.calls[4].text, "1時半なら大丈夫");
    f.calls[4].result.resolve("1시 반이면 괜찮습니다."); await tick();
    assert.equal(f.calls[5].text, "ところでそのカフェには肉を使わない料理もあるかな");
    f.calls[5].result.resolve("고기를 사용하지 않는 요리도 있을까요?");
    assert.equal((await joined).value?.text, "1시 반이면 괜찮습니다. 고기를 사용하지 않는 요리도 있을까요?"); await conversation.return?.();
    const relative = f.host.translate({ ...source(), text: "昨日行った駅でよく本を読む きつね鍋を食べる" }, pair)[Symbol.asyncIterator]();
    const result = relative.next(); assert.equal(f.calls[6].text, "昨日行った駅でよく本を読む きつね鍋を食べる");
    f.calls[6].result.resolve("관계절을 보존한 문장"); await result; await relative.return?.();
  } finally { await f.host.close(); }
});

test("Japanese unpunctuated follow-up speech preserves both question and explanation in translation", async () => {
  for (const phrases of [
    ["こんなことがあったんですか", "まったく面倒なことになりましたよ"],
    ["うーんお社長とりあえずそんなこと忘れて遊んでいってくださいよ", "ちょうどね人らんきのいい子が入ってくる"],
  ]) {
    const f = fixture();
    try {
      const prepared = f.host.prepare(); f.loads[0].resolve(f.native); await prepared;
      const iterator = f.host.translate({ ...source(), text: phrases.join(""), final: true }, pair)[Symbol.asyncIterator]();
      const result = iterator.next();
      for (const [index, phrase] of phrases.entries()) {
        assert.equal(f.calls[index]?.text, phrase, "Each complete clause must reach the native translator");
        f.calls[index].result.resolve(`번역 ${index}`); await tick();
      }
      assert.equal((await result).value?.text, "번역 0 번역 1"); await iterator.return?.();
    } finally { await f.host.close(); }
  }
});

test("cancelling a Japanese phrase translation discards all parts and suppresses remaining native calls", async () => {
  const f = fixture();
  try {
    const prepared = f.host.prepare(); f.loads[0].resolve(f.native); await prepared;
    const pending = f.host.translate({ ...source(), text: "最初です 次です 最後です" }, pair)[Symbol.asyncIterator]().next();
    f.calls[0].result.resolve("첫째"); await tick();
    assert.equal(f.calls[1].text, "次です");
    await f.host.cancel(identity); assert.equal(f.calls[1].signal.aborted, true);
    f.calls[1].result.resolve("늦은 둘째");
    await assert.rejects(pending, { name: "AbortError" }); assert.equal(f.calls.length, 2);
    const fresh = f.host.translate(source("fresh", 2, true), pair)[Symbol.asyncIterator]();
    const current = fresh.next(); f.calls[2].result.resolve("현재");
    assert.equal(((await current).value as TranslationRevision).translationRevision, 1);
    await fresh.return?.();
  } finally { await f.host.close(); }
});

test("phrase translation rejects an empty part and bounds the complete Korean result", async () => {
  for (const second of ["", "x".repeat(8193)]) {
    const f = fixture();
    try {
      const prepared = f.host.prepare(); f.loads[0].resolve(f.native); await prepared;
      const pending = f.host.translate({ ...source(), text: "最初です 次です" }, pair)[Symbol.asyncIterator]().next();
      f.calls[0].result.resolve("x".repeat(8192)); await tick();
      f.calls[1].result.resolve(second);
      await assert.rejects(pending, /Invalid translation result/);
    } finally { await f.host.close(); }
  }
});


test("Japanese sentence boundaries retain word spacing and polite questions", async () => {
  for (const phrases of [["明日の 午後 三時に 駅で 会いましょう"], ["行きませんか", "今は 三時です"], ["来ますかと聞かれた質問です"], ["来ますかを確認してください"]]) {
    const f = fixture();
    try {
      const prepared = f.host.prepare(); f.loads[0].resolve(f.native); await prepared;
      const iterator = f.host.translate({ ...source(), text: phrases.join(" ") }, pair)[Symbol.asyncIterator]();
      const pending = iterator.next();
      for (const [index, phrase] of phrases.entries()) {
        assert.equal(f.calls[index]?.text, phrase);
        f.calls[index].result.resolve("합성 결과"); await tick();
      }
      await pending; assert.equal(f.calls.length, phrases.length); await iterator.return?.();
    } finally { await f.host.close(); }
  }
});
