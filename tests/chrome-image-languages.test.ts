import assert from "node:assert/strict";
import test from "node:test";
import type { MediaTargetId } from "../packages/contracts";
import { createDocumentTranslator } from "../packages/engines-browser/document-translator";
import { createModelTranslator } from "../packages/engines-browser/model-translator";
import { modelOptionsKey, readModelOptions, subtitleLanguages } from "../apps/chrome/model-options";

const identity = { sessionId: "image-languages", targetId: "image" as MediaTargetId, epoch: 1 };

test("image output choices match quality settings and changing target preserves model, detector and speaker choices", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
  try {
    const settings = { recognition: "smallFp16", translation: "hyMt2", targetLanguage: "ko", languageDetection: "voxlingua", speaker: "off" };
    localStorage.setItem(modelOptionsKey, JSON.stringify(settings));
    assert.deepEqual(subtitleLanguages.map(choice => choice.id), ["ko", "en", "ja"]);
    assert.deepEqual(readModelOptions(), settings);
    localStorage.setItem(modelOptionsKey, JSON.stringify({ ...readModelOptions(), targetLanguage: "ja" }));
    assert.deepEqual(readModelOptions(), { ...settings, targetLanguage: "ja" });
    stored.clear(); assert.deepEqual(readModelOptions(), { recognition: "chrome", translation: "chrome" });
  } finally { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); }
});

test("image text translates to Korean, Japanese and English with the exact requested native pair", async () => {
  for (const source of ["en", "ja"]) for (const target of ["ko", "ja", "en"]) {
    if (source === target) continue;
    const opened: { sourceLanguage: string; targetLanguage: string }[] = [];
    const document = Object.assign(new EventTarget(), { visibilityState: "visible", defaultView: Object.assign(new EventTarget(), {
      isSecureContext: true, navigator: { userActivation: { isActive: true } }, Translator: {
        async create(pair: { sourceLanguage: string; targetLanguage: string }) {
          opened.push(pair);
          return { async translate(text: string) { return `${target}: ${text}`; }, destroy() {} };
        },
      },
    }) }) as unknown as Document;
    const host = createDocumentTranslator(document, { source, target }, () => {});
    try {
      await host.prepare();
      assert.deepEqual(opened.map(pair => [pair.sourceLanguage, pair.targetLanguage]), [[source, target]]);
      const revisions = [];
      for await (const revision of host.translate({ identity, utteranceId: "line", sourceRevision: 3, language: source,
        text: "example", final: true, audioRange: { startMs: 0, endMs: 0 } }, { source, target })) revisions.push(revision);
      assert.equal(revisions.at(-1)?.text, `${target}: example`);
      assert.deepEqual(revisions.at(-1)?.languages, { source, target });
      assert.equal(revisions.at(-1)?.sourceRevision, 3);
    } finally { await host.close(); }
  }
});

test("the selected model worker receives the image target language and preserves source pairing", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const requests: { requestId: number; type: string; targetLanguage?: string; language?: string }[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(request: typeof requests[number]) {
      requests.push(request);
      queueMicrotask(() => this.onmessage?.({ data: { requestId: request.requestId, type: request.type === "prepare" ? "ready" : "result", text: "Hello" } }));
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible", defaultView: Object.assign(new EventTarget(), {
    isSecureContext: true, navigator: { userActivation: { isActive: true } },
  }) }) as unknown as Document;
  const host = createModelTranslator(document, { source: "ja", target: "en" }, "hyMt2", () => {});
  try {
    await host.prepare();
    const revisions = [];
    for await (const revision of host.translate({ identity, utteranceId: "line", sourceRevision: 2, language: "ja",
      text: "こんにちは", final: true, audioRange: { startMs: 0, endMs: 0 } }, { source: "ja", target: "en" })) revisions.push(revision);
    assert.equal(requests.at(-1)?.targetLanguage, "en");
    assert.equal(requests.at(-1)?.language, "ja");
    assert.equal(revisions.at(-1)?.text, "Hello");
    assert.equal(revisions.at(-1)?.sourceRevision, 2);
  } finally {
    await host.close();
    if (original) Object.defineProperty(globalThis, "Worker", original); else Reflect.deleteProperty(globalThis, "Worker");
  }
});
