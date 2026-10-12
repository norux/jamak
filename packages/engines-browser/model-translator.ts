import type { Capability, LanguagePair, ModelStatus, SessionIdentity, TextTranslator } from "../contracts";
import { sameIdentity } from "../core/identity";
import { registeredCandidate } from "./model";
import { createModelRepository } from "./model-repository";
import { translationCandidates } from "./translation-model";

export function createModelTranslator(document: Document, languages: LanguagePair, candidate: keyof typeof translationCandidates,
  receive: (status: ModelStatus) => void, execution: "foreground" | "offscreen" = "foreground") {
  const selected = registeredCandidate(translationCandidates[candidate].model, translationCandidates[candidate].dtype);
  let worker: Worker | undefined;
  let requestId = 0;
  let ready = false;
  let disposed = false;
  let translationRevision = 0;
  let active: SessionIdentity | undefined;
  let pending: { resolve(value?: string): void; reject(error: Error): void; chunk?: (text: string) => void } | undefined;
  function eligible() { return !disposed && document.defaultView?.isSecureContext && (execution === "offscreen" || document.visibilityState === "visible"); }
  function stop() {
    ready = false; active = undefined; requestId++;
    worker?.terminate(); worker = undefined;
    const operation = pending; pending = undefined;
    operation?.reject(new DOMException("Translation stopped", "AbortError"));
  }
  function request(type: "prepare" | "translate", text?: string, language?: string, chunk?: (text: string) => void) {
    if (!eligible()) return Promise.reject(new Error("execution-context-unavailable"));
    if (pending) return Promise.reject(new Error("overloaded"));
    if (type === "translate" && !ready) return Promise.reject(new Error("model-load-failed"));
    if (!worker) {
      worker = new Worker(new URL("./model-translator-worker.ts", import.meta.url), { type: "module" });
      const owned = worker;
      worker.onmessage = (event: MessageEvent<{ requestId: number; type: string; status?: ModelStatus; reason?: string; text?: string }>) => {
        const value = event.data;
        if (worker !== owned || value?.requestId !== requestId || !pending) return;
        if (value.type === "status" && value.status?.model.id === selected.model.id && value.status.model.version === selected.model.version) { receive(value.status); return; }
        if (value.type === "chunk" && typeof value.text === "string" && value.text.trim() && value.text.length <= 16384) { pending.chunk?.(value.text); return; }
        const operation = pending;
        if (value.type === "ready") { ready = true; pending = undefined; operation.resolve(); }
        else if (value.type === "result" && typeof value.text === "string" && value.text.trim() && value.text.length <= 16384) { pending = undefined; operation.resolve(value.text); }
        else { pending = undefined; stop(); operation.reject(new Error(value.reason ?? "Invalid translation worker response")); }
      };
      worker.onerror = event => { const operation = pending; pending = undefined; stop(); operation?.reject(new Error(event.message)); };
    }
    const current = ++requestId;
    return new Promise<string | undefined>((resolve, reject) => {
      pending = { resolve, reject, chunk };
      worker?.postMessage({ requestId: current, type, candidate, text, language });
    });
  }
  const suspend = () => { if (execution === "foreground" && document.visibilityState !== "visible") stop(); };
  document.addEventListener("visibilitychange", suspend);
  document.defaultView?.addEventListener("pagehide", stop);
  const port: TextTranslator = {
    streaming: candidate === "hyMt2",
    async *translate(source, pair) {
      if (!source.text || source.text.length > 16384 || !Number.isSafeInteger(source.sourceRevision) || source.sourceRevision <= 0) throw new Error("Invalid translation source");
      if ((languages.source !== "auto" && languages.source !== pair.source) || pair.target !== "ko" || source.language !== pair.source || (pair.source !== "en" && pair.source !== "ja")) throw new Error("language-pair-unsupported");
      if (active) throw new Error("overloaded");
      const identity = { ...source.identity }; active = identity;
      let latest: string | undefined;
      let done = false;
      let failure: Error | undefined;
      let wake: (() => void) | undefined;
      try {
        // Keep only the latest cumulative chunk while the consumer paints.
        void request("translate", source.text, source.language, text => { latest = text; wake?.(); }).then(text => {
          latest = text; done = true; wake?.();
        }, error => { failure = error; done = true; wake?.(); });
        for (;;) {
          if (failure) throw failure;
          if (!active || !sameIdentity(active, identity)) throw new DOMException("Translation stopped", "AbortError");
          if (latest) {
            const text = latest; latest = undefined;
            yield { identity, utteranceId: source.utteranceId, sourceRevision: source.sourceRevision, translationRevision: ++translationRevision,
              languages: { ...pair }, text, final: done };
            continue;
          }
          if (done) break;
          if (!latest) await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
        }
      } finally { if (active === identity) { if (!done) stop(); active = undefined; } }
    },
    async cancel(identity) { if (active && sameIdentity(active, identity)) stop(); },
    async close() {
      if (disposed) return;
      disposed = true; stop(); document.removeEventListener("visibilitychange", suspend); document.defaultView?.removeEventListener("pagehide", stop);
    },
  };
  return {
    ...port,
    async probe(): Promise<Capability> {
      if (!eligible()) return { state: "unavailable", reason: "execution-context-unavailable", message: "Local translator requires a secure execution context" };
      const repository = createModelRepository(async () => { throw new Error("Probe does not load models"); }, selected.model, selected.dtype);
      const status = await repository.status(selected.model);
      return status.state === "cached" || ready ? { state: "available" } : { state: "download-required", reason: "download-required", message: "Select this model to download it" };
    },
    async prepare() {
      if (execution === "foreground" && !document.defaultView?.navigator.userActivation.isActive) throw new Error("Press Prepare in this document to start");
      if (ready) throw new Error("Stop before preparing another translator");
      await request("prepare");
    },
    stop,
  };
}
