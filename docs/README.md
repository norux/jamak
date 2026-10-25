# Jamak documentation

- [Privacy policy](../PRIVACY.md): local audio/text/speaker processing, memory history and external model downloads.

- [Architecture](architecture/media-framework.md): shipping Chrome runtime, data flow, models and planned platform boundaries.
- [Coding conventions](coding-conventions.md): implementation rules and documentation synchronization.
- [Testing](testing.md): repeatable checks and real-browser prerequisites.
- [Chrome Web Store releases](releasing.md): one-time OAuth/store setup, one-command submission and local packaging checks.
- [Brand assets](branding/README.md): extension icons and README mark.
- [Model quality audit and research](verification/model-quality-20261025.md): measured model screening, subtitle targets and fast audio language decisions.
- [Model selection verification](verification/model-options.md): Advanced settings, independent local model choices and real inference checks.
- [Chrome transition verification](verification/jamak-chrome.md): build, tests and branding checks.
- [Automatic language verification](verification/asr/automatic-language.md): per-turn English/Japanese/Korean routing, real synthetic meeting and latency limits.
- [Speaker and caption verification](verification/captions/conversation-speakers.md): model choice, attribution and conversation regression evidence.
- [Japanese conversation verification](verification/asr/japanese-conversation.md): two-voice fixture, recognition/translation fixes, real Chrome evidence and remaining errors.

Older files under `verification/` preserve historical measurements. Reports mentioning the removed Python server, companion app or legacy `extension/` build describe previous implementations, not supported Jamak features. Use the current documents above for development and installation.
