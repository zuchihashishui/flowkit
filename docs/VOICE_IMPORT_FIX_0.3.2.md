# Voice import fix — 0.3.2

Based on zuchihashishui/flowkit main at 3a4f476. Preserves the user's TTS changes.

## Changes

- Electron reads both JSON and plain-text backend errors, including HTTP status.
  Voice and script audio imports no longer hide HTTP errors behind JSON syntax errors.
- Voice metadata uses explicit UTF-8, accepts UTF-8 BOM, and is replaced atomically.
- Invalid metadata remains untouched and produces an actionable JSON error.
- Audio import reports directory, FFmpeg, missing executable and timeout errors.
  Cleanup failures are logged without hiding the original error.

The original Windows backend traceback was not available. This release fixes
confirmed error-handling and encoding defects; it does not claim to establish
which server exception occurred on the user's machine. Existing malformed or
non-UTF-8 templates.json files are preserved and need inspection if reported.

## Verification

- 22 desktop backend tests passed, including real FFmpeg WAV import, Unicode
  transcript, corrupt/BOM metadata, failed atomic replacement and directory errors.
- 5 main-process IPC tests passed, including plain-text 500, empty 502 and JSON
  error responses through the actual import-voice handler.
- main.cjs syntax check passed.
- No native Windows or OmniVoice model inference test was performed.

## Update on Windows

Close Electron and its backend. Extract the complete ZIP and copy source files
into the existing project. Preserve .venv, output, database files and your local
configuration. Launch start_desktop.bat again. No dependency changes are required.

If import still fails, send the complete new error. The backend traceback is in
Electron's userData/backend.log (normally under %APPDATA%/flowkit-studio on Windows).
Do not delete output/_shared/tts_templates/templates.json to work around an error;
it contains saved voices and their transcripts.
