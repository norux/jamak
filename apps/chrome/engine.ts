import type { InterpretationEngine, LanguagePair, ModelStatus, SessionIdentity } from "../../packages/contracts";
import { sameIdentity } from "../../packages/core/identity";
import { createLanguageHost } from "../../packages/engines-browser/language-host";
import { createAsrHost } from "../../packages/engines-browser/asr-host";
import { createDocumentTranslator } from "../../packages/engines-browser/document-translator";
import { createModelTranslator } from "../../packages/engines-browser/model-translator";
import { createLocalSpeechHost } from "../../packages/engines-browser/local-speech";
import { asrCandidates, registeredCandidate, speakerCandidate, vadCandidate, languageCandidate } from "../../packages/engines-browser/model";
import { createBrowserPipeline } from "../../packages/engines-browser/pipeline";
import { createSpeakerHost } from "../../packages/engines-browser/speaker-host";
import { createStreamingSpeechRecognizer } from "../../packages/engines-browser/streaming-speech";
import { createVadHost } from "../../packages/engines-browser/vad-host";
import { defaultModelOptions, type ModelOptions, recognitionChoices, translationChoices, subtitleLanguages, detectionChoices } from "./model-options";

export function createChromeEngine(document: Document, source: "ja" | "en" | "ko" | "auto", receive: (message: string, progress?: string, fraction?: number) => void, execution: "foreground" | "offscreen" = "foreground", audioTrack?: () => MediaStreamTrack | undefined, options: ModelOptions = defaultModelOptions) {
  options = { ...options };
  let target = options.targetLanguage ?? "ko";
  let languages = { source, target };
  const candidate = options.recognition === "chrome" ? "turboFp16" : options.recognition;
  const model = registeredCandidate(asrCandidates[candidate].model, asrCandidates[candidate].dtype);
  const report = (status: ModelStatus) => receive(`${status.model.id} @ ${status.model.version}: ${status.state}; ${status.downloadedBytes ?? 0}/${status.requiredBytes} bytes${status.reason ? ` (${status.reason})` : ""}`,
    status.state === "downloading" ? `음성 인식 모델 다운로드 · ${Math.floor((status.downloadedBytes ?? 0) / status.requiredBytes * 100)}%`
      : status.state === "loading" ? "음성 인식 모델을 불러오는 중…" : undefined,
    status.state === "downloading" ? (status.downloadedBytes ?? 0) / status.requiredBytes : undefined);
  const speaker = createSpeakerHost(document, status => receive(`Speaker ${status.state}: ${status.downloadedBytes ?? 0}/${status.requiredBytes}`,
    status.state === "downloading" ? "화자 구분 모델 다운로드 중…" : status.state === "loading" ? "화자 구분 모델을 불러오는 중…" : undefined,
    status.state === "downloading" ? (status.downloadedBytes ?? 0) / status.requiredBytes : undefined));
  let speakerReady = false;
  let asrReady = false;
  let detectorReady = false;
  let localReady = false;
  const asr = createAsrHost(document, candidate, model.dtype === "fp16" ? "webgpu" : "wasm", report, execution);
  const createDetector = () => createLanguageHost(document, status => receive(`Language ${status.state}`,
    status.state === "downloading" ? "언어 감지 모델 다운로드 중…" : status.state === "loading" ? "언어 감지 모델을 불러오는 중…" : undefined,
    status.state === "downloading" ? (status.downloadedBytes ?? 0) / status.requiredBytes : undefined), execution);
  let detector = source === "auto" && options.languageDetection === "voxlingua" ? createDetector() : undefined;
  const executor: Pick<typeof asr, "recognize" | "stop"> = {
    stop() { asr.stop(); detector?.stop(); },
    async recognize(job) {
      if (!detector || job.language !== "auto") return asr.recognize(job);
      const decision = await detector.detect(job.pcm.slice());
      const result = await asr.recognize({ ...job, language: decision.language });
      receive(`Language ${decision.language}: ${Math.round(decision.inferenceMs)} ms`);
      return { ...result, inferenceMs: result.inferenceMs + decision.inferenceMs,
        revision: { ...result.revision, confidence: { measure: "voxlingua-language-probability", value: decision.confidence } } };
    },
  };
  const vad = createVadHost(document, report, execution);
  let local = options.recognition === "chrome" && (source === "ja" || source === "en") && execution === "offscreen" && audioTrack ? createLocalSpeechHost(document, source, audioTrack, receive) : undefined;
  let usingLocal = local?.supported === true;
  const translator = options.translation !== "chrome" ? createModelTranslator(document, languages, options.translation, status => receive(`${status.model.id}: ${status.state}`,
    status.state === "downloading" ? `번역 모델 다운로드 · ${Math.floor((status.downloadedBytes ?? 0) / status.requiredBytes * 100)}%` : status.state === "loading" ? "번역 모델을 불러오는 중…" : undefined,
    status.state === "downloading" ? (status.downloadedBytes ?? 0) / status.requiredBytes : undefined), execution) : createDocumentTranslator(document, languages, status => receive(`Translator ${source} → ${target}: ${status.state}${status.progress === undefined ? "" : ` ${Math.round(status.progress * 100)}%`}${status.reason ? ` (${status.reason})` : ""}`,
    status.state === "preparing" ? `번역 모델 준비${status.progress === undefined ? " 중…" : ` · ${Math.round(status.progress * 100)}%`}` : undefined,
    status.state === "preparing" ? status.progress : undefined), execution);
  let ready = false;
  let preparing = false;
  let disposed = false;
  let generation = 0;
  let identity: SessionIdentity | undefined;
  let pipeline: ReturnType<typeof createBrowserPipeline> | undefined;

  function stopResources() { ready = false; local?.stop(); asr.stop(); detector?.stop(); vad.stop(); translator.stop(); speaker.stop(); speakerReady = false; asrReady = false; detectorReady = false; localReady = false; }
  const port: InterpretationEngine = {
    async probe(pair) {
      const native = source === target ? { state: "available" as const } : await translator.probe();
      return { availability: pair.source !== source || pair.target !== target
        ? { state: "unavailable", reason: "language-pair-unsupported", message: "Prepare the selected source language" }
        : native.state !== "available" && native.state !== "download-required" ? native
        : ready && !disposed ? { state: "available" }
        : { state: "permission-required", reason: "permission-required", message: "Press Prepare in the visible interpreter document" },
      pipeline: "separate-asr-translation", asrOnlyUpdates: true, languages,
      models: [...usingLocal && local ? [local.model] : [model.model, vadCandidate.model], ...options.speaker === "off" ? [] : [speakerCandidate.model], ...source === "auto" && detector ? [languageCandidate.model] : []], limits: { maxChunkBytes: 8192, maxAudioQueueMs: 1000,
        maxPendingUtterances: 16, maxTranslationJobs: 1, maxStoredCaptions: 300 } };
    },
    async prepare(selected, pair) {
      if (!ready || disposed || pipeline || pair.source !== source || pair.target !== target) throw new Error("Press Prepare for a fresh session");
      identity = { ...selected };
      pipeline = createBrowserPipeline(identity, languages, report => usingLocal && local ? local.createRecognizer(selected, report)
        : createStreamingSpeechRecognizer(selected, source, executor, report, vad), translator, speakerReady ? {
          embed: pcm => speaker.embed(pcm),
          fail: error => receive(`화자 구분을 사용할 수 없습니다: ${String(error)}`),
        } : undefined);
    },
    run(audio) {
      if (!pipeline || !ready || disposed) throw new Error("Browser engine is not prepared");
      return pipeline.run(audio);
    },
    async cancel(selected) {
      if (!identity || !sameIdentity(identity, selected)) return;
      ready = false; await pipeline?.cancel(selected);
    },
    async close() {
      if (disposed) return;
      disposed = true; generation++; stopResources();
      await pipeline?.close(); local?.dispose(); speaker.dispose(); asr.dispose(); detector?.dispose(); vad.dispose(); await translator.close();
      document.removeEventListener("visibilitychange", suspend);
      document.defaultView?.removeEventListener("pagehide", interrupt);
    },
  };
  function interrupt() { generation++; stopResources(); if (identity) void port.cancel(identity); }
  function suspend() { if (execution === "foreground" && document.visibilityState !== "visible" && pipeline) interrupt(); }
  document.addEventListener("visibilitychange", suspend);
  document.defaultView?.addEventListener("pagehide", interrupt);

  return {
    port,
    async prepareFromGesture(pair: LanguagePair = languages) {
      if (disposed || preparing || pipeline) throw new Error("Stop before preparing another session");
      if (pair.source !== "auto" && pair.source !== "en" && pair.source !== "ja" && pair.source !== "ko" || pair.target !== "en" && pair.target !== "ja" && pair.target !== "ko") throw new Error("language-pair-unsupported");
      if (source !== pair.source) {
        local?.dispose(); localReady = false;
        local = options.recognition === "chrome" && (pair.source === "ja" || pair.source === "en") && execution === "offscreen" && audioTrack ? createLocalSpeechHost(document, pair.source, audioTrack, receive) : undefined;
        usingLocal = local?.supported === true;
      }
      source = pair.source; target = pair.target; languages = { source, target }; ready = false;
      if (source === "auto" && options.languageDetection === "voxlingua" && !detector) detector = createDetector();
      const current = ++generation; preparing = true;
      try {
        // Local speech observes Chrome's popup-initiated language-pack download.
        const jobs: Promise<unknown>[] = [];
        if (usingLocal && local) {
          if (!localReady) jobs.push(local.prepare().then(() => { localReady = true; }));
        } else if (!asrReady) jobs.push(Promise.all([asr.prepare(), vad.prepare()]).then(() => { asrReady = true; }));
        if (source === "auto" && detector && !detectorReady) jobs.push(detector.prepare().then(() => { detectorReady = true; }));
        if (source !== target) jobs.push(translator.prepare(languages));
        if (options.speaker !== "off" && !speakerReady) jobs.push(speaker.prepare().then(() => { speakerReady = true; }).catch(error => {
          if (options.speaker === "wespeaker") throw error;
          if (current === generation) receive(`화자 구분 모델 준비 실패: ${String(error)}`);
        }));
        await Promise.all(jobs);
        if (disposed || current !== generation) throw new DOMException("Preparation stopped", "AbortError");
        ready = true;
      } catch (error) { if (current === generation) stopResources(); throw error; }
      finally { if (current === generation) preparing = false; }
    },
    get ready() { return ready; },
    get models() {
      return [
        { task: source === "auto" && !detector ? "언어 감지 · 받아쓰기" : "받아쓰기", name: usingLocal ? "Chrome SODA" : candidate === "turboFp16" ? "Whisper large-v3-turbo · FP16 / WebGPU" : `${recognitionChoices.find(choice => choice.id === candidate)?.name} / ${model.dtype === "fp16" ? "WebGPU" : "WASM"}` },
        ...usingLocal ? [] : [{ task: "발화 감지", name: "Silero VAD" }],
        ...source === "auto" && detector ? [{ task: "언어 감지", name: detectionChoices.find(choice => choice.id === (options.languageDetection ?? "whisper"))?.name ?? "" }] : [],
        ...source === target ? [] : [{ task: `${subtitleLanguages.find(language => language.id === target)?.name} 번역`, name: options.translation === "chrome" ? "Chrome TranslateKit" : translationChoices.find(choice => choice.id === options.translation)?.name ?? "" }],
        ...options.speaker === "off" ? [] : [{ task: "화자 구분", name: "WeSpeaker VoxCeleb ResNet34-LM · q8" }],
      ];
    },
    get running() { return !usingLocal || local?.running === true; },
  };
}
