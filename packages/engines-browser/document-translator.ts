import type { Capability, LanguagePair, ReasonCode, SessionIdentity, TextTranslator } from "../contracts";
import { sameIdentity } from "../core/identity";

interface NativeTranslator {
  translate(text: string, options: { signal: AbortSignal }): Promise<string>;
  translateStreaming?(text: string, options: { signal: AbortSignal }): ReadableStream<string>;
  destroy(): void;
}

interface TranslatorApi {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<"available" | "downloadable" | "downloading" | "unavailable">;
  create(options: {
    sourceLanguage: string; targetLanguage: string; signal: AbortSignal;
    monitor(monitor: { addEventListener(type: "downloadprogress", receive: (event: { loaded: number }) => void): void }): void;
  }): Promise<NativeTranslator>;
}

export function createDocumentTranslator(document: Document, languages: LanguagePair,
  receive: (status: { state: "preparing" | "ready" | "stopped" | "failed"; progress?: number; reason?: ReasonCode }) => void, execution: "foreground" | "offscreen" = "foreground") {
  let pair = { ...languages };
  const translators = new Map<string, NativeTranslator>();
  let sources = (pair.source === "auto" ? ["en", "ja", "ko"] : [pair.source]).filter(source => source !== pair.target);
  let englishBridge = pair.source === "auto" && pair.target === "ja";
  function target(source: string) { return englishBridge && source === "ko" ? "en" : pair.target; }
  function key(source: string) { return `${source}:${target(source)}`; }
  let preparing: AbortController | undefined;
  let active: { identity: SessionIdentity; controller: AbortController } | undefined;
  let disposed = false;
  let translationRevision = 0;

  function api(): TranslatorApi | undefined {
    return (document.defaultView as (Window & { Translator?: TranslatorApi }) | null)?.Translator;
  }
  function eligible(visible = true) {
    return !disposed && document.defaultView?.isSecureContext && (execution === "offscreen" || !visible || document.visibilityState === "visible");
  }
  function supported() { return ["auto", "ja", "en", "ko"].includes(pair.source) && ["ko", "en", "ja"].includes(pair.target); }
  function stop() {
    preparing?.abort(); preparing = undefined;
    active?.controller.abort(); active = undefined;
    for (const translator of translators.values()) translator.destroy();
    translators.clear();
    receive({ state: "stopped", reason: "cancelled" });
  }
  const suspend = () => { if (execution === "foreground" && document.visibilityState !== "visible" && active) stop(); };
  document.addEventListener("visibilitychange", suspend);
  document.defaultView?.addEventListener("pagehide", stop);

  const port: TextTranslator = {
    async *translate(source, requested) {
      if (!eligible()) throw new Error("execution-context-unavailable");
      if (!supported() || !sources.includes(requested.source) || requested.target !== pair.target || source.language !== requested.source) throw new Error("language-pair-unsupported");
      const translator = translators.get(key(source.language));
      if (!translator) throw new Error("model-load-failed");
      if (!source.text || source.text.length > 16384 || !Number.isSafeInteger(source.sourceRevision) || source.sourceRevision <= 0) throw new Error("Invalid translation source");
      if (active) throw new Error("overloaded");
      const identity = { ...source.identity };
      const utteranceId = source.utteranceId; const sourceRevision = source.sourceRevision;
      const operation = { identity, controller: new AbortController() };
      active = operation;
      try {
        // ASR can omit punctuation between Japanese sentence endings. Casual
        // endings need a new-script word or discourse marker: never split よく
        // or relative clauses such as 行った駅 just because a verb ended.
        // Keep spaces within time phrases; splitting every word loses context.
        const phrases = source.language === "ja" ? source.text.split(
          /(?<=[。！？!?])\s*|(?<=ませんでした|ません|ました|ます|でした|です|ましょう|ください)\s*(?=[\p{Script=Han}\p{Script=Katakana}])|(?<=ですか|でしたか|ますか|ましたか|ませんか|大丈夫|(?:ませんでした|ません|ました|でした|ください|る|た|だ|ない|ます|です|て|で|く|いい)[よね]|んだ|んだけど|かな|しよう)\s*(?=[\p{Script=Han}\p{Script=Katakana}]|ところで|それから|まだ|でも|じゃあ|もちろん|ありがとう|まったく|ちょうど)/u,
        ).map(phrase => phrase.trim()).filter(Boolean) : [source.text];
        // Chrome can consume activation per unpreferred language pair. Share
        // en-to-ja in automatic mode so preparation needs only one such create.
        const native = englishBridge && source.language === "ko" ? translators.get(key("en")) : translator;
        if (!native) throw new Error("model-load-failed");
        let text = "";
        for (const phrase of phrases) {
          operation.controller.signal.throwIfAborted();
          const input = englishBridge && source.language === "ko" ? await translator.translate(phrase, { signal: operation.controller.signal }) : phrase;
          operation.controller.signal.throwIfAborted();
          if (typeof input !== "string" || !input.trim() || input.length > 16384) throw new Error("Invalid translation result");
          if (native.translateStreaming) {
            const prefix = text ? `${text} ` : "";
            let part = "";
            const reader = native.translateStreaming(input, { signal: operation.controller.signal }).getReader();
            const abort = () => { void reader.cancel().catch(() => {}); };
            operation.controller.signal.addEventListener("abort", abort, { once: true });
            try {
              for (;;) {
                const chunk = await reader.read();
                operation.controller.signal.throwIfAborted();
                if (chunk.done) break;
                if (typeof chunk.value !== "string") throw new Error("Invalid translation result");
                part += chunk.value;
                text = prefix + part;
                if (text.length > 16384) throw new Error("Invalid translation result");
                if (chunk.value && text.trim()) yield { identity, utteranceId, sourceRevision, translationRevision: ++translationRevision,
                  languages: { ...requested }, text, final: false };
              }
              if (!part.trim()) throw new Error("Invalid translation result");
            } finally {
              operation.controller.signal.removeEventListener("abort", abort);
              await reader.cancel().catch(() => {}); reader.releaseLock();
            }
            continue;
          }
          const part = await native.translate(input, { signal: operation.controller.signal });
          operation.controller.signal.throwIfAborted();
          if (typeof part !== "string" || !part.trim() || part.length > 16384) throw new Error("Invalid translation result");
          text += `${text ? " " : ""}${part}`;
          if (text.length > 16384) throw new Error("Invalid translation result");
        }
        if (!eligible()) throw new Error("execution-context-unavailable");
        if (typeof text !== "string" || !text.trim() || text.length > 16384) throw new Error("Invalid translation result");
        yield { identity, utteranceId, sourceRevision, translationRevision: ++translationRevision,
          languages: { ...requested }, text, final: true };
      } finally { if (active === operation) active = undefined; }
    },
    async cancel(identity) {
      if (active && sameIdentity(active.identity, identity)) {
        active.controller.abort(); active = undefined;
      }
    },
    async close() {
      if (disposed) return;
      disposed = true; stop();
      document.removeEventListener("visibilitychange", suspend);
      document.defaultView?.removeEventListener("pagehide", stop);
    },
  };

  return {
    ...port,
    get streaming() { return sources.length > 0 && sources.every(source => typeof translators.get(key(source))?.translateStreaming === "function"); },
    async probe(): Promise<Capability> {
      if (!eligible() || !api()) return { state: "unavailable", reason: "execution-context-unavailable", message: "Translator requires an eligible visible secure document" };
      if (!supported()) return { state: "unavailable", reason: "language-pair-unsupported", message: "Select English, Japanese or Korean for speech and subtitles" };
      try {
        const states = await Promise.all(sources.map(sourceLanguage => api()?.availability({ sourceLanguage, targetLanguage: target(sourceLanguage) })));
        if (!eligible()) return { state: "unavailable", reason: "execution-context-unavailable", message: "Document suspended during probe" };
        if (states.every(state => state === "available")) return { state: "available" };
        if (states.every(state => state === "available" || state === "downloadable" || state === "downloading")) return { state: "download-required", reason: "download-required", message: "Press Prepare to download or finish loading this language pair" };
        return { state: "unavailable", reason: "language-pair-unsupported", message: "Browser cannot translate this language pair" };
      } catch { return { state: "unavailable", reason: "execution-context-unavailable", message: "Translator capability probe failed" }; }
    },
    async prepare(languages: LanguagePair = pair): Promise<void> {
      const native = api();
      if (!eligible() || !native) throw new Error("execution-context-unavailable");
      if (preparing || active) throw new Error("Stop before preparing another translator");
      pair = { ...languages };
      sources = (pair.source === "auto" ? ["en", "ja", "ko"] : [pair.source]).filter(source => source !== pair.target);
      englishBridge = pair.source === "auto" && pair.target === "ja";
      if (!supported()) throw new Error("language-pair-unsupported");
      if (execution === "foreground" && !document.defaultView?.navigator.userActivation.isActive) throw new Error("Press Prepare in this document to start");
      const operation = new AbortController(); preparing = operation;
      receive({ state: "preparing" });
      try {
        // Call create before any await: a capability probe must not consume the
        // activation needed to begin the browser-owned language-pack download.
        await Promise.all(sources.map(async sourceLanguage => {
          const id = key(sourceLanguage);
          if (translators.has(id)) return;
          const loaded = await native.create({ sourceLanguage, targetLanguage: target(sourceLanguage), signal: operation.signal,
            monitor(monitor) {
              monitor.addEventListener("downloadprogress", event => {
                if (preparing === operation && !operation.signal.aborted && Number.isFinite(event.loaded) && event.loaded >= 0 && event.loaded <= 1) receive({ state: "preparing", progress: event.loaded });
              });
            },
          });
          if (operation.signal.aborted || !eligible(false)) { loaded.destroy(); throw new DOMException("Translation preparation stopped", "AbortError"); }
          translators.set(id, loaded);
        }));
        receive({ state: "ready" });
      } catch (error) {
        if (!operation.signal.aborted) receive({ state: "failed", reason: error instanceof DOMException && error.name === "NotSupportedError" ? "language-pair-unsupported" : "model-load-failed" });
        operation.abort();
        if (preparing === operation) {
          for (const translator of translators.values()) translator.destroy();
          translators.clear();
        }
        throw error;
      } finally { if (preparing === operation) preparing = undefined; }
    },
    stop,
  };
}
