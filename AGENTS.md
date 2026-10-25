# Jamak agent harness

Jamak is a desktop Chrome extension for on-device live Korean, English and Japanese subtitles. `apps/chrome` is the only shipping application. iPhone Safari and a macOS app are planned, not implemented. Do not recreate the removed server or companion app without an explicit request.

## Read before editing

- [Documentation index](docs/README.md)
- [Architecture and runtime boundaries](docs/architecture/media-framework.md)
- [Coding conventions](docs/coding-conventions.md)
- [Verification and local fixtures](docs/testing.md)

Read the relevant feature verification document when changing recognition, translation, speaker assignment or caption lifecycle.

## Scope and implementation

State assumptions and observable success criteria before coding. Preserve the existing architecture and use the smallest change that satisfies the request. Establish a failing regression check for bugs. Keep unrelated changes out. Internal channel names, CSS selectors and model cache keys may retain the old `interpreter` prefix for compatibility; user-facing branding is Jamak.

Application code and brand assets are MIT-licensed; keep upstream model attribution and separate licenses intact.

Never commit credentials, model weights, user recordings, `.ralph` output or OS metadata. Synthetic, reproducible test fixtures belong in `tests/fixtures`.

With Chrome defaults, manual English and Japanese prefer Chrome local streaming speech when its API is supported, regardless of WebGPU. Publish interim revisions through the existing native path; coalesce drafts for 180 ms and publish native finals immediately. A pause-separated native span can finalize before the cumulative result only when the next published result confirms its unchanged text behind the measured speech boundary; keep the current open span provisional. Use Whisper when the local speech API is unsupported. Whisper publishes provisional snapshot text through the same revision/translation pipeline: preserve the pending caption's utterance ID across text/language corrections and PCM trimming, increment source revisions, coalesce queued replacements, and finalize stable completed sentences without replaying their prefix. Keep engine selection, popup model descriptions and cached-model checks consistent. Whisper timestamp segments are not sentence boundaries: preserve unfinished speech across snapshot cuts and never replay a committed prefix after punctuation corrections. Drain retained tails at a completed automatic speech boundary before detecting the next turn's language.

Chrome Japanese translation must preserve follow-up clauses in unpunctuated recognition. Split complete polite questions and sentence-final よ/ね before a new clause or discourse marker (including まったく/ちょうど), translate each phrase and emit one exact source-revision pair. Preserve quoted questions such as 来ますかと聞かれた and 来ますかを確認, word-internal text and spaced time phrases. A correctly paired final translation alone does not prove semantic completeness; verify the follow-up meaning with real TranslateKit.

Keep `PRIVACY.md` consistent with local audio/text/speaker processing, in-memory transcript retention and external model downloads. Stop releases capture/inference resources but can leave transcript text in the background snapshot or an open history window; do not promise immediate text deletion on Stop.

## Documentation synchronization — required for feature changes

Whenever a feature is added, removed or modified, review and update all of the following in the same change:

1. `README.md`: supported capabilities, installation, limitations and platform status.
2. `AGENTS.md`: agent workflow, application scope and invariants affected by the feature.
3. `docs/`: architecture, coding conventions and verification instructions or evidence affected by the feature.

Make concrete edits wherever the behavior or instructions changed. If a document remains accurate, explicitly report that it was reviewed and why no edit was needed. Do not add meaningless edits just to touch a file. Do not mark the work complete while documentation contradicts implementation, or present planned platforms as supported.

## Automatic language invariants

Automatic mode supports English/Japanese/Korean speech through the selected multilingual Whisper; Chrome defaults use Turbo FP16/WebGPU, and explicit Small/Turbo FP16 choices use WebGPU. Automatic detection is opt-in; the popup defaults to manual English. Selecting English/Japanese/Korean disables detection. With Chrome defaults, manual English and Japanese prefer SODA; manual Korean uses fixed-language Whisper; bypass applies only when it matches the subtitle language. `auto` is a session selection, never a transcript language: each utterance carries its detected `en`, `ja` or `ko` through recognition, translation and overlay validation. Subtitle language is independently selected as `ko`, `en` or `ja` (default `ko`). Every other source language translates to it; matching-language speech bypasses every translator and pairs with its original text. Preserve first-word PCM and queued speech boundaries during inference. Recent language is a session-local tie breaker, not a fixed language per speaker. Stop/navigation must retire both prepared translation pairs and pending recognition.

Ready captions stack below earlier captions and accrue reading time concurrently. Retire completed rows oldest first, preserve each row’s measured two-line parts and correction offsets, and never spend the reading time of clipped/offscreen rows. The model-information table uses the prepared engine’s actual model list when available.

Never expire a provisional caption because a newer caption arrived. Keep its row and accept live revisions until the latest source and matching translation are both final. A pending source/translation correction blocks retirement even if the displayed previous pair was final; grant at least four seconds of final reading time after the corrected pair arrives, including unchanged text. Long provisional rows may still advance their measured parts without retiring the row. When an already translated caption receives a new same-language source revision, retain its visible text while a regenerated translation prefix is incomplete; allow verbatim continuations immediately and apply the complete correction in place. Flush translation generation completion immediately through the presentation cadence even while recognition is provisional, so the next pending source cannot discard that completed paint. Preserve offsets against the actual previously displayed text, not held raw chunks. Patch the existing text node only within the changed range. Initial translations, language corrections and same-language bypass keep streaming without this hold.

When Whisper corrections remove a provisional tail (including empty boundary/EOF results), explicitly withdraw that hypothesis with the same ID and a newer final empty `retracted` source revision. A final filler-only correction of a previously accepted draft also withdraws it. Remove withdrawn rows from the overlay and history, cancel their queued translation and reject late source/translation/speaker updates. Never withdraw a confirmed sentence or carry a removed draft's identity into the next turn.

Fullscreen captions use a manual popover in the page's top layer, including video-only and embedded-frame fullscreen. Keep the overlay noninteractive, preserve caption revisions and reading progress through entry/exit, and remove the top-layer surface on Stop/disposal. Do not replace the page's fullscreen target or modify its video element.

Recognition, translation, audio language detection and speaker selections are independent, on-device only and persisted in extension-origin localStorage without additional permissions. Advanced selection stops the old session before preparing the new models; prepared snapshots freeze recognition, translation, audio language detection, speaker selection and subtitle language. Keep engine/backend selection, cache readiness, popup model information and documentation aligned. Explicit model failure must stay visible, never silently switch to another model. Hy-MT2 1.8B q4f16 requires WebGPU/FP16; NLLB and M2M100 are retained only in the internal audit registry and use WASM. Chrome TranslateKit uses its streaming API when supported, with its complete-result API for older implementations. Emit cumulative translation chunks as increasing translation revisions for the exact source revision; mark translation final when generation finishes for that exact source revision, independently of recognition finality. Reuse its completed translation for an unchanged same-language recognition final, including a confirmation queued during generation; changed text requires new inference. Caption retirement still requires both source and translation final. A corrected source starts a new translation stream, while a finalized translation cannot regress within the same source revision. Bound worker chunk buffering and reject late chunks after Stop. Speech matching the subtitle language bypasses every translator. Preserve pinned revisions, sizes/hashes and separate upstream licenses, including NLLB’s noncommercial restriction.

Before capture starts, source/subtitle-only changes reuse the ready engine when recognition/translation/detection/speaker choices match. Keep the loaded multilingual workers, prepare only newly needed components, and retain native translators by actual source/target pair. Freeze the new language snapshot before Start; reject reconfiguration after pipeline creation. Stop/navigation/Advanced model changes still dispose all retained resources. Do not label cached-model loading as downloading.

Download progress must come from background preparation state, survive popup closure and reflect the current model stage. Keep stages without reported progress indeterminate; downloaded files do not imply that model loading is complete.

Advanced download labels must inspect the selected model's complete cache inventory and sizes, or Chrome pack availability; never persist a completion flag or count a partial file as downloaded. Save a selection before preparation so failed preparation does not leave model information showing the old choice. Prepared model metadata without options identifies Chrome defaults only. Advanced readiness emits one completion notification from the service worker using the `notifications` permission; Stop, failed/stale preparation and automatic popup cache preparation must not notify. Notification failure must not fail model readiness.

## Verification and delivery

Language/model selectors use the local `jamak-select` CSS component and Chrome's native customizable select/picker. Preserve select IDs, labels, descriptions, values, change events and disabled states; do not replace them with a scripted dropdown. Keep the component's Norux semantic roles mapped to Jamak's existing theme/font rather than migrating unrelated UI. Verify open pickers, keyboard selection/Escape/Tab, both themes, 320px reflow and 200% zoom through the popup browser check.

`npm run dev` owns a build watcher, loopback conversation server on port 8790 and a Chrome for Testing instance. Keep its output/profile under ignored `.ralph/dev`, separate from shipping `apps/chrome/dist` and personal Chrome data. Automatically load only the development extension; never attach to or close another browser instance. Ctrl+C/browser closure must release the owned watcher/server/browser while preserving model caches. Port conflicts fail visibly without stopping the existing server. Extension reload after rebuild remains manual.

Dev startup must wait for Chrome's own first page when using custom launch arguments, then leave one conversation tab in one window. Close other restored pages only in the owned dev context; do not automatically open extension management. Let the launcher own SIGINT/SIGTERM cleanup instead of racing Playwright's signal handlers.

For streaming translators, validate every incoming recognition revision but keep the active source published until its translation stream finishes; coalesce newer same-language corrections for the next job so ongoing ASR cannot starve translated display. Language corrections and same-language bypass invalidate the old published source immediately. Keep exact source pairing and a shared published translation revision sequence across model chunks and same-language bypass. Verify multiple visible Korean changes within the same caption before the fixture's first spoken turn ends; a worker stream or a delayed published final alone is insufficient.

Run `npm run verify` for broad changes. For a scoped change, run the checks listed in `docs/testing.md` that demonstrate its behavior. Distinguish mocked display tests from real audio/model/browser verification. Report commands, failures and environment limitations honestly.

Keep package test scripts limited to the default suite and documented release, caption, speaker and conversation checks. Run focused unit tests with `node --import tsx --test tests/<name>.test.ts` and individual browser harnesses with `node tests/<name>.mjs` plus their mode flags; do not restore a package alias for every framework test or flag. Historical verification reports may refer to removed aliases.

For Japanese recognition or translation changes, use the non-looping two-voice `tests/fixtures/conversation/ja` fixture and `npm run test:conversation:ja:live`. Check final source/Korean meanings and actual display completion; preparation or a paired translation alone does not prove quality. Record remaining recognition/translation errors explicitly.

Use Conventional Commits with one intent per commit. Push, publish, rename a remote repository or modify external settings only when the user has authorized the action.

Chrome Web Store releases use `npm run release:chrome` with API V2 and private `.env.chrome-store` credentials; see [release setup](docs/releasing.md). The command uploads and submits for automatic publication after approval. It authenticates and reads the currently published remote version before verification/build, using an optional `patch`, `minor` or `major` positional argument (default `patch`). Use the highest published distribution-channel version; ignore local versions and failed/unsubmitted drafts, and never fall back to local when remote status/version is unavailable. Pending/staged submissions stop before model build or upload. Minor resets patch; major resets minor and patch. `-- --dry-run` requires credentials and performs only authentication/status requests, verification and packaging, restoring the source manifest. All release failures also restore it; only an accepted review submission retains the chosen version. Verification must pass before upload/submission. Do not update npm versions, commit or tag automatically. Check Dashboard → Why can't I submit? for missing permission justifications after a submission 400; do not assume upload failure or repeat uploads to resolve listing requirements. Never package credentials or release archives in `apps/chrome/dist`.

The main checkout owns the private release credentials. Orca can copy or link `.env.chrome-store` into new workspaces through its local shared-path setting. Keep these files Git-ignored and owner-readable only; do not print their values or assume a workspace copy follows later credential changes.

## Model quality and language selection

The popup persists the subtitle language independently of speech language. Propagate it through native pack checks, immutable preparation snapshots, translator workers, session pairing and overlay validation. Automatic mode needs the two other source-to-target pairs; same-language speech never invokes a translator. Legacy settings and snapshots default to Korean subtitles/shared Whisper detection/WeSpeaker.

Advanced offers the shared Whisper detector and a pinned one-pass VoxLingua107 ECAPA audio classifier. Laya/Kev/OpenJev/Clef/pplx-decider use text (or text/images), so they cannot replace raw-audio language detection before ASR. Do not add a text decision model under an audio-detector label. Preserve first-word PCM through the additional detector, retain uncertain audio and queued speech boundaries, and terminate both detector and ASR on cancellation. Manual modes do not load the independent detector. Report detection time separately from total recognition and visible-caption latency; separate classification can add total latency despite faster language judgment.

Advanced also exposes WeSpeaker or disabled speaker analysis; disabled means no download or embedding inference. Keep old implicit defaults compatible. Explicit selected-model failures must remain visible. Model pruning requires real same-fixture output and timing evidence, not parameter count or a download-only test. Keep removed candidates' pinned inventory only for reproducible audits and compatibility with focused historical harnesses; do not advertise them as supported choices.

The development launcher must register required TranslateKit pairs and SODA language packs in its owned profile before waiting for downloads. Preserve unrelated Local State settings. Its first-page wait includes the component-download budget. See `docs/verification/model-quality-20261025.md` for the current audit and new-model research.

Keep automated audio tests quiet: the current extension harnesses attenuate only offscreen playback to gain 0.005. Preserve captured PCM at the original level for valid recognition/quality measurements, and do not alter system volume or shipping playback behavior.
