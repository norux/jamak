import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

const output = resolve(".ralph/media-framework/chrome-popup-build");
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: { outDir: output } });
const server = createServer(async (request, response) => {
  const file = resolve(output, `.${new URL(request.url, "http://localhost").pathname}`);
  if (!file.startsWith(output + sep)) { response.writeHead(403); response.end(); return; }
  try {
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html");
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ channel: "chromium", headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const params = new URL(location.href).searchParams;
    if (!params.has("gpu")) Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    const fresh = params.has("fresh") || params.has("downloading");
    globalThis.windows = []; globalThis.commands = []; globalThis.installs = [];
    globalThis.translationProbes = [];
    globalThis.listeners = []; globalThis.delaySnapshot = false; globalThis.rejectModels = false;
    globalThis.packs = fresh ? [] : ["ja-JP", "en-US", "ko-KR"];
    globalThis.translationReady = !fresh;
    globalThis.saved = { state: "idle", source: params.has("auto") ? "auto" : "ja", message: "初期", captions: [] };
    if (params.has("downloading")) saved = { ...saved, state: "preparing", tabId: 10, message: "백그라운드 다운로드 중…" };
    class Speech {
      processLocally = false;
      static async available({ langs }) { return langs.every(lang => packs.includes(lang)) ? "available" : "downloadable"; }
      static async install({ langs }) { installs.push(langs); packs = [...langs]; translationReady = true; return true; }
    }
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: Speech });
    if (params.has("whisper")) Speech.install = undefined;
    Object.defineProperty(window, "Translator", { configurable: true, value: { availability: async options => {
      translationProbes.push(options); return translationReady ? "available" : "downloadable";
    } } });
    Object.defineProperty(window, "chrome", { configurable: true, value: {
      windows: { create: async options => { windows.push(options); } },
      tabs: { query: async () => [{ id: 10, url: "http://fixture.test" }] },
      runtime: { id: "fixture", getURL: path => new URL(path, location.href).href, onMessage: { addListener(listener) { listeners.push(listener); }, removeListener() {} }, async sendMessage({ command }) {
        commands.push(command);
        if (command.type === "models" && rejectModels) throw new Error("테스트 모델 준비 실패");
        if (command.type === "models") saved = { state: "preparing", source: command.source, tabId: command.tabId, options: command.options, message: "선택한 모델 다운로드 중…", captions: [] };
        if (command.type === "prepare") saved = { state: "ready", source: command.source, tabId: command.tabId, message: "준비 완료", captions: [] };
        if (command.type === "start") saved = { ...saved, state: "starting", message: "탭 오디오에 연결 중…" };
        if (command.type === "stop") {
          saved = { state: "idle", source: saved.source, message: "중지됨", captions: [] };
          delaySnapshot = true;
          for (const listener of listeners) listener({ channel: "interpreter-event-v1" }, { id: "fixture" });
        }
        if (command.type === "snapshot" && delaySnapshot) {
          delaySnapshot = false; const old = { ...saved };
          await new Promise(done => setTimeout(done, 100)); return { snapshot: old };
        }
        return { snapshot: { ...saved } };
      } },
    } });
  });
  const url = `http://127.0.0.1:${server.address().port}/popup.html`;
  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector("#start").disabled, undefined, { timeout: 3000 });
  assert.deepEqual(await page.evaluate(() => installs), [], "Cached models must not reinstall");
  assert.equal(await page.locator("#auto-detect").isChecked(), false);
  assert.equal(await page.locator("#language").inputValue(), "ja");
  await page.locator("#model-details summary").click();
  assert.match(await page.locator("#model-list").innerText(), /Chrome SODA/);
  await page.locator("#model-details summary").click();
  assert.equal(await page.locator("#prepare").isVisible(), false);
  assert.equal(await page.evaluate(() => commands.some(command => command.type === "start")), false, "Readiness must not capture audio");
  await page.getByRole("button", { name: "번역 시작", exact: true }).click();
  assert.equal(await page.locator("#prepare").isVisible(), false, "No disabled Prepare button while starting");
  for (const state of ["running", "failed"]) {
    await page.evaluate(state => {
      saved = { ...saved, state, message: state };
      for (const listener of listeners) listener({ channel: "interpreter-event-v1" }, { id: "fixture" });
    }, state);
    await page.waitForFunction(state => document.querySelector("#status").textContent === state, state);
    assert.equal(await page.locator("#prepare").isVisible(), false);
  }
  await page.getByRole("button", { name: "중지", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.equal(await page.evaluate(() => commands.filter(command => command.type === "prepare").length), 2);
  await page.locator("#language").selectOption("en");
  await page.waitForFunction(() => saved.source === "en" && !document.querySelector("#start").disabled);
  assert.deepEqual(await page.evaluate(() => installs), []);
  await page.evaluate(() => { packs = ["ja-JP", "en-US"]; });
  await page.locator("#language").selectOption("ja");
  await page.waitForFunction(() => !document.querySelector("#prepare").disabled);
  assert.equal(await page.locator("#start").isVisible(), false, "Japanese and English cannot bypass the Korean Chrome bootstrap pack");
  await page.evaluate(() => { packs = ["ja-JP", "en-US", "ko-KR"]; });
  await page.locator("#language").selectOption("en");
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  await page.evaluate(() => { packs = ["ja-JP"]; });
  await page.locator("#language").selectOption("ja");
  await page.waitForFunction(() => !document.querySelector("#prepare").disabled);
  assert.equal(await page.locator("#start").isDisabled(), true, "Japanese alone cannot bypass the English bootstrap dependency");
  assert.deepEqual(await page.evaluate(() => installs), []);
  await page.goto(`${url}?fresh`);
  await page.waitForFunction(() => !document.querySelector("#prepare").disabled);
  assert.equal(await page.locator("#start").isVisible(), false, "Download setup must precede translation controls");
  assert.equal(await page.locator("#reference").isVisible(), false, "No record window before model setup");
  assert.match(await page.locator("#model-description").textContent(), /Chrome SODA/u);
  assert.equal(await page.locator("#start").isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => commands.filter(command => command.type === "prepare" || command.type === "start")), []);
  await page.getByRole("button", { name: "모델 다운로드", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.deepEqual(await page.evaluate(() => installs), [["ja-JP", "en-US", "ko-KR"]]);
  assert.equal(await page.locator("#model-setup").isVisible(), false);
  assert.equal(await page.locator("#start").isVisible(), true);
  await page.goto(`${url}?fresh&whisper`);
  await page.waitForFunction(() => !document.querySelector("#prepare").disabled);
  assert.match(await page.locator("#model-description").textContent(), /Whisper large-v3-turbo/u);
  assert.match(await page.locator("#model-description").textContent(), /Silero VAD/u);
  assert.equal(await page.locator("#start").isVisible(), false);
  await page.getByRole("button", { name: "모델 다운로드", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.deepEqual(await page.evaluate(() => installs), [], "Whisper setup must not call unsupported native speech installation");
  await page.goto(`${url}?fresh&auto`);
  await page.waitForFunction(() => !document.querySelector("#prepare").disabled);
  assert.equal(await page.locator("#auto-detect").isChecked(), true);
  assert.match(await page.locator("#model-description").textContent(), /발화별로 자동 감지/);
  await page.locator("#model-details summary").click();
  const modelTable = await page.locator("#model-list").innerText();
  for (const name of ["Whisper large-v3-turbo", "Silero VAD", "Chrome TranslateKit", "WeSpeaker"]) assert.ok(modelTable.includes(name));
  await page.screenshot({path:".ralph/popup-model-table.png"});
  assert.deepEqual(await page.evaluate(() => translationProbes), [
    { sourceLanguage: "en", targetLanguage: "ko" }, { sourceLanguage: "ja", targetLanguage: "ko" },
  ]);
  await page.getByRole("button", { name: "모델 다운로드", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.deepEqual(await page.evaluate(() => installs), [], "Automatic mode must use Whisper even when native SODA exists");
  assert.equal(await page.evaluate(() => commands.find(command => command.type === "prepare").source), "auto");
  await page.locator("#language").selectOption("ko");
  await page.waitForFunction(() => !document.querySelector("#prepare").disabled);
  assert.equal(await page.locator("#auto-detect").isChecked(), false, "Selecting a language disables detection");
  assert.match(await page.locator("#model-description").textContent(), /한국어 원문/);
  assert.doesNotMatch(await page.locator("#model-list").innerText(), /TranslateKit|SODA/);
  const probes = await page.evaluate(() => translationProbes.length);
  await page.getByRole("button", { name: "모델 다운로드", exact: true }).click();
  await page.waitForFunction(() => saved.source === "ko" && !document.querySelector("#start").disabled);
  assert.equal(await page.evaluate(() => translationProbes.length), probes, "Korean skips translation probing");
  assert.deepEqual(await page.evaluate(() => installs), [], "Korean uses fixed-language Whisper");
  await page.locator("#auto-detect").check();
  await page.waitForFunction(() => !document.querySelector("#prepare").disabled);
  await page.getByRole("button", { name: "모델 다운로드", exact: true }).click();
  await page.waitForFunction(() => saved.source === "auto" && !document.querySelector("#start").disabled);
  await page.locator("#language").selectOption("en");
  await page.waitForFunction(() => !document.querySelector("#prepare").disabled);
  assert.equal(await page.locator("#auto-detect").isChecked(), false);
  await page.getByRole("button", { name: "모델 다운로드", exact: true }).click();
  await page.waitForFunction(() => saved.source === "en" && !document.querySelector("#start").disabled);
  assert.equal(await page.locator("#diagnostic").count(), 0);
  await page.goto(`${url}?gpu`);
  await page.waitForFunction(() => !document.querySelector("#start").disabled, undefined, {timeout:3000});
  assert.match(await page.locator("#model-description").textContent(), /Chrome SODA/u);
  assert.deepEqual(await page.evaluate(() => installs), [], "Cached Japanese speech packs must work on WebGPU without a Whisper download");
  assert.equal(await page.evaluate(() => commands.find(command => command.type === "prepare").source), "ja");
  await page.goto(`${url}?fresh&gpu`);
  await page.waitForFunction(() => !document.querySelector("#prepare").disabled);
  assert.match(await page.locator("#model-description").textContent(), /Chrome SODA/u);
  assert.equal(await page.locator("#start").isVisible(), false);
  await page.getByRole("button", { name: "모델 다운로드", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.deepEqual(await page.evaluate(() => installs), [["ja-JP", "en-US", "ko-KR"]], "Japanese uses the same native streaming setup on WebGPU");
  await page.locator("#language").selectOption("en");
  await page.waitForFunction(() => saved.source === "en" && !document.querySelector("#start").disabled);
  assert.match(await page.locator("#model-description").textContent(), /Chrome SODA/u);
  await page.goto(`${url}?downloading`);
  await page.getByText("백그라운드 다운로드 중…", { exact: true }).waitFor();
  assert.equal(await page.locator("#start").isVisible(), false);
  assert.equal(await page.locator("#prepare").isVisible(), true);
  assert.equal(await page.locator("#prepare").isDisabled(), true);
  assert.equal(await page.locator("#download-progress").isVisible(), true);
  assert.equal(await page.locator("#model-progress").getAttribute("value"), null, "Unknown preparation progress stays indeterminate");
  await page.evaluate(() => {
    saved = { ...saved, downloadProgress: 0.42, message: "음성 인식 모델 다운로드 · 42%" };
    for (const listener of listeners) listener({ channel: "interpreter-event-v1" }, { id: "fixture" });
  });
  await page.waitForFunction(() => document.querySelector("#model-progress").value === 0.42);
  assert.equal(await page.locator("#download-percent").textContent(), "42%");
  await page.screenshot({ path: ".ralph/model-download-progress.png" });
  await page.evaluate(() => {
    saved = { ...saved, downloadProgress: undefined, message: "음성 인식 모델을 불러오는 중…" };
    for (const listener of listeners) listener({ channel: "interpreter-event-v1" }, { id: "fixture" });
  });
  await page.waitForFunction(() => !document.querySelector("#model-progress").hasAttribute("value"));
  assert.equal(await page.locator("#download-percent").textContent(), "준비 중…");
  assert.equal(await page.evaluate(() => commands.some(command => command.type === "prepare")), false, "Reopening must observe, not restart, the background download");
  await page.evaluate(() => {
    saved = { ...saved, state: "ready", message: "준비 완료", models: [
      {task:"받아쓰기",name:"Whisper large-v3-turbo · FP16 / WebGPU"},
      {task:"발화 감지",name:"Silero VAD"},
      {task:"한국어 번역",name:"Chrome TranslateKit"},
      {task:"화자 구분",name:"WeSpeaker VoxCeleb ResNet34-LM · q8"},
    ] };
    for (const listener of listeners) listener({ channel: "interpreter-event-v1" }, { id: "fixture" });
  });
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.equal(await page.locator("#model-setup").isVisible(), false);
  assert.equal(await page.locator("#start").isVisible(), true);
  assert.equal(await page.locator("#download-progress").isVisible(), false);
  await page.locator("#model-details summary").click();
  const preparedModels = await page.locator("#model-list").innerText();
  assert.match(preparedModels,/Whisper large-v3-turbo/);
  assert.ok(!preparedModels.includes("Chrome SODA"),"The prepared engine's actual model list overrides popup API predictions");
  await page.locator("#advanced").click();
  const opened = await page.evaluate(() => windows.at(-1));
  assert.equal(opened.type, "popup"); assert.match(opened.url, /advanced.html/);
  assert.equal(new URL(opened.url).searchParams.get("tabId"), "10");
  assert.equal(new URL(opened.url).searchParams.get("source"), "ja");
  await page.goto(opened.url);
  await page.waitForFunction(() => document.querySelector("#recognition").options.length === 6);
  assert.equal(await page.locator("#recognition").inputValue(), "chrome");
  assert.equal(await page.locator("#translation").inputValue(), "chrome");
  assert.equal(await page.locator("#recognition").evaluate(select => select.getBoundingClientRect().height >= 44), true, "Model controls must have 44px targets");
  await page.locator("#translation").evaluate(select => { select.disabled = true; });
  assert.equal(await page.locator("#translation").evaluate(select => getComputedStyle(select).opacity), "0.5");
  await page.locator("#translation").evaluate(select => { select.disabled = false; });
  await page.getByText("다운로드 완료 · Chrome 언어 팩", { exact: true }).first().waitFor({ timeout: 3000 });
  assert.equal(await page.locator("#recognition-download").textContent(), "다운로드 완료 · Chrome 언어 팩");
  assert.equal(await page.locator("#translation-download").textContent(), "다운로드 완료 · Chrome 언어 팩");
  assert.equal(await page.locator("#stop").isDisabled(), true, "Download Stop is enabled only during preparation");
  assert.equal(await page.locator("#recognition").evaluate(select => getComputedStyle(select).appearance), "base-select");
  await page.setViewportSize({ width: 640, height: 740 });
  await page.getByLabel("받아쓰기 모델", { exact: true }).focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#recognition").evaluate(select => select.matches(":open")), true);
  await page.screenshot({ path: ".ralph/advanced-select-light.png" });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#recognition").inputValue(), "chrome", "Escape leaves the selected model unchanged");
  assert.equal(await page.evaluate(() => commands.some(command => command.type === "models")), false, "Opening and dismissing a picker cannot download a model");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#translation").evaluate(select => document.activeElement === select), true, "Tab leaves the picker for the next field");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator("#recognition").click();
  await page.screenshot({ path: ".ralph/advanced-select-dark.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 640, height: 960 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await page.locator("#translation").click();
  await page.screenshot({ path: ".ralph/advanced-select-zoom.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Advanced must reflow at 200% zoom");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.locator("#recognition").click();
  await page.screenshot({ path: ".ralph/advanced-select-narrow.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Select must fit a narrow viewport");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 640, height: 740 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByLabel("받아쓰기 모델", { exact: true }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByText("선택한 모델 다운로드 중…", { exact:true }).waitFor();
  await page.getByText("다운로드 필요", { exact: true }).waitFor();
  assert.equal(await page.locator("#download-progress").isVisible(), true);
  await page.evaluate(() => {
    saved = { ...saved, downloadProgress: 0.42 };
    for (const listener of listeners) listener({ channel: "interpreter-event-v1" }, { id: "fixture" });
  });
  await page.waitForFunction(() => document.querySelector("#model-progress").value === 0.42);
  assert.equal(await page.locator("#download-percent").textContent(), "42%");
  assert.deepEqual(await page.evaluate(() => commands.find(c => c.type === "models")), {type:"models",tabId:10,source:"ja",options:{recognition:"tiny",translation:"chrome"}});
  assert.deepEqual(await page.evaluate(() => installs), [], "Explicit Whisper never installs SODA");
  await page.locator("#translation").selectOption("m2m100");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jamak-model-options-v1")).translation === "m2m100");
  assert.equal(await page.evaluate(() => commands.filter(c => c.type === "models").length), 2, "Selection starts model preparation without another Save click");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#recognition").value === "tiny");
  assert.equal(await page.locator("#translation").inputValue(), "m2m100");
  assert.equal(await page.evaluate(() => commands.some(c => c.type === "models")), false, "Reopening settings must not restart downloads");
  await page.locator("#translation").selectOption("nllb");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jamak-model-options-v1")).translation === "nllb");
  assert.match(await page.locator("#translation-detail").textContent(), /CC-BY-NC-4.0/);
  await page.locator("#stop").click();
  await page.getByText("중지됨", {exact:true}).waitFor();
  await page.locator("#reset").click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("jamak-model-options-v1")).recognition === "chrome");
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("jamak-model-options-v1"))), {recognition:"chrome",translation:"chrome"});
  assert.deepEqual(await page.evaluate(() => installs), [["ja-JP","en-US","ko-KR"]]);
  await page.screenshot({path:".ralph/advanced-model-options.png"});
  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByLabel("음성 언어", { exact: true }).focus();
  await page.keyboard.press("Space");
  await page.screenshot({ path: ".ralph/popup-select-narrow.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Popup select must fit a narrow viewport");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 640, height: 960 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await page.getByLabel("음성 언어", { exact: true }).click();
  await page.screenshot({ path: ".ralph/popup-select-zoom.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Popup must reflow at 200% zoom");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await page.setViewportSize({ width: 640, height: 740 });
  await page.locator("#model-details summary").click();
  await page.evaluate(() => {
    localStorage.setItem("jamak-model-options-v1", JSON.stringify({ recognition: "tiny", translation: "m2m100" }));
    saved = { ...saved, options: undefined, models: [{ task: "받아쓰기", name: "Chrome SODA" }, { task: "한국어 번역", name: "Chrome TranslateKit" }] };
    for (const listener of listeners) listener({ channel: "interpreter-event-v1" }, { id: "fixture" });
  });
  await page.waitForFunction(() => document.querySelector("#model-list").textContent.includes("Whisper Tiny"), undefined, { timeout: 3000 });
  assert.match(await page.locator("#model-list").innerText(), /M2M100/);
  assert.doesNotMatch(await page.locator("#model-list").innerText(), /Chrome SODA|Chrome TranslateKit/);
  assert.equal(await page.locator("#start").isDisabled(), true, "Unidentified previous readiness cannot enable the newly selected model");
  await page.goto(opened.url);
  await page.evaluate(() => { rejectModels = true; });
  await page.locator("#recognition").selectOption("base");
  await page.getByText("모델 준비 실패: 테스트 모델 준비 실패", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("jamak-model-options-v1")).recognition), "base", "A failed preparation still retains the selected model");
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#model-list").textContent.includes("Whisper Base"));
  await page.locator("#model-details summary").click();
  assert.doesNotMatch(await page.locator("#model-list").innerText(), /Chrome SODA/);
  console.log(JSON.stringify({ passed: true, scope: "Popup DOM and browser API mocks; cached models auto-ready on open/Stop, missing packs require a download gesture, readiness never starts capture" }));
} finally {
  await browser?.close(); await new Promise(done => server.close(done));
}
