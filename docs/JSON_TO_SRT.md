# JSON to SRT — Studio 0.7.48

## What changed

New jobs use **source-boundaries-v1**. ChatGPT chooses how to group the transcript
into scenes. Studio constructs each subtitle from an immutable copy of the
source text and its timing. ChatGPT does not write the subtitle wording or
invent new timestamps.

This release preserves the existing single SRT worker: one fresh ChatGPT tab in
its own window, automatically bound, **Work / Temporary OFF**, with the requested
model (default `GPT-6 Astra`). The extension receives the ordinary prompt + JSON
attachment transport. The three reusable Text to Prompt workers remain separate.
After the response is validated and the SRT is saved, the existing save
acknowledgement releases and closes the managed SRT tab. Uncertain requests stay
held for review. Closing a tab does not delete a regular ChatGPT conversation.

Stage transitions remain manual. Completing SRT does not start prompt creation,
image generation or video assembly.

## Update and use

1. Close Studio, replace the complete source with 0.7.48, and restart Studio and
   its backend. Keep your databases, output files, environment and settings.
   This release does not change the extension code or add dependencies; if you
   are already on the 0.7.47 extensions, no extension reload is required.
2. Select the active project in **Project**. One project represents one complete
   video. Sources and jobs follow that project selection.
3. Open **SRT**, or click **Create SRT** on a completed WhisperX result. Select
   its JSON or use **Choose JSON file**. Source selection works even while the
   ChatGPT bridge is disconnected.
4. For old JSON without full audio duration, optionally enter the measured
   **Exact audio duration (seconds)**. This value belongs to the selected source
   and is cleared when you select another source or project.
5. Click **Check transcript**. This is local validation; it sends nothing to
   ChatGPT. A blocked source must be corrected. Warnings identify limitations
   that remain visible in the eventual result.
6. Edit the scene-grouping instructions, or click **Use scene-boundary template**.
   Saved custom prompts are preserved. Studio appends a mandatory output
   contract: choose unit IDs only, preserving all input content. Instructions
   asking for rewritten text, an SRT block or a download link are superseded.
7. Set the exact model label shown on your page; `GPT-6 Astra :: High` requests
   High effort, and `auto` keeps the page model. Your browser account must have
   the requested mode/model. Click **Create SRT**. The source is checked again
   and snapshotted before the job enters the queue.
8. When complete, use **Preview SRT**, **Quality report** or **Save SRT as…**.
   A passing result can be imported as scenes or used in assembly. For a report
   marked **REVIEW**, inspect the exceptions against the audio, then explicitly
   **Accept reported exceptions for this SRT** if appropriate. You can export
   the SRT for inspection before accepting exceptions.

## Quality report

| State | Meaning | Next-stage behavior |
|---|---|---|
| READY | Source checks found no warnings or errors | Can queue generation |
| BLOCKED | Inconsistent source or invalid model boundary response | Cannot produce/use a new valid SRT |
| PASSED | Output preserves complete source content and passes timing checks | Import or assembly available |
| REVIEW | SRT was saved with explicit source/timing limitations | Review and accept exceptions before handoff |
| LEGACY | Existing job uses the earlier SRT-response workflow | Remains usable; not retroactively marked validated |

The report shows source units/characters, missing timing, audio-duration source,
content coverage, a continuous timeline, scene count, shortest/longest scene,
and a table of source text with each scene's timing. It flags durations outside
3–15 seconds. Japanese/Chinese alignment units may be characters, not words.

**These checks establish consistency with the supplied transcript.** They do
not prove ASR accuracy, verify the spoken content against the audio, or judge
whether every semantic boundary is natural. A user-supplied duration or imported
JSON duration is recorded as source information, not independently measured.

Exceptions are retained after acceptance. Acceptance is saved in the database;
`quality.json` records the original checks. This local review is distinct from a
ChatGPT worker's **NEEDS_REVIEW** state. A completed SRT with quality warnings
has already been saved and acknowledged; accepting its warnings does not send
another ChatGPT request.

## Source and boundary rules

- Input may be a WhisperX object or a list of transcript segments. Timed
  `segments[].words` is preferred. A duplicate top-level `word_segments` list
  is not appended. If nested alignment is absent, flat word alignment is
  matched to the original segment text.
- Segment text is the original wording. Punctuation and unmatched source text
  are retained. Missing alignment becomes an untimed unit with a warning;
  Studio does not discard the text or estimate a timestamp from character count.
- If only timed segments are available, each segment remains one unit and a
  warning explains that it cannot be split using word timing. If only flat
  words are available, their wording is preserved, but completeness against
  absent segment text cannot be established.
- A mismatch between alignment words and source text, backwards start times,
  invalid numeric timestamps, empty content, or inconsistent full audio
  duration blocks generation. Missing timing and overlapping alignment are
  reported; only known, non-overlapping start positions can become boundaries.
- The attachment contains indexed units, timing in integer milliseconds,
  eligible start positions, duration and a source hash. It omits duplicate
  alignment and a duplicate full-text copy.
- ChatGPT returns exactly one JSON object with `schema_version: 1`, the same
  `source_sha256`, and `scene_end_unit_ids`. IDs must be strictly increasing,
  start coverage at unit 1, and end at the final unit. Extra rewritten text or
  timestamps are rejected. The raw response is retained for review.
- Studio concatenates the source units for every scene. Whitespace is normalized
  for subtitle layout; the exact non-whitespace character sequence must match
  the original source. Every unit is covered once, in order.
- The first scene starts at zero. Each intermediate boundary is the known start
  time of the next scene's first unit. The final scene ends at full audio
  duration when available. This allocates pauses to the preceding scene and
  keeps the timeline continuous, without inventing spoken text.
- New WhisperX results include `metadata.audio_duration_seconds`, measured from
  decoded audio samples. For older results linked to a WhisperX job, Studio can
  recover saved `progress.audio_seconds` without modifying the original file.
  Otherwise it uses the last aligned end and flags the **unverified audio tail**.
- SRT uses UTF-8 and `HH:MM:SS,mmm --> HH:MM:SS,mmm` timestamps. Values are rounded
  to milliseconds once. A hash mismatch, incomplete coverage, invalid selected
  boundary or zero-length scene fails the model response; no SRT is reported as
  successfully generated.

## Queue, recovery and compatibility

SRT remains sequential with one dedicated worker. Text to Prompt has its own
three slots. Bridge ON, account readiness and queue pause still govern dispatch.
The job list explains queued waits. Do not enqueue a second copy merely because
an existing job is waiting for a connection or worker.

Default generation timeout is 30 minutes, adjustable from 1–30 minutes. Page
preparation and upload have separate bounded waits. JSON attachment verification
waits up to 120 seconds. This release does not change those browser waits.

A successful response is saved before the gateway sends the worker its save
acknowledgement. A malformed or uncertain response becomes **NEEDS_REVIEW** and
is never automatically submitted again. Inspect the saved response and the
worker tab, release the worker after review in ChatGPT settings, and create a
new job only when appropriate. Queued jobs can be cancelled.

Jobs that already existed before 0.7.48 retain the legacy SRT code-block
transport, including queued jobs. Existing files are not regenerated, erased or
claimed to have passed the new checks. New jobs use source-boundary mode. If
checks are unavailable on a stale backend, Studio stops before creating the new
job and asks you to restart the updated backend.

## Files and APIs

Imported JSON is copied to `output/srt/<source-id>.json`. Each new job stores:

| File | Purpose |
|---|---|
| `output/srt/<job-id>/source-plan.json` | Immutable indexed source, original text, hashes and source checks |
| `output/srt/<job-id>/response.txt` | Complete model response, including invalid responses |
| `output/srt/<job-id>/quality.json` | Original output checks and scene mapping |
| `output/srt/<job-id>/subtitles.srt` | Validated, locally built subtitles |

Jobs and approval state are stored in `srt_jobs.db`. Quality data uses a separate
`srt_quality` table, preserving the old job schema. List polling loads a compact
quality summary rather than every scene's text. Project ownership and exact
source references remain in the existing resource scope.

New endpoints, shared by Electron and future web/CLI clients:

- `POST /api/srt/analyze`: source ID, project context, optional `duration_seconds`.
- `POST /api/srt/jobs`: existing request plus optional `duration_seconds`.
- `GET /api/srt/jobs/<id>/quality`: full report and approval state.
- `POST /api/srt/jobs/<id>/approve`: `{ "reviewed": true }` for a completed result
  with reviewable warnings. Blocked results cannot be approved.

JSON and the prepared attachment are limited to 16 MiB; prompt to 100,000
characters; source to 100,000 alignment units. Model/account context and upload
limits still apply. The subtitle preview shows the first 20,000 characters;
export includes the full file. The quality UI displays up to 200 findings and
1,000 scenes; the stored report contains the complete results.

## Verification for this release

All 132 targeted checks passed: 92 Python checks and 40 Electron/extension/IPC
checks. The assembly regression suite includes real local FFmpeg renders;
browser interactions use simulated pages. JavaScript syntax and patch
whitespace checks also passed.

Targeted automated coverage includes:

- Exact Japanese wording, punctuation, duplicate alignment, missing words/times,
  invalid numeric timing, unknown audio tail and explicit duration overrides.
- A synthetic 10,000-unit Japanese transcript converted into 200 scenes, with
  all units preserved and a continuous 2,000-second timeline.
- Invalid/incomplete boundary IDs, mismatched source hash and attempted rewritten
  text; none is saved as a successful SRT.
- Actual local service/gateway code with simulated HTTP model responses:
  immutable snapshots, save-before-acknowledgement, warnings and next-stage
  review, invalid-response retention, and pre-existing job compatibility.
- WhisperX duration metadata, API/IPC routes, project ownership and handoffs,
  Electron source selection, custom prompts, reports, review controls and stale
  asynchronous responses after a source/project change.

These are automated tests with fixtures and simulated browser/model responses.
They are not a live signed-in ChatGPT run, native Windows Electron validation,
or a ten-video production trial. Semantic grouping on real long transcripts
still needs to be checked against actual ChatGPT output and the source audio.
