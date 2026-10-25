<p align="center"><img src="apps/chrome/public/icons/jamak.svg" width="112" alt="Jamak subtitle bubble"></p>
<h1 align="center">Jamak</h1>
<p align="center">Live subtitles, right in your browser.</p>

**Jamak** (자막, /dʒɑːmɑːk/) means “subtitles” in Korean. It is a Chrome extension that turns tab audio into live Korean, English or Japanese captions using on-device speech recognition and translation.

[Privacy policy / 개인정보처리방침](PRIVACY.md)

## Features

- Optionally detects English, Japanese and Korean per speech turn. Choose Korean, English or Japanese subtitles independently of the speech language. Speech in the selected subtitle language keeps its original text.
- Select English, Japanese or Korean manually to disable automatic detection. Manual English is the default.
- Captures the selected tab's audio, including videos, iframes and Web Audio. Playback remains audible.
- Updates captions as speech arrives and keeps each caption in place until recognition and its matching translation are final, even when newer captions arrive. Whisper also shows provisional text while speaking, then confirms stable sentences. Hypotheses removed by recognition corrections are withdrawn from the overlay and history so they cannot block later captions.
- Streams translation as it is generated with Chrome TranslateKit or the optional Hy-MT2 WebGPU model; source corrections update the same caption, keeping the previous sentence while its replacement regenerates and patching the changed text without replaying the read prefix.
- Distinguishes speakers with background colors, without speaker labels.
- Shows ready captions immediately below earlier captions in a bounded toast-style stack. Visible captions read concurrently and leave oldest first; each completed part remains for 4–6 seconds, then fades out.
- Keeps captions visible over fullscreen videos and players, including fullscreen videos inside embedded frames. Playback controls remain clickable.
- Opens a separate original/translation history window.
- Offers a separate **Advanced · 모델 선택** window with independent recognition, translation, audio language detection and speaker selectors. Selecting a model starts its download/preparation; saved choices and downloaded files are reused.
- Changing speech or subtitle language before Start reuses loaded multilingual models and existing Chrome translator instances; only missing engines or language packs are prepared. Stop and Advanced model changes release the loaded models.
- Uses matching light/dark selection controls and dropdowns for language and models, with keyboard navigation and visible selected/focus states.
- Shows each selected model's download status in Advanced, including partial cached files and completed Chrome packs, plus current preparation progress. Advanced preparation sends a desktop Chrome notification once models are ready, even after the window closes.
- Runs speech recognition, translation and speaker analysis locally. No API key or companion app required.

## Install and use

Requires desktop Chrome **138+**. Chrome defaults require available on-device speech/translation packs; the independent language detector and speaker analysis run on CPU/WASM, while selected Whisper FP16 and Hy-MT2 q4f16 require WebGPU with FP16 support. API and model availability depend on your Chrome version, device and language.

```sh
git clone https://github.com/norux/jamak.git
cd jamak
npm ci
npm run build
```

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select `apps/chrome/dist`.
3. Open a page with audio, click Jamak, and choose English, Japanese or Korean manually (English by default), or enable the **자동 감지** checkbox for multilingual speech. Selecting a source language turns automatic detection off. Choose the subtitle language separately; when speech and subtitles use the same language, Jamak displays the original without translation. Manual Korean uses Whisper.
4. Use Chrome defaults, or open **Advanced · 모델 선택** to choose recognition, translation, language detection and speaker analysis separately. Selecting an option stops the current session and prepares the new models immediately; closing the window does not stop downloads. Each selector shows whether its model still needs downloading or is stored locally; completed downloads can still be loading. A Chrome desktop notification announces readiness. Allow Chrome notifications in your OS settings to receive it. **모두 기본값으로** restores the model defaults. Then return to the original tab.
5. Press **모델 준비** once; the popup shows a progress bar for the current download/preparation stage, including when reopened. Download and loading stages have separate status text; language changes before Start retain the loaded models. **모델 정보** opens a compact table of the selected recognition, translation, voice-activity and speaker models. Then click **번역 시작**. Click **중지** to stop.

With Chrome defaults, automatic mode requires WebGPU and prepares Whisper Turbo plus the two source-to-selected-subtitle-language translation pairs. Advanced can select a different multilingual Whisper and one multilingual local translation model instead. The first preparation downloads language packs and model files; internet access is required for downloads. With Chrome recognition selected, manual English and Japanese prefer Chrome local streaming recognition, showing interim text and correcting it as recognition completes. A stable earlier span separated by an audio pause can finish while the current span remains provisional. Whisper is the fallback when the local speech API is unsupported; it requires WebGPU and about 1.6 GB for the speech model. Prepared models run locally. Restricted Chrome pages cannot show the overlay. Microphone and system-wide audio capture are not supported.

## Platforms

| Platform | Status |
| --- | --- |
| Chrome extension · desktop | Supported |
| Safari extension · iPhone | Planned |
| macOS desktop app | Planned |

## Development

Node.js **22.12+** is required.

```sh
npm run dev       # Watch builds, serve fixtures and open isolated Chrome for Testing
npm run verify    # Lint, types, build, unit tests and caption display checks
npm run test:conversation # Serve English (~58 s) and Japanese (~76 s) conversations
```

The conversation player opens at `http://127.0.0.1:8790`; select Japanese with the page link or `?language=ja`. Both fixtures contain eight distinct turns and two synthetic voices. Real model and tab-capture checks are documented in [Testing](docs/testing.md).

`npm test` runs the unit/fixture suite and caption display checks. For a focused unit test, use `node --import tsx --test tests/<name>.test.ts`; individual browser checks run directly with `node tests/<name>.mjs`. The former `test:framework:*` aliases are removed; their individual test files remain available.

`npm run dev` requires Playwright's browser (`npx playwright install chromium`). It automatically loads the extension in Chrome for Testing and opens one window with only the Japanese conversation tab. Startup waits for Chrome’s first page and closes other restored tabs/windows in this owned test profile. Use Jamak on the conversation tab, then play the audio. Development builds and the persistent test profile live in `.ralph/dev/extension` and `.ralph/dev/chrome-profile`, separate from `apps/chrome/dist` and your normal Chrome profile. Chrome may download its local language packs on first startup. After a rebuild, open `chrome://extensions` in the test browser and reload the extension; Vite configuration changes require restarting the command. Ctrl+C or closing the test browser stops the watcher and fixture server, retaining downloaded models and test settings. Port 8790 must be free; stop a separately running `npm run test:conversation` first. Use the test profile without account synchronization to keep it isolated.

See [Architecture](docs/architecture/media-framework.md), [Coding conventions](docs/coding-conventions.md), and [AGENTS.md](AGENTS.md) before contributing. Feature changes must keep code and these documents consistent.

## Publishing to Chrome Web Store

After [one-time developer account and OAuth setup](docs/releasing.md), run `npm run release:chrome` to read the currently published Chrome Web Store version, increase its patch version, verify, build, ZIP, upload and submit for review. Use `npm run release:chrome -- minor` or `npm run release:chrome -- major` for larger version changes. The local manifest and failed draft uploads do not determine the next version; unavailable remote versions stop the command. Approval publishes automatically with the store item's existing distribution settings. Run `npm run release:chrome -- --dry-run` to authenticate/read the remote version, verify and create a ZIP without saving the version change, uploading or submitting. Dry runs and all failed releases restore the original manifest; only an accepted submission retains the selected version. Pending/staged submissions stop a new release. The command does not commit or tag; store metadata and permission justifications are configured in the developer dashboard.

For Orca workspaces, keep credentials in the main checkout and configure `.env.chrome-store` as a [worktree shared path](docs/releasing.md#orca-workspaces) so newly created workspaces receive the private file.

## Models and limitations

Chrome SODA and TranslateKit provide local recognition and translation when available. With Chrome defaults, automatic mode and the fallback use Whisper large-v3-turbo with Silero VAD. Advanced offers Small FP16 (~488 MB) and Large v3 Turbo FP16 (~1.6 GB) on WebGPU, plus independent Chrome TranslateKit or Hy-MT2 1.8B q4f16 (~1.38 GB) translation. Tiny/Base/Small q8 recognition and NLLB/M2M100 translation were removed from the supported selectors after the [real model audit](docs/verification/model-quality-20261025.md). Old selections migrate to Chrome defaults while preserving independent subtitle/detection/speaker settings. Explicit selected-model failures still never silently fall back. Automatic mode reuses one acoustic encoder pass for language detection and transcription, keeps the translation pairs ready, and uses recent language only to break uncertain ties. Speaker history does not determine language. Advanced can select shared Whisper detection or the independent one-pass VoxLingua107 ECAPA audio classifier (~87 MB, CPU/WASM), and enable WeSpeaker session-local speaker embeddings or turn speaker analysis off. The independent detector can shorten language classification while adding a separate inference before recognition; it is not a guarantee of faster captions. Laya and other text decision models cannot identify a language directly from audio; see the [model audit](docs/verification/model-quality-20261025.md). The Japanese Whisper fallback retains unfinished phrases across recognition windows. Chrome Japanese translation separates unpunctuated polite questions and conversational endings, including よ/ね followed by a new clause, to reduce missing follow-up sentences. Correctly paired translations can still omit or mistranslate meaning. Interim captions may change as speech continues; recognition and translation can still misinterpret individual words or relationships. Short responses may have no speaker assignment; overlapping speech, noise and similar voices can reduce accuracy.

Whisper repeatedly analyzes growing audio snapshots, normally after about one second of new audio, and updates the same provisional caption. Matching completed sentences are confirmed across consecutive results; unfinished audio stays available for correction. This adds repeated inference cost, and the actual display interval depends on model speed and translation. It does not guarantee SODA-like latency.

Chrome uses `translateStreaming()` when available and the complete-result API otherwise. Hy-MT2 streams generated translated words. Translation finishes when generation ends for the current original; the caption stays visible until recognition also confirms it. Confirming unchanged original text reuses the completed translation instead of invoking the model again. While one translation streams, its displayed original stays paired with it and newer recognition corrections coalesce for the next translation. Original corrections can therefore wait for an active translation to finish, while translated text keeps updating during speech. Language corrections and same-language bypass apply immediately. The first translation streams immediately. During same-language retranslation, the live caption keeps its existing sentence until the new stream extends it verbatim or generation completes, then patches the changed range in place. Genuine continuations still stream; changed wording can appear later to avoid replaying short regenerated prefixes. Corrections may rewrite earlier translated text because word order differs across languages. The current Japanese fixture still exposes meaning errors in both TranslateKit and Hy-MT2; Hy-MT2 is a comparison option, not a demonstrated universal quality upgrade. Streaming does not eliminate initial inference delay, and running Whisper and Hy-MT2 together shares GPU resources.

Automatic language switching currently follows speech pauses; simultaneous voices or language changes without a pause can share one recognition window. It is not instantaneous: audio accumulation and inference delay initial text, confirmation adds delay to final text, and short ambiguous speech can be misidentified.

Model weights have their own licenses. The optional [VoxLingua107 ECAPA](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa) language classifier and its pinned [ONNX export](https://huggingface.co/christopherthompson81/voxlingua107-lid-onnx) are Apache-2.0; credits belong to SpeechBrain, Jörgen Valk, Tanel Alumäe and the ONNX exporter. [Hy-MT2 1.8B](https://huggingface.co/tencent/Hy-MT2-1.8B) is Apache-2.0; the registered [ONNX conversion](https://huggingface.co/DavidLuong/Hy-MT2-1.8B-ONNX-q4f16) retains upstream attribution. [NLLB](https://huggingface.co/facebook/nllb-200-distilled-600M) is CC-BY-NC-4.0 and intended for research/noncommercial use; [M2M100](https://huggingface.co/facebook/m2m100_418M) is MIT. See [model attribution and speaker verification](docs/verification/captions/conversation-speakers.md) and the [architecture model inventory](docs/architecture/media-framework.md#models).

## License

[MIT](LICENSE). Model weights and dependencies retain their own licenses.
