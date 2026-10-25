import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { build } from "vite";
import { asrCandidates, registeredCandidate } from "../packages/engines-browser/model";
import { translationCandidates } from "../packages/engines-browser/translation-model";
import type { BackgroundSnapshot } from "../apps/chrome/background-protocol";

type Fixture = { saved: BackgroundSnapshot; changed(): void; commands: { type: string }[]; inventoryReads: number; holdInventory: boolean; inventoryWaiters: (() => void)[] };

test("Advanced distinguishes partial downloads, cached files and loaded models across reopening", async () => {
  const output = resolve(".ralph/media-framework/advanced-download-build");
  await build({ configFile: "vite.chrome.config.ts", logLevel: "silent", build: { outDir: output } });
  const server = createServer(async (request, response) => {
    const file = resolve(output, `.${new URL(request.url ?? "/", "http://localhost").pathname}`);
    if (!file.startsWith(output + sep)) { response.writeHead(403); response.end(); return; }
    try {
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".png") ? "image/png" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("jamak-model-options-v1", JSON.stringify({ recognition: "smallFp16", translation: "hyMt2" }));
      const listeners: ((message: object, sender: object) => void)[] = [];
      const fixture: Fixture = { saved: { state: "idle", source: "ja", message: "중지됨", captions: [] }, commands: [], inventoryReads: 0, holdInventory: false, inventoryWaiters: [],
        changed() { for (const listener of listeners) listener({ channel: "interpreter-event-v1" }, { id: "fixture" }); } };
      Object.assign(window, fixture);
      const has = caches.has.bind(caches);
      caches.has = async name => {
        const state = window as unknown as Fixture; state.inventoryReads++;
        if (state.holdInventory) await new Promise<void>(resolve => state.inventoryWaiters.push(resolve));
        return has(name);
      };
      Object.defineProperty(window, "chrome", { configurable: true, value: { runtime: { id: "fixture", onMessage: {
        addListener(listener: typeof listeners[number]) { listeners.push(listener); }, removeListener() {},
      }, async sendMessage({ command }: { command?: { type: string } }) {
        if (!command) return { ocrPreparation: { state: "idle", message: "" } };
        (window as unknown as Fixture).commands.push(command);
        return { snapshot: (window as unknown as Fixture).saved };
      } } } });
    });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await page.goto(`http://127.0.0.1:${address.port}/advanced.html?source=ja`);
    await page.getByText("다운로드 필요", { exact: true }).first().waitFor();
    assert.equal(await page.locator("#translation-download").textContent(), "다운로드 필요");
    const selected = [registeredCandidate(asrCandidates.smallFp16.model, "fp16"), registeredCandidate(translationCandidates.hyMt2.model, "q4f16")].map(candidate => ({
      cacheName: candidate.cacheName, files: candidate.files.map(file => ({ url: candidate.url(file.path), bytes: file.bytes })),
    }));
    await page.evaluate(async candidates => {
      for (const candidate of candidates) {
        const cache = await caches.open(candidate.cacheName);
        await cache.put(candidate.files[0].url, new Response("", { headers: { "Content-Length": String(candidate.files[0].bytes) } }));
        await cache.put(candidate.files[1].url, new Response("", { headers: { "Content-Length": "1" } }));
      }
      (window as unknown as Fixture).changed();
    }, selected);
    await page.waitForFunction(() => document.querySelector("#recognition-download")?.textContent === "다운로드 미완료 · 1/7개 파일 저장됨");
    assert.equal(await page.locator("#translation-download").textContent(), "다운로드 미완료 · 1/7개 파일 저장됨", "A truncated cached response never counts as downloaded");
    await page.evaluate(async candidates => {
      for (const candidate of candidates) {
        const cache = await caches.open(candidate.cacheName);
        for (const file of candidate.files) await cache.put(file.url, new Response("", { headers: { "Content-Length": String(file.bytes) } }));
      }
      const fixture = window as unknown as Fixture;
      fixture.saved = { ...fixture.saved, state: "preparing", options: { recognition: "smallFp16", translation: "hyMt2" }, message: "모델을 불러오는 중…" };
      fixture.changed();
    }, selected);
    await page.getByText("다운로드 완료 · 기기에 저장됨", { exact: true }).first().waitFor();
    assert.equal(await page.locator("#translation-download").textContent(), "다운로드 완료 · 기기에 저장됨");
    assert.equal(await page.locator("#status").textContent(), "모델을 불러오는 중…", "Downloaded files do not imply loaded models");
    assert.equal(await page.locator("#model-progress").getAttribute("value"), null);
    await page.evaluate(() => {
      const fixture = window as unknown as Fixture;
      fixture.inventoryReads = 0; fixture.holdInventory = true;
      for (let i = 0; i < 50; i++) {
        fixture.saved = { ...fixture.saved, downloadProgress: i / 100 }; fixture.changed();
      }
    });
    await page.waitForFunction(() => (document.querySelector("#model-progress") as HTMLProgressElement).value === 0.49);
    assert.ok(await page.evaluate(() => (window as unknown as Fixture).inventoryReads <= 4), "Progress bursts must not create overlapping full inventory scans");
    await page.evaluate(() => {
      const fixture = window as unknown as Fixture; fixture.holdInventory = false;
      for (const release of fixture.inventoryWaiters.splice(0)) release();
    });
    await page.evaluate(() => {
      const fixture = window as unknown as Fixture;
      fixture.saved = { ...fixture.saved, state: "ready", message: "준비 완료" }; fixture.changed();
    });
    await page.getByText("다운로드 완료 · 모델 사용 준비 완료", { exact: true }).waitFor();
    assert.equal(await page.locator("#stop").isDisabled(), true);
    assert.equal(await page.locator("#download-progress").isVisible(), false);
    await page.screenshot({ path: ".ralph/advanced-download-complete.png" });
    await page.reload();
    await page.getByText("다운로드 완료 · 기기에 저장됨", { exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => (window as unknown as Fixture).commands.some(command => command.type === "models")), false, "Reopening only checks caches");
    await page.evaluate(async cacheName => { await caches.delete(cacheName); (window as unknown as Fixture).changed(); }, selected[0].cacheName);
    await page.waitForFunction(() => document.querySelector("#recognition-download")?.textContent === "다운로드 필요");
    assert.equal(await page.locator("#translation-download").textContent(), "다운로드 완료 · 기기에 저장됨", "Cache removal affects only its own model");
  } finally {
    await browser.close(); await new Promise<void>(done => server.close(() => done()));
  }
});
