import assert from "node:assert/strict";
import { test } from "node:test";
import { backgroundChannel, eventChannel, type BackgroundCommand, type BackgroundSnapshot } from "../apps/chrome/background-protocol";

test("Advanced preparation emits one completion event after readiness, never after Stop or failure", async () => {
  const originals = ["chrome", "document", "Worker"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
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
    terminate() {}
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
  const options = { recognition: "tiny", translation: "m2m100" } as const;
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
    await command({ type: "stop" });
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
  } finally {
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
