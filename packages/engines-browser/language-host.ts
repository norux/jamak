import type { ModelStatus } from "../contracts";
import { languageCandidate, registeredCandidate } from "./model";

type Decision = { language: "en" | "ja" | "ko"; confidence: number; inferenceMs: number };
export function createLanguageHost(document: Document, receive: (status: ModelStatus) => void, execution: "foreground" | "offscreen" = "foreground") {
  const selected = registeredCandidate(languageCandidate.model, "fp32");
  let worker: Worker | undefined;
  let requestId = 0;
  let ready = false;
  let disposed = false;
  let pending: { resolve(value?: Decision): void; reject(error: Error): void } | undefined;
  function stop() {
    ready = false; requestId++;
    worker?.terminate(); worker = undefined;
    const operation = pending; pending = undefined;
    operation?.reject(new DOMException("Language detection stopped", "AbortError"));
  }
  function request(type: "prepare" | "detect", pcm?: Float32Array) {
    if (disposed || !document.defaultView?.isSecureContext || execution === "foreground" && document.visibilityState !== "visible") return Promise.reject(new Error("Language detection requires a secure active document"));
    if (type === "prepare" && execution === "foreground" && !document.defaultView.navigator.userActivation.isActive) return Promise.reject(new Error("Press Prepare in this document to start"));
    if (pending) return Promise.reject(new Error("overloaded"));
    if (type === "detect" && !ready) return Promise.reject(new Error("Language model is not ready"));
    if (!worker) {
      worker = new Worker(new URL("./language-worker.ts", import.meta.url), { type: "module" });
      const owned = worker;
      worker.onmessage = (event: MessageEvent<{ requestId: number; type: string; status?: ModelStatus; reason?: string } & Decision>) => {
        const value = event.data;
        if (worker !== owned || value?.requestId !== requestId || !pending) return;
        if (value.type === "status" && value.status?.model.id === selected.model.id && value.status.model.version === selected.model.version
          && value.status.requiredBytes === selected.requiredBytes) { receive(value.status); return; }
        const operation = pending;
        if (value.type === "ready") { pending = undefined; ready = true; operation.resolve(); return; }
        if (value.type === "result" && ["en", "ja", "ko"].includes(value.language)
          && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
          && Number.isFinite(value.inferenceMs) && value.inferenceMs >= 0) {
          pending = undefined; operation.resolve({ language: value.language, confidence: value.confidence, inferenceMs: value.inferenceMs }); return;
        }
        pending = undefined; stop(); operation.reject(new Error(value.reason ?? "Invalid language decision"));
      };
      worker.onmessageerror = () => { const operation = pending; pending = undefined; stop(); operation?.reject(new Error("Language worker transport failed")); };
      worker.onerror = () => { const operation = pending; pending = undefined; stop(); operation?.reject(new Error("Language worker failed")); };
    }
    const current = ++requestId;
    return new Promise<Decision | undefined>((resolve, reject) => {
      pending = { resolve, reject };
      worker?.postMessage({ requestId: current, type, pcm }, pcm ? [pcm.buffer as ArrayBuffer] : []);
    });
  }
  const suspend = () => { if (execution === "foreground" && document.visibilityState !== "visible") stop(); };
  document.addEventListener("visibilitychange", suspend);
  document.defaultView?.addEventListener("pagehide", stop);
  return {
    prepare: () => request("prepare"),
    async detect(pcm: Float32Array) {
      const result = await request("detect", pcm);
      if (!result) throw new Error("Missing language decision");
      return result;
    },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true; stop();
      document.removeEventListener("visibilitychange", suspend);
      document.defaultView?.removeEventListener("pagehide", stop);
    },
  };
}
