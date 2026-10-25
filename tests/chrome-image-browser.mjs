import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

// Production extension, actual OCR and Chrome text-language detection. By
// default only translation responses are mocked; --native uses real TranslateKit.
const prepareOnly = process.argv.includes("--ocr-prepare");
const hyMt2 = process.argv.includes("--hy-mt2");
const medium = process.argv.includes("--ocr-medium");
const precise = process.argv.includes("--ocr-v6");
const handwriting = process.argv.includes("--handwriting");
const ocrChoice = medium ? "v6Medium" : precise ? "v6Small" : "mobile";
let handwrittenSources;
const native = process.argv.includes("--native");
const output = resolve(".ralph/image-browser-extension");
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: { outDir: output } });
let crossPixels;
const server = createServer((request, response) => {
  if (request.url === "/cross.png") { response.setHeader("Content-Type", "image/png"); response.end(crossPixels); return; }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<title>Jamak background image fixture</title><style>body{margin:40px}img{display:block;margin-bottom:320px;max-width:100%;height:auto}</style><main id="images"></main>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const profile = await mkdtemp(resolve(".ralph/image-background-profile-"));
let context;
try {
  const args = ["--enable-unsafe-extension-debugging", ...(hyMt2 ? ["--enable-unsafe-webgpu"] : [])];
  if (native) {
    await writeFile(resolve(profile, "Local State"), JSON.stringify({ on_device_translation: { translate_kit_registered: true, translate_kit_packages: { en_ja_registered: true, en_ko_registered: true } } }));
    const config = resolve(profile, "cft-config.json");
    await writeFile(config, JSON.stringify({ requiredComponents: ["Chrome TranslateKit", "Chrome TranslateKit en-ja", "Chrome TranslateKit en-ko"], requiredComponentsDir: resolve(".ralph/image-native-components"), requiredComponentsUpdateTimeout: "120s" }));
    args.push("--headless", "--no-sandbox", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, `--chrome-for-testing-config=${config}`, "about:blank");
  }
  context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, ignoreHTTPSErrors: true, ignoreDefaultArgs: native ? true : ["--disable-extensions"], args, acceptDownloads: true });
  if (native && !context.pages().length) await context.waitForEvent("page", { timeout: 30000 });
  for (const [name, path] of [["PP-OCRv5_mobile_det_onnx_infer.tar", ".ralph/image-models/det.tar"], ["PP-OCRv5_mobile_rec_onnx_infer.tar", ".ralph/image-models/rec.tar"], ...["small", "medium"].flatMap(size => ["det", "rec"].map(part => [`PP-OCRv6_${size}_${part}_onnx_infer.tar`, `.ralph/image-models/PP-OCRv6_${size}_${part}_onnx_infer.tar`]))]) {
    try { const body = await readFile(path); await context.route(`**/${name}`, async route => {
      await route.fulfill({ body, contentType: "application/octet-stream" }).catch(() => {});
    }); }
    catch { /* Production downloads remain hash/size verified. */ }
  }
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: output });
  const worker = context.serviceWorkers().find(value => new URL(value.url()).host === id)
    ?? await context.waitForEvent("serviceworker", { predicate: value => new URL(value.url()).host === id });
  async function attach(targetId) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: false }); let next = 0; const pending = new Map();
    cdp.on("Target.receivedMessageFromTarget", event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message); const operation = pending.get(message.id); if (!operation) return;
      pending.delete(message.id); if (message.error) operation.reject(Error(message.error.message)); else operation.resolve(message.result);
    });
    async function send(method, params) {
      const sequence = ++next; const result = new Promise((resolve, reject) => pending.set(sequence, { resolve, reject }));
      await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: sequence, method, params }) });
      const fail = () => { pending.get(sequence)?.reject(Error("Owned extension context closed")); pending.delete(sequence); };
      context.on("close", fail);
      try { return await result; } finally { context.off("close", fail); }
    }
    async function evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
    }
    return { evaluate, async click(selector) {
      const point = await evaluate(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(node.disabled)throw Error('Disabled control');const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    } };
  }
  await worker.evaluate(async () => { await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS", "IFRAME_SCRIPTING", "BLOBS"], justification: "Verify the owned production background image runtime." }); });
  const runtimeTarget = (await cdp.send("Target.getTargets")).targetInfos.find(value => value.url === `chrome-extension://${id}/offscreen.html`);
  assert.ok(runtimeTarget); const runtime = await attach(runtimeTarget.targetId);
  // Settings preparation is checked without downloading speech packs or
  // starting recognition. OCR and native image translation stay real.
  const speechPreparationMock = `Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:class {processLocally=true;static async available(){return 'available'}static async install(){return true}start(){throw Error('Preparation must not start recognition')}abort(){}}});undefined;`;
  await runtime.evaluate(`localStorage.setItem('jamak-image-options-v1',JSON.stringify({ocr:${JSON.stringify(ocrChoice)},fontScale:1})); localStorage.setItem('jamak-popup-mode-v1','image'); localStorage.setItem('jamak-model-options-v1',JSON.stringify({recognition:'chrome',translation:${JSON.stringify(hyMt2 ? 'hyMt2' : 'chrome')},speaker:'off'}));`);
  if (hyMt2) await runtime.evaluate(`window.imageModelRequests=[]; const ImageWorker=window.Worker; window.Worker=class extends ImageWorker { postMessage(value,...args){window.imageModelRequests.push(value);return super.postMessage(value,...args)} }; Object.defineProperty(window,'Translator',{configurable:true,value:{availability:async()=>{throw Error('Hy-MT2 must not use Chrome translation')},create:async()=>{throw Error('Hy-MT2 must not use Chrome translation')}}}); undefined;`);
  if (!native && !hyMt2) await runtime.evaluate(`Object.defineProperty(window,'Translator',{configurable:true,value:{availability:async()=> 'available',create:async pair=>({translate:async text=> {if(window.jamakDelay)await new Promise(resolve=>window.jamakRelease=resolve);return (pair.targetLanguage==='ko'?'한국어':pair.targetLanguage==='ja'?'日本語':'English')+' '+text},destroy(){}})}});undefined;`);
  const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const other of context.pages()) if (other !== page) await other.close();
  const fixturePixels = await page.evaluate(() => {
    const texts = [
      ["Please return your library books by Friday.", "Welcome to the city library and enjoy your visit."],
      ["明日の午後三時に駅で会いましょう。", "予約は取り消さないでください。"],
      ["Please return your library books by Friday.", "明日の午後三時に駅で会いましょう。"],
    ];
    for (const [index, lines] of texts.entries()) {
      const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 220;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 960, 220); context.fillStyle = "black"; context.font = "32px system-ui";
      lines.forEach((text, row) => { context.fillText(text, 30, 70 + row * 90); });
      const image = document.createElement("img"); image.id = `image-${index}`; image.src = canvas.toDataURL(); image.width = 720; document.querySelector("#images").append(image);
    }
    return document.querySelector("#image-0").src;
  });
  crossPixels = Buffer.from(fixturePixels.split(",")[1], "base64");
  const original = await page.locator("#images").innerHTML();
  async function popup(automatic, target = "ko", stop = false, fontScale) {
    await page.bringToFront();
    const targetInfo = (await cdp.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }, { exclude: true }] })).targetInfos.find(value => value.url === page.url());
    await cdp.send("Extensions.triggerAction", { id, targetId: targetInfo.targetId });
    let popupTarget;
    for (let attempt = 0; attempt < 100; attempt++) {
      popupTarget = (await cdp.send("Target.getTargets")).targetInfos.find(value => value.url === `chrome-extension://${id}/popup.html`);
      if (popupTarget) break; await new Promise(done => setTimeout(done, 30));
    }
    assert.ok(popupTarget); const surface = await attach(popupTarget.targetId);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await surface.evaluate(`document.querySelector('#status')?.textContent!=='연결 중…'`)) break;
      await new Promise(done => setTimeout(done, 30));
    }
    await surface.click("#image-tab");
    if (fontScale !== undefined) {
      await surface.evaluate(`const font=document.querySelector('#image-font-size input[value="${fontScale}"]');font.checked=true;font.dispatchEvent(new Event('change'));`);
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline) {
        const scale = await worker.evaluate(async () => (await chrome.runtime.sendMessage({channel:"jamak-image-runtime",command:{type:"snapshot"}}))?.session?.imageOptions?.fontScale);
        if (scale === fontScale) { await surface.evaluate("window.close()"); return; }
        await new Promise(done => setTimeout(done, 50));
      }
      throw Error(`Image font size was not applied: ${JSON.stringify({ status: await surface.evaluate("document.querySelector('#image-status')?.textContent"), setting: await surface.evaluate("localStorage.getItem('jamak-image-options-v1')"), session: await worker.evaluate(async () => (await chrome.runtime.sendMessage({channel:"jamak-image-runtime",command:{type:"snapshot"}}))?.session) })}`);
    }
    if (stop) { if (!await surface.evaluate("document.querySelector('#image-stop').disabled")) await surface.click("#image-stop"); else assert.equal((await state()).state, "stopped"); await surface.evaluate("window.close()"); return; }
    await surface.evaluate(`const select=document.querySelector('#image-target');select.value=${JSON.stringify(target)};select.dispatchEvent(new Event('change'));`);
    assert.equal(await surface.evaluate("document.querySelector('#image-target').value"), target);
    await surface.click(automatic ? "#image-automatic" : "#image-translation");
    if (!automatic) await page.getByText("Jamak · 번역할 이미지를 클릭하세요 · Esc 취소", { exact: true }).waitFor().catch(async error => {
      throw Error(`${error.message}: ${JSON.stringify(await state())}; popup=${await surface.evaluate("document.querySelector('#image-status')?.textContent").catch(() => 'closed')}; page=${await page.locator('[role="status"]').allTextContents()}`);
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await cdp.send("Target.getTargets")).targetInfos.some(value => value.targetId === popupTarget.targetId)) return;
      await new Promise(done => setTimeout(done, 30));
    }
    throw Error("The image popup did not close after analysis started");
  }
  const state = () => worker.evaluate(async () => (await chrome.runtime.sendMessage({ channel: "jamak-image-runtime", command: { type: "snapshot" } }))?.snapshot);
  async function complete(total = 1) {
    const deadline = performance.now() + (hyMt2 || medium ? 600000 : 120000);
    while (performance.now() < deadline) {
      const snapshot = await state();
      if (snapshot?.state === "failed") throw Error(JSON.stringify(snapshot));
      if (snapshot?.state === "ready" && snapshot.total === total) { assert.equal(snapshot.failed, 0, snapshot.message); return snapshot; }
      await new Promise(done => setTimeout(done, 100));
    }
    throw Error(JSON.stringify(await state()));
  }
  if (prepareOnly) {
    await runtime.evaluate(speechPreparationMock);
    const ocrState = () => worker.evaluate(async () => (await chrome.runtime.sendMessage({ channel: "jamak-image-runtime", command: { type: "ocr-snapshot" } }))?.ocrPreparation);
    const preparation = () => worker.evaluate(async () => (await chrome.runtime.sendMessage({ channel: "interpreter-background-v1", command: { type: "snapshot" } })).snapshot);
    await worker.evaluate(() => { globalThis.ocrStates = []; chrome.runtime.onMessage.addListener(message => { if (message.channel === "jamak-image-event" && message.type === "ocr-status") ocrStates.push(message.ocrPreparation); }); });
    let settings = await context.newPage(); await settings.addInitScript(speechPreparationMock); await settings.goto(`chrome-extension://${id}/advanced.html`);
    await runtime.evaluate(`(() => { const original = window.fetch.bind(window); window.ocrHeld=false; window.holdOcr=true; window.fetch=async(input,options)=>{ if(window.holdOcr&&String(input).endsWith('PP-OCRv6_small_det_onnx_infer.tar')){ window.ocrHeld=true; await new Promise(resolve=>window.releaseOcr=resolve); } return original(input,options); }; })()`);
    await settings.locator("#image-ocr").selectOption("v6Small");
    for (let attempt = 0; attempt < 200 && !await runtime.evaluate("window.ocrHeld"); attempt++) await new Promise(done => setTimeout(done, 30));
    assert.equal(await runtime.evaluate("window.ocrHeld"), true, `Selecting OCR must request its model: ${JSON.stringify({ runtime: await ocrState(), ui: await settings.locator("#image-ocr-download").textContent() })}`);
    assert.equal((await ocrState()).state, "preparing");
    assert.equal((await preparation()).state, "preparing", "Overall readiness waits for OCR verification");
    await settings.close(); assert.equal((await ocrState()).state, "preparing", "Closing Advanced preserves the background download");
    settings = await context.newPage(); await settings.addInitScript(speechPreparationMock); await settings.goto(`chrome-extension://${id}/advanced.html`);
    await settings.locator("#download-progress").waitFor();
    assert.equal(await settings.locator("progress").count(), 1);
    assert.equal(await settings.locator("#ocr-progress, #ocr-prepare, #ocr-stop").count(), 0);
    await settings.locator("#stop").click();
    for (let attempt = 0; attempt < 100 && (await ocrState()).state !== "stopped"; attempt++) await new Promise(done => setTimeout(done, 30));
    assert.equal((await ocrState()).state, "stopped");
    assert.equal((await preparation()).state, "idle");
    await runtime.evaluate("window.holdOcr=false;window.releaseOcr?.();undefined");
    await settings.locator("#retry").click();
    for (let attempt = 0; attempt < 1000; attempt++) { const value = await preparation(); if (value.state === "failed") throw Error(value.message); if (value.state === "ready") break; await new Promise(done => setTimeout(done, 30)); }
    assert.equal((await ocrState()).state, "ready");
    assert.equal((await ocrState()).choice, "v6Small");
    assert.equal((await preparation()).state, "ready");
    assert.equal((await preparation()).imageOptions.ocr, "v6Small");
    const stages = await worker.evaluate(() => ocrStates);
    assert.ok(stages.some(value => value.downloadProgress > 0 && value.downloadProgress <= 1), "Progress must come from actual transferred bytes");
    assert.ok(stages.some(value => value.state === "preparing" && value.downloadProgress === undefined), "Verification stays indeterminate");
    await settings.screenshot({ path: ".ralph/advanced-unified-ready.png", fullPage: true });
    await settings.close(); settings = await context.newPage(); await settings.goto(`chrome-extension://${id}/advanced.html`);
    await settings.evaluate(() => {
      window.ocrInventoryBodyReads = 0;
      const arrayBuffer = Response.prototype.arrayBuffer;
      Response.prototype.arrayBuffer = function () { window.ocrInventoryBodyReads++; return arrayBuffer.call(this); };
    });
    await settings.locator("#image-ocr-download").filter({ hasText: "완료" }).waitFor();
    await settings.getByText("선택한 모델 전체 준비 완료", { exact: true }).waitFor();
    await runtime.evaluate(`(() => { const original=window.fetch.bind(window);let fail=true;window.fetch=async(input,options)=>{if(fail&&String(input).endsWith('PP-OCRv6_medium_rec_onnx_infer.tar')){fail=false;let sent=false;return new Response(new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(new Uint8Array(1024));}else controller.error(new TypeError('Injected interrupted OCR transfer'));}}));}return original(input,options);};})()`);
    await settings.locator("#image-ocr").selectOption("v6Medium");
    for (let attempt = 0; attempt < 1000 && (await preparation()).state !== "failed"; attempt++) await new Promise(done => setTimeout(done, 30));
    assert.equal((await preparation()).state, "failed");
    assert.match((await preparation()).message, /Injected interrupted OCR transfer/);
    await settings.locator("#status").filter({ hasText: "Injected interrupted OCR transfer" }).waitFor();
    assert.equal(await settings.locator("#retry").isEnabled(), true);
    assert.equal(await settings.locator("#stop").isDisabled(), true);
    const partial = await runtime.evaluate(`(async()=>{const cache=await caches.open('jamak-image-ocr-v1');const base='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/';return {det:!!await cache.match(base+'PP-OCRv6_medium_det_onnx_infer.tar'),rec:!!await cache.match(base+'PP-OCRv6_medium_rec_onnx_infer.tar')};})()`);
    assert.deepEqual(partial, { det: true, rec: false }, "Only a complete verified file survives interruption");
    await settings.locator("#retry").click();
    for (let attempt = 0; attempt < 1000; attempt++) { const value = await preparation(); if (value.state === "failed") throw Error(value.message); if (value.state === "ready") break; await new Promise(done => setTimeout(done, 30)); }
    assert.equal((await preparation()).state, "ready");
    assert.equal((await preparation()).imageOptions.ocr, "v6Medium");
    await settings.locator("#image-ocr-download").filter({ hasText: "완료" }).waitFor();
    assert.equal(await settings.evaluate(() => window.ocrInventoryBodyReads), 0, "Download progress must not reload 139 MB into the settings window");
    await settings.screenshot({ path: ".ralph/advanced-download-recovered.png", fullPage: true });
    assert.equal(await page.locator(".label").count(), 0, "OCR preparation never starts analysis");
    assert.equal((await preparation()).identity, undefined, "Unified preparation never starts audio capture");
    assert.equal((await preparation()).target, undefined);
    console.log(JSON.stringify({ passed: true, scope: "Actual Advanced unified preparation, interrupted Medium download/retry, partial-cache safety, zero settings weight-body reads, closure/reopening, shared Stop/retry, real OCR bytes/hashes; speech availability and translation mocked, no capture/inference", final: await preparation() }));
  } else {
  const pagesBefore = context.pages().length;
  await popup(false); await page.locator("#image-0").click();
  await complete();
  if (hyMt2) {
    const requests = await runtime.evaluate("window.imageModelRequests");
    assert.ok(requests.some(value => value.type === "prepare" && value.candidate === "hyMt2"));
    assert.ok(requests.some(value => value.type === "translate" && value.candidate === "hyMt2" && value.language === "en" && value.targetLanguage === "ko"));
    const translated = await page.locator(".label").allTextContents();
    assert.ok(translated.some(text => /[가-힣]/u.test(text)), JSON.stringify(translated));
    assert.ok(translated.some(text => /반납|반환|돌려/u.test(text)), JSON.stringify(translated));
    console.log(JSON.stringify({ passed: true, selectedTranslation: "hyMt2", requests: requests.map(({ type, candidate, language, targetLanguage }) => ({ type, candidate, language, targetLanguage })), translated, scope: "Actual page OCR to selected Hy-MT2 WebGPU translation; Chrome translation forbidden" }));
    process.exitCode = 0;
  } else {
  assert.equal(context.pages().length, pagesBefore, `Image analysis never opens another tab or window: ${JSON.stringify(context.pages().map(page => page.url()))}`);
  assert.equal(await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length), 1);
  const labels = page.locator(".label"); assert.ok(await labels.count() > 0);
  assert.equal(await labels.first().getAttribute("lang"), "ko");
  assert.equal(await page.locator("#images").innerHTML(), original, "Original images are untouched");
  const originalTop = await labels.first().evaluate(node => Number.parseFloat(node.parentElement.style.top));
  await page.locator("#image-0").evaluate(image => { image.style.height = `${image.getBoundingClientRect().height * 2}px`; });
  await page.waitForFunction(top => [...document.querySelectorAll("div")].some(host => Math.abs(Number.parseFloat(host.shadowRoot?.querySelector(".caption")?.style.top) - top * 2) < 1), originalTop);
  await page.locator("#image-0").evaluate(image => { image.style.removeProperty("height"); image.removeAttribute("style"); });
  await page.waitForFunction(top => [...document.querySelectorAll("div")].some(host => Math.abs(Number.parseFloat(host.shadowRoot?.querySelector(".caption")?.style.top) - top) < 1), originalTop);
  const before = await labels.first().boundingBox();
  await page.mouse.move(before.x + 20, before.y + 15); await page.mouse.down(); await page.mouse.move(before.x + 100, before.y + 240, { steps: 5 }); await page.mouse.up();
  const downloadReady = page.waitForEvent("download"); await page.getByRole("button", { name: "PNG 저장", exact: true }).click();
  const download = await downloadReady; const png = await readFile(await download.path());
  assert.equal(png.subarray(1, 4).toString(), "PNG"); assert.ok(png.readUInt32BE(20) > 220, "Export preserves the dragged position outside the image");
  await download.saveAs(resolve(`.ralph/image-background${native ? '-native' : ''}.png`));
  await page.screenshot({ path: resolve(`.ralph/image-background${native ? '-native' : ''}-page.png`) });
  await page.getByRole("button", { name: "자막 원래 위치로", exact: true }).first().click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".jamak-image")].some(host => host.shadowRoot?.querySelector(".caption.is-positioned")));
  const resetDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "PNG 저장", exact: true }).click();
  const resetPng = await readFile(await (await resetDownload).path());
  assert.equal(resetPng.readUInt32BE(20), 220, "Reset restores the original export geometry without model inference");
  await page.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().click();
  assert.equal(await page.locator(".editor select").first().inputValue(), "en");
  await page.locator(".editor fieldset").first().getByLabel("번역", { exact: true }).fill("수정한 번역입니다.");
  await page.locator(".editor fieldset").first().getByRole("button", { name: "수정 반영", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("div")].some(host => host.shadowRoot?.querySelector(".label")?.textContent === "수정한 번역입니다."));
  assert.equal(await page.getByRole("dialog", { name: "원문 · 번역 수정", exact: true }).isVisible(), true, "Saving a correction keeps the editor open");
  await page.locator(".editor fieldset").first().getByLabel("원문", { exact: true }).fill("Please return your books by Monday.");
  await page.locator(".editor fieldset").first().getByLabel("번역", { exact: true }).fill("원문 변경 후 새 번역을 기다립니다.");
  await page.locator(".editor fieldset").first().getByRole("button", { name: "수정 반영", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("div")].some(host => {
    const field = host.shadowRoot?.querySelector(".editor fieldset"); const translation = field?.querySelectorAll("textarea")[1]?.value;
    return translation && !translation.includes("원문 변경 후") && translation.replace(/\s/g, "") === host.shadowRoot.querySelector(".label")?.textContent.replace(/\s/g, "") && !field.querySelector("button").disabled;
  }));
  const baseFont = await labels.first().evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize));
  const sizeBaselineReady = page.waitForEvent("download"); await page.getByRole("button", { name: "PNG 저장", exact: true }).click();
  const sizeBaseline = await readFile(await (await sizeBaselineReady).path());
  assert.equal(await page.getByRole("dialog", { name: "원문 · 번역 수정", exact: true }).count(), 0, "Downloading outside dismisses editing");
  await labels.first().click();
  assert.equal(await page.getByRole("dialog", { name: "원문 · 번역 수정", exact: true }).count(), 0, "Caption clicks do not open editing");
  await page.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().click();
  await popup(false, "ko", false, 1.5);
  await page.waitForFunction(base => [...document.querySelectorAll(".jamak-image")].some(host => Number.parseFloat(getComputedStyle(host.shadowRoot.querySelector(".label")).fontSize) > base), baseFont);

  await page.screenshot({ path: resolve(`.ralph/image-font${native ? '-native' : ''}-page.png`) });
  const sizeDownloadReady = page.waitForEvent("download"); await page.getByRole("button", { name: "PNG 저장", exact: true }).click();
  const enlargedPng = await readFile(await (await sizeDownloadReady).path());
  assert.notDeepEqual(enlargedPng, sizeBaseline, "Changing only font size changes the saved PNG raster");
  await page.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().click();
  assert.equal(await page.locator(".editor .font-settings").count(), 0, "Editing has no font-size controls");
  await popup(false, "ko", false, 0.7);
  await page.waitForFunction(base => [...document.querySelectorAll(".jamak-image")].some(host => Number.parseFloat(getComputedStyle(host.shadowRoot.querySelector(".label")).fontSize) < base), baseFont);
  await popup(false, "ko", false, 1);
  await page.waitForFunction(base => [...document.querySelectorAll(".jamak-image")].some(host => Number.parseFloat(getComputedStyle(host.shadowRoot.querySelector(".label")).fontSize) === base), baseFont);
  if (await page.getByRole("button", { name: "수정 패널 닫기", exact: true }).count()) await page.getByRole("button", { name: "수정 패널 닫기", exact: true }).click();
  await labels.first().focus(); const moved = await labels.first().boundingBox(); await page.keyboard.press("Shift+ArrowRight");
  assert.ok((await labels.first().boundingBox()).x > moved.x, "Keyboard movement updates the page label");
  await page.evaluate(port => { const image = document.createElement("img"); image.id = "cross"; image.src = `http://localhost:${port}/cross.png`; image.width = 720; document.querySelector("#images").append(image); }, server.address().port);
  await page.locator("#cross").evaluate(image => image.decode());
  await popup(true); const all = await complete(4); assert.equal(all.total, 4);
  assert.equal(context.pages().length, pagesBefore);
  const detected = await page.locator(".editor select").evaluateAll(selects => selects.map(select => select.value));
  assert.ok(detected.includes("en")); assert.ok(detected.includes("ja"), JSON.stringify(detected));
  assert.equal(await worker.evaluate(async () => (await chrome.runtime.sendMessage({ channel: "interpreter-background-v1", command: { type: "snapshot" } })).snapshot.state), "idle", "Image processing does not prepare/start audio");
  const text = await labels.allTextContents(); assert.ok(text.length >= 6);
  if (native) assert.ok(text.some(value => /반납|도서관|금요일/u.test(value)), JSON.stringify(text));
  assert.equal(await page.getByRole("button", { name: "이미지 번역 설정", exact: true }).count(), 0);
  assert.equal(await page.locator('.dock button[aria-label="PNG 저장"]').count(), 4);
  await page.locator("#image-0").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "자막 숨기기", exact: true }).first().click();
  assert.equal(await labels.first().isVisible(), false);
  await page.getByRole("button", { name: "자막 다시 표시", exact: true }).first().click();
  assert.equal(await page.locator(".dock").count(), 4);
  await page.locator("#image-1").evaluate(image => { image.src = document.querySelector("#image-0").src; });
  await page.waitForFunction(() => [...document.querySelectorAll("div")].filter(node => node.shadowRoot?.querySelector(".dock")).length === 3);
  for (const target of ["ja", "en"]) {
    await popup(false, target); await page.locator("#image-2").click(); await complete();
    assert.equal(await labels.first().getAttribute("lang"), target);
    assert.equal(context.pages().length, pagesBefore);
  }
  const advanced = await context.newPage();
  await runtime.evaluate(speechPreparationMock); await advanced.addInitScript(speechPreparationMock);
  await advanced.goto(`chrome-extension://${id}/advanced.html`);
  const nextOcr = ocrChoice === "mobile" ? "v6Small" : "mobile";
  await advanced.locator("#image-ocr").selectOption(nextOcr);
  for (let attempt = 0; attempt < 100; attempt++) { if ((await state())?.state === "stopped") break; await new Promise(done => setTimeout(done, 30)); }
  assert.equal((await state()).state, "stopped", "Real Advanced OCR selection retires the previous image inference");
  assert.equal(await worker.evaluate(async () => (await chrome.runtime.sendMessage({ channel: "interpreter-background-v1", command: { type: "snapshot" } })).snapshot.identity), undefined, "Unified Advanced preparation never starts capture");
  await advanced.locator("#image-ocr").selectOption(ocrChoice);
  // Cached preparation may finish before a click; shared Stop is exercised
  // against a held download in --ocr-prepare. Release this smoke check's models.
  await worker.evaluate(async () => chrome.runtime.sendMessage({ channel: "interpreter-background-v1", command: { type: "stop" } }));
  await advanced.close(); await page.bringToFront();
  // Stopping releases inference but completed labels can still be moved/exported.
  await popup(false, "ko", true);
  await page.locator("#image-2").scrollIntoViewIfNeeded();
  await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "PNG 저장", exact: true }).click()]);
  await page.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().click();
  const stoppedFont = await labels.first().evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize));
  await popup(false, "ko", false, 1.25);
  await page.waitForFunction(base => [...document.querySelectorAll(".jamak-image")].some(host => Number.parseFloat(getComputedStyle(host.shadowRoot.querySelector(".label")).fontSize) > base), stoppedFont);
  if (await page.getByRole("button", { name: "수정 패널 닫기", exact: true }).count()) await page.getByRole("button", { name: "수정 패널 닫기", exact: true }).click();
  if (!native) {
    await runtime.evaluate("window.jamakDelay=true"); await popup(false); await page.locator("#image-0").click();
    for (let attempt = 0; attempt < 1000; attempt++) { if (await runtime.evaluate("!!window.jamakRelease")) break; await new Promise(done => setTimeout(done, 50)); }
    assert.equal(await runtime.evaluate("!!window.jamakRelease"), true);
    await page.getByRole("button", { name: "중지", exact: true }).click();
    await runtime.evaluate("window.jamakDelay=false;window.jamakRelease()");
    await page.waitForTimeout(400); assert.equal(await labels.count(), 0, "Late translations cannot paint after Stop");
  }
  await popup(false); await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes("중지"));
  assert.equal(await page.getByText("Jamak · 번역할 이미지를 클릭하세요 · Esc 취소", { exact: true }).count(), 0);
  if (handwriting) {
    const data = (await readFile(".ralph/image-models/handwritten-line.jpg")).toString("base64");
    await page.locator("#image-2").evaluate((image, data) => { image.src = `data:image/jpeg;base64,${data}`; }, data);
    await page.locator("#image-2").evaluate(image => image.decode());
    await popup(false); await page.locator("#image-2").click(); await complete();
    handwrittenSources = await page.locator(".editor fieldset textarea").evaluateAll(nodes => nodes.filter((_, index) => index % 2 === 0).map(node => node.value));
  }
  console.log(JSON.stringify({ passed: true, native, ocr: ocrChoice, handwrittenSources, snapshot: all, languages: detected, scope: "Actual background OCR/CLD, popup closure, no new page, mixed languages, cross-origin capture, drag/PNG, audio isolation" }));
  }
  }
} finally { await context?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
