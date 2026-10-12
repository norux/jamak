import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

const output = resolve(".ralph/media-framework/chrome-translation-build");
const clips = JSON.parse(await readFile("tests/fixtures/video-speech/manifest.json", "utf8")).clips;
const meanings = [
  ["today-negation", /오늘(?:(?!오늘|[.!?\n]).)*?(?:회의|만나|만날|만납)(?:(?!오늘|[.!?\n]).)*?(?:않|안\s|못|없)/gu],
  ["tomorrow", /내일/gu],
  ["afternoon-three", /오후\s*(?:3|세)\s*시/gu],
  ["station-future-meeting", /(?:역|정거장)(?:(?!역|정거장|[.!?\n]).)*?(?:만나(?:요|자|겠)|만납시다|만날\s*(?:것|거|까)|뵙겠습니다)/gu],
  ["reservation-not-cancelled", /예약(?:(?!예약|[.!?\n]).)*?취소(?:(?!예약|[.!?\n]).)*?(?:마|말|않)/gu],
];
const fixtures = clips.flatMap(clip => [
  { ...clip, name: `${clip.language}/original`, counts: [1, 1, 1, 1, 1] },
  { ...clip, name: `${clip.language}/complete-repetition`, text: `${clip.text} ${clip.text}`, counts: [2, 2, 2, 2, 2] },
  { ...clip, name: `${clip.language}/unpunctuated-repetition`,
    text: `${clip.text} ${clip.text}`.replace(/[。.!?]/gu, ""), counts: [2, 2, 2, 2, 2] },
]);
fixtures.push({ language: "ja", name: "ja/spaced-time-phrase",
  text: "今日は会議をしません。明日の 午後 三時に 駅で 会いましょう。予約は取り消さないでください。", counts: [1, 1, 1, 1, 1] });
fixtures.push({ language: "ja", name: "ja/opposite-polarity",
  text: "今日は会議をします。明日の午後三時に駅では会いません。予約は取り消してください。", counts: [0, 1, 1, 0, 0] });
fixtures.push({ language: "en", name: "en/opposite-polarity",
  text: "We will meet today. We will not meet at the station tomorrow at three in the afternoon. Please cancel the reservation.", counts: [0, 1, 1, 0, 0] });
// Exact synthetic ASR output that lost repeated clauses in B5. Keep it distinct
// from complete repetitions; the reservation occurs only once in this source.
fixtures.push({ language: "ja", name: "ja/b5-clipped-repeated-prefix",
  text: "今日は会議をしません 明日の午後3時に駅で会いましょう予約は取り消さないでください 今日は会議をしません明日の午後3時に駅で会いましょう",
  counts: [2, 2, 2, 2, 1] });
fixtures.push({language:"ja",name:"ja/question-followed-by-explanation",
  text:"こんなことがあったんですかまったく面倒なことになりましたよ",counts:[0,0,0,0,0],koreanAnchors:["번거|귀찮|골치|복잡|성가"]});
fixtures.push({language:"ja",name:"ja/request-followed-by-arrival",
  text:"うーんお社長とりあえずそんなこと忘れて遊んでいってくださいよちょうどね人らんきのいい子が入ってくる",counts:[0,0,0,0,0],koreanAnchors:["들어|오고|올|옵|온다|찾아"]});
await build({ configFile: "vite.chrome.config.ts", logLevel: "warn", build: {
  outDir: output, rollupOptions: { input: { translator: resolve("packages/engines-browser/document-translator.ts"), queue: resolve("packages/engines-browser/translation-queue.ts") },
    preserveEntrySignatures: "strict", output: { entryFileNames: "[name].js" } },
} });
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(`<button id="prepare">Prepare selected language</button><button id="stop">Stop</button><script type="module">
      import {createDocumentTranslator} from '/translator.js';
      import {createTranslationQueue} from '/queue.js';
      globalThis.statuses = []; globalThis.captions = []; globalThis.captionTimes = []; globalThis.failures = [];
      const language = new URL(location.href).searchParams.get('language');
      globalThis.host = createDocumentTranslator(document, {source: language, target: 'ko'}, status => statuses.push(status));
      globalThis.queue = createTranslationQueue({sessionId: 'translation-fixture', targetId: 'video', epoch: 1},
        {source: language, target: 'ko'}, host, 4, 300, caption => {captions.push(caption); captionTimes.push(performance.now())}, reason => failures.push(reason));
      globalThis.withoutActivation = host.prepare().then(() => 'unexpected', error => error.message);
      document.querySelector('#prepare').onclick = () => {
        globalThis.prepared = false; globalThis.failure = undefined;
        host.prepare().then(() => {globalThis.prepared = true}, error => {globalThis.failure = {name: error.name, message: error.message}});
      };
      document.querySelector('#stop').onclick = () => {queue.cancel(); host.stop()};
      globalThis.submit = (text, revision, final) => queue.accept({identity: {sessionId: 'translation-fixture', targetId: 'video', epoch: 1},
        utteranceId: 'speech', sourceRevision: revision, text, final, language, audioRange: {startMs: 0, endMs: 7000}});
      globalThis.loaded = true;
    </script>`);
    return;
  }
  const file = resolve(output, `.${path}`);
  if (!file.startsWith(output + sep)) { response.writeHead(403); response.end(); return; }
  try {
    response.setHeader("Content-Type", ({ ".js": "text/javascript", ".mjs": "text/javascript" })[extname(file)] ?? "application/octet-stream");
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const observations = { scope: "Real native Japanese/English to Korean semantic counts and revision queue on synthetic text, including exact B5 failure; no PCM or ASR accuracy", runs: [], pageErrors: [] };
let browser; let browserProcess; let browserExit; let profile;
const failures = [];
try {
  profile = await mkdtemp(resolve(".ralph/media-framework/chrome-translation-profile-"));
  // CfT disables background component updates. Register only the required
  // native components in this owned profile; Chrome downloads and verifies them.
  const components = ["Chrome TranslateKit", "Chrome TranslateKit en-ja", "Chrome TranslateKit en-ko"];
  await writeFile(resolve(profile, "Local State"), JSON.stringify({ on_device_translation: {
    translate_kit_registered: true, translate_kit_packages: { en_ja_registered: true, en_ko_registered: true },
  } }));
  const configuration = resolve(profile, "cft-config.json");
  await writeFile(configuration, JSON.stringify({ requiredComponents: components,
    requiredComponentsDir: resolve(".ralph/media-framework/chrome-translation-components"), requiredComponentsUpdateTimeout: "120s" }));
  observations.requiredComponents = components;
  browserProcess = spawn(chromium.executablePath(), ["--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
    `--chrome-for-testing-config=${configuration}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  browserExit = new Promise(done => { browserProcess.once("exit", done); browserProcess.once("error", done); });
  let port; const deadline = performance.now() + 120000;
  while (performance.now() < deadline && browserProcess.exitCode === null) {
    try { port = (await readFile(resolve(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch { await new Promise(done => setTimeout(done, 100)); }
  }
  assert.ok(port, "Owned Chromium must expose its debugging endpoint");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  observations.browser = browser.version(); observations.platform = `${process.platform}/${process.arch}`;
  // The debugging endpoint may precede the first document while CfT downloads.
  let page;
  while (performance.now() < deadline && browserProcess.exitCode === null) {
    page = browser.contexts()[0]?.pages()[0];
    if (page) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(page, "Owned Chromium must finish required native component preparation");
  page.on("pageerror", error => observations.pageErrors.push(error.message));
  for (const fixture of fixtures) {
    const run = { name: fixture.name, language: fixture.language, target: "ko", checks: [] }; observations.runs.push(run);
    await page.goto(`${origin}/?language=${fixture.language}`); await page.waitForFunction(() => globalThis.loaded);
    run.context = await page.evaluate(() => ({ visible: document.visibilityState, secure: isSecureContext, api: typeof Translator }));
    assert.equal(run.context.visible, "visible"); assert.equal(run.context.secure, true);
    assert.match(await page.evaluate(() => withoutActivation), /Press Prepare/);
    run.capability = await page.evaluate(() => host.probe());
    if (!["available", "download-required"].includes(run.capability.state)) {
      failures.push(`${fixture.language}: ${run.capability.reason}`); console.log(JSON.stringify({ run })); continue;
    }
    const started = performance.now();
    // One real gesture per selected language: creation may consume activation.
    await page.locator("#prepare").click();
    try { await page.waitForFunction(() => prepared || failure, undefined, { timeout: 120000, polling: 100 }); }
    catch (error) { run.timeout = error.message; }
    run.preparationMs = performance.now() - started;
    run.preparation = await page.evaluate(() => ({ ready: prepared, failure, statuses }));
    if (!run.preparation.ready) {
      await page.locator("#stop").click();
      run.afterStop = await page.evaluate(() => statuses.at(-1));
      failures.push(`${fixture.language}: ${run.preparation.failure?.message ?? run.timeout}`);
      console.log(JSON.stringify({ run })); continue;
    }
    run.checks.push("Real native pair creation from trusted document activation");
    await page.evaluate(text => { submit(text, 1, false); submit(text, 2, true); }, fixture.text);
    await page.waitForFunction(() => captions.some(c => c.source.sourceRevision === 2 && c.translation.state === 'paired' && c.translation.revision.final) || failures.length, undefined, { timeout: 30000 });
    run.captions = await page.evaluate(() => captions); run.failures = await page.evaluate(() => failures);
    assert.deepEqual(run.failures, []);
    assert.equal(run.captions[0].translation.state, "pending");
    const finalSourceIndex = run.captions.findIndex(c => c.source.sourceRevision === 2);
    assert.equal(run.captions[finalSourceIndex].translation.state, "pending");
    const result = run.captions.at(-1); const translated = result.translation.revision;
    assert.equal(result.source.sourceRevision, 2); assert.equal(result.source.final, true);
    assert.equal(translated.sourceRevision, 2); assert.equal(translated.final, true);
    assert.deepEqual(translated.identity, result.source.identity); assert.equal(translated.utteranceId, result.source.utteranceId);
    assert.deepEqual(translated.languages, { source: fixture.language, target: "ko" }); assert.match(translated.text, /[가-힣]/u);
    assert.ok(run.captions.every(c => c.translation.state !== "paired" || c.source.sourceRevision === c.translation.revision.sourceRevision));
    assert.equal(result.source.text, fixture.text, "Full source is preserved with the paired revision");
    run.sourceToPairedMs = await page.evaluate(index => captionTimes.at(-1) - captionTimes[index], finalSourceIndex);
    run.checks.push("Real Korean output, original-before-translation, latest final revision pairing");
    run.meanings = meanings.map(([name, pattern], index) => ({ name,
      expected: fixture.counts[index], actual: [...translated.text.matchAll(pattern)].length }));
    for (const meaning of run.meanings) {
      if (meaning.actual !== meaning.expected) failures.push(`${fixture.name}: ${meaning.name} expected ${meaning.expected}, actual ${meaning.actual}`);
    }
    run.missingKorean = (fixture.koreanAnchors??[]).filter(anchor=>!new RegExp(anchor).test(translated.text));
    if(run.missingKorean.length) failures.push(`${fixture.name}: missing follow-up meaning ${run.missingKorean.join(', ')}`);
    await page.locator("#stop").click();
    assert.equal(await page.evaluate(text => submit(text, 3, true), fixture.text), false);
    const count = await page.evaluate(() => captions.length); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => captions.length), count);
    await page.evaluate(() => host.close());
    run.checks.push("Stop suppresses further submissions and captions");
    console.log(JSON.stringify({ run }));
  }
  assert.deepEqual(observations.pageErrors, []);
  assert.deepEqual(failures, [], "Both real language pairs must prepare and translate; capability/model loading alone cannot pass");
  console.log(JSON.stringify({ passed: true, ...observations }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, ...observations, failures, error: error.message }));
  process.exitCode = 1;
} finally {
  browserProcess?.kill("SIGTERM"); await browser?.close(); await browserExit;
  if (profile) await rm(profile, { recursive: true, force: true });
  await new Promise(done => server.close(done));
}
