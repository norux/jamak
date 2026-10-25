import assert from "node:assert/strict";
import { test } from "node:test";
import { imageModels } from "../apps/chrome/image-model";
import { backgroundChannel, eventChannel, type BackgroundCommand, type BackgroundSnapshot } from "../apps/chrome/background-protocol";

test("Advanced preparation emits one completion event after readiness, never after Stop or failure", async () => {
  const originals = ["chrome", "document", "Worker", "caches", "fetch", "crypto"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let receive!: (message: object, sender: object, respond: (value: { snapshot: BackgroundSnapshot }) => void) => unknown;
  const events: { channel: string; type: string }[] = [];
  const workers: FakeWorker[] = [];
  let replies: "ready" | "wait" | "error" = "ready";
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    last?: { requestId: number };
    constructor() { workers.push(this); }
    postMessage(message: { requestId: number }) {
      this.last = message;
      if (replies !== "wait") queueMicrotask(() => this.reply(replies));
    }
    reply(type: string) { this.onmessage?.({ data: { version: 1, requestId: this.last?.requestId, type, reason: "model-load-failed" } }); }
    terminated = false;
    terminate() { this.terminated = true; }
  }
  const base = "chrome-extension://fixture/";
  const document = Object.assign(new EventTarget(), { visibilityState: "hidden", defaultView: Object.assign(new EventTarget(), {
    isSecureContext: true, navigator: { userAgent: "Chrome/154", userActivation: { isActive: false } },
  }) });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: document }, Worker: { configurable: true, value: FakeWorker },
    chrome: { configurable: true, value: { runtime: { id: "fixture", getURL: (path: string) => base + path,
      onMessage: { addListener(listener: typeof receive) { receive = listener; } },
      async sendMessage(event: typeof events[number]) { events.push(event); },
    } } },
  });
  const command = (command: BackgroundCommand) => new Promise<BackgroundSnapshot>(resolve => receive({ channel: backgroundChannel, command },
    { id: "fixture", url: `${base}service-worker.js` }, result => resolve(result.snapshot)));
  const completions = () => events.filter(event => event.channel === eventChannel && event.type === "models-ready").length;
  const options = { recognition: "smallFp16", translation: "hyMt2" } as const;
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  try {
    await import("../apps/chrome/offscreen");
    assert.equal((await command({ type: "snapshot" })).source, "en", "A fresh background defaults to manual English");
    await command({ type: "models", source: "ja", options }); await settle();
    assert.equal((await command({ type: "snapshot" })).state, "ready");
    assert.equal(completions(), 1, "Ready models notify even without an Advanced page listener");
    await command({ type: "snapshot" }); await command({ type: "stop" });
    assert.equal(completions(), 1, "Observation and Stop do not repeat notifications");
    await command({ type: "prepare", tabId: 10, source: "ja", options }); await settle();
    assert.equal((await command({ type: "snapshot" })).state, "ready");
    assert.equal(completions(), 1, "Automatic popup preparation of cached models does not notify");
    const resident = [...workers];
    await command({ type: "prepare", tabId: 10, source: "en", options: { ...options, targetLanguage: "ja" } }); await settle();
    const changed = await command({ type: "snapshot" });
    assert.equal(changed.state, "ready");
    assert.equal(changed.source, "en");
    assert.equal(changed.options?.targetLanguage, "ja");
    assert.equal(workers.length, resident.length, "Language changes must retain the prepared engine's workers");
    assert.ok(resident.slice(-4).every(worker => !worker.terminated));
    assert.equal(completions(), 1, "Language-only preparation does not notify");
    await command({ type: "stop" });
    assert.ok(workers.every(worker => worker.terminated), "Explicit Stop still releases all retained models");
    replies = "wait";
    const before = workers.length;
    await command({ type: "models", source: "ja", options });
    await command({ type: "stop" });
    for (const worker of workers.slice(before)) worker.reply("ready");
    await settle();
    assert.equal((await command({ type: "snapshot" })).state, "idle");
    assert.equal(completions(), 1, "Late worker readiness after Stop never notifies");
    replies = "error";
    await command({ type: "models", source: "ja", options }); await settle();
    assert.equal((await command({ type: "snapshot" })).state, "failed");
    assert.equal(completions(), 1, "Failed preparation never reports completion");
    await command({ type: "stop" });
    replies = "ready";
    const downloads: (() => void)[] = [];
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => ({ match: async () => undefined, put: async () => {} }) } });
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { subtle: { digest: async (_: string, bytes: ArrayBuffer) => {
      const model = imageModels.find(model => model.bytes === bytes.byteLength); if (!model) throw Error("Unexpected OCR fixture");
      return Uint8Array.from(model.sha256.match(/../g) ?? [], part => Number.parseInt(part, 16)).buffer;
    } } } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init: { signal: AbortSignal }) => new Promise<Response>((resolve, reject) => {
      const model = imageModels.find(model => url.endsWith(model.file)); if (!model) throw Error("Unexpected model request");
      init.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
      downloads.push(() => resolve(new Response(new Uint8Array(model.bytes))));
    }) });
    const unified = { type: "models", source: "ja", options, imageOptions: { ocr: "mobile", fontScale: 1 } } as const;
    await command(unified); await settle();
    assert.equal((await command({ type: "snapshot" })).state, "preparing", "Audio readiness alone cannot finish unified preparation");
    assert.equal(completions(), 1);
    assert.equal(downloads.length, 1, "The same background preparation must advance to OCR");
    downloads.shift()?.(); await settle(); await settle(); downloads.shift()?.(); await settle(); await settle();
    assert.equal((await command({ type: "snapshot" })).state, "ready");
    assert.equal(completions(), 2, "Only the complete combined preparation emits one notification");
    await command({ type: "stop" });
    await command(unified); await settle();
    assert.equal(downloads.length, 1);
    await command({ type: "stop" }); downloads.shift()?.(); await settle();
    assert.equal((await command({ type: "snapshot" })).state, "idle");
    assert.equal(completions(), 2, "Stopping in the OCR stage cannot emit a late combined readiness notification");
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => { throw Error("OCR network failure"); } });
    const beforeFailure = workers.length;
    await command(unified); await settle();
    assert.equal((await command({ type: "snapshot" })).state, "failed");
    assert.equal(completions(), 2, "OCR failure cannot announce overall readiness after audio succeeds");
    assert.ok(workers.length > beforeFailure);
    assert.ok(workers.slice(beforeFailure).every(worker => worker.terminated), "A failed combined preparation must release already-loaded audio/translation workers");
    await command({ type: "prepare", tabId: 10, source: "ja", options }); await settle();
    assert.equal((await command({ type: "snapshot" })).state, "ready");
    assert.equal((await command({ type: "snapshot" })).imageOptions, undefined, "Audio-only recovery cannot claim the failed OCR selection is prepared");
    await command({ type: "stop" });
  } finally {
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
