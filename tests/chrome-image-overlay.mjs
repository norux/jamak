import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { build } from "vite";

// Actual page adapter and browser layout. OCR/translation messages are synthetic.
const output = resolve(".ralph/image-overlay-check");
await mkdir(output, { recursive: true });
await build({ configFile: false, logLevel: "warn", build: { outDir: output,
  lib: { entry: resolve("apps/chrome/tab-image.ts"), formats: ["iife"], name: "JamakImageOverlay", fileName: () => "overlay.js" } } });
const browser = await chromium.launch({ channel: "chromium", headless: true });

async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(3000);
  await page.route("http://127.0.0.1/overlay", route => route.fulfill({ contentType: "text/html", body: '<title>Image overlay controls</title><style>body{margin:0;min-height:1400px;background:#f2f3f7}img{position:absolute;left:24px;width:600px;height:180px;object-fit:fill}</style>' }));
  await page.goto("http://127.0.0.1/overlay");
  await page.evaluate(async () => {
    for (let index = 0; index < 3; index++) {
      const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 180;
      const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 600, 180); context.fillStyle = "#242936"; context.font = "24px system-ui";
      context.fillText("Please return your books by Friday.", 24, 56);
      const image = document.createElement("img"); image.id = `image-${index}`; image.src = canvas.toDataURL(); image.style.top = `${80 + index * 200}px`; document.body.append(image); await image.decode();
    }
    let receive;
    globalThis.imageRequests = [];
    globalThis.chrome = { runtime: { id: "fixture", onMessage: { addListener(listener) { receive = listener; } }, async sendMessage(message) { imageRequests.push(message); return {}; } } };
    globalThis.imageMessage = fields => new Promise(resolve => receive({ channel: "jamak-image", token: "overlay", ...fields }, { id: "fixture" }, resolve));
  });
  await page.addScriptTag({ path: resolve(output, "overlay.js") });
  await page.evaluate(async () => {
    const selected = await imageMessage({ type: "select", automatic: true });
    globalThis.paintImage = (index, revision = 1, complete = true, fontScale = 1) => imageMessage({ type: "paint", imageId: selected.imageIds[index], revision, complete, width: 600, height: 180, targetLanguage: "ko",
      labels: [{ index: 0, x: 24, y: 72, width: 400, height: 42, padding: 6, fontSize: 18, lineHeight: 25.2, lines: ["금요일까지 책을 반납해 주세요."] }],
      regions: Array.from({ length: 2 }, (_, row) => ({ source: `Please return your books by Friday. ${row + 1}`, translation: `금요일까지 책을 반납해 주세요. ${row + 1}`, language: "en", fontScale, score: 1, x: 24, y: row === 0 ? 72 : 16, width: 400, height: 30 })),
    });
    for (let index = 0; index < 3; index++) await paintImage(index);
  });
  return page;
}
async function drag(page, locator, x, y, offset) {
  const bounds = await locator.boundingBox(); assert.ok(bounds);
  const start = { x: bounds.x + (offset?.x ?? bounds.width / 2), y: bounds.y + (offset?.y ?? bounds.height / 2) };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + x, start.y + y, { steps: 8 }); await page.mouse.up();
}
function surface(page, index = 0) { return page.locator("html > div").filter({ has: page.locator(".dock") }).nth(index); }
async function insideViewport(page, element) {
  const bounds = await element.boundingBox();
  const viewport = await page.evaluate(() => ({ x: visualViewport.offsetLeft, y: visualViewport.offsetTop, width: visualViewport.width, height: visualViewport.height }));
  assert.ok(bounds && bounds.x >= viewport.x + 10 && bounds.y >= viewport.y + 10, JSON.stringify({ bounds, viewport }));
  assert.ok(bounds.x + bounds.width <= viewport.x + viewport.width - 10 && bounds.y + bounds.height <= viewport.y + viewport.height - 10, JSON.stringify({ bounds, viewport }));
}

try {
  await test("only the pencil opens editing and outside clicks dismiss the popup", async () => {
    const page = await fixture();
    try {
      const first = surface(page);
      assert.equal(await first.getByRole("button", { name: "이미지 번역 설정", exact: true }).count(), 0);
      assert.equal(await first.locator(".dock button").count(), 2);
      assert.equal(await first.locator(".dock").getByRole("button", { name: "PNG 저장", exact: true }).isVisible(), true);
      await first.locator(".label").first().click();
      assert.equal(await first.locator(".editor").isVisible(), false);
      await page.keyboard.press("Enter");
      await page.evaluate(() => scrollTo(0, 0)); await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await first.locator(".editor").isVisible(), false);
      await first.locator('.caption-edit[data-index="0"]').click();
      assert.equal(await first.locator(".editor fieldset:visible").count(), 1);
      assert.equal(await first.locator(".editor fieldset:visible").getByLabel("원문", { exact: true }).inputValue(), "Please return your books by Friday. 1");
      await first.getByRole("button", { name: "수정 패널 닫기", exact: true }).click();
      await drag(page, first.locator(".label").first(), 20, 20, { x: 10, y: 10 });
      assert.equal(await first.locator(".editor").isVisible(), false, "A caption drag does not open editing");
      await first.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().click();
      assert.equal(await first.locator(".editor").isVisible(), true);
      const source = first.locator(".editor fieldset:visible").getByLabel("원문", { exact: true });
      await source.fill("Keep this region draft.");
      await first.getByRole("button", { name: "수정 패널 닫기", exact: true }).click();
      await first.locator('.caption-edit[data-index="1"]').click();
      assert.equal(await first.locator(".editor fieldset:visible").count(), 1);
      assert.equal(await first.locator(".editor fieldset:visible").getByLabel("원문", { exact: true }).inputValue(), "Please return your books by Friday. 2");
      await first.locator(".editor fieldset:visible").getByRole("button", { name: "수정 반영", exact: true }).click();
      assert.equal(await page.evaluate(() => imageRequests.at(-1).index), 1);
      await first.getByRole("button", { name: "수정 패널 닫기", exact: true }).click();
      await page.mouse.click(4, 4);
      assert.equal(await first.locator(".editor").isVisible(), false);
      await first.locator('.caption-edit[data-index="0"]').click();
      assert.equal(await first.locator(".editor fieldset:visible").getByLabel("원문", { exact: true }).inputValue(), "Keep this region draft.");
    } finally { await page.close(); }
  });
  await test("download and independent caption visibility persist across paint", async () => {
    const page = await fixture();
    try {
      const first = surface(page); const original = await page.locator("#image-0").evaluate(image => image.outerHTML);
      const position = await first.locator(".label").first().boundingBox();
      const download = first.getByRole("button", { name: "PNG 저장", exact: true });
      assert.equal(await download.isVisible(), true);
      await first.getByRole("button", { name: "자막 숨기기", exact: true }).click();
      assert.equal(await first.locator(".label").first().isVisible(), false);
      assert.equal(await download.isVisible(), true);
      await page.evaluate(() => paintImage(0, 2));
      assert.equal(await first.locator(".label").first().isVisible(), false);
      await first.getByRole("button", { name: "자막 다시 표시", exact: true }).click();
      assert.deepEqual(await first.locator(".label").first().boundingBox(), position);
      assert.deepEqual(await page.evaluate(() => imageRequests), [], "Display controls never rerun inference");
      assert.equal(await page.locator("#image-0").evaluate(image => image.outerHTML), original);
      await page.screenshot({ path: resolve(output, "paired-controls.png") });
    } finally { await page.close(); }
  });
  await test("the popup keeps its moved position and drafts but dismisses for other captions", async () => {
    const page = await fixture();
    try {
      const first = surface(page); const pencil = first.locator('.caption-edit[data-index="0"]');
      await pencil.click();
      const before = await first.locator(".editor").boundingBox();
      await drag(page, first.locator(".editor-header"), 100, 30, { x: 60, y: 20 });
      const after = await first.locator(".editor").boundingBox();
      assert.ok(after.x > before.x + 80 && after.y > before.y + 20, JSON.stringify({ before, after }));
      const source = first.locator(".editor fieldset").first().getByLabel("원문", { exact: true });
      await source.fill("Keep this draft when dismissed.");
      await page.mouse.click(4, 4);
      assert.equal(await first.locator(".editor").isVisible(), false);
      await pencil.click(); assert.deepEqual(await first.locator(".editor").boundingBox(), after);
      assert.equal(await source.inputValue(), "Keep this draft when dismissed.");
      await drag(page, first.locator(".label").first(), 30, 40, { x: 10, y: 10 });
      assert.equal(await first.locator(".editor").isVisible(), false);
      await pencil.click();
      await first.getByRole("button", { name: "수정 창 이동", exact: true }).focus();
      for (let step = 0; step < 60; step++) await page.keyboard.press("Shift+ArrowRight");
      await surface(page, 1).locator('.caption-edit[data-index="0"]').click();
      assert.equal(await first.locator(".editor").isVisible(), false);
      assert.equal(await page.getByRole("dialog", { name: "원문 · 번역 수정", exact: true }).count(), 1);
    } finally { await page.close(); }
  });
  await test("caption editing has no font controls and labels have no focus outline", async () => {
    const page = await fixture();
    try {
      const first = surface(page);
      await first.locator(".label").first().focus();
      assert.equal(await first.locator(".label").first().evaluate(node => getComputedStyle(node).outlineStyle), "none");
      await first.locator('.caption-edit[data-index="0"]').click();
      assert.equal(await first.getByRole("group", { name: "글자 크기", exact: true }).count(), 0);
    } finally { await page.close(); }
  });
  await test("paired icons drag together within the image plus 24px without triggering their clicks", async () => {
    const page = await fixture();
    try {
      const first = surface(page); const download = first.getByRole("button", { name: "PNG 저장", exact: true });
      const dock = first.locator(".dock");
      const before = await dock.boundingBox();
      await drag(page, download, -160, 50);
      const after = await dock.boundingBox();
      assert.ok(after.x < before.x - 140 && after.y > before.y + 40);
      assert.deepEqual(await page.evaluate(() => imageRequests), [], "Dragging download cannot export");
      assert.equal(await first.locator(".label").first().isVisible(), true);
      await page.evaluate(() => paintImage(0, 2)); assert.deepEqual(await dock.boundingBox(), after);
      await page.evaluate(() => scrollTo(0, 500)); await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await first.locator(".caption-actions").first().isVisible(), false, "Offscreen captions cannot leave floating edit controls in the viewport");
      await page.evaluate(() => scrollTo(0, 0)); await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.deepEqual(await dock.boundingBox(), after, "Scrolling an image away and back preserves the icon placement");
      for (const direction of [-1, 1]) {
        await drag(page, download, direction * 2000, direction * 2000);
        const bounds = await dock.boundingBox(); const image = await page.locator("#image-0").boundingBox();
        assert.ok(bounds.x >= image.x - 24.5 && bounds.y >= image.y - 24.5);
        assert.ok(bounds.x + bounds.width <= image.x + image.width + 24.5 && bounds.y + bounds.height <= image.y + image.height + 24.5);
      }
      await download.focus(); const keyboardStart = await dock.boundingBox(); await page.keyboard.press("Shift+ArrowLeft");
      assert.ok(Math.abs((await dock.boundingBox()).x - keyboardStart.x + 10) < 1);
      await download.click(); assert.equal(await page.evaluate(() => imageRequests.at(-1).type), "export");
      assert.equal(await first.getByRole("button", { name: "자막 숨기기", exact: true }).isVisible(), true);
    } finally { await page.close(); }
  });
  await test("moved captions offer an original-position action and remove it after a reset paint", async () => {
    const page = await fixture();
    try {
      const first = surface(page); const before = await first.locator(".label").first().boundingBox();
      assert.equal(await first.getByRole("button", { name: "자막 원래 위치로", exact: true }).count(), 0);
      await drag(page, first.locator(".label").first(), 50, 70, { x: 10, y: 10 });
      const reset = first.getByRole("button", { name: "자막 원래 위치로", exact: true });
      assert.equal(await reset.isVisible(), true);
      await page.screenshot({ path: resolve(output, "caption-reset.png") });
      await reset.click();
      assert.equal(await page.evaluate(() => imageRequests.at(-1).type), "reset");
      await page.evaluate(() => paintImage(0, 2));
      assert.deepEqual(await first.locator(".label").first().boundingBox(), before);
      assert.equal(await first.getByRole("button", { name: "자막 원래 위치로", exact: true }).count(), 0);
    } finally { await page.close(); }
  });
  await test("the editor stays inside the screen near edges, on narrow screens and at 200% visual zoom", async () => {
    const page = await fixture();
    try {
      await page.locator("#image-0").evaluate(image => { image.style.left = "950px"; image.style.top = "540px"; });
      const first = surface(page); await first.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().click();
      await insideViewport(page, first.locator(".editor"));
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 320, height: 480 });
      await page.locator("#image-0").evaluate(image => { image.style.left = "8px"; image.style.top = "200px"; image.style.width = "304px"; });
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await first.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().click();
        await insideViewport(page, first.locator(".dock")); await insideViewport(page, first.locator(".caption-actions").first()); await insideViewport(page, first.locator(".editor"));
        const source = first.locator(".editor fieldset").first().getByLabel("원문", { exact: true });
        await source.fill("An unsaved correction."); await page.evaluate(() => paintImage(0, 3));
        assert.equal(await source.inputValue(), "An unsaved correction."); assert.equal(await first.locator(".editor").isVisible(), true);
        await page.keyboard.press("Tab"); await page.keyboard.press("Space");
        assert.equal(await first.locator(".editor select").first().evaluate(select => select.matches(":open")), true);
        await page.keyboard.press("Escape");
        assert.equal(await first.locator(".editor").isVisible(), true, "Escape closes the native language picker before the editor");
        await first.locator(".editor fieldset").first().getByRole("button", { name: "수정 반영", exact: true }).scrollIntoViewIfNeeded();
        await insideViewport(page, first.locator(".editor"));
        await page.screenshot({ path: resolve(output, `editor-${colorScheme}-320.png`) });
        await page.keyboard.press("Escape");
        assert.equal(await first.locator(".editor").isVisible(), false);
        assert.equal(await first.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().evaluate(node => node === node.getRootNode().activeElement), true);
      }
      await page.setViewportSize({ width: 640, height: 960 });
      await first.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().click();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
      await page.waitForTimeout(100); await insideViewport(page, first.locator(".editor"));
      const lastApply = first.locator(".editor fieldset").first().getByRole("button", { name: "수정 반영", exact: true });
      await lastApply.scrollIntoViewIfNeeded(); await insideViewport(page, lastApply);
      await page.screenshot({ path: resolve(output, "editor-200-percent.png") });
    } finally { await page.close(); }
  });
  await test("an open editor stays above the next image toolbar and cleans up when its source changes", async () => {
    const page = await fixture();
    try {
      const first = surface(page); await first.getByRole("button", { name: "원문 · 번역 수정", exact: true }).first().click();
      const other = await surface(page, 1).locator(".dock").boundingBox();
      const point = { x: other.x + other.width / 2, y: other.y + other.height / 2 };
      assert.equal(await first.locator(".editor").evaluate((editor, point) => editor.contains(editor.getRootNode().elementFromPoint(point.x, point.y)), point), true, "The editor is above the other image's toolbar");
      await page.screenshot({ path: resolve(output, "editor-overlapping-images.png") });
      await page.locator("#image-0").evaluate(image => { image.src = `${document.querySelector("#image-1").src}#changed`; });
      await page.waitForFunction(() => [...document.querySelectorAll("html > div")].filter(host => host.shadowRoot?.querySelector(".dock")).length === 2);
      assert.equal(await page.getByRole("dialog", { name: "원문 · 번역 수정", exact: true }).count(), 0);
    } finally { await page.close(); }
  });
  await test("successful completion never leaves a page notice, while errors stay visible", async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => imageMessage({ type: "status", snapshot: { state: "running", message: "이미지 읽는 중…" } }));
      assert.equal(await page.getByRole("status").count(), 1);
      await page.evaluate(() => imageMessage({ type: "status", snapshot: { state: "ready", failed: 0, message: "3개 이미지 처리 완료 · 언어 판별 불가 1개 영역 (원문 수정에서 보완 가능)" } }));
      assert.equal(await page.getByRole("status").count(), 0);
      await page.evaluate(() => imageMessage({ type: "status", snapshot: { state: "failed", failed: 1, message: "OCR 모델 다운로드 실패" } }));
      assert.equal(await page.getByText("Jamak · OCR 모델 다운로드 실패", { exact: false }).isVisible(), true);
    } finally { await page.close(); }
  });
} finally { await browser.close(); }
