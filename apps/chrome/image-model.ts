export const imageModels = [
  { name: "글자 위치 모델", file: "PP-OCRv5_mobile_det_onnx_infer.tar", bytes: 4843520,
    sha256: "781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30" },
  { name: "문자 인식 모델", file: "PP-OCRv5_mobile_rec_onnx_infer.tar", bytes: 16701440,
    sha256: "f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c" },
] as const;

const preciseModels = [
  { name: "글자 위치 모델", file: "PP-OCRv6_small_det_onnx_infer.tar", bytes: 9891840,
    sha256: "d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4" },
  { name: "문자 인식 모델", file: "PP-OCRv6_small_rec_onnx_infer.tar", bytes: 21319680,
    sha256: "d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1" },
] as const;
const qualityModels = [
  { name: "글자 위치 모델", file: "PP-OCRv6_medium_det_onnx_infer.tar", bytes: 62044160,
    sha256: "c5adb0b15de1b1838934eba1dd72e7529e7d80132216c6ee6d26eba6fa054fcf" },
  { name: "문자 인식 모델", file: "PP-OCRv6_medium_rec_onnx_infer.tar", bytes: 76718080,
    sha256: "d8cc46c7163c83a151aef8fce5856b965860df90a875029216d605b0f607eaec" },
] as const;
export const imageOcrChoices = [
  { id: "mobile", name: "PP-OCRv5 Mobile · 경량", detail: "약 21.5 MB · CPU/WASM · 영어·일본어와 손글씨를 인식합니다.", models: imageModels },
  { id: "v6Small", name: "PP-OCRv6 Small · 정밀", detail: "약 31.2 MB · CPU/WASM · 영어·일본어 포함 50개 언어. 경량 모델보다 느릴 수 있으며 손글씨 정확도는 이미지에 따라 다릅니다.", models: preciseModels },
  { id: "v6Medium", name: "PP-OCRv6 Medium · 고정밀", detail: "약 138.8 MB · CPU/WASM · 더 큰 정밀 OCR 모델. 이미지가 많으면 처리 시간이 길어질 수 있습니다. 영어·일본어 포함 50개 언어.", models: qualityModels },
] as const;
export async function imageModelStatus(choice: typeof imageOcrChoices[number]) {
  if (!await caches.has("jamak-image-ocr-v1")) return "다운로드 필요 · 선택하면 바로 다운로드합니다.";
  const cache = await caches.open("jamak-image-ocr-v1"); let complete = 0;
  for (const model of choice.models) {
    const response = await cache.match(`https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${model.file}`);
    if (response?.ok && Number(response.headers.get("Content-Length")) === model.bytes) complete++;
    if (response?.body) await response.body.cancel().catch(() => {});
  }
  return complete === choice.models.length ? "다운로드 완료 · 기기에 저장됨" : "다운로드 필요 · 선택하면 바로 다운로드합니다.";
}

export async function loadImageModel(model: typeof imageOcrChoices[number]["models"][number], signal: AbortSignal, receive?: (progress?: number) => void) {
  const url = `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${model.file}`;
  const cache = await caches.open("jamak-image-ocr-v1");
  async function verified(bytes: ArrayBuffer) {
    signal.throwIfAborted();
    if (bytes.byteLength !== model.bytes) throw new Error("OCR 모델 파일 크기가 다릅니다.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if (Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") !== model.sha256) throw new Error("OCR 모델 파일 검증에 실패했습니다.");
    signal.throwIfAborted();
    return bytes;
  }
  receive?.();
  const saved = await cache.match(url);
  if (saved) {
    let bytes: ArrayBuffer | undefined;
    try { bytes = await verified(await saved.arrayBuffer()); }
    catch { signal.throwIfAborted(); await cache.delete(url); }
    if (bytes) {
      if (Number(saved.headers.get("Content-Length")) !== model.bytes) await cache.put(url, new Response(bytes, { headers: { "Content-Length": String(model.bytes) } }));
      return bytes;
    }
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`OCR 모델 다운로드 실패: HTTP ${response.status}`);
  if (!response.body) throw new Error("OCR 모델 데이터를 받을 수 없습니다.");
  const reader = response.body.getReader(); const buffer = new Uint8Array(model.bytes); let offset = 0;
  receive?.(0);
  try {
    for (;;) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
      if (offset + value.byteLength > model.bytes) throw new Error("OCR 모델 파일 크기가 다릅니다.");
      buffer.set(value, offset); offset += value.byteLength; receive?.(offset / model.bytes);
    }
  } finally { await reader.cancel().catch(() => {}); }
  receive?.();
  if (offset !== model.bytes) throw new Error("OCR 모델 파일 크기가 다릅니다.");
  const bytes = await verified(buffer.buffer);
  signal.throwIfAborted();
  await cache.put(url, new Response(bytes, { headers: { "Content-Length": String(model.bytes) } }));
  return bytes;
}
