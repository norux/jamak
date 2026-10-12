import type { AudioChunk, SessionIdentity, SessionStatus, SpeechRecognizer, TranscriptRevision } from "../contracts";
import { validAudio } from "../core/audio-queue";
import { sameIdentity } from "../core/identity";

interface LocalRecognition {
  processLocally: boolean;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(track: MediaStreamTrack): void;
  abort(): void;
}
interface LocalRecognitionApi {
  new(): LocalRecognition;
  install(options: { langs: string[]; processLocally: true }): Promise<boolean>;
  available(options: { langs: string[]; processLocally: true }): Promise<string>;
}

export function localSpeechLanguages(language: "ja" | "en") {
  // Chrome starts SODA with its Live Caption language before the requested
  // recognizer. Korean can be account-synced even when the local pref is absent.
  return language === "ja" ? ["ja-JP", "en-US", "ko-KR"] : ["en-US", "ko-KR"];
}

// Chrome's streaming recognizer reads the same authorized tab track as the PCM
// transport. PCM still enforces the session's input clock, bounds and lifetime.
export function createLocalSpeechHost(document: Document, language: "ja" | "en",
  track: () => MediaStreamTrack | undefined,
  receive: (message: string, progress?: string) => void) {
  const view = document.defaultView as (Window & { SpeechRecognition?: LocalRecognitionApi; webkitSpeechRecognition?: LocalRecognitionApi }) | null;
  const api = view?.SpeechRecognition ?? view?.webkitSpeechRecognition;
  const locale = language === "ja" ? "ja-JP" : "en-US";
  const requiredLanguages = localSpeechLanguages(language);
  const supported = !!api?.install && !!api.available && "processLocally" in new api();
  let ready = false; let recognizing = false; let disposed = false; let generation = 0;
  let active: (() => void) | undefined;

  function stop() { generation++; ready = false; active?.(); active = undefined; }
  document.defaultView?.addEventListener("pagehide", stop);
  return {
    supported,
    get running() { return recognizing; },
    model: { id: `Chrome/on-device-speech-recognition/${locale}`, version: view?.navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "browser-managed" },
    async prepare() {
      if (!supported || !api || !view?.isSecureContext || disposed || ready) throw new Error("execution-context-unavailable");
      const current = ++generation;
      receive(`Chrome local speech ${locale}: preparing`, "Chrome 음성 인식 언어 팩 준비 중…");
      // The popup initiates installation with activation. A downloading pack
      // allows this persistent document to join install() without another gesture.
      const deadline = Date.now() + 600000;
      let joined = false;
      for (;;) {
        const availability = await api.available({ langs: requiredLanguages, processLocally: true });
        if (availability === "available") break;
        if (availability === "unavailable") throw new Error("language-pair-unsupported");
        if (disposed || current !== generation) throw new DOMException("Speech preparation stopped", "AbortError");
        if (Date.now() >= deadline) throw new Error("offline-model-unavailable");
        if (availability === "downloading" && !joined) {
          joined = true;
          receive(`Chrome local speech ${locale}: downloading`, "Chrome 음성 인식 언어 팩 다운로드 중…");
          if (!await api.install({ langs: requiredLanguages, processLocally: true })) throw new Error("offline-model-unavailable");
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (disposed || current !== generation) throw new DOMException("Speech preparation stopped", "AbortError");
      ready = true; receive(`Chrome local speech ${locale}: model-ready`);
    },
    createRecognizer(identity: SessionIdentity, report: (status: SessionStatus) => void): SpeechRecognizer {
      if (!ready || !api || active || disposed) throw new Error("Local speech is not prepared");
      const selected = { ...identity };
      const recognition = new api();
      // Never fall back to Chrome's remote speech service or microphone input.
      recognition.processLocally = true; recognition.lang = locale;
      recognition.continuous = true; recognition.interimResults = true;
      const sentences = new Intl.Segmenter(language, { granularity: "sentence" });
      const records = new Map<string, { text: string; revision: number; final: boolean; startMs: number; endMs: number }>();
      const pending = new Map<string, TranscriptRevision>();
      let input: AsyncIterator<AudioChunk> | undefined;
      let started = false; let stopped = false; let ended = false;
      let audioFormat = "";
      let failure: Error | undefined; let endMs = 0; let nativeStartMs = 0;
      let wake: (() => void) | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
      const pauses = new Map<number, { units: number; endMs: number }[]>();
      const latest = new Map<number, { index: number; text: string; final: boolean; startMs: number }>();
      let quietMs = 0; let hadSpeech = false;
      function units(text: string) {
        // SODA alternates "1:30" and "1 30"; count both as two units so an
        // earlier number correction cannot shift every later turn boundary.
        return language === "ja" ? Array.from(text.trim()) : text.trim().match(/\d+(?=:\d)|\S+/gu) ?? [];
      }
      let drafts: { index: number; text: string; final: boolean; startMs: number }[] = [];

      function stop(reason?: string) {
        if (stopped) return;
        stopped = true; recognizing = false; if (reason) failure = new Error(reason);
        clearTimeout(timer); pending.clear(); drafts = [];
        recognition.onstart = null; recognition.onresult = null; recognition.onerror = null; recognition.onend = null;
        recognition.abort(); active = undefined;
        void input?.return?.().catch(() => {}); wake?.();
      }
      active = () => stop("cancelled");
      recognition.onstart = () => {
        if (stopped) return;
        recognizing = true;
        receive(`Chrome local speech ${locale}: started${audioFormat}`);
        report({ identity: selected, state: "running", message: "Local streaming speech", queue: { pendingAudioMs: 0, droppedAudioMs: 0 } });
      };
      function publish() {
        timer = undefined; if (stopped) return;
        for (const draft of drafts) {
          const tokens = units(draft.text);
          const boundaries = pauses.get(draft.index) ?? [];
          const spans = [...boundaries, { units: tokens.length, endMs }].map((boundary, index) => ({
            text: tokens.slice(index ? boundaries[index - 1].units : 0, boundary.units).join(language === "ja" ? "" : " ").replace(/(?<=\d)\s+:(?=\d)/gu, ":"),
            startMs: index ? boundaries[index - 1].endMs : draft.startMs, endMs: boundary.endMs,
          }));
          for (const [spanIndex, span] of spans.entries()) {
            const parts = boundaries.length ? [span.text.trim()].filter(Boolean) : (language === "ja" ? span.text.trim().split(/(?<=[。！？!?])\s*|(?<=ませんでした|ません|ました|ます|でした|です|ましょう|ください)\s*(?=[\p{Script=Han}\p{Script=Katakana}])/u)
              : [...sentences.segment(span.text.trim())].flatMap(sentence => sentence.segment.split(/\s+(?=(?:let['’]s|please do|we will)\b)/iu)))
              .map(text => text.trim()).filter(Boolean);
            for (const [index, text] of parts.entries()) {
              const id = `local-${draft.index}-${spanIndex}-${index}`;
              const previous = records.get(id);
              if (!text.trim()) continue;
              const final = draft.final || previous?.final === true
                || previous?.text === text && (spanIndex < boundaries.length || index < parts.length - 1);
              if (previous?.text === text && previous.final === final) continue;
              const record = { text, revision: (previous?.revision ?? 0) + 1, final,
                startMs: previous?.startMs ?? Math.max(span.startMs, index ? records.get(`local-${draft.index}-${spanIndex}-${index - 1}`)?.endMs ?? span.startMs : span.startMs), endMs: span.endMs };
              records.set(id, record);
              // Native Web Speech has no word timestamps: these are capture
              // delivery ranges, not invented acoustic sentence boundaries.
              pending.set(id, { identity: selected, utteranceId: id, sourceRevision: record.revision,
                language, text, final, audioRange: { startMs: record.startMs, endMs: Math.max(record.startMs, record.endMs) } });
              if (pending.size > 16) { stop("overloaded"); return; }
              if (records.size > 300) records.delete(records.keys().next().value as string);
            }
          }
        }
        drafts = []; wake?.();
      }
      recognition.onresult = event => {
        if (stopped) return;
        if (!Number.isSafeInteger(event.resultIndex) || event.resultIndex < 0 || event.results.length - event.resultIndex > 16) { stop("engine-failed"); return; }
        drafts = [];
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index]; const raw = result?.[0]?.transcript;
          // SODA may insert spaces between Japanese tokens only in its final
          // result. Keep those from changing sentence IDs or negation endings.
          const text = typeof raw === "string" && language === "ja" ? raw.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+|\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, "") : raw;
          if (typeof text !== "string" || text.length > 16384 || typeof result.isFinal !== "boolean") { stop("engine-failed"); return; }
          const draft = { index, text, final: result.isFinal, startMs: latest.get(index)?.startMs ?? nativeStartMs };
          latest.set(index, draft); drafts.push(draft);
          if (latest.size > 16) { const oldest = latest.keys().next().value as number; latest.delete(oldest); pauses.delete(oldest); }
          if (result.isFinal) nativeStartMs = endMs;
        }
        // Coalesce drafts so translations keep up; final results bypass the gate.
        if (drafts.some(draft => draft.final)) { clearTimeout(timer); publish(); }
        else timer ??= setTimeout(publish, 180);
      };
      recognition.onerror = event => {
        if (stopped) return;
        receive(`Chrome local speech ${locale}: ${event.error}${audioFormat}`);
        stop(event.error === "aborted" ? "cancelled" : "engine-failed");
      };
      recognition.onend = () => {
        if (stopped || ended) return;
        receive(`Chrome local speech ${locale}: recognition ended`);
        stop("engine-failed");
      };
      async function consume() {
        let previous: AudioChunk | undefined;
        try {
          while (!stopped) {
            const next = await input?.next(); if (stopped) return;
            if (!next || next.done) break;
            const chunk = next.value;
            if (!sameIdentity(selected, chunk.identity) || previous && (chunk.sequence !== previous.sequence + 1 || chunk.scope !== previous.scope
              || chunk.capture.clockId !== previous.capture.clockId || Math.abs(chunk.audioRange.startMs - previous.audioRange.endMs) > 0.001
              || Math.abs(chunk.capture.startMs - previous.capture.endMs) > 0.001)) { stop("audio-gap"); return; }
            if (!validAudio(chunk) || chunk.sampleRate !== 16000 || chunk.channels !== 1 || chunk.sampleFormat !== "pcm-f32le"
              || !["tab-mix", "selected-video"].includes(chunk.scope) || !(chunk.pcm instanceof ArrayBuffer) || chunk.pcm.byteLength > 12800
              || !new Float32Array(chunk.pcm).every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1)) { stop("engine-failed"); return; }
            previous = chunk; endMs = chunk.audioRange.endMs;
            const pcm = new Float32Array(chunk.pcm);
            const rms = Math.sqrt(pcm.reduce((sum, sample) => sum + sample * sample, 0) / pcm.length);
            if (rms < 0.006) quietMs += chunk.audioRange.endMs - chunk.audioRange.startMs;
            else {
              // SODA can keep a whole conversation in one unpunctuated result.
              // Split at measured pauses so translation edits stay within a turn.
              if (hadSpeech && quietMs >= 320) for (const draft of latest.values()) {
                if (draft.final) continue;
                const boundaries = pauses.get(draft.index) ?? [];
                const count = units(draft.text).length;
                if (count > (boundaries.at(-1)?.units ?? 0)) {
                  boundaries.push({ units: count, endMs: chunk.audioRange.startMs - quietMs });
                  pauses.set(draft.index, boundaries);
                }
              }
              hadSpeech = true; quietMs = 0;
            }
          }
          if (!stopped) { ended = true; clearTimeout(timer); publish(); wake?.(); }
        } catch (error) { if (!stopped) stop(error instanceof Error && error.message === "audio-gap" ? "audio-gap" : "engine-failed"); }
      }
      return {
        async *run(audio) {
          if (started || stopped) throw new Error("Local speech requires a fresh session");
          started = true; input = audio[Symbol.asyncIterator]();
          const source = track();
          if (source?.kind !== "audio" || source.readyState !== "live") { stop("engine-failed"); throw new Error("Authorized tab audio track required"); }
          const settings = source.getSettings?.();
          if (settings) audioFormat = ` (${settings.sampleRate ?? "unknown"} Hz, ${settings.channelCount ?? "unknown"} channels)`;
          try {
            recognition.start(source);
            void consume();
            while (!stopped) {
              const next = pending.entries().next().value;
              if (next) { pending.delete(next[0]); yield next[1]; continue; }
              if (ended) break;
              await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
            }
            if (failure) throw failure;
          } finally { stop(); records.clear(); }
        },
        async cancel(current) { if (sameIdentity(selected, current)) stop("cancelled"); },
        async close() { stop(); },
      };
    },
    stop,
    dispose() { if (disposed) return; disposed = true; stop(); document.defaultView?.removeEventListener("pagehide", stop); },
  };
}
