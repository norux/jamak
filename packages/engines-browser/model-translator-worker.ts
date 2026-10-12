import { env, pipeline, TextStreamer } from "@huggingface/transformers";
import wasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import wasmModuleUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url";
import gpuWasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
import gpuModuleUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url";
import { registeredCandidate } from "./model";
import { createModelRepository } from "./model-repository";
import { translationCandidates } from "./translation-model";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.useFSCache = false;
env.useCustomCache = true;
env.useWasmCache = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
}
let resident: Awaited<ReturnType<typeof pipeline<"translation">>> | undefined;
let generator: Awaited<ReturnType<typeof pipeline<"text-generation">>> | undefined;
let candidate: keyof typeof translationCandidates | undefined;
let busy = false;
globalThis.onmessage = async (event: MessageEvent<{ requestId: number; type: string; candidate?: keyof typeof translationCandidates; text?: string; language?: "en" | "ja" }>) => {
  const value = event.data;
  if (!value || !Number.isSafeInteger(value.requestId)) return;
  const send = (message: object) => globalThis.postMessage({ requestId: value.requestId, ...message });
  if (busy) { send({ type: "error", reason: "overloaded" }); return; }
  busy = true;
  try {
    if (value.type === "prepare" && (value.candidate === "nllb" || value.candidate === "m2m100" || value.candidate === "hyMt2") && !resident && !generator) {
      candidate = value.candidate;
      const selected = registeredCandidate(translationCandidates[candidate].model, translationCandidates[candidate].dtype);
      if (candidate === "hyMt2") {
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: { has(name: string): boolean } } | null> } }).gpu;
        const adapter = await gpu?.requestAdapter();
        if (!adapter?.features.has("shader-f16")) throw new Error("Hy-MT2 requires WebGPU with FP16 support");
      }
      const repository = createModelRepository(async cache => {
        if (candidate === "hyMt2" && env.backends.onnx.wasm) {
          // The locked WebGPU backend requires asyncify, as in the ASR loader.
          const runtimeUrl = new URL(gpuWasmUrl, globalThis.location.href).href;
          const cacheable = ["http:", "https:"].includes(new URL(runtimeUrl).protocol);
          let runtime = cacheable ? await cache.match(runtimeUrl) : undefined;
          if (!runtime) {
            runtime = await fetch(runtimeUrl);
            if (!runtime.ok) throw new Error("Packaged WASM runtime unavailable");
            if (cacheable) await cache.put(runtimeUrl, runtime.clone());
          }
          env.backends.onnx.wasm.wasmPaths = { wasm: gpuWasmUrl, mjs: gpuModuleUrl };
          env.backends.onnx.wasm.wasmBinary = await runtime.arrayBuffer();
        }
        env.customCache = {
          match(request: string) {
            const pinned = request.replace(`https://huggingface.co/${selected.model.id}/resolve/main/`, `https://huggingface.co/${selected.model.id}/resolve/${selected.model.version}/`);
            return selected.files.some(file => selected.url(file.path) === pinned) ? cache.match(pinned) : Promise.resolve(undefined);
          },
          put: () => { throw new Error("Runtime must load prepared cache only"); },
        };
        if (candidate === "hyMt2") {
          // This conversion embeds weights in one ONNX file; override its
          // inherited external-data setting rather than requesting missing files.
          generator = await pipeline("text-generation", selected.model.id, { revision: selected.model.version,
            dtype: "q4f16", device: "webgpu", use_external_data_format: false, local_files_only: true });
          return generator;
        }
        resident = await pipeline("translation", selected.model.id, { revision: selected.model.version, dtype: "q8", device: "wasm", local_files_only: true });
        return resident;
      }, selected.model, selected.dtype);
      for await (const status of repository.prepare(selected.model)) {
        send({ type: "status", status });
        if (status.state === "failed") throw new Error(status.reason);
      }
      send({ type: "ready" });
    } else if (value.type === "translate" && (resident || generator) && candidate && typeof value.text === "string" && value.text.length > 0 && value.text.length <= 16384 && (value.language === "ja" || value.language === "en")) {
      let text: string | undefined;
      if (generator) {
        let streamed = "";
        const output = await generator([{ role: "user", content: `Translate the following text from ${value.language === "ja" ? "Japanese" : "English"} into Korean. Note that you should only output the translated result without any additional explanation:\n${value.text}` }], {
          max_new_tokens: 256, do_sample: false,
          streamer: new TextStreamer(generator.tokenizer, { skip_prompt: true, callback_function(part) {
            streamed += part;
            if (streamed.length > 16384) throw new Error("Invalid translation result");
            if (part && streamed.trim()) send({ type: "chunk", text: streamed });
          } }),
        });
        const generated = output[0]?.generated_text;
        const content = Array.isArray(generated) ? generated.at(-1)?.content : undefined;
        text = typeof content === "string" ? content : undefined;
      } else if (resident) {
        const codes = candidate === "nllb" ? { en: "eng_Latn", ja: "jpn_Jpan", ko: "kor_Hang" } : { en: "en", ja: "ja", ko: "ko" };
        const output = await resident(value.text, { src_lang: codes[value.language], tgt_lang: codes.ko, max_new_tokens: 256 });
        text = output[0]?.translation_text;
      }
      if (typeof text !== "string" || !text.trim() || text.length > 16384) throw new Error("Invalid translation result");
      send({ type: "result", text });
    } else throw new Error("model-load-failed");
  } catch (error) { console.error("Local translation failed", error); send({ type: "error", reason: (error as Error).message }); }
  finally { busy = false; }
};
