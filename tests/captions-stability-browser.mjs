import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

const outDir = resolve(".ralph/captions-stability");
await build({ configFile: false, logLevel: "warn", build: { outDir,
  rollupOptions: { input: resolve("apps/chrome/overlay.ts"), preserveEntrySignatures: "strict", output: { entryFileNames: "overlay.js" } } } });
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const page = await browser.newPage();
  await page.clock.install({time:new Date('2026-10-10T00:00:00Z')});
  await page.setContent('<div></div>');
  const { readFile } = await import('node:fs/promises');
  const bundle = await readFile(`${outDir}/overlay.js`, 'utf8');
  const exportedName = bundle.match(/(\w+) as createVideoOverlay/)[1];
  await page.addScriptTag({ type: 'module', content: bundle.replace(/export\s*\{[^}]+\};?\s*$/, `globalThis.createVideoOverlay = ${exportedName};`) });
  await page.waitForFunction(() => globalThis.createVideoOverlay);
  await page.clock.pauseAt(new Date('2026-10-10T00:01:00Z'));
  await page.evaluate(() => {
    const identity = { sessionId: 'stability', targetId: 'tab', epoch: 0 };
    globalThis.overlay = createVideoOverlay(document, null, identity);
    globalThis.send = (id, revision, text, pending = false, speakerId, final = false) => overlay.compare({
      source: { identity, utteranceId: id, sourceRevision: revision, text: 'Corrected English source', final, speakerId, language: 'en', audioRange: {startMs: id === 'one' ? 0 : 1000, endMs: id === 'one' ? 1000 : 2000} },
      translation: pending ? {state:'pending'} : {state:'paired', revision:{identity,utteranceId:id,sourceRevision:revision,translationRevision:revision,languages:{source:'en',target:'ko'},text,final:true}} });
    globalThis.read = () => document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live span')?.textContent ?? '';
    send('one', 1, '첫 번째 문장');
  });
  assert.equal(await page.evaluate(() => read()), '첫 번째 문장');
  await page.evaluate(() => send('one', 2, '', true));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '첫 번째 문장', 'Keep translation visible while its corrected pair is pending');
  await page.evaluate(() => send('one', 2, '교정된 첫 문장'));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '교정된 첫 문장');
  await page.evaluate(() => send('two', 1, '두 번째 문장'));
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelectorAll('.interpreter-live > span:not(.interpreter-measure)')).map(span => span.textContent)),
    ['교정된 첫 문장', '두 번째 문장'], 'A ready caption must appear below the previous caption immediately');
  assert.equal(await page.evaluate(() => {
    const rows = document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelectorAll('.interpreter-live');
    return rows[1].getBoundingClientRect().top >= rows[0].getBoundingClientRect().bottom
      && getComputedStyle(rows[1]).visibility === 'visible';
  }), true);
  assert.equal(await page.evaluate(() => read()), '교정된 첫 문장', 'New utterances cannot discard unread captions');
  await page.clock.runFor(2500);
  assert.equal(await page.evaluate(() => document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelectorAll('.interpreter-live')[1]?.style.opacity ?? '1'), '1', 'Fading an older row must not fade the following caption');
  await page.clock.runFor(500);
  await page.clock.runFor(10000);
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelectorAll('.interpreter-live > span:not(.interpreter-measure)')).map(span => span.textContent)),
    ['교정된 첫 문장', '두 번째 문장'], 'Every provisional caption must stay visible until recognition and translation finish');
  await page.evaluate(() => {
    globalThis.firstCue = document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live');
    send('one', 3, '', true);
  });
  await page.clock.runFor(10000);
  assert.equal(await page.evaluate(() => read()), '교정된 첫 문장');
  await page.evaluate(() => send('one', 3, '늦게 교정된 첫 문장'));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '늦게 교정된 첫 문장', 'Late corrections must update the held caption in real time');
  assert.equal(await page.evaluate(() => firstCue === document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live')), true,
    'A late correction must update the same row in its original position');
  await page.evaluate(() => send('one', 4, '늦게 교정된 첫 문장', false, undefined, true));
  await page.clock.runFor(3999);
  assert.equal(await page.evaluate(() => read()), '늦게 교정된 첫 문장');
  await page.clock.runFor(251);
  assert.equal(await page.evaluate(() => read()), '두 번째 문장');
  await page.evaluate(() => {
    overlay.clear(); send('withdrawn', 1, '없어진 임시 인식'); send('later', 1, '확정된 다음 문장', false, undefined, true);
  });
  await page.clock.runFor(10000);
  assert.equal(await page.evaluate(() => read()), '없어진 임시 인식');
  await page.evaluate(() => overlay.compare({source:{identity:{sessionId:'stability',targetId:'tab',epoch:0},utteranceId:'withdrawn',
    sourceRevision:2,language:'en',text:'',final:true,retracted:true,audioRange:{startMs:1000,endMs:2000}},translation:{state:'pending'}}));
  assert.equal(await page.evaluate(() => read()), '확정된 다음 문장', 'Withdrawal removes the orphan that blocked the stack');
  await page.clock.runFor(251);
  assert.equal(await page.evaluate(() => read()), '', 'The following final keeps its elapsed reading time and leaves');
  await page.evaluate(() => { overlay.clear(); send('one', 1, '첫 화자', false, 1, true); });
  const background = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live span')).backgroundColor);
  const firstBackground = await background();
  await page.clock.runFor(3999);
  assert.equal(await page.evaluate(() => read()), '첫 화자', 'Completed captions need at least four seconds of reading time');
  await page.clock.runFor(1);
  assert.equal(await page.evaluate(() => document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live').style.opacity), '0');
  await page.clock.runFor(250);
  assert.equal(await page.evaluate(() => read()), '');
  await page.evaluate(() => { overlay.clear(); send('two', 1, '둘째 화자', false, 2, true); });
  assert.notEqual(await background(), firstBackground, 'Different voices require different caption backgrounds');
  assert.equal(await page.evaluate(() => document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-speaker')), null, 'Speaker numbers should not appear in captions');
  await page.evaluate(() => { overlay.clear(); send('one', 1, '앞 자막', false, 1, true); });
  await page.clock.runFor(1000);
  await page.evaluate(() => send('two', 1, '뒤 자막', false, 2, true));
  await page.clock.runFor(3000);
  await page.clock.runFor(250);
  assert.equal(await page.evaluate(() => read()), '뒤 자막');
  await page.clock.runFor(749);
  assert.equal(await page.evaluate(() => read()), '뒤 자막');
  await page.clock.runFor(1);
  assert.equal(await page.evaluate(() => document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live').style.opacity), '0',
    'The second caption expires from when it first appeared, without another four-second wait');
  await page.clock.runFor(250);
  assert.equal(await page.evaluate(() => read()), '');
  await page.evaluate(() => { overlay.clear(); send('one', 1, '확정된 앞 자막', false, 1, true); });
  await page.clock.runFor(3900);
  await page.evaluate(() => { send('one', 2, '', true, 1, true); send('two', 1, '뒤 자막', false, 2, true); });
  await page.clock.runFor(10000);
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelectorAll('.interpreter-live > span:not(.interpreter-measure)')).map(span => span.textContent)),
    ['확정된 앞 자막', '뒤 자막'], 'Pending correction must block expiry even when the displayed old pair was final');
  await page.evaluate(() => send('one', 2, '확정된 앞 자막', false, 1, true));
  await page.clock.runFor(3999);
  assert.equal(await page.evaluate(() => read()), '확정된 앞 자막', 'An unchanged corrected final still needs its final reading hold');
  await page.clock.runFor(251);
  assert.equal(await page.evaluate(() => read()), '뒤 자막', 'Completed rows must still leave in their original order');
  await page.clock.runFor(250);
  assert.equal(await page.evaluate(() => read()), '');
  await page.evaluate(() => {
    overlay.clear();
    globalThis.stream = (sourceRevision, translationRevision, text, final = false, language = 'en') => {
      const source = {identity:{sessionId:'stability',targetId:'tab',epoch:0},utteranceId:'stream',sourceRevision,
        text:'Growing original',language,final:false,audioRange:{startMs:0,endMs:2000}};
      if (globalThis.streamSourceRevision !== sourceRevision) overlay.compare({source,translation:{state:'pending'}});
      globalThis.streamSourceRevision = sourceRevision;
      overlay.compare({source,translation:{state:'paired',revision:{identity:source.identity,utteranceId:'stream',
        sourceRevision,translationRevision,languages:{source:language,target:'ko'},text,final}}});
    };
    stream(1,1,'내일 역');
  });
  assert.equal(await page.evaluate(() => read()), '내일 역', 'The initial translation still streams immediately');
  await page.evaluate(() => stream(1,2,'내일 역에서 만나요.',true));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '내일 역에서 만나요.');
  await page.evaluate(() => {
    const text = document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live span');
    globalThis.streamTextNode = text.firstChild;
    globalThis.unchangedSuffix = document.createRange();
    unchangedSuffix.setStart(streamTextNode,5); unchangedSuffix.setEnd(streamTextNode,streamTextNode.length);
    stream(2,3,'내일');
  });
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '내일 역에서 만나요.', 'A regenerated prefix must not erase the visible sentence');
  await page.evaluate(() => stream(2,4,'내일 학교에서'));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '내일 역에서 만나요.', 'Hold the previous sentence while a changed replacement is incomplete');
  await page.evaluate(() => stream(2,5,'내일 학교에서 만나요.',true));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '내일 학교에서 만나요.');
  assert.equal(await page.evaluate(() => streamTextNode === document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelector('.interpreter-live span').firstChild),true,
    'Correct the existing text node rather than recreating the sentence');
  assert.equal(await page.evaluate(() => unchangedSuffix.toString()), '서 만나요.', 'Text outside the changed region keeps its browser range');
  await page.evaluate(() => stream(3,6,'내일 학교에서 만나요. 책도'));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '내일 학교에서 만나요. 책도', 'A continuation of the visible text keeps streaming');
  await page.evaluate(() => stream(3,7,'내일 학교에서 만나요. 책도 가져와요.',true));
  await page.clock.runFor(180);
  await page.evaluate(() => stream(4,8,'내일',true));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '내일', 'A completed shorter translation must still remove obsolete words');
  await page.evaluate(() => stream(5,9,'한국어로 바로 교정',false,'ko'));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '한국어로 바로 교정', 'Korean bypass does not wait for translation completion');
  await page.evaluate(() => stream(6,10,'일본어로 바뀐 번역',false,'ja'));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()), '일본어로 바뀐 번역', 'A language correction must not hold the old-language stream');
  await page.evaluate(() => { overlay.clear(); stream(1,1,`${'이미 읽은 앞 문장입니다. '.repeat(20)}마지막 내용`,true); });
  await page.clock.runFor(6000);
  const readPart = await page.evaluate(() => read());
  await page.evaluate(() => stream(2,2,'이미'));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()),readPart,'A regenerated prefix must preserve the current two-line reading part');
  await page.evaluate(() => stream(2,3,`${'이미 읽은 앞 문장입니다. '.repeat(20)}교정한 내용`,true));
  await page.clock.runFor(180);
  assert.equal(await page.evaluate(() => read()),readPart,'An unread tail correction must not replay a read prefix');
  await page.setViewportSize({width:320,height:520});
  await page.evaluate(() => { overlay.clear(); for (let i=0;i<12;i++) send(`burst-${i}`,1,`대화 ${i}`,false,i%2+1,true); });
  const observed = new Map(); const retired = new Set();
  for (let elapsed=0;elapsed<=12000;elapsed+=250) {
    const rows=await page.evaluate(() => Array.from(document.querySelector('[data-interpreter-overlay]').shadowRoot.querySelectorAll('.interpreter-live')).map(row => ({
      id:row.dataset.utteranceId,visible:getComputedStyle(row).visibility==='visible',top:row.getBoundingClientRect().top,
      bottom:row.getBoundingClientRect().bottom,text:row.querySelector('span').textContent,
    })));
    for (const row of rows.filter(row=>row.visible)) {
      assert.ok(row.top>=0 && row.bottom<=520,'Visible rows must fit the narrow viewport');
      assert.ok(!retired.has(row.id),'A retired toast must never reappear');
      if(!observed.has(row.id))observed.set(row.id,elapsed);
    }
    for(const[id,firstShown]of observed)if(!rows.some(row=>row.id===id)&&!retired.has(id)){
      assert.ok(elapsed-firstShown>=4250,'Clipped captions cannot spend their reading time before becoming visible');retired.add(id);
    }
    if(elapsed===0)assert.ok(rows.some(row=>!row.visible),'Overflow must queue in a bounded display area');
    if(elapsed===0)await page.screenshot({path:'.ralph/captions-stability/stack-narrow.png'});
    await page.clock.runFor(250);
  }
  assert.equal(observed.size,12,'Every queued caption must eventually become visible');
  assert.equal(retired.size,12,'Concurrent reading must clear this burst without a serial four-second wait per row');
  console.log(JSON.stringify({passed:true,readyCaptionStacked:true,concurrentReading:true,narrowBurst:12,pendingTranslationHeld:true,provisionalHeldUntilFinal:true,lateCorrectionKeepsRow:true,pendingFinalCorrectionHeld:true,withdrawalUnblocksStack:true,streamedCorrectionKeepsSentence:true,changedTextPatched:true,unreadSentencePreserved:true,speakerBackgrounds:true,finalHoldMs:4000,fadeMs:250}));
} finally { await browser.close(); }
