# Flowkit Studio 0.7.18 stability review

This release consolidates backend, Electron, and browser-extension fixes after
reviewing the current source and running the repository's automated suites.
It is a full source release, not a Windows installer.

## Included versions

| Component | Version |
|---|---|
| Studio | 0.7.18 |
| ElevenLabs Bridge | 1.0.16 |
| ChatGPT Bridge | 1.5.1 |
| Google Flow extension | 0.6.0 (unchanged; transport fixes are in the backend) |

## Confirmed defects and changes

| Area | Defect | Change |
|---|---|---|
| ElevenLabs queue | Every error entered review, including confirmed failures before Generate. | Pre-submit errors become Failed + paused. Uncertain submissions still require review. |
| Worker status | A review lock appeared busy; release could leave stale UI state. | Separate processing/review fields; successful review clears the lock immediately. |
| Editor input | ProseMirror selection could lag and its plain-text parser collapsed blank lines. | Synchronize selection; paste escaped HTML with explicit breaks plus plain text through the editor handler. Verify the retained document. |
| Page preparation | Closed Settings, voice-label whitespace, and transient hydration could fail preparation. | Open Settings when needed, normalize labels, allow a transient voice mismatch, and prefer the page's Clear text transaction. |
| Download persistence | Failed import lost the download-to-chunk association. | Persist native download metadata before copying; recover recorded downloads without generating again. |
| Electron UI | Native review dialogs, disappearing feedback, stale polling, and submission races obscured state or affected editing. | Inline confirmations, local errors, polling synchronization, exact script snapshot, and editable draft preservation. |
| Backend compatibility | A running old backend could be reused silently with newer UI/extension code. | Feature checks expose an upgrade message and block incompatible ElevenLabs actions. |
| ChatGPT | Long prompt fallback directly changed DOM and accepted partially retained text. | Use browser editing for all lengths, verify complete stable text, and recheck immediately before Send. |
| Google Flow | An uncertain write could fail over to another profile or be automatically retried. | Mark it SUBMISSION_UNCERTAIN and require manual inspection before retry; retain read-only failover. |

Also fixed cancellation masking an existing review error and single-chunk playback
being unnecessarily dependent on FFmpeg. Missing FFmpeg now provides a merge message
while individual audio stays available. Side-panel action errors persist across
polling and closing an idle tab does not invent uncertain audio work.

## Behaviors retained

- English UI and three independent extension directories.
- ElevenLabs credits and cost are informational, read after entry; the website's
  character counter is not used for input validation.
- Sequential ElevenLabs chunks, clear then refresh between chunks, Eleven v4,
  and voice consistency across each narration job.
- Native Chrome Download followed by backend import, without an application
  file-size cap. Chrome originals are kept; the legacy inline payload limit does
  not apply to native files.
- Existing database records and completed audio survive the update.

## Validation

| Check | Result |
|---|---|
| Python `pytest tests/unit -q` | 527 passed |
| Desktop `npm test` | 196 passed |
| Gateway `npm test` | 4 passed |
| Desktop `npm run check` | Passed |
| Google Flow MV3 cold-start regression | Passed |
| Whitespace/diff checks | Passed |

Coverage includes local HTTP/WebSocket exchanges, real audio import larger than
20 MiB, save/restart/recovery, commit ordering, lock release, incompatible-backend
IPC guards, renderer polling and editable drafts, and uncertain Google Flow writes.
The ProseMirror tests execute the actual parser, model and transactions in JSDOM
with both paragraph and inline speaker schemas; they verify exact Japanese content,
blank lines, emoji, literal markup and multiple sequential chunks.

Provider DOM tests otherwise use sanitized fixtures and browser service doubles.
No live paid generation was performed against signed-in ElevenLabs, ChatGPT, or
Google Flow. Native Electron could not be launched successfully in this execution
environment; Windows GUI operation remains unverified. Automated checks do not
reproduce the providers' private application code or guarantee future selector stability.

## Updating and recovering an existing queue

Close Studio and the old Python backend, back up your project folder, update the
complete source, run `setup_desktop.bat`, and restart `start_desktop.bat`. Preserve
databases, `output/`, and your environment. Reload ElevenLabs 1.0.16 and ChatGPT 1.5.1
in Chrome and refresh their tabs.

A previously stuck job is not regenerated automatically. Inspect its tab/downloads,
use the inline **Release after review**, and choose **Recover downloaded audio** if
available. Otherwise choose which unfinished chunks to retry, then **Resume queue**.
Recovery requires metadata saved by this release; older failed records can lack it
although files exist in Chrome Downloads. Keep those files and review before retrying.
See the [complete guide](ELEVENLABS_EXTENSION.md) for detailed steps and time limits.
