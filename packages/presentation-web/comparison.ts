import type { CaptionRevision, DisplayProgress, OutputSink, PresentationEvent, SessionIdentity } from "../contracts";
import { sameIdentity } from "../core/identity";
import { captionHistoryLimit } from "../core/presentation-policy";

export function createComparisonView(container: HTMLElement, timeBasis: "video" | "capture" = "video") {
  const document = container.ownerDocument;
  const window = document.defaultView;
  if (!window) throw new Error("Comparison view requires a live document");
  const host = document.createElement("section");
  host.setAttribute("aria-label", "Jamak captions");
  const style = document.createElement("style");
  style.textContent = `
    .interpreter-stack { max-height:min(45vh,var(--interpreter-stack-height,320px)); overflow:hidden; }
    .interpreter-live { position:relative; padding:8px; min-height:3.2em; font:18px/1.5 system-ui;
      white-space:pre-wrap; overflow-wrap:anywhere; transition:opacity 250ms ease-out; }
    .interpreter-measure { position:absolute; visibility:hidden; left:8px; right:8px; }
    .interpreter-comparison { width:100%; table-layout:fixed; border-collapse:collapse; }
    .interpreter-comparison th, .interpreter-comparison td { padding:8px; vertical-align:top;
      text-align:start; white-space:pre-wrap; overflow-wrap:anywhere; }
    .interpreter-comparison th:nth-child(2) { width:6em; }
  `;
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const stack = document.createElement("div"); stack.className = "interpreter-stack"; stack.setAttribute("aria-live", "polite");
  const table = document.createElement("table"); table.className = "interpreter-comparison";
  const head = document.createElement("thead"); const headings = document.createElement("tr");
  for (const label of ["Original", timeBasis === "capture" ? "Capture elapsed" : "Video time", "Korean"]) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = label; headings.append(cell); }
  head.append(headings); const body = document.createElement("tbody"); table.append(head, body);
  host.append(style, status, stack, table); container.append(host);
  const rows = new Map<string, HTMLTableRowElement>();
  const listeners = new Set<(progress: DisplayProgress) => void>();
  const entries: { caption: CaptionRevision; offset: number; end: number; partIndex: number; fading: boolean; displayedText: string;
    translationSource?: { revision: number; language: string }; replacementText?: string; holdingTranslation: boolean;
    cue: HTMLDivElement; text: HTMLSpanElement; content: Text; measure: HTMLSpanElement }[] = [];
  let identity: SessionIdentity | undefined;
  let disposed = false;

  function key(caption: CaptionRevision) {
    const source = caption.source;
    return JSON.stringify([source.identity.sessionId, source.identity.targetId, source.identity.epoch, source.utteranceId]);
  }
  function layout() {
    if (disposed) return;
    for (const entry of entries) {
      const { cue, content, measure } = entry;
      cue.style.opacity = entry.fading ? "0" : "1";
      const characters = Array.from(entry.displayedText.trim());
      let low = Math.min(entry.offset + 1, characters.length); let high = characters.length;
      const lineHeight = Number.parseFloat(window?.getComputedStyle(cue).lineHeight ?? "27");
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        measure.textContent = characters.slice(entry.offset, middle).join("");
        if (measure.getBoundingClientRect().height <= lineHeight * 2 + 1) low = middle;
        else high = middle - 1;
      }
      cue.dataset.speakerId = String(entry.caption.source.speakerId ?? "");
      cue.dataset.utteranceId = entry.caption.source.utteranceId;
      entry.end = low;
      const displayedText = characters.slice(entry.offset, low).join("");
      if (content.data !== displayedText) {
        const previous = content.data;
        let prefix = 0;
        while (prefix < previous.length && prefix < displayedText.length && previous[prefix] === displayedText[prefix]) prefix++;
        let suffix = 0;
        while (suffix < previous.length - prefix && suffix < displayedText.length - prefix
          && previous[previous.length - suffix - 1] === displayedText[displayedText.length - suffix - 1]) suffix++;
        content.replaceData(prefix, previous.length - prefix - suffix, displayedText.slice(prefix, displayedText.length - suffix));
      }
      measure.textContent = "";
    }
    const bounds = stack.getBoundingClientRect();
    for (const entry of entries) {
      const rect = entry.cue.getBoundingClientRect();
      const fits = rect.width > 0 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
      entry.cue.style.visibility = fits ? "" : "hidden";
      const translation = entry.caption.translation;
      const displayedText = entry.text.textContent ?? "";
      const progress: DisplayProgress = { identity: entry.caption.source.identity, utteranceId: entry.caption.source.utteranceId,
        sourceRevision: entry.caption.source.sourceRevision, translationRevision: translation.state === "paired" ? translation.revision.translationRevision : undefined,
        partIndex: entry.partIndex, complete: entry.end >= Array.from(entry.displayedText.trim()).length,
        displayedText: fits ? displayedText : "",
        visible: fits && !entry.holdingTranslation, characterCount: fits ? Array.from(displayedText).length : 0 };
      for (const listener of listeners) listener(progress);
    }
  }
  const observer = new window.ResizeObserver(layout); observer.observe(stack);
  const sink: OutputSink = {
    present(event: PresentationEvent) {
      const current = "caption" in event ? event.caption.source.identity : event.identity;
      if (disposed || !identity || !sameIdentity(identity, current)) return;
      if (event.type === "clear") { entries.length = 0; stack.replaceChildren(); layout(); return; }
      if (event.type === "fade" || event.type === "remove") {
        const index = entries.findIndex(entry => entry.caption.source.utteranceId === event.utteranceId);
        if (index < 0) return;
        if (event.type === "fade") { entries[index].fading = true; entries[index].cue.style.transitionDuration = `${event.durationMs}ms`; }
        else { entries[index].cue.remove(); entries.splice(index, 1); }
        layout(); return;
      }
      let entry = entries.find(entry => entry.caption.source.utteranceId === event.caption.source.utteranceId);
      if (!entry) {
        const cue = document.createElement("div"); cue.className = "interpreter-live";
        const text = document.createElement("span");
        const content = document.createTextNode(""); text.append(content);
        const measure = document.createElement("span"); measure.className = "interpreter-measure"; measure.setAttribute("aria-hidden", "true");
        cue.append(text, measure); stack.append(cue);
        entry = { caption: event.caption, offset: 0, end: 0, partIndex: 0, fading: false,
          displayedText: event.caption.source.text, holdingTranslation: false, cue, text, content, measure }; entries.push(entry);
      }
      const previousText = entry.displayedText;
      const previousTranslation = entry.translationSource;
      const holdingTranslation = event.caption.translation.state === "pending"
        && (entry.caption.translation.state === "paired" || entry.holdingTranslation);
      // Keep the last translation on screen while the corrected pair is pending.
      if (event.caption.translation.state === "paired") {
        const source = event.caption.source; const translation = event.caption.translation.revision;
        if (previousTranslation && previousTranslation.revision !== source.sourceRevision) {
          entry.replacementText = previousTranslation.language === source.language && source.language !== translation.languages.target
            ? previousText : undefined;
        }
        entry.translationSource = { revision: source.sourceRevision, language: source.language };
        // Regeneration starts at the beginning. Keep the old sentence until
        // the new stream can extend it verbatim or supplies its complete correction.
        if (!entry.replacementText || translation.final || translation.text.startsWith(entry.replacementText)) entry.displayedText = translation.text;
        if (translation.final) entry.replacementText = undefined;
      } else if (!holdingTranslation) entry.displayedText = event.caption.source.text;
      entry.holdingTranslation = holdingTranslation;
      // Source and translated text have independent layout offsets.
      if (!holdingTranslation && !previousTranslation && entry.caption.translation.state !== event.caption.translation.state) {
        entry.offset = 0; entry.end = 0; entry.partIndex = 0;
      }
      if (event.type === "update" && entry.offset && !holdingTranslation && entry.displayedText !== previousText) {
        const previous = Array.from(previousText.trim());
        const next = Array.from(entry.displayedText.trim());
        let prefix = 0;
        while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++;
        let suffix = 0;
        while (suffix < previous.length - prefix && suffix < next.length - prefix
          && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
        if (entry.offset >= previous.length - suffix) entry.offset += next.length - previous.length;
        else if (entry.offset > prefix) entry.offset = prefix;
        entry.offset = Math.max(0, Math.min(entry.offset, next.length));
      }
      if (event.type === "replay") { entry.offset = event.partIndex === 0 ? 0 : entry.end; entry.partIndex = event.partIndex; }
      entry.caption = event.caption;
      layout();
    },
    status(value) { if (!disposed) { status.textContent = `${value.state}: ${value.reason ?? value.message}`; status.dataset.state = value.state;
      status.dataset.pendingAudioMs = value.queue ? `${value.queue.pendingAudioMs}` : "";
      status.dataset.droppedAudioMs = value.queue ? `${value.queue.droppedAudioMs}` : ""; } },
    onDisplayProgress(receive) { listeners.add(receive); return () => { listeners.delete(receive); }; },
    dispose() { if (disposed) return; disposed = true; observer.disconnect(); listeners.clear(); rows.clear(); entries.length = 0; host.remove(); },
  };
  return {
    ...sink,
    activate(selected: SessionIdentity) { entries.length = 0; stack.replaceChildren(); identity = { ...selected }; layout(); },
    compare(caption: CaptionRevision) {
      if (disposed || !identity || !sameIdentity(identity, caption.source.identity)) return;
      const id = key(caption); let row = rows.get(id);
      if (caption.source.retracted) { row?.remove(); rows.delete(id); return; }
      if (!row) {
        row = document.createElement("tr"); for (let i = 0; i < 3; i++) row.append(document.createElement("td"));
        rows.set(id, row); body.append(row);
      }
      row.dataset.utteranceId = caption.source.utteranceId; row.dataset.epoch = `${caption.source.identity.epoch}`;
      row.dataset.sourceRevision = `${caption.source.sourceRevision}`; row.dataset.sourceFinal = `${caption.source.final}`;
      row.dataset.translationState = caption.translation.state;
      row.dataset.speakerId = String(caption.source.speakerId ?? "");
      row.cells[0].textContent = caption.source.text;
      // Tab sample time and a selected video's anchored time are separate bases.
      const range = timeBasis === "capture" ? caption.source.audioRange : caption.videoRange;
      row.cells[1].textContent = range ? `${(range.startMs / 1000).toFixed(1)}–${(range.endMs / 1000).toFixed(1)} s` : "Unavailable";
      row.cells[2].textContent = caption.translation.state === "paired" ? caption.translation.revision.text : "Translation pending";
      row.dataset.translationRevision = caption.translation.state === "paired" ? `${caption.translation.revision.translationRevision}` : "";
      row.dataset.translationFinal = caption.translation.state === "paired" ? `${caption.translation.revision.final}` : "false";
      if (rows.size > captionHistoryLimit) { const first = rows.entries().next().value; if (first) { first[1].remove(); rows.delete(first[0]); } }
    },
  };
}
