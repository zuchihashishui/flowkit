# Project layout

- `agent/`: Python API, services and workers.
- `desktop/`: Electron application and English UI.
- `extensions/googleflow/`: existing Google Flow extension (Google Flow only).
- `extensions/chatgpt/`: separate ChatGPT extension, popup and side panel.
- `extensions/elevenlabs/`: ElevenLabs Text to Speech extension, side panel and local WebSocket bridge.
- `integrations/`: local gateway services.
- `docs/architecture/`: architecture references.
- `docs/archive/`: historical plans and pipeline reports.
- `tools/diagnostics/`: manual TTS and video diagnostics; review sample paths and IDs before running. These are not automatic tests.
- `examples/tts/`: example request payloads.
- `tests/`: automated regression tests.

Root entrypoints (`start_desktop.bat`, `setup_desktop.bat`, `setup.sh`, `setup.py`), dependency manifests, pytest configuration, README, LICENSE and CLAUDE instructions stay at their established paths for compatibility. Runtime databases and output stay where existing installations expect them.

When upgrading by copying a ZIP over an older checkout, old moved files may remain at the root. You can remove the old copies of ARCHITECTURE.md, PLAN.md, PIPELINE_RESULT.md, _gen_tts.py, _gen_tts2.py, test_tts_direct.py, tts_request.json and RETRY_VIDEOS.ps1 after confirming the new folders exist. Back up your databases and output first.

All browser providers now live under `extensions/`. See [migration instructions](../extensions/README.md) when updating from the old root `extension` folder. Each provider is loaded as its own extension. ElevenLabs audio and queue state are stored separately from local OmniVoice.
