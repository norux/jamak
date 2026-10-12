import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaptionRevision, DisplayProgress, MediaTargetId, PresentationEvent, SessionIdentity } from "../packages/contracts";
import { createPresentationPolicy } from "../packages/core/presentation-policy";

const identity: SessionIdentity = { sessionId: "generated", targetId: "video" as MediaTargetId, epoch: 0 };

test("withdrawing a pending correction releases the blocked stack without replaying later rows", () => {
  const h = harness(180); const first = caption(); const next = caption(1, true, "next");
  h.accept(first); h.progress(first);
  h.policy.accept({ type: "transcript", revision: caption(2).source });
  h.accept(next); h.progress(next); h.runFor(10000);
  assert.equal(h.events.length, 2);
  const removed = { ...caption(3, true).source, text: "", retracted: true as const };
  h.policy.accept({ type: "transcript", revision: removed });
  assert.deepEqual(h.events.at(-1)?.event, { type: "remove", identity, utteranceId: "u1" });
  h.runFor(251);
  assert.deepEqual(h.events.filter(item => item.event.type === "remove").map(item => item.event.type === "remove" && item.event.utteranceId), ["u1", "next"]);
  assert.deepEqual(h.policy.snapshot(), [next]);
  assert.ok(first.translation.state === "paired");
  assert.equal(h.policy.accept({ type: "translation", revision: first.translation.revision }), undefined);
});

function caption(revision = 1, final = false, utteranceId = "u1", session = identity): CaptionRevision {
  return {
    source: { identity: session, utteranceId, sourceRevision: revision, text: `generated source ${revision}`,
      final, language: "en", audioRange: { startMs: 0, endMs: 1000 } },
    translation: { state: "paired", revision: { identity: session, utteranceId, sourceRevision: revision,
      translationRevision: revision, languages: { source: "en", target: "ko" }, text: `합성 번역 ${revision}`, final } },
  };
}

function harness(draftUpdateMs?: number) {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let timerId = 0;
  const events: { at: number; event: PresentationEvent }[] = [];
  const policy = createPresentationPolicy(identity, {
    now: () => now,
    schedule(callback, delayMs) {
      const id = ++timerId;
      timers.set(id, { at: now + delayMs, callback });
      return () => { timers.delete(id); };
    },
  }, (event) => { events.push({ at: now, event }); }, draftUpdateMs);
  return {
    policy, events,
    accept: (value: CaptionRevision) => policy.accept({ type: "paired-caption", caption: value }),
    runFor(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    progress(value: CaptionRevision, partIndex = 0, complete = true, characterCount = 10, visible = true) {
      assert.equal(value.translation.state, "paired");
      if (value.translation.state !== "paired") return;
      policy.progress({ identity: value.source.identity, utteranceId: value.source.utteranceId,
        sourceRevision: value.source.sourceRevision, translationRevision: value.translation.revision.translationRevision,
        partIndex, complete, characterCount, visible });
    },
    get timerCount() { return timers.size; },
  };
}

test("first/each utterance is immediate, bursts coalesce at 1000ms and final cancels pending corrections", () => {
  const h = harness();
  h.accept(caption());
  assert.equal(h.events[0].event.type, "insert");
  for (let revision = 2; revision <= 13; revision++) { h.runFor(20); h.accept(caption(revision)); }
  assert.equal(h.events.length, 1);
  assert.equal(h.accept(caption(5)), undefined);
  h.runFor(759);
  assert.equal(h.events.length, 1);
  h.runFor(1);
  assert.equal(h.events[1].at, 1000);
  assert.equal(h.events[1].event.type, "update");
  if (h.events[1].event.type === "update") assert.equal(h.events[1].event.caption.source.sourceRevision, 13);
  h.accept(caption(14));
  h.runFor(200);
  h.accept(caption(15, true));
  assert.equal(h.events.at(-1)?.event.type, "update");
  assert.equal(h.events.at(-1)?.at, 1200);
  h.runFor(1000);
  assert.equal(h.events.length, 3);
  assert.equal(h.accept(caption(16)), undefined);
  h.accept(caption(1, false, "u2"));
  assert.equal(h.events.at(-1)?.event.type, "insert");
});

test("streaming overlay corrections coalesce within 180ms instead of waiting one second", () => {
  const h = harness(180); h.accept(caption()); h.runFor(50); h.accept(caption(2)); h.runFor(50); h.accept(caption(3));
  h.runFor(79); assert.equal(h.events.length, 1); h.runFor(1);
  assert.equal(h.events.at(-1)?.at, 180);
  const event = h.events.at(-1)?.event; assert.equal(event?.type, "update");
  if (event?.type === "update") assert.equal(event.caption.source.sourceRevision, 3);
});

test("completed translation flushes before the next provisional source can replace its queued paint", () => {
  const h = harness(180); const first = caption(); h.accept(first);
  h.runFor(20);
  assert.equal(first.translation.state, "paired");
  if (first.translation.state !== "paired") return;
  h.policy.accept({ type: "translation", revision: { ...first.translation.revision, translationRevision: 2, text: "교정 중" } });
  h.runFor(20);
  h.policy.accept({ type: "translation", revision: { ...first.translation.revision,
    translationRevision: 3, text: "교정된 전체 문장", final: true } });
  const completed = h.events.at(-1);
  assert.equal(completed?.at, 40, "Generation completion must not remain queued behind the draft cadence");
  assert.equal(completed?.event.type, "update");
  if (completed?.event.type === "update") {
    assert.equal(completed.event.caption.source.final, false);
    assert.equal(completed.event.caption.translation.state === "paired" ? completed.event.caption.translation.revision.text : undefined, "교정된 전체 문장");
  }
  h.policy.accept({ type: "transcript", revision: caption(2).source });
  h.runFor(180);
  assert.equal(h.events.at(-1), completed, "The next source must retain the completed text while its translation is pending");
});

test("pending source paints immediately and source final alone cannot initiate translation replay", () => {
  const h = harness();
  const c = caption();
  h.policy.accept({ type: "transcript", revision: c.source });
  assert.equal(h.events[0].event.type, "insert");
  h.accept(c);
  assert.equal(h.events.length, 2, "First useful translation bypasses cadence");
  const final = caption(2, true);
  h.policy.accept({ type: "transcript", revision: final.source });
  assert.equal(h.events.at(-1)?.event.type, "update");
  if (final.translation.state !== "paired") throw new Error("Fixture must be paired");
  h.policy.accept({ type: "translation", revision: { ...final.translation.revision, final: false } });
  assert.equal(h.events.at(-1)?.event.type, "update");
  h.policy.accept({ type: "translation", revision: { ...final.translation.revision, translationRevision: 3 } });
  assert.equal(h.events.at(-1)?.event.type, "update");
  const latest = h.policy.snapshot()[0];
  h.policy.accept({ type: "transcript", revision: { ...final.source, sourceRevision: 3 } });
  assert.equal(h.policy.snapshot()[0].translation.state, "pending", "Never pair an old translation with new source");
  assert.equal(h.events.at(-1)?.event.type, "update", "Final source corrections retain displayed translation while history awaits the matching pair");
  assert.equal(latest.translation.state, "paired");
});

test("long final updates preserve the read part and advance only acknowledged parts then fades for exactly 250ms; expired updates stay in history", () => {
  const h = harness();
  const partial = caption();
  h.accept(partial);
  h.progress(partial, 0, false);
  h.runFor(2500);
  assert.equal(h.events.at(-1)?.event.type, "replay");
  h.progress(partial, 1, false);
  const final = caption(2, true);
  h.accept(final);
  assert.deepEqual(h.events.at(-1)?.event, { type: "update", caption: final });
  h.progress(partial, 1, true, 100);
  h.runFor(10000);
  assert.equal(h.events.length, 3, "Stale renderer completion cannot expire a new final");
  h.progress(final, 1, false, 40);
  h.runFor(3999);
  assert.equal(h.events.length, 3);
  h.runFor(1);
  assert.deepEqual(h.events.at(-1)?.event, { type: "replay", caption: final, partIndex: 2 });
  h.progress(final, 0, true);
  h.runFor(5000);
  assert.equal(h.events.length, 4, "Old part acknowledgement cannot skip an unread part");
  h.progress(final, 2, false, 100);
  h.runFor(5999);
  assert.equal(h.events.length, 4);
  h.runFor(1);
  assert.equal(h.events.at(-1)?.event.type, "replay");
  h.progress(final, 3, true, 1);
  h.runFor(4000);
  assert.deepEqual(h.events.at(-1)?.event, { type: "fade", identity, utteranceId: "u1", durationMs: 250 });
  h.accept(caption(3, true));
  h.runFor(249);
  assert.equal(h.events.at(-1)?.event.type, "fade");
  h.runFor(1);
  assert.equal(h.events.at(-1)?.event.type, "remove");
  const count = h.events.length;
  h.accept(caption(4, true));
  assert.equal(h.events.length, count, "Retired overlays cannot reappear");
  assert.equal(h.policy.snapshot()[0].source.sourceRevision, 4, "Comparison still receives full latest records");
});

test("every provisional waits for final correction, expires in order and hidden layout does not spend reading time", () => {
  const h = harness();
  const first = caption();
  h.accept(first);
  h.progress(first);
  h.runFor(10000);
  assert.equal(h.events.length, 1, "Provisional text must await correction/final");
  assert.equal(h.timerCount, 0, "No polling an indefinitely held provisional");
  const next = caption(1, true, "u2");
  h.accept(next);
  h.progress(next, 0, true, 10, false);
  h.runFor(10000);
  assert.equal(h.events.length, 2, "A newer caption cannot expire an unfinished earlier caption");
  assert.equal(h.timerCount, 0, "Held captions must not poll");
  const final = caption(2, true);
  h.accept(final); h.progress(final);
  h.runFor(3999);
  assert.equal(h.events.at(-1)?.event.type, "update");
  h.runFor(251);
  assert.equal(h.events.at(-1)?.event.type, "remove");
  h.runFor(10000);
  assert.equal(h.events.length, 5, "Hidden text does not expire");
  h.progress(next);
  h.runFor(3999);
  assert.equal(h.events.length, 5);
  h.runFor(1);
  assert.equal(h.events.at(-1)?.event.type, "fade");
});

test("layout acknowledgements preserve deadlines, grant time for extension, and reject malformed progress", () => {
  const h = harness();
  const final = caption(1, true);
  h.accept(final);
  h.progress(final);
  h.runFor(1000);
  h.progress(final);
  const invalid: DisplayProgress = { identity, utteranceId: "u1", sourceRevision: 1, translationRevision: 1,
    partIndex: 0, complete: true, visible: true, characterCount: NaN };
  h.policy.progress(invalid);
  h.runFor(2999);
  assert.equal(h.events.length, 1);
  h.runFor(1);
  assert.equal(h.events.at(-1)?.event.type, "fade");

  const extension = harness();
  extension.accept(final);
  extension.progress(final);
  extension.runFor(2000);
  extension.progress(final, 0, true, 50);
  extension.runFor(4499);
  assert.equal(extension.events.length, 1);
  extension.runFor(1);
  assert.equal(extension.events.at(-1)?.event.type, "fade");
});

test("recent 300 history, eviction, retirement, epoch clear and dispose cancel delayed work", () => {
  const h = harness();
  for (let index = 0; index < 301; index++) {
    const c = caption(1, true, `u${index}`);
    h.accept({ ...c, source: { ...c.source, audioRange: { startMs: index * 1000, endMs: (index + 1) * 1000 } } });
  }
  assert.equal(h.policy.snapshot().length, 300);
  assert.equal(h.policy.snapshot()[0].source.utteranceId, "u1");
  assert.equal(h.accept(caption(2, true, "u0")), undefined);
  h.policy.retire("u1");
  const count = h.events.length;
  h.accept({ ...caption(2, true, "u1"), source: { ...caption(2, true, "u1").source, audioRange: { startMs: 1000, endMs: 2000 } } });
  assert.equal(h.events.length, count);
  const next = { ...identity, epoch: 1 };
  h.policy.activate(next);
  assert.equal(h.events.at(-1)?.event.type, "clear");
  assert.equal(h.accept(caption(3, true)), undefined);
  h.accept(caption(1, false, "fresh", next));
  h.accept(caption(2, false, "fresh", next));
  h.progress(caption(1, true), 0, true);
  assert.equal(h.timerCount, 1);
  h.policy.dispose();
  h.policy.dispose();
  assert.equal(h.timerCount, 0);
  const disposedCount = h.events.length;
  h.runFor(10000);
  assert.equal(h.events.length, disposedCount);
  assert.equal(h.accept(caption(3, true, "fresh", next)), undefined);
  assert.equal(h.policy.snapshot().length, 300, "Stop retains comparison history");
});

test("explicit clear cancels cadence and resets history while keeping the output reusable", () => {
  const h = harness();
  h.accept(caption());
  h.accept(caption(2));
  h.policy.clear();
  assert.equal(h.timerCount, 0);
  assert.equal(h.policy.snapshot().length, 0);
  assert.equal(h.events.at(-1)?.event.type, "clear");
  h.accept(caption());
  h.runFor(1000);
  assert.equal(h.events.at(-1)?.event.type, "insert");
  assert.equal(h.events.length, 3, "Cleared pending correction cannot leak into a reused sink");
});


test("source-only provisional stays in place and keeps updating after the next caption arrives", () => {
  const h = harness();
  const first = caption();
  h.policy.accept({ type: "transcript", revision: first.source });
  h.policy.progress({ identity, utteranceId: "u1", sourceRevision: 1,
    partIndex: 0, complete: true, characterCount: 10, visible: true });
  h.runFor(6000);
  assert.equal(h.events.length, 1, "The last provisional stays visible while awaiting correction");
  h.accept(caption(1, true, "u2"));
  h.runFor(10000);
  assert.equal(h.events.length, 2, "A newer caption cannot remove source text awaiting correction");
  const corrected = { ...first.source, sourceRevision: 2, text: "corrected live source" };
  const accepted = h.policy.accept({ type: "transcript", revision: corrected });
  assert.deepEqual(h.events.at(-1)?.event, { type: "update", caption: accepted });
  assert.equal(h.policy.snapshot()[0].translation.state, "pending", "Reading expiry never fabricates a translation");
});

test("pending and paired reading acknowledgements cannot spend each other's reading time", () => {
  const h = harness(); const first = caption();
  h.policy.accept({ type: "transcript", revision: first.source });
  h.progress(first);
  h.accept(caption(1, true, "u2")); h.runFor(10000);
  assert.equal(h.events.length, 2, "A paired acknowledgement cannot expire pending source text");
  h.policy.progress({ identity, utteranceId: "u1", sourceRevision: 1,
    partIndex: 0, complete: true, characterCount: 10, visible: true });
  h.runFor(1000); h.accept(first);
  const count = h.events.length;
  h.policy.progress({ identity, utteranceId: "u1", sourceRevision: 1,
    partIndex: 0, complete: true, characterCount: 10, visible: true });
  h.runFor(10000);
  assert.equal(h.events.length, count, "A late source-only acknowledgement cannot expire a fresh translation");
  const final = caption(2, true);
  h.accept(final); h.progress(final);
  const finalCount = h.events.length;
  h.runFor(3999); assert.equal(h.events.length, finalCount);
  h.runFor(1);
  assert.deepEqual(h.events.at(-1)?.event, { type: "fade", identity, utteranceId: "u1", durationMs: 250 });
});


test("first translation resets source reading parts; pending corrections retain the translated part", () => {
  const h = harness(); const first = caption();
  h.policy.accept({type:"transcript",revision:first.source});
  h.policy.progress({identity,utteranceId:"u1",sourceRevision:1,partIndex:0,complete:false,characterCount:100,visible:true});
  h.runFor(6000);
  assert.equal(h.events.at(-1)?.event.type,"replay");
  h.accept(first);
  h.progress(first,0,false);
  h.runFor(2500);
  const count = h.events.length;
  h.policy.accept({type:"transcript",revision:{...first.source,sourceRevision:2}});
  assert.equal(h.events.length,count,"Pending correction must not replace the visible translated part with original speech");
});


test("offscreen suffix corrections do not restart reading the unchanged first part", () => {
  const h = harness(180);
  const first = caption();
  h.accept(first);
  h.policy.progress({ identity, utteranceId: 'u1', sourceRevision: 1, translationRevision: 1,
    partIndex: 0, complete: false, visible: true, characterCount: 10, displayedText: 'unchanged' });
  for (let revision = 2; revision <= 10; revision++) {
    h.runFor(200);
    h.accept(caption(revision));
    h.policy.progress({ identity, utteranceId: 'u1', sourceRevision: revision, translationRevision: revision,
      partIndex: 0, complete: false, visible: true, characterCount: 10, displayedText: 'unchanged' });
  }
  h.runFor(700);
  assert.deepEqual(h.events.at(-1)?.event, {type:'replay',caption:caption(10),partIndex:1},
    'Reading must advance at its original deadline even while the unseen suffix changes');
  h.progress(caption(10), 1, false);
  h.accept(caption(11, true));
  assert.equal(h.events.at(-1)?.event.type, 'update', 'Finalization must not replay the already read first part');
});

test("an unchanged final translation grants four seconds after completion before the existing fade", () => {
  const h = harness(180); const first = caption();
  h.accept(first);
  const progress = {identity,utteranceId:'u1',sourceRevision:1,translationRevision:1,
    partIndex:0,complete:true,visible:true,characterCount:5,displayedText:'short'};
  h.policy.progress(progress); h.runFor(2400);
  const final = caption(2,true);
  h.accept(final);
  h.policy.progress({...progress,sourceRevision:2,translationRevision:2});
  h.runFor(3999); assert.equal(h.events.at(-1)?.event.type,'update');
  h.runFor(1); assert.deepEqual(h.events.at(-1)?.event,{type:'fade',identity,utteranceId:'u1',durationMs:250});
  h.runFor(249); assert.equal(h.events.at(-1)?.event.type,'fade');
  h.runFor(1); assert.equal(h.events.at(-1)?.event.type,'remove');
});

test("growing provisional text spends one reading interval instead of restarting it on each correction", () => {
  const h=harness(180); h.accept(caption());
  const progress={identity,utteranceId:'u1',sourceRevision:1,translationRevision:1,partIndex:0,
    complete:false,visible:true,characterCount:10,displayedText:'draft'};
  h.policy.progress(progress);
  for(let revision=2;revision<=10;revision++) {
    h.runFor(200); h.accept(caption(revision));
    h.policy.progress({...progress,sourceRevision:revision,translationRevision:revision,characterCount:revision+10,displayedText:`draft ${revision}`});
  }
  h.runFor(700);
  assert.deepEqual(h.events.at(-1)?.event,{type:'replay',caption:caption(10),partIndex:1});
});

test("stacked captions read concurrently and the next row keeps its original expiry", () => {
  const h = harness(); const first = caption(1, true, "first"); const next = caption(1, true, "next");
  h.accept(first); h.progress(first); h.runFor(1000);
  h.accept(next); h.progress(next); h.runFor(3250);
  assert.deepEqual(h.events.at(-1)?.event, { type: "remove", identity, utteranceId: "first" });
  h.runFor(749); assert.equal(h.events.at(-1)?.event.type, "remove");
  h.runFor(1);
  assert.deepEqual(h.events.at(-1)?.event, { type: "fade", identity, utteranceId: "next", durationMs: 250 });
  h.runFor(250); assert.deepEqual(h.events.at(-1)?.event, { type: "remove", identity, utteranceId: "next" });
});

test("a pending correction holds an old final pair until the latest pair is final and read", () => {
  const h = harness(180);
  const first = caption(1, true, "first");
  const next = caption(1, true, "next");
  h.accept(first);
  const progress = { identity, utteranceId: "first", sourceRevision: 1, translationRevision: 1,
    partIndex: 0, complete: true, visible: true, characterCount: 5, displayedText: "same" };
  h.policy.progress(progress);
  h.runFor(3900);
  const corrected = caption(2, true, "first");
  h.policy.accept({ type: "transcript", revision: corrected.source });
  h.accept(next); h.progress(next);
  h.runFor(10000);
  assert.equal(h.events.length, 2, "The displayed old final pair must stay while its correction is pending");
  assert.equal(h.timerCount, 0, "Both completed rows wait without polling");
  h.accept(corrected);
  h.policy.progress({ ...progress, sourceRevision: 2, translationRevision: 2 });
  h.runFor(3999);
  assert.equal(h.events.at(-1)?.event.type, "update", "Even unchanged corrected text needs a final reading hold");
  h.runFor(251);
  assert.deepEqual(h.events.at(-1)?.event, { type: "fade", identity, utteranceId: "next", durationMs: 250 });
  h.runFor(250);
  assert.deepEqual(h.events.filter(item => item.event.type === "remove").map(item => item.event.type === "remove" && item.event.utteranceId),
    ["first", "next"], "A late correction must preserve caption order");
});

test("a final source with a provisional translation cannot fade before its translation finalizes", () => {
  const h = harness(180);
  const first = caption(1, true);
  if (first.translation.state !== "paired") throw new Error("Fixture must be paired");
  h.accept({ ...first, translation: { state: "paired", revision: { ...first.translation.revision, final: false } } });
  h.progress(first);
  h.accept(caption(1, true, "next"));
  h.runFor(10000);
  assert.equal(h.events.length, 2);
  h.policy.accept({ type: "translation", revision: { ...first.translation.revision, translationRevision: 2 } });
  h.policy.progress({ identity, utteranceId: "u1", sourceRevision: 1, translationRevision: 2,
    partIndex: 0, complete: true, visible: true, characterCount: 10 });
  h.runFor(3999); assert.equal(h.events.at(-1)?.event.type, "update");
  h.runFor(1); assert.equal(h.events.at(-1)?.event.type, "fade");
});

test("a younger completed row waits for the older row to leave without restarting its reading time", () => {
  const h = harness(); const first = caption(1, true, "first"); const next = caption(1, true, "next");
  h.accept(first); h.progress(first, 0, true, 100); h.runFor(1000);
  h.accept(next); h.progress(next); h.runFor(5000);
  assert.deepEqual(h.events.at(-1)?.event, { type: "fade", identity, utteranceId: "first", durationMs: 250 });
  h.runFor(250);
  const removals = h.events.filter(item => item.event.type === "remove");
  assert.equal(removals[0].event.type === "remove" && removals[0].event.utteranceId, "first");
  assert.deepEqual(h.events.at(-1)?.event, { type: "fade", identity, utteranceId: "next", durationMs: 250 });
  h.runFor(250); assert.deepEqual(h.events.at(-1)?.event, { type: "remove", identity, utteranceId: "next" });
});

test("a younger long caption advances its own part while the older row is still being read", () => {
  const h = harness(); const first = caption(1, true, "first"); const next = caption(1, true, "next");
  h.accept(first); h.progress(first, 0, true, 100);
  h.accept(next); h.progress(next, 0, false, 10);
  h.runFor(4000);
  assert.deepEqual(h.events.at(-1)?.event, { type: "replay", caption: next, partIndex: 1 });
  assert.ok(!h.events.some(item => item.event.type === "fade"), "An older six-second hold must not block a younger row's next part");
});
