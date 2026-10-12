import type { ModelIdentity, ModelRepository, ModelStatus, ReasonCode } from "../contracts";
import { preparationModel, registeredCandidate } from "./model";

export function createModelRepository(load: (cache: Cache) => Promise<{ dispose(): Promise<void> }>, selected: ModelIdentity = preparationModel, dtype: "q8" | "fp16" | "fp32" | "q4f16" = "q8"): ModelRepository {
  const { model: registeredModel, cacheName: modelCacheName, files: modelFiles, url: modelUrl, requiredBytes } = registeredCandidate(selected, dtype);
  let controller: AbortController | undefined;
  let resident: { dispose(): Promise<void> } | undefined;
  let observedCache = false;
  const state = (value: ModelStatus["state"], downloadedBytes?: number, reason?: ReasonCode): ModelStatus => ({
    model: registeredModel, state: value, requiredBytes, downloadedBytes, reason,
  });
  function check(model: ModelIdentity) {
    if (model.id !== registeredModel.id || model.version !== registeredModel.version) throw new Error("Unregistered model/version");
  }
  async function cachedBytes(cache: Cache) {
    let bytes = 0;
    for (const file of modelFiles) {
      const response = await cache.match(modelUrl(file.path));
      if (response?.ok && Number(response.headers.get("Content-Length")) === file.bytes) bytes += file.bytes;
    }
    return bytes;
  }
  return {
    async status(model) {
      check(model);
      const bytes = await caches.has(modelCacheName) ? await cachedBytes(await caches.open(modelCacheName)) : 0;
      if (resident) return state("ready", bytes);
      if (bytes === requiredBytes) { observedCache = true; return state("cached", bytes); }
      return state(observedCache ? "evicted" : "absent", bytes);
    },
    async *prepare(model) {
      check(model);
      if (controller) throw new Error("Model preparation already active");
      const operation = new AbortController();
      controller = operation;
      let reason: ReasonCode = "model-load-failed";
      try {
        const cache = await caches.open(modelCacheName);
        let bytes = await cachedBytes(cache);
        yield state(bytes === requiredBytes ? "cached" : observedCache ? "evicted" : "absent", bytes);
        const estimate = await navigator.storage.estimate();
        if (bytes < requiredBytes && estimate.quota !== undefined && estimate.usage !== undefined
          && estimate.quota - estimate.usage < requiredBytes - bytes) {
          reason = "storage-insufficient";
          throw new Error("Insufficient model cache storage");
        }
        for (const file of modelFiles) {
          operation.signal.throwIfAborted();
          const cached = await cache.match(modelUrl(file.path));
          if (cached?.ok && Number(cached.headers.get("Content-Length")) === file.bytes) continue;
          if (!navigator.onLine) { reason = "offline-model-unavailable"; throw new Error("Model missing offline"); }
          reason = "download-required";
          yield state("downloading", bytes);
          const response = await fetch(modelUrl(file.path), { signal: operation.signal, credentials: "omit" });
          if (!response.ok || !response.body) throw new Error(`Model download HTTP ${response.status}`);
          const reader = response.body.getReader();
          const buffer = new Uint8Array(file.bytes);
          let offset = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (offset + value.byteLength > file.bytes) { await reader.cancel(); throw new Error("Model size mismatch"); }
            buffer.set(value, offset); offset += value.byteLength;
            yield state("downloading", bytes + offset);
          }
          if (offset !== file.bytes) throw new Error("Incomplete model download");
          if ("sha256" in file) {
            const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
            if (Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("") !== file.sha256) {
              throw new Error("Model checksum mismatch");
            }
          }
          operation.signal.throwIfAborted();
          reason = "storage-insufficient";
          await cache.put(modelUrl(file.path), new Response(buffer, { headers: { "Content-Length": String(file.bytes) } }));
          bytes += file.bytes;
        }
        observedCache = true;
        yield state("cached", bytes);
        operation.signal.throwIfAborted();
        if (!resident) {
          reason = "model-load-failed";
          yield state("loading", bytes);
          const loaded = await load(cache);
          if (operation.signal.aborted) { await loaded.dispose(); operation.signal.throwIfAborted(); }
          resident = loaded;
        }
        yield state("ready", bytes);
      } catch (error) {
        console.error("Browser model preparation failed", error);
        yield state("failed", undefined, operation.signal.aborted ? "cancelled" : reason);
      } finally {
        if (controller === operation) controller = undefined;
      }
    },
    async cancel(model) {
      check(model);
      controller?.abort();
      const loaded = resident;
      resident = undefined;
      await loaded?.dispose();
    },
    async evict(model) {
      check(model);
      if (controller) throw new Error("Stop preparation before eviction");
      await this.cancel(model);
      await caches.delete(modelCacheName);
      observedCache = true;
    },
  };
}
