# ChatGPT Web — Flowkit Studio 0.6.0

This release adds a fixed pool of up to three Chrome tabs, verified Temporary Chat,
and a durable Desktop batch queue. Google Flow and TTS implementations are preserved.

## Upgrade and setup

1. Back up databases and output. Close the Desktop app, old Python backend and any
   separately launched ChatGPT gateway. Protocol 2 requires the new backend,
   gateway and ChatGPT extension together. Install all 0.6.0 components; older
   protocol-2 processes do not provide the new inspection endpoints.
2. Copy this source, preserving your `.venv`, output and databases. Run
   `setup_desktop.bat` if gateway dependencies have not been installed, then
   `start_desktop.bat`. No new Python or npm dependencies are required for 0.6.0.
3. Reload **Flowkit ChatGPT Gateway 1.5.0** from `extensions/chatgpt/` in Chrome.
   Refresh any already-open ChatGPT tabs. Google Flow remains a separate extension
   in `extensions/googleflow/`.
4. Click the ChatGPT extension toolbar icon to open its side panel. Click
   **Prepare 3 tabs**, or choose 1–3 existing ChatGPT tabs and **Assign selected tabs**.
   Prepare reuses assigned tabs and creates only the missing tabs, up to three.
5. Ensure ChatGPT is usable in those tabs; sign in manually if required. Keep
   them open and do not manually chat in them during jobs. Turn the bridge ON.
6. In Desktop → **ChatGPT**, choose 1, 2 or 3 workers, response timeout and
   conversation mode, then **Save settings**. Defaults: 3 workers, 180 seconds,
   verified Temporary Chat. Begin with one small job before a large batch.

## Chat / Work composer mode

In the extension side panel, choose **Composer mode → Chat (default)** or **Work**.
The choice is saved automatically across extension restarts and applies to all
worker tabs when a new job starts. Pause the queue in Studio and wait for active
requests before changing it; changes are rejected while requests are running.
Refresh existing ChatGPT tabs after reloading the extension.

Before enabling Temporary Chat, selecting a model or typing, the extension finds
`[role="group"][aria-label="Composer mode"]`, clicks the visible button whose text
matches Chat or Work, and verifies `aria-pressed="true"`. It waits up to 10 seconds
for the selector/state. Missing, disabled or unconfirmed modes fail before typing.
This setting is distinct from Studio's Temporary / Regular conversation setting.
Work does not silently disable Temporary Chat. If the page cannot confirm Temporary
Chat in Work, choose Chat or explicitly select Regular chat in Studio.

Selector behavior is covered by DOM tests, not a live Chrome end-to-end test.

## Optional model and reasoning selection

Desktop → ChatGPT has three choices, shared by **Send** and **Add to queue**:

- **Use current model** (default): does not open or change the model/effort picker.
  It uses whatever the website shows after the worker opens its new conversation
  and applies Chat / Work and Temporary / Regular settings. Different tabs may
  have different current models; this is not a pinned model.
- **Choose a model**: enter the exact model label from your account's menu,
  for example `GPT-6 Astra`. Select **High** separately under **Reasoning effort**
  to request both. Leave **Keep current effort** to avoid explicitly changing effort;
  the website may choose its own effort when changing model.
- **Use extension preference**: use the saved **Model preference** from the extension
  side panel. That panel defaults to **Use current model** too. Save a custom choice
  with **Save model preference**. Desktop's current/custom choices override this
  preference, so an old saved extension choice cannot silently change a default job.

Extension preferences persist; Desktop choices apply to the prompts submitted from
that window. Queued custom choices are stored with each job. Extension preferences
are resolved when each job starts; pause the queue before changing them. Changing
preferences is rejected while worker requests are active.

The UI accepts arbitrary exact model names; its Astra suggestion comes from the
supplied HTML, not an account-wide availability list. The effort labels also come
from that trigger's attributes; not every model/account supports every effort.
API callers can pass `model: "auto"` to keep the website selection,
`model: "extension"` to use the saved preference, or
`model: "GPT-6 Astra :: high"` to request a model and effort. Model strings are
limited to 100 characters. Existing concept model fields can use the same syntax
when ChatGPT Web is the provider.

Selection targets the observed `button[aria-label="Select ChatGPT model"]`
(`data-codex-intelligence-trigger`), not a generic menu button. The extension
separates the current model label from `data-selected-reasoning-effort`; hidden
animated labels such as Ultra do not prove that Ultra is selected. It searches
visible menu options for an exact label and verifies the updated trigger before
sending. Missing, ambiguous, disabled or unconfirmed choices fail before submission.
Model selection runs after Temporary Chat setup to avoid a setup reset, with a
10-second selection budget. No unavailable-model fallback is sent automatically.

The uploaded page contained a closed trigger and no open menu markup. Tests cover
that actual trigger with simulated menu options, settings forwarding and batch
requests. Live menu compatibility is not yet confirmed. If selection fails, supply
the HTML after opening the model menu (and the effort submenu if present).

## Refresh models and check worker tabs

Both Desktop and the extension expose **Refresh models** and an **Observed models**
dropdown. Discovery opens the first assigned worker's model menu without selecting
a model or sending a prompt. It reads enabled model-shaped options and supported
model attributes, explores recognized Model / Effort submenus, and restores the
picker's closed state if it opened it. The current model is included. Results are
explicitly partial: arbitrary layouts, collapsed submenus and account differences
may hide choices. Custom exact-name entry remains available. A missing menu reports
that only the current model was detected; this is not a complete account catalog.
Reasoning options are observed for the current menu, not guaranteed for every model.

**Check worker tabs** inspects assigned tabs without navigating, typing, changing
Chat / Work or sending a prompt. It checks visible input and Send controls, page
alerts, generation state, composer-mode availability, Temporary Chat availability
when requested, and the requested model/effort when one is specified. A disabled
Send button is expected on an empty editor. Reports show pass/fail per check/tab.
Desktop uses saved Studio conversation settings and the current model form. The
extension check uses its saved model preference and its **Require Temporary Chat**
checkbox. Make sure settings are saved before checking.

These are availability checks on the current page, not proof that the next job
will succeed. The actual job navigates to a new chat and verifies all settings again.
For mode-specific models, open that mode in the tabs before running the check.

Desktop's **Check worker tabs before adding this batch** is enabled by default.
A failed check preserves the pasted prompts and does not enqueue them. Pause and
wait for active jobs, and review held workers before inspection. To append to a
running queue without inspection, explicitly uncheck that option. Direct API queue
calls and storyboard submissions do not automatically invoke preflight; their jobs
still perform the normal per-job verification. API clients may call
`POST /api/chatgpt/preflight` with a model first; discovery is
`POST /api/chatgpt/models`.

Inspection temporarily blocks dispatch in both gateway and extension. A race rejected
before submission is returned as known-not-submitted, so queued jobs remain queued.
Each tab inspection has a 5-second deadline; gateway control allows 20 seconds.

## Worker progress and completion checks

Side panel and Desktop display phases such as OPENING TAB, SELECTING MODE,
ENABLING TEMPORARY, SELECTING MODEL, TYPING, SENDING, THINKING, USING TOOLS,
GENERATING, WAITING COMPLETION, VERIFYING COMPLETION and AWAITING SAVE. The website
must expose recognizable status indicators to distinguish Thinking / tool activity;
otherwise the extension reports the broader Generating or Waiting state.
Desktop also shows character count and time since the last text change. Progress
contains metadata only; no partial answer is displayed as a completed result.
Updates are correlated by request ID and sending tab ID. Late/wrong-tab updates
cannot overwrite another worker's progress. The UI refreshes every three seconds.

A stable string alone is no longer accepted as completion. A new assistant message
must have a final-assistant marker or recognized response action controls in its
own response container. Stop, busy, Thinking or tool activity blocks completion,
then four stable polling checks are required. Hidden Stop controls do not block.
Errors shown in supported page alerts stop the job. Missing completion evidence
leads to timeout and review, never an automatic partial-success result or resend.
These are conservative DOM heuristics, not a server-issued completion event.

## Temporary Chat

The supplied `button[aria-label="Temporary chat"]` is clicked BEFORE typing.
The extension then requires positive evidence: an active toggle (`aria-pressed=true`
/ `data-state=on`), an explicit exit/turn-off label, or a visible Temporary Chat
heading. Where offered, it selects Unpersonalized. The button's presence alone
and a URL parameter are NOT confirmation. The state is rechecked before Send.

If confirmation is missing, no prompt is sent and that worker requires review.
Share the HTML AFTER enabling Temporary Chat if your layout has different active
indicators. Work mode may not expose this feature; do not assume that it does.
You may explicitly select Regular chat in Desktop; that mode keeps normal history.
There is no automatic fallback to Regular and no automatic deletion in this release.
Temporary chats must not be explicitly saved on the website if you want them to
stay out of history. Local Flowkit audit and results are stored independently.

## Batch prompts

Paste either a JSON array of prompt strings, or separate multiline prompts with
a line containing only `---`. Click **Add batch to queue**. Each batch accepts
1–200 prompts, each up to 20,000 characters. After the optional preflight passes,
prompt/model data is saved;
worker count, timeout and mode are taken from current settings when a job starts.

Example:

```text
Write an image concept for a rainy Tokyo street.
---
Write an image concept for a sunrise over Mount Fuji.
```

The worker that finishes first takes the next eligible job. Results stay attached
to batch/ordinal/job IDs even when responses finish out of order. The UI shows the
latest 1,000 jobs, worker status and elapsed time, counts, full prompt/answer/error,
selection, cancel queued jobs, explicit retry and JSON export of up to 200 selected
jobs. Older rows remain in the database. View Request History shows the last 500
audit records, including direct messages and storyboard requests.

The single-message form also uses this pool and may report Busy if no tab is free.
It displays the full completed answer, not partial streaming. Each job starts a
new conversation; previous jobs are not conversational context.

## Script & Scenes

ChatGPT Web concept generation accepts up to 200 selected segments. Its existing
concept queue and the Desktop prompt queue share the same three-tab capacity.
Concept responses are validated before acknowledging the worker. Image/video
submission limits and the Google Flow worker are unchanged. CLI concept providers
remain available.

## Persistence and recovery

`chatgpt_jobs.db` retains the existing audit table and adds settings and a batch
queue without deleting old data. The backend stores raw responses and completed
answers transactionally BEFORE the gateway sends a save acknowledgement to the
extension. A worker stays AWAITING_SAVE until acknowledged; its tab cannot be
navigated to a new job prematurely. If acknowledgement fails, the saved result
remains COMPLETED and the worker stays held for review. Never resend it merely
because release failed.

- Pause stops new dispatch; active jobs finish and save.
- One uncertain worker is quarantined; other idle workers may continue.
- A detected account usage-limit alert pauses dispatch for the whole gateway.
  Detection depends on visible page alerts and is not a quota guarantee.
- Timeouts/disconnections do not automatically resubmit jobs or press Stop.
- Check uncertain tabs and stop any generation manually. Then **Release workers
  after review**. Active requests must finish first. Release does not retry jobs.
- If a worker tab was closed, replace its assignment in the side panel after
  reviewing the old job, then release reviewed workers in Desktop.
- Backend restart changes interrupted jobs to NEEDS_REVIEW and pauses the queue.
  Extension restart similarly preserves uncertain worker state. Queued jobs stay
  queued. Review, release, then Resume queue. Use Retry selected only deliberately;
  it creates a new job, preserving the original attempt.

## Time limits and protocol

- Response polling: every 1.5 seconds; positive completion evidence, no active
  generation/tool indicators and four stable checks are required. This remains a
  DOM heuristic, not a server completion event.
- Response timeout: configurable 30–600 seconds, default 180.
- Tab ready wait: up to 30 seconds; Temporary Chat verification: up to 10 seconds.
- Gateway deadline: configured response timeout + 65 seconds for preparation.
- Backend HTTP deadline: response timeout + 90 seconds; Desktop: 720 seconds.
- One extension WebSocket, up to three correlated in-flight requests. Request ID
  and worker ID must match. Errors hold the affected worker; wrong/late IDs are ignored.
- Services: backend 127.0.0.1:8100; Google Flow bridge 9222; ChatGPT gateway 18790.
  Gateway protocol is 2. The Desktop checks service identity before reuse.

## Verification limits

Automated tests use the real local HTTP/WebSocket gateway with a fake extension,
actual content/background scripts with browser mocks, and supplied DOM fixtures.
The 150-request tests verify three-worker capacity, response correlation and
save-before-reuse. Python tests cover database persistence, explicit retries,
crash recovery and capacity rejection; UI tests cover batch submission/export.
Release 0.6.0 checks: 81 Desktop/extension tests, 4 gateway tests and 13 targeted
Python tests pass. These include inspection/dispatch exclusion, model discovery
without selection, failed preflight preserving prompts, progress correlation,
partial-only output, delayed final markers, Thinking/tool indicators and resumed
streaming. No new test is a live browser/account test.
These do not prove live ChatGPT concurrency, Temporary Chat DOM behavior on every
account, account quota, response quality, or Windows Electron execution.
No live three-tab ChatGPT success is claimed. Google Flow code was not modified.
