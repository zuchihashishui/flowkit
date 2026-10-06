# Backend recovery — Studio 0.7.19

## Why the warning persists after restarting Studio

Older Studio versions reused any responding backend on port 8100. A reused Python
process belongs to the console or app that originally started it. Closing Studio
does not close that external process. Updating files on disk does not reload its
Python modules either. The browser showing Bridge 1.0.16 confirms the extension
version, not the running backend version.

The 0.7.18 full source archive contains the four capabilities required by Studio
0.7.18. The fresh-tab workflow adds `elevenlabs_auto_prepare_tab` in Studio 0.7.20. A missing
capability report can indicate a stale process or mixed source folders. Studio
0.7.19 reports the missing capabilities, PID, source location, and Python location
instead of leaving only an instruction to restart.

## Recover on Windows

1. Stop other generation and concept-writing work. Close Studio, update the complete
   source in the same project folder, and reopen `start_desktop.bat`. Preserve your
   databases, `output/`, and Python environment. If upgrading from 0.7.18 with a
   working setup, dependencies have not changed; setup is not required again.
2. On the **ElevenLabs** page, inspect the backend warning. **Studio source** is the
   folder you just opened; **Backend source** describes the serving process where
   available, or the checkout verified from its process command.
3. Click **Restart local backend** when enabled. The app pauses ElevenLabs, Desktop,
   and ChatGPT queues, checks reported activity, stops only the verified local
   backend, starts the updated source, and verifies the new process identity.
4. Use **Check backend** to refresh diagnostics. Existing review jobs still need
   **Release after review**; restart never retries or resumes them automatically.
   Resume each queue only when you are ready.

If restart is disabled, the reason appears beside the button. A different checkout,
unrecognized command, reload supervisor, ambiguous listener, or insufficient Windows
process information is not stopped automatically. Close that backend's console with
Ctrl+C, then close and reopen Studio from the updated folder. A backend source folder
that is still old must be updated before it can be restarted successfully.

The app does not delete databases, audio, or Chrome downloads. The existing
[ElevenLabs guide](ELEVENLABS_EXTENSION.md) explains recovery of saved downloads.

## Implementation limits and validation

Restart is an Electron IPC action, not a new network shutdown endpoint. On Windows,
it checks the unique listener, executable, exact module command, process creation
identity and, where applicable, the direct venv launcher parent. These are checked
again immediately before stopping. Shared Python without verified source identity,
unrelated applications, and unknown process commands are refused.

New Desktop-started backends use `GLA_RELOAD=0`. A failed health request on Windows
must not cause another backend to spawn while the port still has a listener. After
restart, a compatible response alone is insufficient: source root and serving PID
must match the newly started process (or its verified venv child).

Windows venv redirectors are handled because they can launch a base Python child
with the original command line. Reference: CPython's
[venv launcher implementation](https://github.com/python/cpython/blob/main/PC/venvlauncher.c).

The helper checks ElevenLabs activity, desktop image/video/voice jobs, legacy Flow
pending/processing requests, direct Flow submissions, and ChatGPT worker/queue/audit
activity. Stop other API callers and storyboard CLI concept-writing tasks before
restarting; older backends do not expose a global activity lock for those operations.

Release validation: **529 Python tests and 231 JavaScript/UI tests passed**;
JavaScript syntax and diff checks passed.

Automated tests cover ownership refusal, venv parent/child identity, startup port
conflicts, PID changes, active-job rejection, paused queues, single restart, IPC
caller validation, and editable UI preservation. Windows process commands are tested
through an adapter; a native Windows restart and paid generation were not executed
in the development environment. No ElevenLabs or ChatGPT extension code changed in
0.7.19.

## Queue recovery after restart

- ElevenLabs, ChatGPT text/concept jobs and SRT jobs quarantine uncertain submissions for manual review. A restart does not blindly send paid work again.
- Desktop Google Flow jobs with saved provider results can resume polling/downloading those results. Jobs without a confirmed result require review.
- The legacy `/requests` worker follows the same rule: only video/reference-video/upscale requests with a saved provider operation ID are resumed by polling. Uncertain requests appear as **Failed** with a `NEEDS_REVIEW:` error because the legacy database status enum has no separate review state. Existing media IDs, URLs and operation IDs are retained. Inspect Google Flow and local files before manually retrying these requests.
- Local WhisperX jobs become **Interrupted**. **Retry job** creates a separate attempt using the saved source/options; completed JSON remains unchanged.
- Local assembly renders can resume verified scene checkpoints. Image-motion settings are part of image checkpoint identity.
