import type { CaptionRevision, LanguagePair, SessionIdentity, TextTranslator, TranscriptRevision } from "../contracts";
import { sameIdentity } from "../core/identity";
import { createRevisionStore } from "../core/revision-store";

function fillerOnly(text: string, language: string) {
  const normalized = text.normalize("NFKC").toLowerCase();
  const words = (language === "ja" ? normalized.replace(/[〜~]/gu, "ー") : normalized)
    .replace(/[\p{P}\p{S}]/gu, " ").trim().split(/\s+/);
  // Only suppress entire filler utterances; short answers and sentence content
  // stay intact, including an interjection followed by meaningful speech.
  const filler = language === "en" ? /^(?:u+h+|u+m+|h+m+|m+h+m+|e+r+m*|a+h+|o+h+)$/
    : language === "ja" ? /^(?:え[えー]*|あ[あー]*|お[おー]*|うー+ん+|んー+|えー*っと)$/
    : language === "ko" ? /^(?:음+|어+|오+|아+|흠+|으+음+)$/ : undefined;
  return words.every(word => !word || filler?.test(word));
}

export function createTranslationQueue(identity: SessionIdentity, languages: LanguagePair, translator: TextTranslator,
  maxPendingUtterances: number, maxStoredCaptions: number,
  receive: (caption: CaptionRevision) => void, fail: (reason: "overloaded" | "engine-failed") => void) {
  if (!Number.isSafeInteger(maxPendingUtterances) || maxPendingUtterances <= 0) throw new Error("Translation limit must be a positive integer");
  const selected = { ...identity }; const pair = { ...languages };
  const store = createRevisionStore(selected, maxStoredCaptions);
  // Validate every ASR correction, but keep an incremental translator's active
  // source published until its Korean stream has had a chance to paint.
  const inputs = translator.streaming ? createRevisionStore(selected, maxStoredCaptions) : store;
  const pending = new Map<string, TranscriptRevision>();
  let active: TranscriptRevision | undefined;
  let activeRetired = false;
  let translationRevision = 0;
  let stopped = false;
  const waiters = new Set<() => void>();

  function settled() {
    if (!stopped && (active || pending.size)) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  function reuseTranslation(source: TranscriptRevision, previous: CaptionRevision | undefined) {
    if (!source.final || source.retracted || previous?.source.text !== source.text || previous.source.language !== source.language
      || previous.translation.state !== "paired" || !previous.translation.revision.final) return false;
    const caption = store.accept({ type: "transcript", revision: source });
    if (caption) receive(caption);
    const paired = store.accept({ type: "translation", revision: { ...previous.translation.revision,
      sourceRevision: source.sourceRevision, translationRevision: ++translationRevision } });
    if (paired) receive(paired);
    pending.delete(source.utteranceId);
    return true;
  }

  async function drain() {
    if (active || stopped) return;
    const source = [...pending.values()].find(source => source.final) ?? pending.values().next().value;
    if (!source) return;
    pending.delete(source.utteranceId); active = source; activeRetired = false;
    try {
      if (inputs !== store) {
        const caption = store.accept({ type: "transcript", revision: source });
        if (caption) receive(caption);
      }
      const requested = pair.source === "auto" ? { source: source.language, target: pair.target } : pair;
      let receivedRevision = 0;
      for await (const revision of translator.translate(source, requested)) {
        if (stopped) return;
        if (!Number.isSafeInteger(revision.translationRevision) || revision.translationRevision <= receivedRevision) continue;
        receivedRevision = revision.translationRevision;
        // Korean bypass and model chunks share one published revision sequence.
        const caption = store.accept({ type: "translation", revision: { ...revision, translationRevision: ++translationRevision } });
        if (caption) receive(caption);
      }
      const confirmed = pending.get(source.utteranceId);
      if (confirmed) reuseTranslation(confirmed, store.snapshot().find(caption => caption.source.utteranceId === source.utteranceId));
    } catch { if (!stopped) fail("engine-failed"); }
    finally { active = undefined; if (!stopped) void drain(); settled(); }
  }

  return {
    accept(source: TranscriptRevision): boolean {
      if (stopped || !sameIdentity(selected, source.identity) || (pair.source === "auto"
        ? !["en", "ja", "ko"].includes(source.language) : source.language !== pair.source) || source.text.length > 16384) return false;
      if (!source.retracted && (!source.text || fillerOnly(source.text, source.language))) {
        if (!source.final || !inputs.snapshot().some(caption => caption.source.utteranceId === source.utteranceId && !caption.source.final)) return false;
        source = { ...source, text: "", retracted: true };
      }
      const previous = store.snapshot().find(caption => caption.source.utteranceId === source.utteranceId);
      const caption = inputs.accept({ type: "transcript", revision: source });
      if (!caption) return false;
      if (reuseTranslation(caption.source, previous)) return true;
      if (active?.utteranceId === source.utteranceId && (active.language !== source.language || source.retracted)) activeRetired = true;
      const pinned = inputs !== store && !activeRetired && active?.utteranceId === source.utteranceId
        && active.language === source.language && source.language !== pair.target && !source.retracted;
      if (!pinned) {
        const published = inputs === store ? caption : store.accept({ type: "transcript", revision: caption.source });
        if (published) receive(published);
      }
      if (source.retracted) {
        pending.delete(source.utteranceId);
        settled();
        return true;
      }
      if (source.language === pair.target) {
        pending.delete(source.utteranceId);
        const paired = store.accept({ type: "translation", revision: { identity: source.identity, utteranceId: source.utteranceId,
          sourceRevision: source.sourceRevision, translationRevision: ++translationRevision,
          languages: { source: source.language, target: pair.target }, text: source.text, final: source.final } });
        if (paired) receive(paired);
        return true;
      }
      // An active revision and its queued replacement are one utterance. Count
      // unique IDs so a final can replace an active partial even at the limit.
      const utterances = new Set(pending.keys());
      if (active) utterances.add(active.utteranceId);
      if (!utterances.has(source.utteranceId) && utterances.size >= maxPendingUtterances) {
        const provisional = [...pending.values()].find(job => !job.final && job.utteranceId !== active?.utteranceId);
        if (provisional) pending.delete(provisional.utteranceId);
        else { fail("overloaded"); return false; }
      }
      pending.set(source.utteranceId, caption.source);
      void drain();
      return true;
    },
    snapshot: () => store.snapshot(),
    // Input EOF must drain accepted translations before its engine stream ends.
    whenIdle(): Promise<void> {
      if (stopped || (!active && !pending.size)) return Promise.resolve();
      return new Promise(resolve => { waiters.add(resolve); });
    },
    async cancel() {
      if (stopped) return;
      stopped = true; pending.clear();
      settled();
      await translator.cancel(selected);
    },
  };
}
