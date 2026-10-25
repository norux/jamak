import { env, InferenceSession, Tensor } from "onnxruntime-web/wasm";
import wasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";
import wasmModuleUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";
import { languageCandidate, registeredCandidate } from "./model";
import { createModelRepository } from "./model-repository";

const selected = registeredCandidate(languageCandidate.model, "fp32");
env.wasm.numThreads = 1;
env.wasm.proxy = false;
env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
let session: InferenceSession | undefined;
let busy = false;
let indices: number[] = [];
globalThis.onmessage = async (event: MessageEvent<{ requestId: number; type: string; pcm?: Float32Array }>) => {
  const value = event.data;
  if (!value || !Number.isSafeInteger(value.requestId)) return;
  const send = (message: object) => globalThis.postMessage({ requestId: value.requestId, ...message });
  if (busy) { send({ type: "error", reason: "overloaded" }); return; }
  busy = true;
  try {
    if (value.type === "prepare" && !session) {
      const repository = createModelRepository(async cache => {
        const bytes = await (await cache.match(selected.url(selected.files[0].path)))?.arrayBuffer();
        if (!bytes || bytes.byteLength !== selected.files[0].bytes) throw new Error("Language model size mismatch");
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (hash !== languageCandidate.files[0].sha256) throw new Error("Language model checksum mismatch");
        const runtime = await fetch(wasmUrl);
        if (!runtime.ok) throw new Error("Packaged language runtime unavailable");
        env.wasm.wasmBinary = await runtime.arrayBuffer();
        const loaded = await InferenceSession.create(bytes, { executionProviders: ["wasm"] });
        if (loaded.inputNames.join() !== "audio" || loaded.outputNames.join() !== "logits,embedding") {
          await loaded.release(); throw new Error("Unexpected language graph");
        }
        const labels = await (await cache.match(selected.url("lang_map.json")))?.json();
        indices = ["en", "ja", "ko"].map(language => Number(Object.keys(labels ?? {}).find(index => labels[index]?.iso === language)));
        if (indices.some(index => !Number.isInteger(index) || index < 0 || index >= 107)) { await loaded.release(); throw new Error("Invalid language labels"); }
        session = loaded;
        return { dispose: () => loaded.release() };
      }, selected.model, "fp32");
      for await (const status of repository.prepare(selected.model)) {
        send({ type: "status", status });
        if (status.state === "failed") throw new Error(status.reason);
      }
      send({ type: "ready" });
    } else if (value.type === "detect" && session && value.pcm instanceof Float32Array
      && value.pcm.length > 0 && value.pcm.length <= 480000
      && value.pcm.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1)) {
      const start = performance.now();
      const output = await session.run({ audio: new Tensor("float32", value.pcm, [1, value.pcm.length]) }, ["logits"]);
      const logits = output.logits;
      if (logits.dims.join() !== "1,107") throw new Error("Invalid language logits");
      // Probabilities are conditional on the three supported session languages.
      const scores = indices.map(index => Number(logits.data[index]));
      if (!scores.every(Number.isFinite)) throw new Error("Invalid language scores");
      const maximum = Math.max(...scores);
      const weights = scores.map(score => Math.exp(score - maximum));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const index = scores.indexOf(maximum);
      send({ type: "result", language: ["en", "ja", "ko"][index], confidence: weights[index] / total, inferenceMs: performance.now() - start });
    } else throw new Error("Language model is not ready or audio is invalid");
  } catch (error) { send({ type: "error", reason: (error as Error).message }); }
  finally { busy = false; }
};
