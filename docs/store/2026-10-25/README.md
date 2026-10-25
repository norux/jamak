# Chrome Web Store assets · 0.2.1

Fresh 1280×800 RGB PNG captures of the actual merged extension on synthetic text images. OCR, local language classification and Chrome TranslateKit are real; no recognized/translated outputs are substituted. The source page is a controlled demonstration fixture. No personal images, browser profile, credentials or model weights are included.

| File | Actual feature shown |
| --- | --- |
| `01-image-translation.png` | English/Japanese images with Korean page overlays |
| `02-caption-editor.png` | Pencil-opened original/translation correction popup |
| `03-movable-captions.png` | Dragged caption and original-position return action |
| `04-japanese-output.png` | Japanese output and same-language bypass |
| `05-model-settings.png` | Native OCR picker and shared preparation controls |

`capture-manifest.json` records the source commit and capture hashes. `listing-ko.txt` is the saved Korean store description. `privacy-justifications.json` records the updated single purpose and permission explanations; `host-permission.txt` is the longer OCR host rationale. Existing icon/promo assets, visibility and account settings were preserved.

## API delivery

The feature was merged in PR #3 (`6e86d0a`). The authenticated release command read published version 0.2.0, selected 0.2.1, passed `npm run verify` (246 tests plus caption stability), built and uploaded the package. Initial review submission returned HTTP 400; Dashboard → Why can’t I submit? identified a missing host-permission justification. After saving the listing images, description and permission explanations, API V2 `:publish` submitted the already-uploaded package without another upload. It returned `PENDING_REVIEW` on 2026-10-25 at 05:56:55 UTC. Approval publishes automatically; acceptance is not proof of public availability.

Package SHA-256: `16aa491e66887f5030a6f2611909b2306d23b51c668f11e14d06d5ce624076a8`.

## Additional verification and limits

The existing channel/overlay/live-audio harnesses had obsolete assertions that no host permission existed. They now assert the exact official OCR host rather than broad access. The channel check passed. The live Japanese run exercised actual SODA/TranslateKit, produced 18 final captions, visible streaming and no page errors, with CER 7/357 (1.96%); its quality gate failed on one source phrase: `まだ行ってないよ` was recognized as `まだ大人ってないよ`. Korean meaning-anchor checks reported no missing details. This is a remaining native recognition error, not a passing quality gate.

The historical synthetic fullscreen overlay harness timed out waiting for a final caption correction at `tests/framework-chrome-overlay.mjs:161`, on both attempts. Earlier geometry, resize, fullscreen placement and lifecycle checks passed; no product code or timing assertions were weakened to hide the failure. The default caption-stability suite and real image/native translation checks remain passing. This release does not claim universal transcription, translation or handwriting accuracy.

README, AGENTS, PRIVACY, architecture and coding conventions were reviewed: the image capabilities, unified settings behavior, model permissions and limits already match this release. This follow-up changes release assets/version and legacy test permission assertions; it adds no runtime capability or data handling.
