import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaptionRevision, MediaTargetId, ModelStatus } from "../packages/contracts";
import { createChromeEngine } from "../apps/chrome/engine";
import { sameModelOptions, validModelOptions, type ModelOptions } from "../apps/chrome/model-options";
import { createDocumentTranslator } from "../packages/engines-browser/document-translator";
import { createLanguageHost } from "../packages/engines-browser/language-host";
import { createModelTranslator } from "../packages/engines-browser/model-translator";
import { createTranslationQueue } from "../packages/engines-browser/translation-queue";

const identity = { sessionId: "languages", targetId: "fixture" as MediaTargetId, epoch: 1 };
const languages = ["en", "ja", "ko"] as const;

test("all subtitle languages bypass same-language speech and translate every other direction with exact pairing", async () => {
  for (const target of languages) for (const automatic of [false, true]) {
    const calls: string[] = [];
    const captions: CaptionRevision[] = [];
    for (const language of languages) {
      const queue = createTranslationQueue(identity, { source: automatic ? "auto" : language, target }, {
        async *translate(source, pair) {
          calls.push(`${pair.source}:${pair.target}`);
          yield { identity, utteranceId: source.utteranceId, sourceRevision: source.sourceRevision, translationRevision: 1, languages: pair, text: `translated ${language}`, final: true };
        }, async cancel() {}, async close() {},
      }, 4, 10, caption => captions.push(caption), reason => assert.fail(reason));
      queue.accept({ identity, utteranceId: language, sourceRevision: 3, text: `original ${language}`, language, final: true, audioRange: { startMs: 0, endMs: 1000 } });
      await queue.whenIdle();
      const caption = queue.snapshot()[0];
      assert.equal(caption.translation.state, "paired");
      if (caption.translation.state !== "paired") assert.fail();
      assert.deepEqual(caption.translation.revision.languages, { source: language, target });
      assert.equal(caption.translation.revision.sourceRevision, 3);
      assert.equal(caption.translation.revision.text, target === language ? `original ${language}` : `translated ${language}`);
      await queue.cancel();
    }
    assert.deepEqual(calls, languages.filter(language => language !== target).map(language => `${language}:${target}`));
  }
});

function documentFixture() {
  const pairs: { sourceLanguage: string; targetLanguage: string }[] = [];
  const document = Object.assign(new EventTarget(), { visibilityState: "hidden", defaultView: Object.assign(new EventTarget(), {
    isSecureContext: true, navigator: { userActivation: { isActive: false } },
    Translator: {
      async availability() { return "available"; },
      async create(pair: { sourceLanguage: string; targetLanguage: string }) {
        pairs.push({ sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage });
        return { async translate(text: string) { return `${pair.targetLanguage}: ${text}`; }, destroy() {} };
      },
    },
  }) }) as unknown as Document;
  return { document, pairs };
}

test("native preparation opens exactly the needed pairs for each target, including Korean source", async () => {
  for (const target of languages) {
    const f = documentFixture();
    const host = createDocumentTranslator(f.document, { source: "auto", target }, () => {}, "offscreen");
    try {
      await host.prepare();
      assert.deepEqual(f.pairs, languages.filter(source => source !== target).map(sourceLanguage => ({ sourceLanguage, targetLanguage: target === "ja" && sourceLanguage === "ko" ? "en" : target })));
      for (const source of languages.filter(source => source !== target)) {
        const revisions = [];
        for await (const revision of host.translate({ identity, utteranceId: source, sourceRevision: 2, final: true, language: source, text: "test", audioRange: { startMs: 0, endMs: 1000 } }, { source, target })) revisions.push(revision);
        assert.equal(revisions.at(-1)?.text, target === "ja" && source === "ko" ? "ja: en: test" : `${target}: test`);
      }
    } finally { await host.close(); }
  }
});

test("new selections validate independently and old prepared snapshots match only their effective defaults", () => {
  assert.equal(validModelOptions({ recognition: "chrome", translation: "chrome", targetLanguage: "fr" }), false);
  assert.equal(validModelOptions({ recognition: "chrome", translation: "chrome", languageDetection: "remote" }), false);
  assert.equal(validModelOptions({ recognition: "chrome", translation: "chrome", speaker: "remote" }), false);
  assert.equal(sameModelOptions(undefined, { recognition: "chrome", translation: "chrome", targetLanguage: "ko", languageDetection: "whisper", speaker: "wespeaker" }), true);
  for (const extra of [{ targetLanguage: "en" as const }, { languageDetection: "voxlingua" as const }, { speaker: "off" as const }]) {
    assert.equal(sameModelOptions(undefined, { recognition: "chrome", translation: "chrome", ...extra }), false);
  }
});

test("automatic Japanese output shares one Japanese translator within Chrome's single activation budget", async () => {
  const f = documentFixture();
  const view = f.document.defaultView as unknown as { Translator: { create(pair: { sourceLanguage: string; targetLanguage: string }): Promise<{ translate(text: string): Promise<string>; destroy(): void }> } };
  let activated = true;
  const create = view.Translator.create;
  view.Translator.create = async pair => {
    if (pair.targetLanguage === "ja") {
      assert.ok(activated, "Chrome consumes activation when creating a translator for an unpreferred language");
      activated = false;
    }
    return create(pair);
  };
  const host = createDocumentTranslator(f.document, { source: "auto", target: "ja" }, () => {}, "offscreen");
  try {
    await host.prepare();
    assert.deepEqual(f.pairs, [{ sourceLanguage: "en", targetLanguage: "ja" }, { sourceLanguage: "ko", targetLanguage: "en" }]);
    const revisions = [];
    for await (const revision of host.translate({ identity, utteranceId: "ko", sourceRevision: 5, final: true, language: "ko", text: "내일 만나요.", audioRange: { startMs: 0, endMs: 1000 } }, { source: "ko", target: "ja" })) revisions.push(revision);
    assert.equal(revisions.at(-1)?.text, "ja: en: 내일 만나요.");
    assert.deepEqual(revisions.at(-1)?.languages, { source: "ko", target: "ja" });
    assert.equal(revisions.at(-1)?.sourceRevision, 5);
  } finally { await host.close(); }
});

test("engine freezes target selection, prepares the independent detector only in auto and omits disabled speakers", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const owned: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    terminated = false;
    constructor(readonly url: URL) { owned.push(this); }
    postMessage(message: { requestId: number }) { queueMicrotask(() => this.onmessage?.({ data: { version: 1, requestId: message.requestId, type: "ready" } })); }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  try {
    for (const source of ["ko", "auto"] as const) {
      const f = documentFixture(); const before = owned.length;
      const options: ModelOptions = { recognition: "smallFp16", translation: "chrome", targetLanguage: "en", languageDetection: "voxlingua", speaker: "off" };
      const engine = createChromeEngine(f.document, source, () => {}, "offscreen", undefined, options);
      options.targetLanguage = "ja"; options.speaker = "wespeaker";
      try {
        await engine.prepareFromGesture();
        assert.ok(engine.ready);
        assert.equal(owned.slice(before).some(worker => worker.url.pathname.endsWith("language-worker.ts")), source === "auto");
        assert.equal(owned.slice(before).some(worker => worker.url.pathname.endsWith("speaker-worker.ts")), false);
        assert.equal((await engine.port.probe({ source, target: "en" })).availability.state, "available");
        assert.equal((await engine.port.probe({ source, target: "ko" })).availability.state, "unavailable");
        assert.deepEqual(f.pairs.map(pair => pair.sourceLanguage), source === "auto" ? ["ja", "ko"] : ["ko"]);
      } finally { await engine.port.close(); }
      assert.ok(owned.slice(before).every(worker => worker.terminated));
    }
  } finally { if (original) Object.defineProperty(globalThis, "Worker", original); else Reflect.deleteProperty(globalThis, "Worker"); }
});

test("language decisions reject malformed probabilities and late replies after Stop", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let worker: FakeWorker | undefined;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    requestId = 0;
    constructor() { worker = this; }
    postMessage(message: { requestId: number; type: string }) {
      this.requestId = message.requestId;
      if (message.type === "prepare") queueMicrotask(() => this.reply({ type: "ready" }));
    }
    reply(value: object) { this.onmessage?.({ data: { requestId: this.requestId, ...value } }); }
    terminate() {}
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  const host = createLanguageHost(documentFixture().document, (_status: ModelStatus) => {}, "offscreen");
  try {
    await host.prepare();
    const valid = host.detect(new Float32Array(16000));
    worker?.reply({ type: "result", language: "ja", confidence: 0.98, inferenceMs: 40 });
    assert.deepEqual(await valid, { language: "ja", confidence: 0.98, inferenceMs: 40 });
    const invalid = host.detect(new Float32Array(16000));
    worker?.reply({ type: "result", language: "en", confidence: 2, inferenceMs: 10 });
    await assert.rejects(invalid, /Invalid language decision/);
    await host.prepare();
    const pending = host.detect(new Float32Array(16000));
    host.stop();
    worker?.reply({ type: "result", language: "ko", confidence: 1, inferenceMs: 10 });
    await assert.rejects(pending, /stopped/);
    await assert.rejects(host.detect(new Float32Array(16000)), /not ready/);
  } finally { host.dispose(); if (original) Object.defineProperty(globalThis, "Worker", original); else Reflect.deleteProperty(globalThis, "Worker"); }
});

test("model translation forwards Korean source and selected Japanese target to the worker", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const messages: { type: string; language?: string; targetLanguage?: string }[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: { requestId: number; type: string; language?: string; targetLanguage?: string }) {
      messages.push(message);
      queueMicrotask(() => this.onmessage?.({ data: { requestId: message.requestId, type: message.type === "prepare" ? "ready" : "result", text: "明日会いましょう。" } }));
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  const host = createModelTranslator(documentFixture().document, { source: "auto", target: "ja" }, "hyMt2", () => {}, "offscreen");
  try {
    await host.prepare();
    const revisions = [];
    for await (const revision of host.translate({ identity, utteranceId: "one", sourceRevision: 4, language: "ko", text: "내일 만나요.", final: true, audioRange: { startMs: 0, endMs: 1000 } }, { source: "ko", target: "ja" })) revisions.push(revision);
    assert.equal(messages.at(-1)?.language, "ko"); assert.equal(messages.at(-1)?.targetLanguage, "ja");
    assert.equal(revisions.at(-1)?.sourceRevision, 4); assert.equal(revisions.at(-1)?.final, true);
    await host.prepare({ source: "ja", target: "en" });
    for await (const revision of host.translate({ identity, utteranceId: "two", sourceRevision: 1, language: "ja", text: "また明日", final: true, audioRange: { startMs: 0, endMs: 1000 } }, { source: "ja", target: "en" })) assert.deepEqual(revision.languages, { source: "ja", target: "en" });
    assert.equal(messages.filter(message => message.type === "prepare").length, 1);
    assert.equal(messages.at(-1)?.language, "ja"); assert.equal(messages.at(-1)?.targetLanguage, "en");
  } finally { await host.close(); if (original) Object.defineProperty(globalThis, "Worker", original); else Reflect.deleteProperty(globalThis, "Worker"); }
});

test("ready engine retains multilingual workers across source and subtitle changes until Stop", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    terminated = false;
    requests: { type: string }[] = [];
    constructor(readonly url: URL) { workers.push(this); }
    postMessage(message: { requestId: number; type: string }) {
      this.requests.push(message);
      queueMicrotask(() => this.onmessage?.({ data: { version: 1, requestId: message.requestId, type: "ready" } }));
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { async has() { return false; } } });
  const engine = createChromeEngine(documentFixture().document, "en", () => {}, "offscreen", undefined,
    { recognition: "smallFp16", translation: "hyMt2", languageDetection: "voxlingua", speaker: "wespeaker" });
  try {
    await engine.prepareFromGesture();
    const initial = [...workers];
    for (const pair of [{ source: "ja", target: "en" }, { source: "auto", target: "ja" }, { source: "ko", target: "ko" }, { source: "en", target: "ko" }] as const) {
      await engine.prepareFromGesture(pair);
      assert.equal((await engine.port.probe(pair)).availability.state, "available");
      assert.ok(initial.every(worker => !worker.terminated && worker.requests.length === 1), "Loaded weights must not reload for a different language");
    }
    assert.equal(workers.length, initial.length + 1, "Only entering automatic mode adds the optional language detector");
    assert.ok(engine.models.every(model => model.task !== "언어 감지"), "Retained inactive detector is not reported as active");
    await engine.port.prepare(identity, { source: "en", target: "ko" });
    await assert.rejects(engine.prepareFromGesture({ source: "ja", target: "en" }), /Stop/);
  } finally {
    await engine.port.close();
    assert.ok(workers.every(worker => worker.terminated));
    if (original) Object.defineProperty(globalThis, "Worker", original); else Reflect.deleteProperty(globalThis, "Worker");
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches); else Reflect.deleteProperty(globalThis, "caches");
  }
});

test("native language changes reuse existing pair instances and create only missing pairs", async () => {
  const f = documentFixture();
  const host = createDocumentTranslator(f.document, { source: "en", target: "ko" }, () => {}, "offscreen");
  try {
    await host.prepare();
    for (const pair of [{ source: "ja", target: "en" }, { source: "auto", target: "ja" }, { source: "en", target: "ko" }] as const) await host.prepare(pair);
    assert.deepEqual(f.pairs, [
      { sourceLanguage: "en", targetLanguage: "ko" }, { sourceLanguage: "ja", targetLanguage: "en" },
      { sourceLanguage: "en", targetLanguage: "ja" }, { sourceLanguage: "ko", targetLanguage: "en" },
    ]);
    const revisions = [];
    for await (const revision of host.translate({ identity, utteranceId: "reuse", sourceRevision: 1, language: "en", text: "Hello", final: true, audioRange: { startMs: 0, endMs: 1000 } }, { source: "en", target: "ko" })) revisions.push(revision);
    assert.equal(revisions.at(-1)?.text, "ko: Hello");
    await assert.rejects(async () => { for await (const _revision of host.translate({ identity, utteranceId: "stale", sourceRevision: 1, language: "ja", text: "こんにちは", final: true, audioRange: { startMs: 0, endMs: 1000 } }, { source: "ja", target: "en" })) { /* Reject the previous pair. */ } }, /language-pair-unsupported/);
  } finally { await host.close(); }
});
