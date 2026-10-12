import type { CaptionRevision } from "../../packages/contracts";
import { createSessionController } from "../../packages/core/session-controller";
import { backgroundChannel, eventChannel, type BackgroundCommand, type BackgroundSnapshot } from "./background-protocol";
import { createChromeEngine } from "./engine";
import { createChromeTabInput } from "./tab-input";
import { defaultModelOptions, validModelOptions } from "./model-options";

let snapshot: BackgroundSnapshot = { state: "idle", source: "en", message: "음성 언어를 선택하고 모델을 준비하세요.", captions: [] };
let engine: ReturnType<typeof createChromeEngine> | undefined;
let capture: ReturnType<typeof createChromeTabInput> | undefined;
let controller: ReturnType<typeof createSessionController> | undefined;
let generation = 0;
let stopping: Promise<void> | undefined;

function publish() {
  void chrome.runtime.sendMessage({ channel: eventChannel, type: "status" }).catch(() => {});
}
function update(state: BackgroundSnapshot["state"], message: string) {
  if (state !== "preparing") snapshot.downloadProgress = undefined;
  snapshot.state = state; snapshot.message = message; publish();
}
function emit(fields: object) {
  void chrome.runtime.sendMessage({ channel: eventChannel, ...fields }).catch(() => {});
}
function accept(caption: CaptionRevision) {
  const index = snapshot.captions.findIndex(value => value.source.utteranceId === caption.source.utteranceId);
  if (caption.source.retracted) { if (index >= 0) snapshot.captions.splice(index, 1); }
  else if (index >= 0) snapshot.captions[index] = caption;
  else { snapshot.captions.push(caption); if (snapshot.captions.length > 300) snapshot.captions.shift(); }
  emit({ type: "caption", caption });
}
function stop() {
  if (stopping) return stopping;
  generation++;
  update("stopping", "중지 중…");
  const owned = engine; engine = undefined;
  const input = capture; capture = undefined;
  const session = controller; controller = undefined;
  const stopped = session?.stop();
  snapshot.identity = undefined; snapshot.target = undefined; snapshot.tabId = undefined;
  stopping = Promise.allSettled([stopped, input?.dispose(), owned?.port.close()]).then(results => {
    const failed = results.find(result => result.status === "rejected");
    update(failed ? "failed" : "idle", failed ? `중지 실패: ${String(failed.reason)}` : "중지됨 · 다시 준비하면 번역을 시작할 수 있습니다.");
  }).finally(() => { stopping = undefined; });
  return stopping;
}
async function command(value: BackgroundCommand) {
  if (value.type === "snapshot") return snapshot;
  if (value.type === "stop") { await stop(); return snapshot; }
  if (value.type === "prepare" || value.type === "models") {
    if (engine || stopping) throw new Error("먼저 중지를 눌러주세요.");
    if (((value.type === "prepare" || value.tabId !== undefined) && (!Number.isSafeInteger(value.tabId) || (value.tabId ?? 0) <= 0)) || !["auto", "ja", "en", "ko"].includes(value.source)) throw new Error("번역할 탭과 언어를 선택하세요.");
    const options = value.options ?? defaultModelOptions;
    if (!validModelOptions(options)) throw new Error("지원하지 않는 모델입니다.");
    const current = ++generation;
    snapshot = { state: "preparing", source: value.source, tabId: value.tabId, options: { ...options },
      message: "음성 인식과 번역 모델 준비 중…", captions: [] };
    engine = createChromeEngine(document, value.source, (diagnostic, progress, fraction) => {
      if (current !== generation) return;
      snapshot.diagnostic = diagnostic;
      if (progress && progress === snapshot.message && fraction === snapshot.downloadProgress) return;
      if (progress) { snapshot.message = progress; snapshot.downloadProgress = fraction; }
      publish();
    }, "offscreen", () => capture?.audioTrack, options);
    snapshot.models = engine.models;
    const owned = engine;
    // Preparation starts while Chrome forwards the popup click's user gesture.
    const prepared = owned.prepareFromGesture(); publish();
    void prepared.then(() => {
      if (current === generation) {
        update("ready", "모델 준비 완료 · 번역 시작을 눌러 연결하세요.");
        if (value.type === "models") emit({ type: "models-ready" });
      }
    }).catch(error => {
      if (current === generation) update("failed", `모델 준비 실패: ${error.message}`);
    });
    return snapshot;
  }
  if (value.type === "start") {
    if (!engine?.ready || snapshot.state !== "ready" || value.tabId !== snapshot.tabId || !value.streamId) throw new Error("이 탭의 모델을 먼저 준비하세요.");
    const current = generation;
    const owned = engine;
    update("starting", "탭 오디오에 연결 중…");
    capture = createChromeTabInput(value.tabId, chrome.runtime.getURL("pcm-worklet.js"),
      { maxChunkBytes: 8192, maxAudioQueueMs: 1000 }, () => { void stop(); });
    const input = capture;
    try {
      await input.capture(value.streamId);
      if (current !== generation) return snapshot;
      snapshot.target = input.target;
      const session = createSessionController({ input: input.input, createEngine: () => owned.port,
        createSessionId: () => crypto.randomUUID(), onCaption: accept,
        onClear(identity) { emit({ type: "clear", identity }); },
        onStatus(status) {
          if (current !== generation) return;
          snapshot.identity = session.identity;
          if (status.state === "probing" && session.identity) emit({ type: "activate", identity: session.identity, target: input.target });
          if (status.state === "running" && owned.running) update("running", "번역 중 · 창을 닫아도 자막이 계속 표시됩니다.");
          else if (["failed", "unavailable", "paused"].includes(status.state)) {
            void stop().then(() => update("failed", `번역이 중단되었습니다: ${status.reason ?? status.state}`));
          } else if (status.state === "idle") void stop();
        },
      });
      controller = session;
      await session.start(input.target, { source: snapshot.source, target: "ko" });
    } catch (error) {
      if (current === generation) { await stop(); update("failed", `탭 연결 실패: ${String(error)}`); }
    }
    return snapshot;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || (sender.url && sender.url !== chrome.runtime.getURL("service-worker.js")) || sender.tab || message?.channel !== backgroundChannel) return;
  void command(message.command).then(snapshot => respond({ snapshot }), error => respond({ error: error.message }));
  return true;
});
