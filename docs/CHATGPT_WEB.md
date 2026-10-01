# ChatGPT Web — Flowkit Studio 0.4.1

Based on the user's working Flowkit commit 680adb3. Existing Flow extension and
TTS changes are preserved. This integrates Draivix's extension architecture,
with adaptations described in integrations/chatgpt-gateway/UPSTREAM.md.

## Windows setup

1. Close Electron and any separately started backend. Back up the project and
   copy this complete release into it, preserving .venv, output and databases.
2. Run setup_desktop.bat once to install the additional local gateway dependency.
3. Run start_desktop.bat. Electron starts the backend and ChatGPT gateway.
4. Keep the existing Flow extension loaded from `extensions/googleflow/`.
5. In chrome://extensions choose Load unpacked AGAIN and select
   `extensions/chatgpt/`. These are TWO different extensions.
6. Open ChatGPT, sign in manually, and click the Flowkit ChatGPT Gateway toolbar icon.
   Select your tab and click **Use selected tab**. Keep that dedicated tab open; do not type
   into it during jobs. Select it again if you close/recreate the tab.
7. In Settings → ChatGPT Web, Refresh status and Test Connection. The test sends
   one real prompt. Connected alone only confirms the extension's socket.
8. In Script & Scenes select ChatGPT Web, select segments, Create Concepts.
   Leave Model blank/auto to use the model selected on ChatGPT. Optional model
   names are matched through the web model picker and may fail if it changes.

## Workflow and recovery

Up to 100 selected segments are queued in the existing concept_job table. One
request per segment is processed serially; this release does not add parallel
ChatGPT workers or multi-scene prompts. Each request starts a new chat in the
selected tab. Conversation history can be saved by ChatGPT; temporary mode is
not implemented. New chats include script context, adjacent segments and style.

The existing versioned scene_concept table receives strictly validated JSON.
Source edits during generation produce a STALE concept retained in history.
The local chatgpt_jobs.db audit stores prompts, raw responses (including returned
conversation URL and request ID), errors and timestamps. Settings shows the last
100 records. Records contain your script text and should be treated as project data.

A failed/uncertain request or invalid concept JSON pauses subsequent ChatGPT
work. Review the tab and Request History; manually save a recovered concept if
appropriate. Stop any still-running browser generation, then click Resume After
Review. This releases queued work but NEVER automatically resends the uncertain
job. To retry that segment, explicitly select it and create a new concept job.
Requests left RUNNING after a crash also require review on the next launch.
Cancel queued concepts remains available. Disconnected extensions leave queued
jobs waiting. A paused ChatGPT job at the head can delay later CLI concept jobs.

The gateway uses DOM input and reads DOM response text. Completion is inferred
from stable text plus absence of a Stop button; it is NOT a server completion
event. A changed website can break this inference. A timeout never returns partial
text as success. Settings records uncertainty; do not blindly retry batch jobs.
No actual account quota, parallelism or speed guarantee is made.

## Services

- Flowkit API: 127.0.0.1:8100; Flow extension WebSocket: 9222 (unchanged).
- ChatGPT gateway HTTP/WebSocket: 127.0.0.1:18790. Do not run upstream gateway on
  that port simultaneously. Electron checks gateway service/protocol identity.
- Electron stops only the gateway it started. An externally started gateway stays
  running. View Logs opens Electron's userData folder (backend.log and
  chatgpt-gateway.log). An old backend on 8100 triggers a startup warning.
- Linux/macOS: install backend requirements, npm ci in desktop AND
  integrations/chatgpt-gateway, then launch Electron from desktop.

## Verification

Automated tests cover real local HTTP/WebSocket relay using a fake extension,
request serialization, disconnect/review/recovery, DOM fixtures for completion
and partial timeouts, UI actions, JSON concept validation, database auditing and
NEEDS_REVIEW state. They do not prove live ChatGPT or Google Flow generation.
A signed-in Chrome integration test on the user's Windows machine remains needed.

## Extension controls (0.4.1)

Click the Flowkit ChatGPT Gateway toolbar icon to open its persistent side panel alongside the page. Both views share controls and state: ON/OFF, gateway status, worker status, tab picker, open/focus tab, reconnect, last request/error, completed count and activity log. The visual theme matches Flow Kit.

ON/OFF is saved across Chrome restarts. OFF lets an active request finish, then disconnects; subsequent queue work waits. It does not cancel a generation already submitted to ChatGPT. Reconnect and changing tabs are disabled while busy. Activity logs and counters are session-local, while Studio retains the request audit database.

## Selector update (0.4.2)

Prioritizes the supplied ProseMirror textbox with data-composer-markdown and Work with ChatGPT label, submit button labeled Send, and generation button labeled Stop. Previous selectors remain as fallbacks. Disabled or aria-disabled Send buttons are not clicked. Tests cover the supplied DOM shape, long prompts, disabled sending and unfinished responses. Live signed-in Chrome verification remains pending.

Load Google Flow from `extensions/googleflow/` and ChatGPT separately from `extensions/chatgpt/`. Reload the ChatGPT extension and refresh its browser tab after updating.

## Chat and Work input support (0.4.3)

Explicit selectors support both `Ask ChatGPT` and `Work with ChatGPT`. Hidden editors are skipped, including duplicate matching editors. DOM tests exercise both supplied editor variants with short/long prompts, disabled Send, Stop still present and a hidden duplicate editor. This verifies input handling with fixtures, not live account or complete Work-mode response compatibility. Refresh the ChatGPT tab after reloading the extension.

## Desktop prompt and response (0.4.4)

Open **ChatGPT** in the Desktop sidebar, enter a message and click **Send to ChatGPT**. A full response is displayed as plain text and can be copied. **Clear** resets the form and displayed answer, not the saved request audit. Requests share the gateway with concept generation. A busy gateway or review pause is shown as an error. No automatic retry occurs. Each send starts a new chat without previous-message context; this screen does not stream partial answers. Both prompt and response are retained in Settings → ChatGPT Web → View Request History. The prompt limit is 20,000 characters.

## Opening the correct panel (0.4.5)

In chrome://extensions, load or reload **Flowkit ChatGPT Gateway** from `extensions/chatgpt/` (extension version 1.3.0). Refresh the ChatGPT tab. Pin this extension through Chrome's Extensions menu and click its icon: Chrome opens the ChatGPT panel directly, with no popup step. The heading must read **FLOW KIT / ChatGPT**. A panel titled **Flow Kit Extension** with Refresh Token belongs to Google Flow. Keep that extension loaded separately from `extensions/googleflow/`. Chrome 116 or later is required.

This release also includes the Desktop **ChatGPT** prompt/response screen from 0.4.4. Restart the Desktop app and backend after updating.

## Response markup update (0.4.7)

Supports assistant-message markdown roots in the provided Chat/Work HTML, with the legacy assistant-role selector retained. Message IDs distinguish newly rendered answers even when virtualized history removes older turns. User bubbles and controls are excluded; paragraph breaks are preserved. Completion still uses DOM stability and the absence of Stop, not a server completion event. Tests cover the uploaded conversation fixture, old messages, a new message replacing a virtualized old one, and an unfinished response. Reload ChatGPT extension 1.3.1 and refresh its tab.
