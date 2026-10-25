import { fileURLToPath } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";
import { build, defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./apps/chrome", import.meta.url)),
  base: "./",
  resolve: { alias: [{ find: /^onnxruntime-web$/, replacement: fileURLToPath(new URL("./node_modules/@paddleocr/paddleocr-js/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs", import.meta.url)) }] },
  worker: { format: "es" },
  plugins: [{
    name: "chrome-selected-page-host",
    async writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) throw new Error("Chrome build requires an output directory");
      await mkdir(`${outDir}/image-runtime`, { recursive: true });
      for (const name of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
        await copyFile(fileURLToPath(new URL(`./node_modules/@paddleocr/paddleocr-js/node_modules/onnxruntime-web/dist/${name}`, import.meta.url)), `${outDir}/image-runtime/${name}`);
      }
      await copyFile(fileURLToPath(new URL("./packages/media-web/pcm-worklet.js", import.meta.url)), `${outDir}/pcm-worklet.js`);
      await build({ configFile: false, logLevel: "warn", build: { outDir, emptyOutDir: false,
        lib: { entry: fileURLToPath(new URL("./apps/chrome/tab-content.ts", import.meta.url)), formats: ["iife"],
          name: "InterpreterTabOverlay", fileName: () => "tab-content.js" } } });
      await build({ configFile: false, logLevel: "warn", build: { outDir, emptyOutDir: false,
        lib: { entry: fileURLToPath(new URL("./apps/chrome/tab-image.ts", import.meta.url)), formats: ["iife"],
          name: "JamakImageOverlay", fileName: () => "tab-image.js" } } });
      await build({ configFile: false, root: fileURLToPath(new URL("./apps/chrome", import.meta.url)),
        logLevel: "warn", build: { outDir, emptyOutDir: false, copyPublicDir: false, target: "chrome138",
          lib: { entry: fileURLToPath(new URL("./apps/chrome/content.ts", import.meta.url)), formats: ["iife"],
            name: "InterpreterSelectedVideo", fileName: () => "content.js" } } });
    },
  }],
  build: {
    outDir: "dist", emptyOutDir: true, target: "chrome116",
    rollupOptions: {
      input: { preparation: fileURLToPath(new URL("./apps/chrome/preparation.html", import.meta.url)),
        popup: fileURLToPath(new URL("./apps/chrome/popup.html", import.meta.url)),
        advanced: fileURLToPath(new URL("./apps/chrome/advanced.html", import.meta.url)),
        "image-sandbox": fileURLToPath(new URL("./apps/chrome/image-sandbox.html", import.meta.url)),
        offscreen: fileURLToPath(new URL("./apps/chrome/offscreen.html", import.meta.url)),
        "tab-host": fileURLToPath(new URL("./apps/chrome/tab-host.html", import.meta.url)),
        host: fileURLToPath(new URL("./apps/chrome/host.html", import.meta.url)),
        "service-worker": fileURLToPath(new URL("./apps/chrome/service-worker.ts", import.meta.url)),
        composition: fileURLToPath(new URL("./apps/chrome/composition.ts", import.meta.url)) },
      preserveEntrySignatures: "strict",
      output: { entryFileNames: "[name].js" },
    },
  },
});
