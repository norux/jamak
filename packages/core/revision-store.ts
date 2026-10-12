import type { AudioRange, CaptionRevision, InterpretationEvent, SessionIdentity, TranscriptRevision, TranslationRevision } from "../contracts";
import { sameIdentity } from "./identity";

function validSource(source: TranscriptRevision): boolean {
  return (source.retracted === undefined || source.retracted === true && source.final && source.text === "")
    && (source.speakerId === undefined || Number.isSafeInteger(source.speakerId) && source.speakerId >= 1 && source.speakerId <= 8)
    && source.utteranceId.length > 0 && Number.isSafeInteger(source.sourceRevision) && source.sourceRevision > 0
    && Number.isFinite(source.audioRange.startMs) && source.audioRange.startMs >= 0
    && Number.isFinite(source.audioRange.endMs) && source.audioRange.endMs >= source.audioRange.startMs;
}

function validTranslation(source: TranscriptRevision, translation: TranslationRevision): boolean {
  return sameIdentity(source.identity, translation.identity) && source.utteranceId === translation.utteranceId
    && source.sourceRevision === translation.sourceRevision && source.language === translation.languages.source
    && Number.isSafeInteger(translation.translationRevision) && translation.translationRevision > 0;
}

export function createRevisionStore(initial: SessionIdentity, maxStoredCaptions: number) {
  if (!Number.isSafeInteger(maxStoredCaptions) || maxStoredCaptions <= 0) throw new Error("Caption limit must be a positive integer");
  let identity = initial;
  const records = new Map<string, { caption: CaptionRevision; translationRevision: number; translationFinal: boolean; targetLanguage?: string }>();
  let retiredThroughMs = -1;

  function key(source: Pick<TranscriptRevision, "identity" | "utteranceId">): string {
    return JSON.stringify([source.identity.sessionId, source.identity.targetId, source.identity.epoch, source.utteranceId]);
  }

  function sourceAllowed(source: TranscriptRevision, previous?: CaptionRevision): boolean {
    return validSource(source) && sameIdentity(identity, source.identity)
      && (previous ? !previous.source.retracted && !(source.retracted && previous.source.final)
        && source.sourceRevision > previous.source.sourceRevision && (!previous.source.final || source.final)
        : source.audioRange.startMs > retiredThroughMs);
  }

  function translationAllowed(source: TranscriptRevision, translation: TranslationRevision): boolean {
    if (source.retracted || !validTranslation(source, translation)) return false;
    const old = records.get(key(source));
    if (!old) return true;
    return translation.translationRevision > old.translationRevision && (!old.translationFinal || translation.final)
      && (old.targetLanguage === undefined || translation.languages.target === old.targetLanguage);
  }

  function save(caption: CaptionRevision): CaptionRevision {
    // Keep owned snapshots: callers and adapters must not mutate accepted history.
    const stored: CaptionRevision = {
      source: { ...caption.source, identity: { ...caption.source.identity }, audioRange: { ...caption.source.audioRange },
        ...(caption.source.confidence ? { confidence: { ...caption.source.confidence } } : {}) },
      translation: caption.translation.state === "pending" ? { state: "pending" } : {
        state: "paired", revision: { ...caption.translation.revision, identity: { ...caption.translation.revision.identity }, languages: { ...caption.translation.revision.languages } },
      },
      ...(caption.videoRange ? { videoRange: { ...caption.videoRange } } : {}),
    };
    const old = records.get(key(stored.source));
    const translation = stored.translation.state === "paired" ? stored.translation.revision : undefined;
    records.set(key(stored.source), { caption: stored,
      translationRevision: translation?.translationRevision ?? old?.translationRevision ?? 0,
      translationFinal: translation?.final ?? false,
      targetLanguage: translation?.languages.target ?? old?.targetLanguage });
    if (records.size > maxStoredCaptions) {
      const oldest = records.entries().next().value;
      if (oldest) {
        if (sameIdentity(oldest[1].caption.source.identity, identity)) retiredThroughMs = Math.max(retiredThroughMs, oldest[1].caption.source.audioRange.startMs);
        records.delete(oldest[0]);
      }
    }
    return stored;
  }

  return {
    activate(next: SessionIdentity): void {
      identity = next;
      retiredThroughMs = -1;
    },
    snapshot(): readonly CaptionRevision[] { return [...records.values()].map((record) => record.caption).filter(caption => !caption.source.retracted); },
    accept(event: InterpretationEvent, videoRange?: AudioRange): CaptionRevision | undefined {
      if (event.type === "status") return undefined;
      if (event.type === "speaker") {
        if (!sameIdentity(identity, event.identity) || !Number.isSafeInteger(event.speakerId) || event.speakerId < 1 || event.speakerId > 8) return undefined;
        const previous = records.get(key(event))?.caption;
        if (!previous || previous.source.retracted || previous.source.speakerId === event.speakerId) return undefined;
        return save({ ...previous, source: { ...previous.source, speakerId: event.speakerId } });
      }
      if (event.type === "translation") {
        const translation = event.revision;
        if (!sameIdentity(identity, translation.identity)) return undefined;
        const previous = records.get(key(translation))?.caption;
        if (!previous || !translationAllowed(previous.source, translation)) return undefined;
        return save({ ...previous, translation: { state: "paired", revision: translation } });
      }
      const source = event.type === "transcript" ? event.revision : event.caption.source;
      const previous = records.get(key(source))?.caption;
      if (event.type === "paired-caption") {
        if (event.caption.translation.state !== "paired") return undefined;
        const translation = event.caption.translation.revision;
        const sameSource = previous && source.sourceRevision === previous.source.sourceRevision
          && source.text === previous.source.text && source.final === previous.source.final
          && source.language === previous.source.language && source.audioRange.startMs === previous.source.audioRange.startMs
          && source.audioRange.endMs === previous.source.audioRange.endMs;
        if (sameSource && sameIdentity(identity, source.identity) && source.speakerId !== undefined && source.speakerId !== previous.source.speakerId
          && Number.isSafeInteger(source.speakerId) && source.speakerId > 0 && source.speakerId <= 8
          && previous.translation.state === "paired" && translation.translationRevision === previous.translation.revision.translationRevision
          && translation.text === previous.translation.revision.text && translation.final === previous.translation.revision.final
          && validTranslation(source, translation) && translation.languages.target === previous.translation.revision.languages.target) {
          return save({ ...previous, source: { ...previous.source, speakerId: source.speakerId } });
        }
        if (!sameIdentity(identity, source.identity) || (!sameSource && !sourceAllowed(source, previous))
          || !translationAllowed(source, translation)) return undefined;
        return save({ source, translation: { state: "paired", revision: translation }, videoRange: videoRange ?? previous?.videoRange });
      }
      if (!sourceAllowed(source, previous)) return undefined;
      return save({ source: { ...source, speakerId: source.speakerId ?? previous?.source.speakerId }, translation: { state: "pending" }, videoRange });
    },
  };
}
