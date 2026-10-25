import { imageFontSizes, imageOptionsKey, readImageOptions } from "./image-options";
import { imageChannel, imageEventChannel, type ImageSnapshot } from "./image-protocol";
import { readModelOptions, modelOptionsKey } from "./model-options";

export function setupImagePopup(getTabId: () => number | undefined) {
  const target = document.querySelector("#image-target") as HTMLSelectElement;
  const font = document.querySelector("#image-font-size .font-choices") as HTMLElement;
  const sizes: HTMLInputElement[] = [];
  for (const size of imageFontSizes) {
    const option = document.createElement("label"); option.className = "font-choice";
    const input = document.createElement("input"); input.type = "radio"; input.name = "image-font-size"; input.value = String(size.value);
    const sample = document.createElement("span"); sample.className = "font-sample"; sample.textContent = "Aa"; sample.style.fontSize = `${Math.round(18 * size.value)}px`; sample.setAttribute("aria-hidden", "true");
    const name = document.createElement("span"); name.textContent = size.name;
    const check = document.createElement("span"); check.className = "font-check"; check.textContent = "✓"; check.setAttribute("aria-hidden", "true");
    option.append(input, sample, name, check); font.append(option); sizes.push(input);
  }
  function fontState() { for (const input of sizes) input.checked = Number(input.value) === readImageOptions().fontScale; }
  fontState();
  const status = document.querySelector("#image-status") as HTMLElement;
  const stop = document.querySelector("#image-stop") as HTMLButtonElement;
  const actions = ["image-automatic", "image-translation"].map(id => document.getElementById(id) as HTMLButtonElement);
  target.value = readModelOptions().targetLanguage ?? "ko";
  function render(snapshot: ImageSnapshot) {
    status.textContent = snapshot.message;
    stop.disabled = ["idle", "stopped", "failed"].includes(snapshot.state);
  }
  async function request(fields: object) {
    const response = await chrome.runtime.sendMessage({ channel: imageChannel, ...fields });
    if (response?.error) throw new Error(response.error);
    if (response?.snapshot) render(response.snapshot);
    return response;
  }
  function refresh() {
    fontState();
    target.value = readModelOptions().targetLanguage ?? "ko";
    void request({ type: "snapshot" }).catch(error => { status.textContent = error.message; });
  }
  for (const input of sizes) input.onchange = () => {
    if (!input.checked) return;
    const fontScale = Number(input.value);
    localStorage.setItem(imageOptionsKey, JSON.stringify({ ...readImageOptions(), fontScale }));
    void request({ type: "size", tabId: getTabId(), fontScale }).catch(error => { status.textContent = error.message; });
  };
  target.onchange = () => localStorage.setItem(modelOptionsKey, JSON.stringify({ ...readModelOptions(), targetLanguage: target.value }));
  for (const [id, automatic] of [["image-automatic", true], ["image-translation", false]] as const) {
    (document.querySelector(`#${id}`) as HTMLButtonElement).onclick = () => {
      actions.forEach(button => { button.disabled = true; });
      status.textContent = automatic ? "탭 이미지의 백그라운드 분석을 시작합니다…" : "페이지에서 이미지를 선택하세요…";
      void request({ type: "select", tabId: getTabId(), automatic, imageOptions: readImageOptions(), options: { ...readModelOptions(), targetLanguage: target.value } })
        .then(() => window.close()).catch(error => { status.textContent = error.message; actions.forEach(button => { button.disabled = false; }); });
    };
  }
  stop.onclick = () => { void request({ type: "stop" }).catch(error => { status.textContent = error.message; }); };
  chrome.runtime.onMessage.addListener((message, sender) => { if (sender.id === chrome.runtime.id && message?.channel === imageEventChannel) refresh(); });
  return { refresh };
}
