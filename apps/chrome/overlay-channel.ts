import type { CaptionRevision, MediaTarget, SessionIdentity } from "../../packages/contracts";
import { sameIdentity } from "../../packages/core/identity";
import { createVideoOverlay, type SelectedVideoOutput } from "./overlay";

export const overlayChannelName = "interpreter-selected-overlay-v1";
export const tabOverlayChannelName = "interpreter-tab-overlay-v1";
const maxWireChars = 32768;
// A native callback can emit sixteen sources and their sixteen translations.
const maxPending = 32;
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max = 256): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function identity(value: unknown): value is SessionIdentity { return record(value) && text(value.sessionId) && text(value.targetId) && integer(value.epoch); }
function target(value: unknown, tab: boolean): value is MediaTarget {
  return record(value) && text(value.id) && text(value.documentId) && (tab
    ? value.frameId === "tab" && value.scope === "tab-mix" && integer(value.tabId) && value.tabId > 0
    : value.frameId === "0");
}
function range(value: unknown): boolean { return record(value) && typeof value.startMs === "number" && Number.isFinite(value.startMs) && value.startMs >= 0
  && typeof value.endMs === "number" && Number.isFinite(value.endMs) && value.endMs >= value.startMs; }
function envelope(value: unknown): value is RecordValue & { sequence: number } { return record(value) && value.version === 1 && integer(value.sequence) && JSON.stringify(value).length <= maxWireChars; }
function caption(value: unknown): value is CaptionRevision {
  if (!record(value) || !record(value.source) || !record(value.translation)) return false;
  const source = value.source;
  if (!identity(source.identity) || !text(source.utteranceId) || !integer(source.sourceRevision) || source.sourceRevision === 0
    || (source.retracted === undefined ? !text(source.text, 12000) : source.retracted !== true || source.text !== "" || source.final !== true)
    || typeof source.final !== "boolean" || !["ja", "en", "ko"].includes(String(source.language))
    || source.speakerId !== undefined && (!integer(source.speakerId) || source.speakerId < 1 || source.speakerId > 8)
    || !range(source.audioRange) || (value.videoRange !== undefined && !range(value.videoRange))) return false;
  if (value.translation.state === "pending") return true;
  if (source.retracted) return false;
  const translation = value.translation.revision;
  return value.translation.state === "paired" && record(translation) && identity(translation.identity)
    && sameIdentity(source.identity, translation.identity) && translation.utteranceId === source.utteranceId
    && translation.sourceRevision === source.sourceRevision && integer(translation.translationRevision) && translation.translationRevision > 0
    && record(translation.languages) && translation.languages.source === source.language && ["ko", "en", "ja"].includes(String(translation.languages.target))
    && text(translation.text, 12000) && typeof translation.final === "boolean";
}

export function createRemoteVideoOutput(port: chrome.runtime.Port, unavailable: (message: string) => void) {
  let sequence = 0;
  let disposed = false;
  let selected: SessionIdentity | undefined;
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  function dispose() {
    if (disposed) return; disposed = true; selected = undefined;
    for (const timer of pending.values()) clearTimeout(timer); pending.clear();
    port.onMessage.removeListener(receive); port.onDisconnect.removeListener(disconnected); port.disconnect();
  }
  function fail(message: string) { if (!disposed) { dispose(); unavailable(message); } }
  function disconnected() { fail("context-destroyed: Page overlay disconnected. Reopen Jamak."); }
  function receive(value: unknown) {
    if (!envelope(value) || value.type !== "ack" || !pending.has(value.sequence)) { fail("engine-failed: Invalid overlay acknowledgement"); return; }
    clearTimeout(pending.get(value.sequence)); pending.delete(value.sequence);
  }
  function send(fields: RecordValue) {
    if (disposed) return;
    const message = { version: 1, sequence: sequence++, ...fields };
    if (JSON.stringify(message).length > maxWireChars || pending.size >= maxPending) { fail("overloaded: Page overlay exceeded its bounded channel"); return; }
    pending.set(message.sequence, setTimeout(() => fail("context-destroyed: Overlay acknowledgement timed out after 1000 ms"), 1000));
    try { port.postMessage(message); } catch { disconnected(); }
  }
  port.onMessage.addListener(receive); port.onDisconnect.addListener(disconnected);
  const output: SelectedVideoOutput = {
    activate(target, current) { selected = { ...current }; send({ type: "activate", target, identity: current }); },
    compare(value) { if (selected && sameIdentity(selected, value.source.identity)) send({ type: "caption", caption: value }); },
    clear(current) { if (!selected || !sameIdentity(selected, current)) return; selected = undefined; send({ type: "clear", identity: current }); },
  };
  return { ...output, dispose };
}

export function serveVideoOutput(port: chrome.runtime.Port,
  catalog: { resolve(target: MediaTarget): HTMLVideoElement | undefined; subscribe(listener: () => void): () => void } | undefined, document?: Document) {
  let next = 0;
  let disposed = false;
  let selected: { target: MediaTarget; identity: SessionIdentity } | undefined;
  let overlay: ReturnType<typeof createVideoOverlay> | undefined;
  function clear() { overlay?.dispose(); overlay = undefined; selected = undefined; }
  function dispose() { if (disposed) return; disposed = true; clear(); unsubscribe();
    port.onMessage.removeListener(receive); port.onDisconnect.removeListener(dispose); port.disconnect(); }
  const unsubscribe = catalog?.subscribe(() => { if (selected && !catalog.resolve(selected.target)) dispose(); }) ?? (() => {});
  function receive(value: unknown) {
    if (!envelope(value) || value.sequence !== next++) { dispose(); return; }
    if (value.type === "activate") {
      const selectedTarget = value.target;
      if (!target(selectedTarget, !catalog) || !identity(value.identity)
        || selectedTarget.id !== value.identity.targetId) { dispose(); return; }
      const video = catalog?.resolve(selectedTarget);
      const ownerDocument = video?.ownerDocument ?? document;
      if ((catalog && !video) || !ownerDocument) { dispose(); return; }
      clear(); selected = { target: selectedTarget, identity: value.identity };
      overlay = createVideoOverlay(ownerDocument, video ?? null, value.identity);
    } else if (value.type === "caption") {
      if (!caption(value.caption) || (!catalog && value.caption.videoRange !== undefined)) { dispose(); return; }
      if (selected && sameIdentity(selected.identity, value.caption.source.identity)) overlay?.compare(value.caption);
    } else if (value.type === "clear") {
      if (!identity(value.identity)) { dispose(); return; }
      if (selected && sameIdentity(selected.identity, value.identity)) clear();
    } else { dispose(); return; }
    if (!disposed) port.postMessage({ version: 1, type: "ack", sequence: value.sequence });
  }
  port.onMessage.addListener(receive); port.onDisconnect.addListener(dispose);
  return { dispose };
}
