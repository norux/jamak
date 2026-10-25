import type { ImageLabel, ImageRegion } from "./image-render";
import overlayStyles from "./image-overlay.css?inline";
import selectStyles from "./select.css?inline";

(() => {
  const scope = window as Window & { jamakImageInstalled?: boolean };
  if (scope.jamakImageInstalled) return;
  scope.jamakImageInstalled = true;
  let cancelSelection: (() => void) | undefined;
  let session = "";
  let originalScroll = { x: 0, y: 0 };
  type Region = ImageRegion & { language?: string };
  type Point = { x: number; y: number };
  type Controls = { editor: HTMLDivElement; dock: HTMLDivElement; open: (index: number, trigger: HTMLElement) => void; update: (regions: Region[], complete: boolean) => void };
  type Target = { image: HTMLImageElement; src: string; host?: HTMLDivElement; labels?: ImageLabel[]; width?: number; height?: number; revision?: number; captionsHidden?: boolean; dockPoint?: Point; editorPoint?: Point; controls?: Controls;
    crop: { x: number; y: number; width: number; height: number }; observer?: ResizeObserver };
  const targets = new Map<string, Target>();
  let activeTarget: Target | undefined;
  let mutations: MutationObserver | undefined;
  let banner: HTMLDivElement | undefined;
  const noticeButtonStyle = "flex:none;min-height:44px;padding:8px 12px;border:1px solid #ffffff3d;border-radius:8px;background:transparent;color:white;font:600 13px system-ui;cursor:pointer";
  function message(text: string) {
    if (!banner) {
      banner = document.createElement("div"); banner.setAttribute("role", "status");
      banner.style.cssText = "position:fixed;bottom:16px;left:16px;max-width:min(calc(100vw - 32px),480px);z-index:2147483645;display:flex;align-items:center;gap:12px;padding:8px 8px 8px 16px;background:#242936;color:white;border:1px solid #ffffff26;border-radius:12px;font:13px/1.5 system-ui;box-shadow:0 4px 20px #0003;box-sizing:border-box";
      document.documentElement.append(banner);
    }
    banner.replaceChildren(document.createTextNode(`Jamak · ${text} `));
    const close = document.createElement("button"); close.textContent = "닫기"; close.onclick = () => { banner?.remove(); banner = undefined; };
    close.type = "button"; close.style.cssText = noticeButtonStyle;
    banner.append(close);
  }
  async function request(type: string, fields: object = {}) {
    const response = await chrome.runtime.sendMessage({ channel: "jamak-image", type, token: session, ...fields });
    if (response?.error) { message(response.error); throw new Error(response.error); }
    return response;
  }
  let scheduled = false;
  const tick = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; for (const target of targets.values()) position(target); }); } };
  function clear(target: Target) { if (activeTarget === target) activeTarget = undefined; target.host?.remove(); target.host = undefined; target.controls = undefined; target.observer?.disconnect(); }
  function activate(target: Target) {
    if (activeTarget === target) return;
    if (activeTarget?.host) activeTarget.host.style.zIndex = "2147483646";
    if (target.host) target.host.style.zIndex = "2147483647";
    activeTarget = target;
  }
  function position(target: Target) {
    if (!target.host) return;
    if (!target.image.isConnected || target.image.currentSrc !== target.src) { clear(target); return; }
    const rect = target.image.getBoundingClientRect(); const crop = target.crop;
    const scale = rect.width * crop.width / (target.width ?? 1);
    const vertical = rect.height * crop.height / (target.height ?? 1);
    Object.assign(target.host.style, { left: `${rect.x + crop.x * rect.width}px`, top: `${rect.y + crop.y * rect.height}px`,
      width: `${rect.width * crop.width}px`, height: `${rect.height * crop.height}px` });
    const root = target.host.shadowRoot;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 12; const top = (viewport?.offsetTop ?? 0) + 12;
    const right = left + (viewport?.width ?? innerWidth) - 24; const bottom = top + (viewport?.height ?? innerHeight) - 24;
    root?.querySelectorAll<HTMLElement>(".caption").forEach((caption, index) => {
      const label = target.labels?.[index]; const node = caption.querySelector<HTMLElement>(".label"); if (!label || !node) return;
      Object.assign(caption.style, { left: `${label.x * scale}px`, top: `${label.y * vertical}px`, width: `${label.width * scale}px` });
      caption.classList.toggle("is-positioned", label.positioned === true);
      Object.assign(node.style, { width: `${label.width * scale}px`, padding: `${label.padding * scale}px`, fontSize: `${label.fontSize * scale}px`, lineHeight: `${label.lineHeight * scale}px` });
      const actions = caption.querySelector<HTMLElement>(".caption-actions");
      if (actions) {
        const bounds = caption.getBoundingClientRect(); const size = actions.getBoundingClientRect();
        actions.style.visibility = bounds.bottom > top && bounds.top < bottom && bounds.right > left && bounds.left < right ? "" : "hidden";
        let x = bounds.right + 4; let y = bounds.top;
        if (x + size.width > right) {
          if (bounds.left - size.width - 4 >= left) x = bounds.left - size.width - 4;
          else { x = Math.max(left, Math.min(right - size.width, bounds.left)); y = bounds.bottom + 4; }
        }
        Object.assign(actions.style, { left: `${Math.max(left, Math.min(right - size.width, x)) - bounds.x}px`, top: `${Math.max(top, Math.min(bottom - size.height, y)) - bounds.y}px` });
      }
    });
    const controls = target.controls;
    if (!controls) return;
    const origin = target.host.getBoundingClientRect();
    const visible = rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right;
    controls.dock.style.visibility = visible ? "" : "hidden";
    const dock = controls.dock.getBoundingClientRect();
    const dockX = target.dockPoint ? rect.x + target.dockPoint.x * rect.width : rect.right - dock.width - 8;
    const dockY = target.dockPoint ? rect.y + target.dockPoint.y * rect.height : rect.top + 8;
    const minX = Math.max(left, rect.left - 24); const minY = Math.max(top, rect.top - 24);
    const maxX = Math.max(minX, Math.min(right - dock.width, rect.right + 24 - dock.width));
    const maxY = Math.max(minY, Math.min(bottom - dock.height, rect.bottom + 24 - dock.height));
    const placed = { x: Math.max(minX, Math.min(maxX, dockX)), y: Math.max(minY, Math.min(maxY, dockY)) };
    Object.assign(controls.dock.style, { left: `${placed.x - origin.x}px`, top: `${placed.y - origin.y}px` });
    const editor = controls.editor;
    editor.style.maxWidth = `${right - left}px`; editor.style.maxHeight = `${Math.min(560, bottom - top)}px`;
    if (!editor.matches(":popover-open")) return;
    const source = controls.dock.getBoundingClientRect(); const panel = editor.getBoundingClientRect();
    const below = source.bottom + 8;
    const preferred = below + panel.height <= bottom ? below : source.top - panel.height - 8;
    const point = target.editorPoint ?? { x: source.right - panel.width, y: preferred };
    target.editorPoint = { x: Math.max(left, Math.min(right - panel.width, point.x)), y: Math.max(top, Math.min(bottom - panel.height, point.y)) };
    Object.assign(editor.style, { left: `${target.editorPoint.x}px`, top: `${target.editorPoint.y}px` });
  }
  function draggable(handle: HTMLElement, point: () => Point, move: (value: Point) => void) {
    let suppressClick = false;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary || (event.target instanceof Element && event.target.closest("[data-no-drag]"))) return;
      suppressClick = false;
      const start = point(); const pointer = { x: event.clientX, y: event.clientY }; let moved = false;
      const capture = event.target instanceof Element ? event.target.closest<HTMLElement>("button") ?? handle : handle;
      function drag(next: PointerEvent) {
        if (!moved && Math.hypot(next.clientX - pointer.x, next.clientY - pointer.y) < 4) return;
        moved = true; next.preventDefault(); handle.classList.add("is-dragging");
        move({ x: start.x + next.clientX - pointer.x, y: start.y + next.clientY - pointer.y });
      }
      function end(next: PointerEvent) {
        handle.removeEventListener("pointermove", drag); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); handle.removeEventListener("lostpointercapture", end);
        suppressClick = moved && next.type === "pointerup"; handle.classList.remove("is-dragging");
        if (capture.hasPointerCapture(event.pointerId)) capture.releasePointerCapture(event.pointerId);
      }
      capture.setPointerCapture(event.pointerId);
      handle.addEventListener("pointermove", drag); handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end); handle.addEventListener("lostpointercapture", end);
    });
    handle.addEventListener("click", event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; } }, true);
    handle.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || (event.target instanceof Element && event.target.closest("[data-no-drag]"))) return;
      event.preventDefault(); event.stopPropagation(); const current = point(); const step = event.shiftKey ? 10 : 1;
      move({ x: current.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: current.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) });
    });
  }

  function register(image: HTMLImageElement) {
    const id = crypto.randomUUID(); targets.set(id, { image, src: image.currentSrc, crop: { x: 0, y: 0, width: 1, height: 1 } }); return id;
  }
  function paint(target: Target, imageId: string, labels: ImageLabel[], width: number, height: number, language: string, regions: Region[], complete: boolean) {
    // Untranslated regions still need an edit action beside the original text.
    labels = [...labels, ...regions.flatMap((region, index) => labels.some(label => label.index === index) ? [] : [{ index, x: region.x, y: region.y, width: region.width, height: region.height, padding: 0, fontSize: 12, lineHeight: 16, lines: [] }])];
    target.labels = labels; target.width = width; target.height = height;
    if (!target.host) {
      const host = document.createElement("div"); target.host = host; host.className = "jamak-image";
      host.classList.toggle("captions-hidden", target.captionsHidden === true);
      host.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;isolation:isolate;";
      const root = host.attachShadow({ mode: "open" });
      root.addEventListener("pointerdown", () => activate(target), true); root.addEventListener("focusin", () => activate(target));
      const style = document.createElement("style"); style.textContent = selectStyles + overlayStyles;
      const layer = document.createElement("div"); layer.className = "labels"; root.append(style, layer);
      target.controls = createControls(target, imageId);
      root.append(target.controls.editor, target.controls.dock);
      document.documentElement.append(host);
      target.observer = new ResizeObserver(tick); target.observer.observe(target.image); target.observer.observe(target.controls.editor);
    }
    const root = target.host.shadowRoot;
    const layer = root?.querySelector(".labels");
    layer?.replaceChildren();
    for (const label of labels) {
      const caption = document.createElement("div"); caption.className = "caption";
      const node = document.createElement("div"); node.className = "label"; node.textContent = label.lines.join("\n");
      node.hidden = label.lines.length === 0;
      node.lang = language;
      node.tabIndex = 0; node.setAttribute("role", "group"); node.setAttribute("aria-label", `${label.lines.join(" ")} · 드래그 또는 방향키로 이동`);
      function move(x: number, y: number) {
        label.x = Math.max(-width, Math.min(width * 2, x)); label.y = Math.max(-height, Math.min(height * 2, y)); label.positioned = true; position(target);
      }
      let dragged = false;
      function changed() { void request("move", { imageId, index: label.index, x: label.x, y: label.y }).catch(() => {}); }
      node.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        dragged = false;
        event.preventDefault(); node.focus({ preventScroll: true }); node.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, left: label.x, top: label.y, positioned: label.positioned };
        const rect = target.image.getBoundingClientRect();
        const scale = rect.width * target.crop.width / width; const vertical = rect.height * target.crop.height / height;
        const drag = (next: PointerEvent) => { if (!dragged && Math.hypot(next.clientX - start.x, next.clientY - start.y) < 4) return; dragged = true; move(start.left + (next.clientX - start.x) / scale, start.top + (next.clientY - start.y) / vertical); };
        const end = () => { node.removeEventListener("pointermove", drag); node.removeEventListener("lostpointercapture", end); if (label.x !== start.left || label.y !== start.top) changed(); else { label.positioned = start.positioned; position(target); } };
        node.addEventListener("pointermove", drag); node.addEventListener("lostpointercapture", end, { once: true });
      });
      node.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 10 : 1;
        move(label.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), label.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)); changed();
      });
      const edit = button("원문 · 번역 수정", "edit", true); edit.classList.add("caption-edit"); edit.dataset.index = String(label.index);
      edit.disabled = !complete; edit.setAttribute("aria-haspopup", "dialog"); edit.setAttribute("aria-controls", "image-editor");
      edit.onclick = () => target.controls?.open(label.index, edit);
      const actions = document.createElement("div"); actions.className = "caption-actions"; actions.setAttribute("role", "group"); actions.setAttribute("aria-label", "자막 도구");
      const reset = button("자막 원래 위치로", "reset", true); reset.classList.add("caption-reset");
      reset.onclick = () => { reset.disabled = true; void request("reset", { imageId, index: label.index }).catch(() => {}).finally(() => { reset.disabled = false; }); };
      actions.append(edit, reset); caption.append(node, actions); layer?.append(caption);
    }
    target.controls?.update(regions, complete); position(target);
  }
  function button(text: string, symbol: "edit" | "download" | "close" | "eye" | "reset" | "move", iconOnly = false) {
    const paths = { eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0", reset: "M4 5v5h5M4 10a8 8 0 1 1 1 9", move: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01", edit: "m14 4 6 6M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16z", download: "M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4", close: "m6 6 12 12M6 18 18 6" };
    const node = document.createElement("button"); node.type = "button";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.7"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", paths[symbol]); svg.append(path); node.append(svg);
    if (iconOnly) { node.className = "icon-button"; node.setAttribute("aria-label", text); node.title = text; }
    else node.append(document.createTextNode(text));
    return node;
  }
  function createControls(target: Target, imageId: string): Controls {
    const save = button("PNG 저장", "download", true); save.classList.add("save"); save.title = "PNG 저장 · 드래그 또는 방향키로 이동";
    const visibility = button("자막 숨기기", "eye", true); visibility.classList.add("visibility");
    const slash = document.createElementNS("http://www.w3.org/2000/svg", "path"); slash.setAttribute("d", "m4 4 16 16"); slash.classList.add("slash"); visibility.querySelector("svg")?.append(slash);
    const dock = document.createElement("div"); dock.className = "dock"; dock.setAttribute("role", "group"); dock.setAttribute("aria-label", "이미지 다운로드와 자막 표시 · 드래그로 이동"); dock.append(save, visibility);
    const editor = document.createElement("div"); editor.id = "image-editor"; editor.className = "editor"; editor.popover = "auto"; editor.setAttribute("role", "dialog"); editor.setAttribute("aria-labelledby", "image-editor-title");
    const header = document.createElement("div"); header.className = "editor-header";
    const grip = button("수정 창 이동", "move", true); grip.title = "수정 창 이동 · 드래그 또는 방향키"; grip.classList.add("drag-handle");
    const heading = document.createElement("div"); heading.className = "editor-heading"; const title = document.createElement("h2"); title.id = "image-editor-title"; title.textContent = "원문 · 번역 수정";
    const description = document.createElement("p"); description.textContent = "원문을 수정하면 새로 번역합니다."; heading.append(title, description);
    let selectedIndex = -1;
    function trigger() { if (target.captionsHidden) return save; return target.host?.shadowRoot?.querySelector<HTMLButtonElement>(`.caption-edit[data-index="${selectedIndex}"]`) ?? save; }
    function focusTrigger() { trigger().focus({ preventScroll: true }); }
    const dismiss = button("수정 패널 닫기", "close", true); dismiss.dataset.noDrag = "true"; dismiss.onclick = () => { editor.hidePopover(); focusTrigger(); };
    header.append(grip, heading, dismiss);
    const body = document.createElement("div"); body.className = "editor-body"; editor.append(header, body);
    const empty = document.createElement("p"); empty.className = "editor-empty"; empty.textContent = "인식한 글자가 없습니다. 다른 이미지를 선택해 주세요."; body.append(empty);
    editor.addEventListener("toggle", () => { if (editor.matches(":popover-open")) position(target); });
    editor.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape" && !editor.querySelector("select:open")) { event.preventDefault(); editor.hidePopover(); focusTrigger(); }
    });
    draggable(header, () => editor.getBoundingClientRect(), point => { target.editorPoint = point; position(target); });
    draggable(dock, () => dock.getBoundingClientRect(), point => {
      const rect = target.image.getBoundingClientRect();
      target.dockPoint = { x: (point.x - rect.x) / (rect.width || 1), y: (point.y - rect.y) / (rect.height || 1) }; position(target);
      const placed = dock.getBoundingClientRect();
      target.dockPoint = { x: (placed.x - rect.x) / (rect.width || 1), y: (placed.y - rect.y) / (rect.height || 1) };
    });
    function captionVisibility() {
      const hidden = target.captionsHidden === true;
      target.host?.classList.toggle("captions-hidden", hidden); visibility.setAttribute("aria-pressed", String(hidden));
      const text = hidden ? "자막 다시 표시" : "자막 숨기기"; visibility.setAttribute("aria-label", text); visibility.title = `${text} · 드래그 또는 방향키로 이동`;
    }
    visibility.onclick = () => { target.captionsHidden = !target.captionsHidden; captionVisibility(); position(target); };
    captionVisibility();
    let ready = false; let exporting = false;
    function downloadState() { save.disabled = exporting || !ready || !target.labels?.some(label => label.lines.length); }
    save.onclick = () => {
      exporting = true; downloadState(); save.setAttribute("aria-busy", "true");
      void request("export", { imageId }).catch(() => {}).finally(() => { exporting = false; downloadState(); save.removeAttribute("aria-busy"); });
    };
    type Values = { source: string; translation: string; language: string };
    const fields: { source: HTMLTextAreaElement; translation: HTMLTextAreaElement; detected: HTMLSelectElement; field: HTMLFieldSetElement; legend: HTMLLegendElement; apply: HTMLButtonElement; applying: boolean; values: Values; submitted?: Values }[] = [];
    function field(index: number) {
      const field = document.createElement("fieldset"); const legend = document.createElement("legend");
      field.append(legend);
      const source = document.createElement("textarea"); source.maxLength = 16384; source.rows = 3;
      const translation = document.createElement("textarea"); translation.maxLength = 16384; translation.rows = 3;
      const detected = document.createElement("select"); detected.className = "jamak-select";
      for (const [value, text] of [["", "자동 판별"], ["en", "English · 영어"], ["ja", "日本語 · 일본어"], ["ko", "한국어"]]) detected.add(new Option(text, value));
      for (const [name, input] of [["원문", source], ["원문 언어 · 짧은 문구는 보정 가능", detected], ["번역", translation]] as const) {
        const label = document.createElement("label"); label.textContent = name; label.append(input); field.append(label);
      }
      const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "수정 반영";
      const feedback = document.createElement("span"); feedback.className = "editor-feedback"; feedback.setAttribute("role", "status");
      const actions = document.createElement("div"); actions.className = "editor-actions"; actions.append(feedback, apply);
      const entry: typeof fields[number] = { source, translation, detected, field, legend, apply, applying: false, values: { source: "", translation: "", language: "" } };
      apply.onclick = () => {
        entry.applying = true; apply.disabled = true; apply.textContent = "반영 중…"; feedback.textContent = ""; feedback.classList.remove("error");
        entry.submitted = { source: source.value, translation: translation.value, language: detected.value };
        void request("edit", { imageId, index, source: source.value, translation: translation.value, language: detected.value }).then(() => { feedback.textContent = "반영했습니다."; })
          .catch(error => { feedback.textContent = error.message; feedback.classList.add("error"); })
          .finally(() => { entry.applying = false; entry.submitted = undefined; apply.disabled = !ready; apply.textContent = "수정 반영"; });
      };
      field.append(actions); body.append(field); fields.push(entry);
    }
    return { editor, dock, open(index, source) {
      if (!ready || !fields[index]) return;
      selectedIndex = index;
      for (const [row, entry] of fields.entries()) entry.field.hidden = row !== index;
      if (!editor.matches(":popover-open")) editor.showPopover({ source });
      position(target); fields[index].source.focus({ preventScroll: true });
    }, update(regions, complete) {
      ready = complete; downloadState();
      empty.hidden = regions.length > 0;
      for (const [index, region] of regions.entries()) {
        if (!fields[index]) field(index);
        const entry = fields[index]; entry.field.hidden = index !== selectedIndex;
        const name = region.language === "en" ? "영어" : region.language === "ja" ? "일본어" : region.language === "ko" ? "한국어" : "언어 확인 필요";
        entry.legend.textContent = `영역 ${index + 1} · ${name}`;
        for (const key of ["source", "translation"] as const) {
          if (entry[key].value === entry.values[key] || (entry.applying && entry[key].value === entry.submitted?.[key])) entry[key].value = region[key];
          entry.values[key] = region[key];
        }
        if (entry.detected.value === entry.values.language || (entry.applying && entry.detected.value === entry.submitted?.language)) entry.detected.value = region.language ?? "";
        entry.values.language = region.language ?? "";
        entry.apply.disabled = !complete || entry.applying;

      }
    } };
  }
  function messageStatus(snapshot: { state: string; message: string; failed?: number }) {
    if (snapshot.state === "ready" && !snapshot.failed) { banner?.remove(); banner = undefined; return; }
    message(snapshot.message);
    if (["preparing", "running", "selecting"].includes(snapshot.state) && banner) {
      const stop = document.createElement("button"); stop.type = "button"; stop.style.cssText = noticeButtonStyle; stop.textContent = "중지"; stop.onclick = () => { void request("stop").catch(() => {}); }; banner.append(stop);
    }
  }
  window.addEventListener("scroll", tick, true); window.addEventListener("resize", tick);
  window.visualViewport?.addEventListener("resize", tick); window.visualViewport?.addEventListener("scroll", tick);
  document.addEventListener("load", event => { if (event.target instanceof HTMLImageElement) tick(); }, true);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== "jamak-image") return;
    if (message.type === "select") {
      cancelSelection?.(); for (const target of targets.values()) clear(target); targets.clear(); mutations?.disconnect();
      session = message.token; originalScroll = { x: scrollX, y: scrollY };
      mutations = new MutationObserver(records => { if (records.some(record => ![...targets.values()].some(target => target.host === record.target))) tick(); });
      mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset", "style", "class"] });
      if (message.automatic) {
        const images = [...document.images].filter(image => { const rect = image.getBoundingClientRect(); return rect.width >= 8 && rect.height >= 8 && getComputedStyle(image).visibility !== "hidden"; });
        if (!images.length) { respond({ error: "이 탭에서 분석할 이미지를 찾지 못했습니다." }); return; }
        respond({ imageIds: images.map(register) }); return;
      }
      const hint = document.createElement("div"); hint.textContent = "Jamak · 번역할 이미지를 클릭하세요 · Esc 취소";
      hint.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:12px 20px;background:#242936;color:white;border-radius:12px;font:14px system-ui;pointer-events:none";
      document.documentElement.append(hint);
      function cleanup() { hint.remove(); window.removeEventListener("click", click, true); window.removeEventListener("keydown", key, true); cancelSelection = undefined; }
      function key(event: KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cleanup(); void request("cancel-selection").catch(() => {}); } }
      function click(event: MouseEvent) {
        const image = event.composedPath().find(item => item instanceof HTMLImageElement); if (!(image instanceof HTMLImageElement)) return;
        event.preventDefault(); event.stopImmediatePropagation(); cleanup();
        void chrome.runtime.sendMessage({ channel: "jamak-image", type: "selected", token: session, imageId: register(image) }).then(result => {
          if (result?.error) { hint.textContent = `Jamak · ${result.error}`; document.documentElement.append(hint); setTimeout(() => hint.remove(), 5000); }
        });
      }
      window.addEventListener("click", click, true); window.addEventListener("keydown", key, true); cancelSelection = cleanup;
      respond({ selecting: true }); return;
    }
    if (message.token !== session) return;
    if (message.type === "status") { messageStatus(message.snapshot); respond({}); return; }
    if (message.type === "dispose") { cancelSelection?.(); for (const value of targets.values()) clear(value); targets.clear(); mutations?.disconnect(); banner?.remove(); banner = undefined; session = ""; respond({}); return; }
    if (message.type === "download" && typeof message.png === "string" && message.png.startsWith("data:image/png;base64,")) {
      const link = document.createElement("a"); link.href = message.png; link.download = "jamak-translated-image.png"; document.documentElement.append(link); link.click(); link.remove(); respond({}); return;
    }
    if (message.type === "finish") { cancelSelection?.(); scrollTo(originalScroll.x, originalScroll.y); respond({}); return; }
    if (message.type === "captured") { for (const target of targets.values()) if (target.host) target.host.style.visibility = ""; if (banner) banner.style.visibility = ""; respond({}); return; }
    const target = targets.get(message.imageId);
    if (!target) { respond({ error: "원래 이미지가 더 이상 없습니다." }); return; }
    if (message.type === "paint" && Array.isArray(message.labels) && ["ko", "en", "ja"].includes(message.targetLanguage)) {
      if (!target.image.isConnected || target.src !== target.image.currentSrc) { clear(target); respond({ painted: false }); return; }
      if (!target.revision || message.revision > target.revision) {
        target.revision = message.revision; paint(target, message.imageId, message.labels, message.width, message.height, message.targetLanguage, message.regions ?? [], message.complete === true);
      }
      respond({ painted: true }); return;
    }
    if (message.type !== "capture") return;
    const capturedTarget = target;
    async function capture() {
      const image = capturedTarget.image;
      if (!image.isConnected) throw new Error("이미지가 페이지에서 제거되었습니다.");
      clear(capturedTarget);
      image.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      await Promise.race([image.decode().catch(() => {}), new Promise(done => setTimeout(done, 5000))]);
      capturedTarget.src = image.currentSrc;
      capturedTarget.captionsHidden = false;
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("이미지를 불러올 수 없습니다.");
      // Same-origin/CORS images retain their full pixels without capturing the page.
      // Cross-origin images fall back to an action-granted visible-tab capture.
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      try {
        const rect = image.getBoundingClientRect();
        if (getComputedStyle(image).objectFit !== "fill" && Math.abs(rect.width / rect.height - image.naturalWidth / image.naturalHeight) > 0.01) throw new Error("Rendered image is cropped or letterboxed");
        const pixels = canvas.toDataURL("image/png"); capturedTarget.crop = { x: 0, y: 0, width: 1, height: 1 }; return { pixels };
      } catch {
        for (const entry of targets.values()) if (entry.host) entry.host.style.visibility = "hidden";
        if (banner) banner.style.visibility = "hidden";
        await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        const rect = image.getBoundingClientRect(); const x = Math.max(0, rect.x); const y = Math.max(0, rect.y);
        const width = Math.min(innerWidth, rect.right) - x; const height = Math.min(innerHeight, rect.bottom) - y;
        if (width < 8 || height < 8) throw new Error("이미지의 보이는 영역이 너무 작습니다.");
        capturedTarget.crop = { x: (x - rect.x) / rect.width, y: (y - rect.y) / rect.height, width: width / rect.width, height: height / rect.height };
        return { selection: { x, y, width, height, viewportWidth: innerWidth, viewportHeight: innerHeight }, clipped: width < rect.width - 1 || height < rect.height - 1 };
      }
    }
    void capture().then(respond, error => respond({ error: error.message })); return true;
  });
})();
