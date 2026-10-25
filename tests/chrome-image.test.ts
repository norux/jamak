import assert from "node:assert/strict";
import test from "node:test";
import { imageRegions, imageLabels } from "../apps/chrome/image-render";
import { imageOptionsKey, readImageOptions, validImageOptions } from "../apps/chrome/image-options";
import { imageModels, imageOcrChoices, imageModelStatus, loadImageModel } from "../apps/chrome/image-model";

test("OCR regions retain original text and clamp rotated/outside coordinates to the image", () => {
  const regions = imageRegions([{ text: "  Hello world  ", score: 0.6, poly: [[-5, 20], [120, 18], [125, 60], [-2, 65]] }], 100, 50);
  assert.deepEqual(regions, [{ source: "Hello world", translation: "", score: 0.6, x: 0, y: 18, width: 100, height: 32 }]);
  assert.throws(() => imageRegions([{ text: "invalid", score: 1, poly: [[NaN, 0], [1, 0], [1, 1], [0, 1]] }], 100, 50));
  assert.throws(() => imageRegions(Array(257).fill({}), 100, 50));
});

test("Korean labels wrap without dropping text, stay inside the image and retain user positions", () => {
  const context = { canvas: { width: 320, height: 200 }, measureText: (text: string) => ({ width: [...text].length * 20 }), font: "" } as unknown as CanvasRenderingContext2D;
  const regions = [{ source: "Hello world", translation: "안녕하세요 만나서 반갑습니다 👋", score: 0.9, x: 310, y: 190, width: 90, height: 30 }];
  const original = structuredClone(regions);
  const [label] = imageLabels(context, regions);
  assert.equal(label.lines.join(""), regions[0].translation);
  assert.ok(label.x >= 0 && label.x + label.width <= 320);
  assert.ok(label.y >= 0 && label.y + label.height <= 200);
  assert.deepEqual(regions, original, "Layout does not rewrite OCR/source data or the stored position");
  regions[0].x = 10; regions[0].y = 20;
  assert.equal(imageLabels(context, regions)[0].x, 10);
  assert.equal(imageLabels(context, regions)[0].y, 20);
});

test("Explicitly moved labels preserve positions outside the original image", () => {
  const context = { canvas: { width: 320, height: 200 }, measureText: (text: string) => ({ width: text.length * 10 }), font: "" } as unknown as CanvasRenderingContext2D;
  const [label] = imageLabels(context, [{ source: "Hello", translation: "안녕하세요", score: 0.9, x: -50, y: 240, width: 90, height: 30, positioned: true }]);
  assert.equal(label.x, -50); assert.equal(label.y, 240);
});

test("OCR downloads reject corrupt model files without caching them", async () => {
  const previousCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const previousFetch = globalThis.fetch;
  let stored = false; let removed = false; let requested = false;
  const progress: (number | undefined)[] = [];
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => ({
    match: async () => new Response(new Uint8Array(1)), delete: async () => { removed = true; }, put: async () => { stored = true; },
  }) } });
  globalThis.fetch = async () => { requested = true; return new Response(new Uint8Array(imageModels[0].bytes)); };
  try {
    await assert.rejects(loadImageModel(imageModels[0], new AbortController().signal, value => progress.push(value)), /검증/);
    assert.equal(removed, true); assert.equal(requested, true); assert.equal(stored, false);
    assert.ok(progress.includes(0) && progress.includes(1));
    assert.equal(progress.at(-1), undefined, "Hash verification must not masquerade as download progress");
    requested = false;
    const operation = new AbortController(); operation.abort();
    await assert.rejects(loadImageModel(imageModels[0], operation.signal), { name: "AbortError" });
    assert.equal(requested, false, "Cancellation cannot start another model request");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCaches) Object.defineProperty(globalThis, "caches", previousCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});


test("font-size presets scale the shared label/export layout without changing text or manual position", () => {
  const context = { canvas: { width: 600, height: 300 }, measureText: (text: string) => ({ width: text.length * 10 }), font: "" } as unknown as CanvasRenderingContext2D;
  const region = { source: "Hello", translation: "안녕하세요", score: 1, x: -20, y: 320, width: 300, height: 30, positioned: true };
  const sizes = [0.7, 0.85, 1, 1.25, 1.5].map(fontScale => imageLabels(context, [region], 600, 300, fontScale)[0]);
  assert.deepEqual(sizes.map(label => label.fontSize), [12, 14, 17, 21, 25]);
  assert.equal(imageLabels(context, [region])[0].fontSize, 17, "Normal now matches the previous very-small size");
  for (const label of sizes) { assert.equal(label.x, -20); assert.equal(label.y, 320); assert.equal(label.lines.join(""), "안녕하세요"); }
});


test("OCR choices use distinct complete pinned detector/recognizer pairs", () => {
  assert.deepEqual(imageOcrChoices.map(choice => choice.id), ["mobile", "v6Small", "v6Medium"]);
  for (const choice of imageOcrChoices) {
    assert.equal(choice.models.length, 2);
    assert.match(choice.models[0].file, /_det_onnx_infer.tar$/);
    assert.match(choice.models[1].file, /_rec_onnx_infer.tar$/);
    for (const model of choice.models) { assert.match(model.sha256, /^[a-f0-9]{64}$/); assert.ok(model.bytes > 0); }
  }
  assert.equal(imageOcrChoices[1].models.reduce((total, model) => total + model.bytes, 0), 31211520);
});


test("image options validate model/font choices and preserve independent audio preferences", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map([["jamak-model-options-v1", JSON.stringify({ recognition: "turboFp16", translation: "hyMt2" })]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null } });
  try {
    assert.deepEqual(readImageOptions(), { ocr: "mobile", fontScale: 1 });
    values.set(imageOptionsKey, JSON.stringify({ ocr: "v6Medium", fontScale: 1.5 }));
    assert.deepEqual(readImageOptions(), { ocr: "v6Medium", fontScale: 1.5 });
    assert.equal(validImageOptions({ ocr: "missing", fontScale: 1 }), false);
    assert.equal(validImageOptions({ ocr: "v6Medium", fontScale: 99 }), false);
    assert.equal(JSON.parse(values.get("jamak-model-options-v1") ?? "{}").translation, "hyMt2");
  } finally { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); }
});


test("OCR download status requires both selected archive sizes and rejects partial caches", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "caches");
  let partial = true; const seen: string[] = [];
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { has: async () => true, open: async () => ({ match: async (url: string) => {
    seen.push(url); const model = imageModels.find(model => url.endsWith(model.file));
    return model ? new Response("", { headers: { "Content-Length": String(partial ? 1 : model.bytes) } }) : undefined;
  } }) } });
  try {
    assert.match(await imageModelStatus(imageOcrChoices[0]), /다운로드 필요/);
    partial = false; assert.match(await imageModelStatus(imageOcrChoices[0]), /다운로드 완료/);
    assert.match(await imageModelStatus(imageOcrChoices[1]), /다운로드 필요/, "A complete Mobile pair does not mark Small as cached");
    assert.ok(seen.some(url => url.includes("PP-OCRv6_small_det")) && seen.some(url => url.includes("PP-OCRv6_small_rec")));
  } finally { if (previous) Object.defineProperty(globalThis, "caches", previous); else Reflect.deleteProperty(globalThis, "caches"); }
});

test("OCR inventory checks never load weight bodies, including repeated Medium progress refreshes", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "caches");
  let bodyReads = 0; let cancelled = 0;
  const choice = imageOcrChoices[2];
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { has: async () => true, open: async () => ({ match: async (url: string) => {
    const model = choice.models.find(model => url.endsWith(model.file));
    return model ? { ok: true, headers: new Headers({ "Content-Length": String(model.bytes) }), body: { cancel: async () => { cancelled++; } },
      arrayBuffer: async () => { bodyReads++; throw Error("Inventory must not allocate model weights"); } } : undefined;
  } }) } });
  try {
    for (let i = 0; i < 20; i++) assert.match(await imageModelStatus(choice), /다운로드 완료/);
    assert.equal(bodyReads, 0);
    assert.equal(cancelled, 40, "Unused cache response streams are released");
  } finally { if (previous) Object.defineProperty(globalThis, "caches", previous); else Reflect.deleteProperty(globalThis, "caches"); }
});

test("legacy OCR cache metadata repair preserves verified weights when storage rejects the write", async () => {
  const originals = ["caches", "fetch", "crypto"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const model = imageModels[0]; let removed = false; let requested = false;
  Object.defineProperties(globalThis, {
    caches: { configurable: true, value: { open: async () => ({
      match: async () => ({ headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(model.bytes) }),
      put: async () => { throw new DOMException("Storage full", "QuotaExceededError"); }, delete: async () => { removed = true; },
    }) } },
    crypto: { configurable: true, value: { subtle: { digest: async () => Uint8Array.from(model.sha256.match(/../g) ?? [], part => Number.parseInt(part, 16)).buffer } } },
    fetch: { configurable: true, value: async () => { requested = true; throw Error("Verified weights must not be downloaded again"); } },
  });
  try {
    await assert.rejects(loadImageModel(model, new AbortController().signal), { name: "QuotaExceededError" });
    assert.equal(removed, false); assert.equal(requested, false);
  } finally { for (const [name, original] of originals) { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); } }
});
