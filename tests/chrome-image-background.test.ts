import assert from "node:assert/strict";
import test from "node:test";
import { setupImageBackground } from "../apps/chrome/image-background";
import { imageChannel, imageRuntimeChannel } from "../apps/chrome/image-protocol";

test("a restarted image broker restores completed results and preserves document fencing without touching audio", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let receive: (message: unknown, sender: unknown, respond: (value: unknown) => void) => unknown = () => {};
  const commands: Record<string, unknown>[] = [];
  const pages: unknown[] = [];
  let acquired = 0;
  let removed: (tabId: number) => void = () => {};
  const session = { token: "retained", tabId: 17, documentId: "original-document", imageIds: ["image"], options: { recognition: "chrome", translation: "chrome" } as const };
  const snapshot = { state: "ready", message: "완료", total: 1, completed: 1, failed: 0 };
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { id: "owned", getURL: (file: string) => `chrome-extension://owned/${file}`,
      onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
      sendMessage: async (message: { channel: string; command?: Record<string, unknown> }) => {
        if (message.channel !== imageRuntimeChannel) return {};
        if (message.command) commands.push(message.command);
        return message.command?.type === "snapshot" ? { snapshot, session } : {};
      },
    },
    tabs: { sendMessage: async (...args: unknown[]) => { pages.push(args); return {}; }, onRemoved: { addListener: (listener: typeof removed) => { removed = listener; } }, onUpdated: { addListener() {} } },
  } });
  try {
    const images = setupImageBackground(async () => { acquired++; });
    const sender = { id: "owned", tab: { id: 17 }, frameId: 0, documentId: "original-document" };
    const dispatch = (type: string, origin = sender) => new Promise<Record<string, unknown>>(resolve => {
      receive({ channel: imageChannel, token: "retained", type, imageId: "image" }, origin, value => resolve(value as Record<string, unknown>));
    });
    assert.deepEqual(await dispatch("export"), {});
    assert.deepEqual(commands.map(command => command.type), ["snapshot", "export"]);
    assert.match(String((await dispatch("export", { ...sender, documentId: "replacement" })).error), /종료된/);
    assert.equal(acquired, 0, "Retained controls never prepare the runtime again");
    const popup = { id: "owned", url: "chrome-extension://owned/popup.html" };
    const control = (fields: object, sender: object) => new Promise<Record<string, unknown>>(resolve => receive({ channel: imageChannel, ...fields }, sender, value => resolve(value as Record<string, unknown>)));
    commands.length = 0;
    await control({ type: "size", tabId: 99, fontScale: 1.5 }, popup);
    assert.equal(commands.length, 0, "Image size cannot change a different tab's session");
    await control({ type: "size", tabId: 17, fontScale: 1.5 }, popup);
    assert.deepEqual(commands.map(({ type, token, fontScale }) => ({ type, token, fontScale })), [{ type: "size", token: "retained", fontScale: 1.5 }]);
    assert.match(String((await control({ type: "size", tabId: 17, fontScale: 99 }, popup)).error), /글자 크기/);
    commands.length = 0;
    await images.configure(session.options, { ocr: "mobile", fontScale: 1 });
    assert.equal(commands.length, 0, "Unrelated audio model changes do not stop unchanged image models");
    await images.configure({ ...session.options, translation: "hyMt2" }, { ocr: "mobile", fontScale: 1 });
    assert.equal(commands.at(-1)?.type, "stop", "Switching the shared translator stops the previous image translator");
    commands.length = 0;
    await images.configure(session.options, { ocr: "v6Small", fontScale: 1 });
    assert.deepEqual(commands.map(command => command.type), ["stop"], "Combined preparation retires incompatible image inference; the shared offscreen operation owns downloads");
    assert.equal(acquired, 0);
    await dispatch("stop");
    assert.equal(commands.at(-1)?.type, "stop");
    assert.equal(commands.at(-1)?.dispose, false);
    assert.ok(pages.some(args => JSON.stringify(args).includes("original-document")));
    assert.equal(commands.some(command => command.type === "prepare"), false);
    commands.length = 0;
    setupImageBackground(async () => { throw new Error("Closing the image tab must not prepare audio"); });
    removed(17);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(commands.map(command => command.type), ["snapshot", "stop"]);
    assert.equal(commands.at(-1)?.dispose, true, "Tab closure disposes restored image results");
  } finally {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});
