import { PaddleOCR } from "@paddleocr/paddleocr-js";

// OpenCV's generated bindings need eval. Only this sandbox has it; it has no
// extension privileges, network models or access to the parent document.
window.addEventListener("message", event => {
  if (event.source !== parent || event.data !== "jamak-image-ocr" || !event.ports[0]) return;
  const port = event.ports[0];
  port.onmessage = async message => {
    const { image, detection, recognition, modelNames } = message.data;
    let ocr: Awaited<ReturnType<typeof PaddleOCR.create>> | undefined;
    try {
      ocr = await PaddleOCR.create({
        textDetectionModelName: modelNames[0],
        textRecognitionModelName: modelNames[1],
        textDetectionModelAsset: { url: "detection" },
        textRecognitionModelAsset: { url: "recognition" },
        fetch: async input => new Response(input === "detection" ? detection : recognition),
        ortOptions: { backend: "wasm", numThreads: 1, proxy: false,
          wasmPaths: new URL("./image-runtime/", location.href).href },
      });
      port.postMessage({ type: "recognizing" });
      // A small white border keeps writing that touches an image edge from
      // disappearing during detection. Return coordinates in the original image.
      const padded = document.createElement("canvas"); padded.width = image.width + 64; padded.height = image.height + 64;
      const context = padded.getContext("2d");
      if (!context) throw new Error("OCR 이미지를 준비할 수 없습니다.");
      const original = document.createElement("canvas"); original.width = image.width; original.height = image.height;
      original.getContext("2d")?.putImageData(image, 0, 0);
      context.fillStyle = "white"; context.fillRect(0, 0, padded.width, padded.height); context.drawImage(original, 32, 32);
      const [result] = await ocr.predict(padded);
      port.postMessage({ type: "result", items: result.items.map(item => ({ ...item, poly: item.poly.map(([x, y]) => [x - 32, y - 32]) })) });
    } catch (error) {
      port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      await ocr?.dispose();
      port.close();
    }
  };
  port.start();
}, { once: true });
parent.postMessage("jamak-image-ocr-ready", "*");
