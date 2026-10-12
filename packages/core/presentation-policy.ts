import type { CaptionRevision, DisplayProgress, InterpretationEvent, PresentationEvent, SessionIdentity } from "../contracts";
import { sameIdentity } from "./identity";
import { createRevisionStore } from "./revision-store";

export const captionHistoryLimit = 300;

interface PresentationClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

function finalPair(caption: CaptionRevision): boolean {
  return caption.source.final && caption.translation.state === "paired" && caption.translation.revision.final;
}

export function createPresentationPolicy(initial: SessionIdentity, clock: PresentationClock, present: (event: PresentationEvent) => void, draftUpdateMs = 1000) {
  type Entry = {
    caption: CaptionRevision;
    pending?: CaptionRevision;
    correctionPending: boolean;
    updatedAt: number;
    partIndex: number;
    progress?: DisplayProgress;
    until?: number;
    readingStartedAt?: number;
    fading: boolean;
    retired: boolean;
  };
  let identity = initial;
  let store = createRevisionStore(identity, captionHistoryLimit);
  const entries = new Map<string, Entry>();
  let cancelTimer: (() => void) | undefined;
  let disposed = false;

  function visibleEntries(): Entry[] {
    return [...entries.values()].filter((entry) => !entry.retired && entry.progress?.visible
      && entry.progress.sourceRevision === entry.caption.source.sourceRevision
      && entry.progress.translationRevision === (entry.caption.translation.state === "paired" ? entry.caption.translation.revision.translationRevision : undefined));
  }

  function visibleFront(): Entry | undefined { return visibleEntries()[0]; }

  function canExpire(entry: Entry): boolean {
    return entry.fading || !entry.progress?.complete
      || finalPair(entry.caption) && !entry.correctionPending && !entry.pending;
  }

  function schedule(): void {
    cancelTimer?.();
    cancelTimer = undefined;
    if (disposed) return;
    const deadlines = [...entries.values()].filter((entry) => entry.pending && !entry.retired && !entry.fading)
      .map((entry) => entry.updatedAt + draftUpdateMs);
    const front = visibleFront();
    if (front?.until !== undefined && canExpire(front)) deadlines.push(front.until);
    for (const entry of visibleEntries()) {
      if (entry !== front && !entry.retired && !entry.fading && entry.progress?.visible && !entry.progress.complete
        && entry.until !== undefined) deadlines.push(entry.until);
    }
    if (deadlines.length) cancelTimer = clock.schedule(tick, Math.max(1, Math.min(...deadlines) - clock.now()));
  }

  function retire(entry: Entry): void {
    entry.retired = true;
    entry.pending = undefined;
    entry.until = undefined;
    present({ type: "remove", identity, utteranceId: entry.caption.source.utteranceId });
  }

  function paint(entry: Entry, caption: CaptionRevision, first: boolean): void {
    const finalized = finalPair(caption) && (!finalPair(entry.caption) || entry.correctionPending);
    const changedState = entry.caption.translation.state !== caption.translation.state;
    entry.caption = caption;
    entry.pending = undefined;
    entry.correctionPending = false;
    entry.updatedAt = clock.now();
    // Finalizing or extending an utterance must not replay its already read prefix.
    if (changedState || entry.progress?.displayedText === undefined) { entry.progress = undefined; entry.until = undefined; }
    if (changedState) entry.partIndex = 0;
    if (finalized && entry.until !== undefined) entry.until = Math.max(entry.until, clock.now() + 4000);
    present({ type: first ? "insert" : "update", caption });
  }

  function tick(): void {
    cancelTimer = undefined;
    if (disposed) return;
    const now = clock.now();
    for (const entry of entries.values()) {
      if (entry.pending && !entry.retired && !entry.fading && entry.updatedAt + draftUpdateMs <= now) paint(entry, entry.pending, false);
    }
    // Visible rows read concurrently; long rows advance their own parts.
    for (const entry of visibleEntries()) {
      if (!entry.retired && !entry.fading && entry.progress?.visible && !entry.progress.complete && entry.until !== undefined && entry.until <= now) {
        entry.partIndex++; entry.progress = undefined; entry.until = undefined;
        present({ type: "replay", caption: entry.caption, partIndex: entry.partIndex });
      }
    }
    // Completed rows leave in insertion order without restarting the next clock.
    let front = visibleFront();
    while (front?.until !== undefined && front.until <= now && canExpire(front)) {
      if (front.fading) {
        retire(front);
        front = visibleFront();
        continue;
      }
      if (front.progress?.complete) {
        front.fading = true;
        front.pending = undefined;
        front.until = now + 250;
        present({ type: "fade", identity, utteranceId: front.caption.source.utteranceId, durationMs: 250 });
      } else {
        front.partIndex++;
        front.progress = undefined;
        front.until = undefined;
        present({ type: "replay", caption: front.caption, partIndex: front.partIndex });
      }
      break;
    }
    schedule();
  }

  return {
    accept(event: InterpretationEvent, videoRange?: CaptionRevision["videoRange"]): CaptionRevision | undefined {
      if (disposed) return undefined;
      const caption = store.accept(event, videoRange);
      if (!caption) return undefined;
      if (caption.source.retracted) {
        const entry = entries.get(caption.source.utteranceId);
        if (entry && !entry.retired) retire(entry);
        entries.delete(caption.source.utteranceId);
        schedule();
        return caption;
      }
      // The comparison history is independent of overlay retirement and cadence.
      const retained = new Set(store.snapshot().filter((item) => sameIdentity(item.source.identity, identity)).map((item) => item.source.utteranceId));
      for (const [id, entry] of entries) {
        if (!retained.has(id)) { if (!entry.retired) retire(entry); entries.delete(id); }
      }
      const id = caption.source.utteranceId;
      let entry = entries.get(id);
      if (entry?.retired || entry?.fading) return caption;
      if (entry && caption.translation.state === "pending" && entry.caption.translation.state === "paired") {
        // History records the new source immediately; keep the last displayed
        // pair and its reading clock until a matching translation arrives,
        // but do not expire that pair while the correction is pending.
        entry.pending = undefined;
        entry.correctionPending = true;
        schedule();
        return caption;
      }
      if (!entry) {
        entry = { caption, correctionPending: false, updatedAt: clock.now(), partIndex: 0, fading: false, retired: false };
        entries.set(id, entry);
        paint(entry, caption, true);
      } else {
        const immediate = event.type === "speaker" || caption.source.speakerId !== entry.caption.source.speakerId || finalPair(caption)
          || caption.translation.state === "paired" && caption.translation.revision.final
          || (caption.source.final && caption.source.sourceRevision !== entry.caption.source.sourceRevision)
          || (entry.caption.translation.state === "pending" && caption.translation.state === "paired");
        if (!immediate && clock.now() - entry.updatedAt < draftUpdateMs) entry.pending = caption;
        else paint(entry, caption, false);
      }
      schedule();
      return caption;
    },
    progress(progress: DisplayProgress): void {
      if (disposed || !sameIdentity(identity, progress.identity)) return;
      const entry = entries.get(progress.utteranceId);
      const translation = entry?.caption.translation;
      const translationRevision = translation?.state === "paired" ? translation.revision.translationRevision : undefined;
      if (!entry || entry.retired || entry.fading
        || progress.sourceRevision !== entry.caption.source.sourceRevision
        || progress.translationRevision !== translationRevision
        || progress.partIndex !== entry.partIndex || !Number.isSafeInteger(progress.characterCount) || progress.characterCount < 0) return;
      const old = entry.progress;
      entry.progress = { ...progress, identity: { ...progress.identity } };
      const readingMs = Math.min(6000, Math.max(finalPair(entry.caption) ? 4000 : 2500, progress.characterCount * 90));
      if (!progress.visible) { entry.until = undefined; entry.readingStartedAt = undefined; }
      else if (entry.until === undefined || !old?.visible) {
        entry.readingStartedAt = clock.now(); entry.until = clock.now() + readingMs;
      } else if (progress.characterCount > old.characterCount
        || progress.displayedText !== undefined && old.displayedText !== undefined && progress.displayedText !== old.displayedText) {
        // Drafts are read while they grow. Rewriting a draft must not restart
        // its whole reading clock on every token; completed corrections do.
        entry.until = Math.max(entry.until, (finalPair(entry.caption) ? clock.now() : entry.readingStartedAt ?? clock.now()) + readingMs);
      }
      schedule();
    },
    retire(utteranceId: string): void {
      const entry = entries.get(utteranceId);
      if (entry && !entry.retired) retire(entry);
      schedule();
    },
    clear(): void {
      if (disposed) return;
      cancelTimer?.();
      cancelTimer = undefined;
      entries.clear();
      store = createRevisionStore(identity, captionHistoryLimit);
      present({ type: "clear", identity });
    },
    activate(next: SessionIdentity): void {
      if (disposed) return;
      cancelTimer?.();
      cancelTimer = undefined;
      present({ type: "clear", identity });
      identity = next;
      entries.clear();
      store.activate(next);
    },
    snapshot(): readonly CaptionRevision[] { return store.snapshot(); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelTimer?.();
      cancelTimer = undefined;
      entries.clear();
      present({ type: "clear", identity });
    },
  };
}
