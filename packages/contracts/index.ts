// Internal media and caption protocol.
export const FRAMEWORK_VERSION = 1;

declare const mediaTargetId: unique symbol;

// Only a media adapter issues this ID; elements and URLs never cross this port.
export type MediaTargetId = string & { readonly [mediaTargetId]: true };

export interface MediaTarget {
  readonly id: MediaTargetId;
  readonly documentId: string;
  readonly frameId: string;
}

export interface SessionIdentity {
  readonly sessionId: string;
  readonly targetId: MediaTargetId;
  readonly epoch: number;
}

export interface AudioRange {
  // Milliseconds from the start of this epoch's audio, not wall-clock time.
  readonly startMs: number;
  readonly endMs: number;
}

export interface PlaybackAnchor {
  // Monotonic values may be compared only within the same clockId.
  readonly clockId: string;
  readonly monotonicMs: number;
  readonly mediaTimeMs: number;
  readonly playbackRate: number;
}

export interface AudioChunk {
  readonly identity: SessionIdentity;
  // Legacy tab capture must never masquerade as selected-element samples.
  readonly scope: "selected-video" | "tab-mix";
  readonly sequence: number;
  readonly audioRange: AudioRange;
  readonly capture: { readonly clockId: string; readonly startMs: number; readonly endMs: number };
  readonly sampleRate: number;
  readonly channels: number;
  readonly sampleFormat: "pcm-s16le" | "pcm-f32le";
  // Ownership transfers to the receiver; limits are validated by the transport.
  readonly pcm: ArrayBuffer;
}

export interface PlaybackEvent {
  readonly identity: SessionIdentity;
  readonly sequence: number;
  readonly type: "play" | "pause" | "seek" | "rate" | "source" | "end";
  readonly anchor: PlaybackAnchor;
}

export interface TranscriptRevision {
  readonly identity: SessionIdentity;
  readonly utteranceId: string;
  readonly sourceRevision: number;
  readonly text: string;
  readonly final: boolean;
  // A final, empty revision withdraws a hypothesis removed by recognition.
  readonly retracted?: true;
  readonly audioRange: AudioRange;
  readonly language: string;
  readonly speakerId?: number;
  readonly confidence?: { readonly measure: string; readonly value: number };
}

export interface LanguagePair {
  readonly source: string;
  readonly target: string;
}

export interface TranslationRevision {
  readonly identity: SessionIdentity;
  readonly utteranceId: string;
  // The exact source revision translated, independent of translationRevision.
  readonly sourceRevision: number;
  readonly translationRevision: number;
  readonly languages: LanguagePair;
  readonly text: string;
  // Generation is complete for this source revision; recognition can still revise it.
  readonly final: boolean;
}

export interface CaptionRevision {
  readonly source: TranscriptRevision;
  // A newer source is pending until its matching translation is accepted.
  readonly translation:
    | { readonly state: "pending" }
    | { readonly state: "paired"; readonly revision: TranslationRevision };
  readonly videoRange?: AudioRange;
}

export type ReasonCode =
  | "media-access-denied" | "protected-media" | "frame-permission-required"
  | "media-route-unknown" | "target-invalidated" | "permission-required"
  | "execution-context-unavailable" | "context-destroyed" | "suspended"
  | "language-pair-unsupported" | "model-unverified" | "download-required"
  | "model-load-failed" | "storage-insufficient" | "offline-model-unavailable"
  | "gpu-lost" | "overloaded" | "audio-gap" | "engine-failed" | "cancelled";

export type Capability =
  | { readonly state: "available" }
  | {
    readonly state: "download-required" | "permission-required" | "unavailable" | "unverified";
    readonly reason: ReasonCode;
    readonly message: string;
  };

export interface ModelIdentity {
  readonly id: string;
  readonly version: string;
}

export interface ModelStatus {
  readonly model: ModelIdentity;
  readonly state: "absent" | "cached" | "downloading" | "loading" | "ready" | "failed" | "evicted";
  readonly requiredBytes: number;
  readonly downloadedBytes?: number;
  readonly reason?: ReasonCode;
}

export interface RuntimeLimits {
  readonly maxChunkBytes: number;
  readonly maxAudioQueueMs: number;
  readonly maxPendingUtterances: number;
  readonly maxTranslationJobs: number;
  readonly maxStoredCaptions: number;
}

export interface EngineCapabilities {
  readonly availability: Capability;
  readonly pipeline: "combined-interpretation" | "separate-asr-translation";
  readonly asrOnlyUpdates: boolean;
  readonly languages: LanguagePair;
  readonly models: readonly ModelIdentity[];
  readonly limits: RuntimeLimits;
}

export interface SessionStatus {
  readonly identity: SessionIdentity;
  readonly state: "idle" | "probing" | "unavailable" | "preparing" | "running" | "paused" | "stopping" | "failed";
  readonly message: string;
  readonly reason?: ReasonCode;
  readonly preparation?: readonly ModelStatus[];
  readonly queue?: { readonly pendingAudioMs: number; readonly droppedAudioMs: number };
}

export type InterpretationEvent =
  | { readonly type: "speaker"; readonly identity: SessionIdentity; readonly utteranceId: string; readonly speakerId: number }
  | { readonly type: "transcript"; readonly revision: TranscriptRevision }
  | { readonly type: "translation"; readonly revision: TranslationRevision }
  // Companion pairs are accepted atomically, never fabricated ASR-only updates.
  | { readonly type: "paired-caption"; readonly caption: CaptionRevision }
  | { readonly type: "status"; readonly status: SessionStatus };

export type PresentationEvent =
  | { readonly type: "insert" | "update"; readonly caption: CaptionRevision }
  | { readonly type: "replay"; readonly caption: CaptionRevision; readonly partIndex: number }
  | { readonly type: "fade"; readonly identity: SessionIdentity; readonly utteranceId: string; readonly durationMs: number }
  | { readonly type: "remove"; readonly identity: SessionIdentity; readonly utteranceId: string }
  | { readonly type: "clear"; readonly identity: SessionIdentity };

export interface DisplayProgress {
  readonly identity: SessionIdentity;
  readonly utteranceId: string;
  readonly sourceRevision: number;
  // Absent when the renderer displays original speech with translation pending.
  readonly translationRevision?: number;
  readonly partIndex: number;
  readonly complete: boolean;
  // Measured by the renderer; core never estimates line fitting.
  readonly visible: boolean;
  readonly characterCount: number;
  readonly displayedText?: string;
}

export type FrameworkMessage =
  | { readonly type: "audio"; readonly chunk: AudioChunk }
  | { readonly type: "playback"; readonly event: PlaybackEvent }
  | InterpretationEvent
  | { readonly type: "presentation"; readonly event: PresentationEvent }
  | { readonly type: "display-progress"; readonly progress: DisplayProgress };

// Each host validates unknown input and declared limits before constructing this.
export interface FrameworkEnvelope {
  readonly version: typeof FRAMEWORK_VERSION;
  readonly message: FrameworkMessage;
}

export interface MediaCandidate {
  readonly target: MediaTarget;
  readonly label: string;
  readonly visible: boolean;
  readonly playing: boolean;
  readonly width: number;
  readonly height: number;
}

export interface MediaCatalog {
  discover(): Promise<readonly MediaCandidate[]>;
  isCurrent(target: MediaTarget): Promise<boolean>;
}

export interface VideoInput {
  probe(target: MediaTarget): Promise<Capability>;
  // open follows user activation. close releases only session-owned work.
  open(target: MediaTarget, identity: SessionIdentity): Promise<{
    readonly events: AsyncIterable<AudioChunk | PlaybackEvent>;
    close(): Promise<void>;
  }>;
}

export interface InterpretationEngine {
  probe(languages: LanguagePair): Promise<EngineCapabilities>;
  prepare(identity: SessionIdentity, languages: LanguagePair): Promise<void>;
  run(audio: AsyncIterable<AudioChunk>): AsyncIterable<InterpretationEvent>;
  cancel(identity: SessionIdentity): Promise<void>;
  close(): Promise<void>;
}

export interface SpeechRecognizer {
  run(audio: AsyncIterable<AudioChunk>): AsyncIterable<TranscriptRevision>;
  cancel(identity: SessionIdentity): Promise<void>;
  close(): Promise<void>;
}

export interface TextTranslator {
  readonly streaming?: boolean;
  translate(source: TranscriptRevision, languages: LanguagePair): AsyncIterable<TranslationRevision>;
  cancel(identity: SessionIdentity): Promise<void>;
  close(): Promise<void>;
}

export interface ModelRepository {
  status(model: ModelIdentity): Promise<ModelStatus>;
  prepare(model: ModelIdentity): AsyncIterable<ModelStatus>;
  cancel(model: ModelIdentity): Promise<void>;
  evict(model: ModelIdentity): Promise<void>;
}

export interface OutputSink {
  present(event: PresentationEvent): void;
  status(status: SessionStatus): void;
  // Renderer measures/fits lines and reports final replay progress to core.
  onDisplayProgress(receive: (progress: DisplayProgress) => void): () => void;
  dispose(): void;
}
