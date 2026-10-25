import { validImageOptions, defaultImageOptions, imageFontSizes, type ImageOptions } from "./image-options";
import { detectImageLanguages } from "./image-language";
import { imageChannel, imageRuntimeChannel, imageEventChannel, type ImageSession, type ImageSnapshot } from "./image-protocol";
import { validModelOptions, type ModelOptions } from "./model-options";

export function setupImageBackground(ensureRuntime: () => Promise<void>) {
  let session: ImageSession | undefined;
  let snapshot: ImageSnapshot = { state: "idle", message: "번역할 이미지를 선택하세요. 원문 언어는 자동으로 판별합니다.", total: 0, completed: 0, failed: 0 };
  const offscreen = chrome.runtime.getURL("offscreen.html");
  const popup = chrome.runtime.getURL("popup.html");
  async function runtime(command: object) {
    const response = await chrome.runtime.sendMessage({ channel: imageRuntimeChannel, command });
    if (response?.error) throw new Error(response.error);
    return response;
  }
  async function restore() {
    if (session) return;
    const saved = await runtime({ type: "snapshot" }).catch(() => undefined);
    if (!session && saved?.session) { session = saved.session; snapshot = saved.snapshot; }
  }
  async function page(message: object, owned = session) {
    if (!owned) throw new Error("이미지 분석 세션이 종료되었습니다.");
    return chrome.tabs.sendMessage(owned.tabId, { channel: imageChannel, token: owned.token, ...message }, owned.documentId ? { documentId: owned.documentId } : { frameId: 0 });
  }
  async function stop(dispose = false) {
    const owned = session;
    if (!owned) return;
    await runtime({ type: "stop", token: owned.token, dispose }).catch(() => {});
    await page({ type: "finish" }, owned).catch(() => {});
    if (session !== owned) return;
    snapshot = { ...snapshot, state: "stopped", message: "이미지 분석을 중지했습니다. 완료된 번역은 남습니다." };
    await page({ type: "status", snapshot }).catch(() => {});
    void chrome.runtime.sendMessage({ channel: imageEventChannel, type: "changed" }).catch(() => {});
    if (dispose) { await page({ type: "dispose" }).catch(() => {}); session = undefined; }
  }
  async function configure(options: ModelOptions, imageOptions: ImageOptions) {
    await restore();
    if (session && (session.options.translation !== options.translation || (session.imageOptions?.ocr ?? "mobile") !== imageOptions.ocr)) await stop();
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    const ownedRuntime = sender.url === offscreen && !sender.tab;
    if (message?.channel === imageEventChannel && ownedRuntime) {
      async function event() {
        if (message.type === "ocr-status") return {};
        await restore();
        if (!session || message.token !== session.token) throw new Error("종료된 이미지 작업입니다.");
        if (message.type === "status") {
          snapshot = message.snapshot;
          await page({ type: "status", snapshot }).catch(() => {});
          void chrome.runtime.sendMessage({ channel: imageEventChannel, type: "changed" }).catch(() => {});
          return {};
        }
        if (message.type === "capture") {
          const owned = session;
          const tab = await chrome.tabs.get(owned.tabId);
          try {
            const captured = await page({ type: "capture", imageId: message.imageId }, owned);
            if (captured?.error) throw new Error(captured.error);
            if (session !== owned) throw new Error("이미지 분석이 취소되었습니다.");
            if (captured.pixels) return captured;
            const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
            if (active?.id !== owned.tabId) throw new Error("캡처가 필요한 이미지입니다. 원래 탭으로 돌아와 다시 분석하세요.");
            return { ...captured, screenshot: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
          } finally { await page({ type: "captured" }, owned).catch(() => {}); }
        }
        if (message.type === "detect") {
          if (!Array.isArray(message.texts) || message.texts.length > 256 || !message.texts.every((text: unknown) => typeof text === "string" && text.length <= 16384)) throw new Error("잘못된 OCR 텍스트입니다.");
          return { languages: await detectImageLanguages(message.texts, text => chrome.i18n.detectLanguage(text)) };
        }
        if (message.type === "paint" || message.type === "finish" || message.type === "download") {
          return page({ ...message, channel: imageChannel });
        }
        return {};
      }
      void event().then(respond, error => respond({ error: error.message })); return true;
    }
    if (message?.channel !== imageChannel) return;
    async function control() {
      const fromPopup = sender.url?.split("?")[0] === popup && !sender.tab;
      await restore();
      const fromPage = session && sender.tab?.id === session.tabId && sender.frameId === 0 && message.token === session.token
        && (!session.documentId || sender.documentId === session.documentId);
      if (message.type === "snapshot" && fromPopup) return { snapshot };
      if (message.type === "select" && fromPopup) {
        if (!Number.isSafeInteger(message.tabId) || !validModelOptions(message.options) || (message.imageOptions !== undefined && !validImageOptions(message.imageOptions))) throw new Error("일반 웹페이지에서 이미지 분석을 실행하세요.");
        if (session) await page({ type: "dispose" }).catch(() => {});
        const owned: ImageSession = { token: crypto.randomUUID(), tabId: message.tabId, imageIds: [], options: { ...message.options }, imageOptions: { ...(message.imageOptions ?? defaultImageOptions) } };
        session = owned;
        snapshot = { token: owned.token, tabId: owned.tabId, state: "selecting", message: message.automatic ? "탭의 이미지를 찾는 중…" : "웹페이지에서 번역할 이미지를 클릭하세요. Esc로 취소합니다.", total: 0, completed: 0, failed: 0 };
        // Forward the action's gesture to native preparation before OCR begins.
        await ensureRuntime();
        if (session !== owned) throw new Error("이미지 선택이 취소되었습니다.");
        await runtime({ type: "prepare", session: owned });
        if (session !== owned) throw new Error("이미지 선택이 취소되었습니다.");
        const injected = await chrome.scripting.executeScript({ target: { tabId: owned.tabId, frameIds: [0] }, files: ["tab-image.js"] });
        if (session !== owned) throw new Error("이미지 선택이 취소되었습니다.");
        owned.documentId = injected[0]?.documentId;
        const selected = await page({ type: "select", automatic: message.automatic === true }, owned);
        if (session !== owned) throw new Error("이미지 선택이 취소되었습니다.");
        if (selected?.error) { await stop(); throw new Error(selected.error); }
        if (selected?.imageIds) { owned.imageIds = selected.imageIds; await runtime({ type: "start", session: owned }); }
        return { snapshot };
      }
      if (message.type === "size" && fromPopup) {
        if (!imageFontSizes.some(size => size.value === message.fontScale)) throw new Error("잘못된 글자 크기입니다.");
        if (!session || session.tabId !== message.tabId) return { snapshot };
        await runtime({ type: "size", token: session.token, fontScale: message.fontScale });
        session.imageOptions = { ...(session.imageOptions ?? defaultImageOptions), fontScale: message.fontScale };
        return { snapshot };
      }
      if (message.type === "stop" && fromPopup) { await stop(); return { snapshot }; }
      if (!fromPage || !session) throw new Error("종료된 이미지 요청입니다.");
      if (message.type === "selected") {
        session.imageIds = [message.imageId];
        await runtime({ type: "start", session }); return {};
      }
      if (message.type === "cancel-selection") { await stop(); return {}; }
      if (message.type === "stop") { await stop(); return { snapshot }; }
      if (["move", "reset", "edit", "export"].includes(message.type)) return runtime({ ...message, token: session.token });
      return {};
    }
    void control().then(respond, error => respond({ error: error.message })); return true;
  });
  async function retire(tabId: number) { await restore(); if (session?.tabId === tabId) await stop(true); }
  chrome.tabs.onRemoved.addListener(tabId => { void retire(tabId); });
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === "loading") void retire(tabId); });
  return { configure };
}
