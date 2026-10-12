import { controlChannel, eventChannel, type BackgroundSnapshot } from "./background-protocol";
import { asrCandidates, registeredCandidate, vadCandidate } from "../../packages/engines-browser/model";
import { readModelOptions, modelOptionsKey, recognitionChoices, translationChoices } from "./model-options";
import { translationCandidates } from "../../packages/engines-browser/translation-model";
import { localSpeechLanguages } from "../../packages/engines-browser/local-speech";

const automatic = document.querySelector("#auto-detect") as HTMLInputElement;
const language = document.querySelector("#language") as HTMLSelectElement;
const prepare = document.querySelector("#prepare") as HTMLButtonElement;
const start = document.querySelector("#start") as HTMLButtonElement;
const stop = document.querySelector("#stop") as HTMLButtonElement;
const status = document.querySelector("#status") as HTMLElement;
const modelList = document.querySelector("#model-list") as HTMLElement;
const modelSetup = document.querySelector("#model-setup") as HTMLElement;
const translationControls = document.querySelector("#translation-controls") as HTMLElement;
const modelDescription = document.querySelector("#model-description") as HTMLElement;
const downloadProgress = document.querySelector("#download-progress") as HTMLElement;
const modelProgress = document.querySelector("#model-progress") as HTMLProgressElement;
const downloadPercent = document.querySelector("#download-percent") as HTMLElement;
let tabId: number | undefined;
let disposed = false;
let revision = 0;
let snapshot: BackgroundSnapshot | undefined;
let checking = false;
let changingSource = false;
function selectedSource(): BackgroundSnapshot["source"] { return automatic.checked ? "auto" : language.value as "ja" | "en" | "ko"; }
type SpeechApi = { available?: (options: { langs: string[]; processLocally: true }) => Promise<string>; install?: (options: { langs: string[]; processLocally: true }) => Promise<boolean>; new(): { processLocally?: boolean } };
const view = window as Window & { SpeechRecognition?: SpeechApi; webkitSpeechRecognition?: SpeechApi; Translator?: { availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string> } };
const speech = view.SpeechRecognition ?? view.webkitSpeechRecognition;
const localSpeechSupported = !!speech?.available && !!speech.install && "processLocally" in new speech();
function usingLocalSpeech() {
  const source = selectedSource();
  return readModelOptions().recognition === "chrome" && localSpeechSupported && (source === "en" || source === "ja");
}
function render(value: BackgroundSnapshot) {
  snapshot = value;
  const busy = ["preparing", "starting", "running", "stopping", "failed"].includes(value.state);
  if (!changingSource && (busy || value.state === "ready")) {
    automatic.checked = value.source === "auto";
    if (value.source !== "auto") language.value = value.source;
  }
  language.disabled = busy || checking || changingSource;
  automatic.disabled = busy || checking || changingSource;
  const source = selectedSource();
  const setup = value.state === "idle" || value.state === "preparing";
  modelSetup.hidden = !setup;
  downloadProgress.hidden = value.state !== "preparing";
  if (value.downloadProgress === undefined) {
    modelProgress.removeAttribute("value"); downloadPercent.textContent = "준비 중…";
  } else {
    modelProgress.value = value.downloadProgress;
    downloadPercent.textContent = `${Math.floor(value.downloadProgress * 100)}%`;
  }
  translationControls.hidden = setup;
  const options = readModelOptions();
  const candidate = options.recognition === "chrome" ? "turboFp16" : options.recognition;
  const asrName = candidate === "turboFp16" ? "Whisper large-v3-turbo · FP16 / WebGPU" : recognitionChoices.find(choice => choice.id === candidate)?.name ?? "";
  const translationName = options.translation === "chrome" ? "Chrome TranslateKit" : translationChoices.find(choice => choice.id === options.translation)?.name ?? "";
  const matches = value.source === source && (value.options ? value.options.recognition === options.recognition && value.options.translation === options.translation : options.recognition === "chrome" && options.translation === "chrome");
  const native = value.models && matches ? value.models.some(model => model.name === "Chrome SODA")
    : usingLocalSpeech();
  modelDescription.textContent = options.recognition === "chrome" && options.translation === "chrome" ? source === "auto"
    ? "영어 · 일본어 · 한국어를 발화별로 자동 감지합니다.\n한국어 발화는 원문을 표시하고, 영어·일본어는 한국어로 번역합니다.\n처음 모델 다운로드 후 기기에서 처리합니다."
    : source === "ko"
    ? "음성 인식: Whisper large-v3-turbo · FP16 + Silero VAD\n한국어 원문을 표시하며 번역은 생략합니다.\n창을 닫아도 준비가 계속 진행됩니다."
    : native
    ? `음성 인식: Chrome SODA · ${source === "ja" ? "일본어" : "영어"}\nChrome 시작용 영어·한국어 팩 포함\n번역: Chrome TranslateKit · 한국어\n창을 닫아도 다운로드가 계속 진행됩니다.`
    : "음성 인식: Whisper large-v3-turbo · FP16 + Silero VAD\n번역: Chrome TranslateKit · 한국어\n음성 모델 약 1.6 GB · WebGPU 필요\n최초 한 번 다운로드하며, 창을 닫아도 계속 진행됩니다."
    : `음성 인식: ${native ? "Chrome SODA" : asrName}${native ? "" : " + Silero VAD"}\n${source === "ko" ? "한국어 원문을 표시하며 번역은 생략합니다." : `번역: ${translationName}`}\n${source === "auto" ? "영어 · 일본어 · 한국어를 발화별로 자동 감지합니다.\n" : ""}창을 닫아도 모델 준비가 계속 진행됩니다.`;
  prepare.hidden = !setup;
  prepare.textContent = checking ? "모델 확인 중…" : value.state === "preparing" ? "다운로드 · 준비 중…" : "모델 다운로드";
  prepare.disabled = busy || checking || tabId === undefined;
  start.disabled = value.state !== "ready" || value.tabId !== tabId || !matches || checking;
  stop.disabled = value.state === "idle" || value.state === "stopping";
  status.textContent = value.message;
  const models = value.models && matches ? value.models : [
    { task: source === "auto" ? "언어 감지 · 받아쓰기" : "받아쓰기", name: native ? "Chrome SODA" : asrName },
    ...native ? [] : [{ task: "발화 감지", name: "Silero VAD" }],
    ...source === "ko" ? [] : [{ task: "한국어 번역", name: translationName }],
    { task: "화자 구분", name: "WeSpeaker VoxCeleb ResNet34-LM · q8" },
  ];
  modelList.replaceChildren(...models.map(model => {
    const row = document.createElement("tr");
    for (const value of [model.task, model.name]) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    return row;
  }));
}
async function request(type: string) {
  const current = ++revision;
  const result = await chrome.runtime.sendMessage({ channel: controlChannel,
    command: { type, tabId: type === "start" ? snapshot?.tabId : tabId, source: selectedSource(), options: readModelOptions() } });
  if (disposed || current !== revision) return result?.snapshot as BackgroundSnapshot | undefined;
  if (result?.error) { status.textContent = result.error; return; }
  if (result?.snapshot) render(result.snapshot);
  return result?.snapshot as BackgroundSnapshot | undefined;
}
function action(type: string) {
  void request(type).catch(error => { if (!disposed) status.textContent = error.message; });
}
async function ensureReady() {
  if (disposed || checking || tabId === undefined || !snapshot || !["idle", "ready"].includes(snapshot.state)) return;
  const source = selectedSource();
  checking = true; render(snapshot);
  try {
    if (snapshot.state === "ready") {
      const options = readModelOptions();
      if (snapshot.tabId === tabId && snapshot.source === source && (snapshot.options ? snapshot.options.recognition === options.recognition && snapshot.options.translation === options.translation : options.recognition === "chrome" && options.translation === "chrome")) return;
      const stopped = await request("stop");
      if (disposed) return;
      if (stopped) render(stopped);
    }
    status.textContent = "저장된 모델 확인 중…";
    const options = readModelOptions();
    const candidate = options.recognition === "chrome" ? "turboFp16" : options.recognition;
    const sources = source === "auto" ? ["en", "ja"] : source === "ko" ? [] : [source];
    const translations = options.translation === "chrome" ? await Promise.all(sources.map(sourceLanguage => view.Translator?.availability({ sourceLanguage, targetLanguage: "ko" }))) : [];
    let cached = translations.every(state => state === "available");
    const selectedModels = options.translation !== "chrome" && source !== "ko" ? [registeredCandidate(translationCandidates[options.translation].model, translationCandidates[options.translation].dtype)] : [];
    if (cached && usingLocalSpeech()) {
      cached = await speech?.available?.({ langs: localSpeechLanguages(source as "ja" | "en"), processLocally: true }) === "available";
    } else if (cached) {
      selectedModels.push(registeredCandidate(asrCandidates[candidate].model, asrCandidates[candidate].dtype), registeredCandidate(vadCandidate.model, "fp32"));
    }
    if (cached) {
      for (const selected of selectedModels) {
        if (!await caches.has(selected.cacheName)) { cached = false; break; }
        const cache = await caches.open(selected.cacheName);
        for (const file of selected.files) {
          const response = await cache.match(selected.url(file.path));
          if (!response?.ok || Number(response.headers.get("Content-Length")) !== file.bytes) { cached = false; break; }
        }
        if (!cached) break;
      }
    }
    if (disposed) return;
    if (cached) await request("prepare");
    else if (snapshot.state === "idle") snapshot.message = "처음 사용할 언어의 모델을 준비하세요.";
  } catch (error) {
    if (!disposed && snapshot.state === "idle") snapshot.message = `모델 확인 실패: ${(error as Error).message}`;
  } finally {
    checking = false;
    if (!disposed && snapshot) render(snapshot);
  }
}
prepare.onclick = () => {
  prepare.disabled = true;
  // The browser keeps downloading even after this action popup disappears.
  const source = selectedSource();
  if (usingLocalSpeech()) void speech?.install?.({ langs: localSpeechLanguages(source as "ja" | "en"), processLocally: true }).catch(error => {
    if (!disposed) status.textContent = `음성 인식 모델 준비 실패: ${error.message}`;
  });
  action("prepare");
};
start.onclick = () => { start.disabled = true; action("start"); };
stop.onclick = () => {
  stop.disabled = true;
  void request("stop").then(async stopped => {
    if (disposed) return;
    if (stopped) render(stopped);
    await ensureReady();
  }).catch(error => { if (!disposed) status.textContent = error.message; });
};
async function changeSource() {
  if (changingSource) return;
  changingSource = true;
  if (snapshot) render(snapshot);
  try {
    if (snapshot?.state === "ready") await request("stop");
    if (!disposed) await ensureReady();
  } catch (error) { if (!disposed) status.textContent = (error as Error).message; }
  finally { changingSource = false; if (!disposed && snapshot) render(snapshot); }
}
language.onchange = () => { automatic.checked = false; void changeSource(); };
automatic.onchange = () => { void changeSource(); };
(document.querySelector("#advanced") as HTMLButtonElement).onclick = () => {
  const url = new URL(chrome.runtime.getURL("advanced.html"));
  url.searchParams.set("source", selectedSource());
  if (tabId !== undefined) url.searchParams.set("tabId", String(tabId));
  void chrome.windows.create({ url: url.href, type: "popup", width: 640, height: 650 }).catch(error => { status.textContent = error.message; });
};
window.addEventListener("storage", event => { if (event.key === modelOptionsKey) action("snapshot"); });
(document.querySelector("#reference") as HTMLButtonElement).onclick = () => action("reference");
function changed(message: { channel?: string }, sender: chrome.runtime.MessageSender) {
  if (sender.id === chrome.runtime.id && message.channel === eventChannel) action("snapshot");
}
chrome.runtime.onMessage.addListener(changed);
void chrome.tabs.query({ active: true, currentWindow: true }).then(async tabs => {
  const tab = tabs[0];
  if (tab?.id !== undefined && !tab.url?.startsWith("chrome-extension:")) tabId = tab.id;
  const initial = await request("snapshot");
  if (disposed) return;
  if (initial) { automatic.checked = initial.source === "auto"; if (initial.source !== "auto") language.value = initial.source; render(initial); }
  await ensureReady();
}).catch(error => { status.textContent = error.message; });
window.addEventListener("pagehide", () => { disposed = true; chrome.runtime.onMessage.removeListener(changed); });
