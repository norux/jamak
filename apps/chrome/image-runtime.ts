import type { MediaTargetId } from "../../packages/contracts";
import { createDocumentTranslator } from "../../packages/engines-browser/document-translator";
import { createModelTranslator } from "../../packages/engines-browser/model-translator";
import { imageOcrChoices, loadImageModel } from "./image-model";
import { imageLabels, imageRegions, drawImageTranslations, type ImageRegion } from "./image-render";
import { imageEventChannel, imageRuntimeChannel, type ImageSession, type ImageSnapshot, type ImageLanguage, type OcrPreparation } from "./image-protocol";

import { defaultImageOptions, imageFontSizes } from "./image-options";

type Region = ImageRegion & { language?: ImageLanguage };
type Result = { pixels: Blob; width: number; height: number; regions: Region[]; origins: { x: number; y: number }[]; revision: number; complete: boolean };
type Translator = ReturnType<typeof createDocumentTranslator> | ReturnType<typeof createModelTranslator>;
let job: { session: ImageSession; controller: AbortController; prepared: Promise<void>; running: boolean } | undefined;
let host: { choice: string; port: Translator } | undefined;
let sandbox: HTMLIFrameElement | undefined;
const results = new Map<string, Result>();
let snapshot: ImageSnapshot = { state: "idle", message: "이미지 분석 대기 중", total: 0, completed: 0, failed: 0 };
let revision = 0;

let ocrPreparation: { choice: NonNullable<OcrPreparation["choice"]>; controller: AbortController; done: Promise<void>; receive?: (value: OcrPreparation) => void } | undefined;
let ocrRevision = 0;
let ocrSnapshot: OcrPreparation = { state: "idle", message: "OCR 모델을 선택하면 다운로드합니다." };
function ocrStatus(value: OcrPreparation) {
  value = { ...value, revision: ++ocrRevision };
  const previous = ocrSnapshot; ocrSnapshot = value;
  if (previous.state === value.state && previous.message === value.message && Math.floor((previous.downloadProgress ?? -1) * 100) === Math.floor((value.downloadProgress ?? -1) * 100)) return;
  ocrPreparation?.receive?.(value);
  void chrome.runtime.sendMessage({ channel: imageEventChannel, type: "ocr-status", ocrPreparation: value }).catch(() => {});
}
export function stopOcr() {
  const pending = ocrPreparation; ocrPreparation = undefined; pending?.controller.abort();
  if (ocrSnapshot.state === "preparing") ocrStatus({ choice: pending?.choice, state: "stopped", message: "OCR 다운로드를 중지했습니다. 완료된 파일은 남습니다." });
}
export function prepareOcr(choiceId: unknown, receive?: (value: OcrPreparation) => void) {
  const choice = imageOcrChoices.find(choice => choice.id === choiceId); if (!choice) throw new Error("잘못된 OCR 모델입니다.");
  stopOcr();
  const owned = { choice: choice.id, controller: new AbortController(), done: Promise.resolve(), receive }; ocrPreparation = owned;
  ocrStatus({ choice: choice.id, state: "preparing", message: `${choice.name} · 캐시 확인·검증 중…` });
  owned.done = (async () => {
    const total = choice.models.reduce((sum, model) => sum + model.bytes, 0); let completed = 0;
    for (const model of choice.models) {
      await loadImageModel(model, owned.controller.signal, progress => {
        if (ocrPreparation !== owned) return;
        ocrStatus({ choice: choice.id, state: "preparing", message: `${choice.name} · ${model.name} ${progress === undefined ? "확인·검증 중…" : "다운로드 중…"}`,
          downloadProgress: progress === undefined ? undefined : (completed + progress * model.bytes) / total });
      });
      owned.controller.signal.throwIfAborted(); completed += model.bytes;
    }
    if (ocrPreparation === owned) ocrStatus({ choice: choice.id, state: "ready", message: "OCR 모델 다운로드·검증 완료" });
  })().catch(error => {
    if (ocrPreparation === owned && !owned.controller.signal.aborted) ocrStatus({ choice: choice.id, state: "failed", message: `OCR 다운로드 실패: ${error.message}` });
    throw error;
  });
  void owned.done.catch(() => {});
  return owned.done;
}

async function event(type: string, fields: object = {}, owned = job) {
  if (!owned || owned.controller.signal.aborted) throw new DOMException("이미지 분석 중지됨", "AbortError");
  const response = await chrome.runtime.sendMessage({ channel: imageEventChannel, token: owned.session.token, type, ...fields });
  owned.controller.signal.throwIfAborted();
  if (response?.error) throw new Error(response.error);
  return response;
}
function status(state: ImageSnapshot["state"], message: string) {
  snapshot = { ...snapshot, state, message };
  if (job) void event("status", { snapshot }).catch(() => {});
}
async function stop(preserveIdle = false) {
  const keep = preserveIdle && !job?.running && snapshot.state === "ready";
  const active = job; job = undefined; active?.controller.abort(); sandbox?.remove(); sandbox = undefined;
  if (!keep) { const owned = host; host = undefined; await owned?.port.close(); }
}
function pixels(dataUrl: string) {
  return new Blob([Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), character => character.charCodeAt(0))], { type: "image/png" });
}
async function capture(imageId: string, owned: NonNullable<typeof job>): Promise<Blob> {
  const entry = await event("capture", { imageId }, owned);
  if (entry.pixels) return pixels(entry.pixels);
  const bitmap = await createImageBitmap(pixels(entry.screenshot)); let cropped: ImageBitmap | undefined;
  try {
    const { x, y, width, height, viewportWidth, viewportHeight } = entry.selection;
    cropped = await createImageBitmap(bitmap, Math.round(x * bitmap.width / viewportWidth), Math.round(y * bitmap.height / viewportHeight), Math.round(width * bitmap.width / viewportWidth), Math.round(height * bitmap.height / viewportHeight));
    const canvas = document.createElement("canvas"); canvas.width = cropped.width; canvas.height = cropped.height; canvas.getContext("2d")?.drawImage(cropped, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("이미지를 캡처할 수 없습니다.")), "image/png"));
  } finally { bitmap.close(); cropped?.close(); }
}
async function recognize(bitmap: ImageBitmap, owned: NonNullable<typeof job>) {
  const signal = owned.controller.signal; const buffers: ArrayBuffer[] = [];
  const choice = imageOcrChoices.find(choice => choice.id === owned.session.imageOptions?.ocr) ?? imageOcrChoices[0];
  const pending = ocrPreparation;
  if (pending?.choice === choice.id) {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => reject(new DOMException("이미지 분석 중지됨", "AbortError"));
      signal.addEventListener("abort", cancel, { once: true });
      void pending.done.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
      if (signal.aborted) cancel();
    });
  }
  for (const model of choice.models) { status("running", `${model.name} 캐시 확인 · 다운로드 · 검증 중…`); buffers.push(await loadImageModel(model, signal)); }
  status("running", "이미지에서 글자를 읽는 중…");
  return new Promise<unknown>((resolve, reject) => {
    const frame = document.createElement("iframe"); sandbox = frame; const channel = new MessageChannel();
    function finish(error?: Error, items?: unknown) {
      window.removeEventListener("message", ready); signal.removeEventListener("abort", abort); channel.port1.close(); channel.port2.close(); frame.remove();
      if (sandbox === frame) sandbox = undefined;
      if (error) reject(error); else resolve(items);
    }
    function abort() { finish(new DOMException("이미지 분석 중지됨", "AbortError")); }
    function ready(message: MessageEvent) {
      if (message.source !== frame.contentWindow || message.data !== "jamak-image-ocr-ready") return;
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d"); if (!context) { finish(new Error("이미지 처리 실패")); return; }
      context.drawImage(bitmap, 0, 0);
      frame.contentWindow?.postMessage("jamak-image-ocr", "*", [channel.port2]);
      channel.port1.postMessage({ image: context.getImageData(0, 0, canvas.width, canvas.height), detection: buffers[0], recognition: buffers[1], modelNames: choice.models.map(model => model.file.replace("_onnx_infer.tar", "")) }, buffers);
    }
    channel.port1.onmessage = message => {
      if (message.data.type === "result") finish(undefined, message.data.items);
      else if (message.data.type === "error") finish(new Error(message.data.message));
    };
    signal.addEventListener("abort", abort, { once: true }); window.addEventListener("message", ready);
    frame.src = chrome.runtime.getURL("image-sandbox.html"); document.body.append(frame);
    if (signal.aborted) abort();
  });
}
async function paint(imageId: string, result: Result, owned: NonNullable<typeof job>) {
  const canvas = document.createElement("canvas"); canvas.width = result.width; canvas.height = result.height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("이미지 레이아웃 실패");
  result.revision = ++revision;
  const response = await event("paint", { imageId, revision: result.revision, labels: imageLabels(context, result.regions, result.width, result.height, owned.session.imageOptions?.fontScale ?? 1), regions: result.regions,
    width: result.width, height: result.height, targetLanguage: owned.session.options.targetLanguage ?? "ko", complete: result.complete }, owned);
  if (!response?.painted) throw new Error("원래 이미지가 변경되었거나 번역 표시가 닫혔습니다.");
}
async function translate(imageId: string, result: Result, owned: NonNullable<typeof job>) {
  const target = owned.session.options.targetLanguage ?? "ko";
  let unknown = 0;
  for (const [index, region] of result.regions.entries()) {
    owned.controller.signal.throwIfAborted();
    if (!region.source.trim()) { region.translation = ""; continue; }
    if (!/\p{L}/u.test(region.source) || region.language === target) { region.translation = region.source; continue; }
    if (!region.language) { region.translation = ""; unknown++; continue; }
    status("running", `이미지 ${snapshot.completed + 1}/${snapshot.total} · ${index + 1}/${result.regions.length} 영역 번역 중…`);
    const identity = { sessionId: owned.session.token, targetId: imageId as MediaTargetId, epoch: 1 };
    if (!host) throw new Error("번역 모델이 준비되지 않았습니다.");
    if (host.choice !== "chrome") await host.port.prepare({ source: region.language, target });
    for await (const chunk of host.port.translate({ identity, utteranceId: String(index), sourceRevision: result.revision + 1, language: region.language,
      text: region.source, final: true, audioRange: { startMs: 0, endMs: 0 } }, { source: region.language, target })) {
      owned.controller.signal.throwIfAborted(); region.translation = chunk.text;
    }
    await paint(imageId, result, owned);
  }
  owned.controller.signal.throwIfAborted(); result.complete = true;
  await paint(imageId, result, owned);
  return unknown;
}
async function run(owned: NonNullable<typeof job>) {
  if (owned.running) throw new Error("이미지 분석이 이미 실행 중입니다.");
  owned.running = true; snapshot.total = owned.session.imageIds.length;
  const heartbeat = setInterval(() => { if (job === owned) void event("status", { snapshot }, owned).catch(() => {}); }, 20000);
  let unknown = 0;
  try {
    status("preparing", snapshot.message);
    await owned.prepared; owned.controller.signal.throwIfAborted();
    for (const imageId of owned.session.imageIds) {
      owned.controller.signal.throwIfAborted();
      try {
        status("running", `이미지 ${snapshot.completed + 1}/${snapshot.total} 읽는 중…`);
        const original = await capture(imageId, owned); const bitmap = await createImageBitmap(original);
        try {
          const items = await recognize(bitmap, owned); owned.controller.signal.throwIfAborted();
          const regions: Region[] = imageRegions(items, bitmap.width, bitmap.height);
          const detected = regions.length ? await event("detect", { texts: regions.map(region => region.source) }, owned) : { languages: [] };
          regions.forEach((region, index) => { region.language = detected.languages[index] ?? undefined; });
          const result: Result = { pixels: original, width: bitmap.width, height: bitmap.height, regions, origins: regions.map(region => ({ x: region.x, y: region.y })), revision: 0, complete: false };
          results.set(imageId, result); unknown += await translate(imageId, result, owned);
        } finally { bitmap.close(); }
      } catch (error) {
        owned.controller.signal.throwIfAborted(); snapshot.failed++;
        status("running", `이미지 처리 실패: ${error instanceof Error ? error.message : String(error)}`);
      }
      snapshot.completed++;
    }
    status("ready", `${snapshot.total - snapshot.failed}개 이미지 처리 완료${snapshot.failed ? ` · 실패 ${snapshot.failed}개` : ""}${unknown ? ` · 언어 판별 불가 ${unknown}개 영역 (원문 수정에서 보완 가능)` : ""}`);
  } catch (error) {
    if (job === owned) status("failed", error instanceof Error ? error.message : String(error));
  } finally {
    clearInterval(heartbeat); owned.running = false;
    if (job === owned && !owned.controller.signal.aborted) await event("finish", {}, owned).catch(() => {});
  }
}
async function prepare(session: ImageSession) {
  await stop(true); results.clear();
  const owned = { session: { ...session, options: { ...session.options } }, controller: new AbortController(), prepared: Promise.resolve(), running: false };
  job = owned; snapshot = { token: session.token, tabId: session.tabId, state: "preparing", message: "번역 모델 준비 중…", total: 0, completed: 0, failed: 0 };
  const choice = session.options.translation; const pair = { source: "auto", target: session.options.targetLanguage ?? "ko" };
  if (host?.choice !== choice) {
    await host?.port.close();
    host = { choice, port: choice === "chrome" ? createDocumentTranslator(document, pair, state => {
      if (state.state === "preparing") status("preparing", state.progress === undefined ? "Chrome 번역 언어 팩 준비 중…" : `번역 언어 팩 준비 ${Math.floor(state.progress * 100)}%`);
    }, "offscreen") : createModelTranslator(document, pair, choice, state => {
      if (state.state === "downloading") status("preparing", "번역 모델 다운로드 중…");
      else if (state.state === "cached" || state.state === "loading") status("preparing", "저장된 번역 모델 불러오는 중…");
    }, "offscreen") };
  }
  // Native pairs must start while Chrome forwards the explicit popup gesture.
  owned.prepared = (choice === "chrome" ? host.port.prepare(pair) : Promise.resolve()).then(() => { if (job === owned) status("preparing", "이미지를 선택하면 원문 언어를 자동 판별해 번역합니다."); });
  void owned.prepared.catch(error => { if (job === owned) status("failed", error.message); });
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.channel !== imageRuntimeChannel) return;
  async function command() {
    const value = message.command;
    if (value.type === "ocr-snapshot") return { ocrPreparation: ocrSnapshot };
    if (value.type === "snapshot") return { snapshot, session: job?.session };
    if (value.type === "prepare") { await prepare(value.session); return { snapshot }; }
    const owned = job;
    if (!owned || value.token !== owned.session.token) {
      if (value.type !== "start" || !owned || value.session?.token !== owned.session.token) throw new Error("종료된 이미지 작업입니다.");
    }
    if (!owned) throw new Error("이미지 분석을 먼저 시작하세요.");
    if (value.type === "stop") {
      await stop();
      if (value.dispose) results.clear();
      else job = { session: owned.session, controller: new AbortController(), prepared: Promise.resolve(), running: false };
      snapshot = { ...snapshot, state: "stopped", message: "이미지 분석을 중지했습니다." }; return { snapshot };
    }
    if (value.type === "start") { owned.session = { ...value.session, options: { ...owned.session.options }, imageOptions: { ...(owned.session.imageOptions ?? defaultImageOptions) } }; void run(owned); return { snapshot }; }
    if (value.type === "size") {
      if (!imageFontSizes.some(size => size.value === value.fontScale)) throw new Error("잘못된 글자 크기입니다.");
      owned.session.imageOptions = { ...(owned.session.imageOptions ?? defaultImageOptions), fontScale: value.fontScale };
      for (const [imageId, result] of results) await paint(imageId, result, owned);
      return { snapshot };
    }
    const result = results.get(value.imageId);
    if (!result) throw new Error("이미지 분석 결과가 없습니다.");
    if (value.type === "move") {
      const region = result.regions[value.index];
      if (!region || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error("잘못된 번역 위치입니다.");
      region.x = Math.max(-result.width, Math.min(result.width * 2, value.x)); region.y = Math.max(-result.height, Math.min(result.height * 2, value.y)); region.positioned = true; return {};
    }
    if (value.type === "reset") {
      const region = result.regions[value.index]; const origin = result.origins[value.index];
      if (!region || !origin) throw new Error("자막의 원래 위치를 찾을 수 없습니다.");
      region.x = origin.x; region.y = origin.y; delete region.positioned;
      await paint(value.imageId, result, owned); return {};
    }
    if (value.type === "edit") {
      if (owned.running) throw new Error("분석이 끝난 뒤 수정하세요.");
      const region = result.regions[value.index];
      if (!region || typeof value.source !== "string" || typeof value.translation !== "string" || value.source.length > 16384 || value.translation.length > 16384) throw new Error("잘못된 번역 수정입니다.");
      const sourceChanged = region.source !== value.source || region.language !== value.language;
      if (sourceChanged && !host) throw new Error("원문을 다시 번역하려면 이미지 분석을 시작하세요.");
      region.source = value.source; region.translation = value.translation;
      if (["en", "ja", "ko"].includes(value.language)) region.language = value.language;
      else { const detected = await event("detect", { texts: [region.source] }, owned); region.language = detected.languages[0] ?? undefined; }
      if (sourceChanged) { owned.running = true; result.complete = false; try { await translate(value.imageId, result, owned); } finally { owned.running = false; } }
      else await paint(value.imageId, result, owned);
      status("ready", "수정한 번역을 반영했습니다.");
      return {};
    }
    if (value.type === "export") {
      if (!result.complete || owned.running || !result.regions.some(region => region.translation)) throw new Error("이미지 번역이 완료된 뒤 저장하세요.");
      const bitmap = await createImageBitmap(result.pixels);
      try {
        const canvas = document.createElement("canvas"); drawImageTranslations(canvas, result.regions, bitmap, owned.session.imageOptions?.fontScale ?? 1);
        await event("download", { imageId: value.imageId, png: canvas.toDataURL("image/png") }, owned);
      } finally { bitmap.close(); }
      return {};
    }
    return {};
  }
  void command().then(respond, error => respond({ error: error.message })); return true;
});
