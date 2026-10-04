# Flowkit ElevenLabs Bridge 1.0.21

Use this extension with Flowkit Studio 0.7.28 and its matching Python backend.
It automates **Text to Speech** in one signed-in ElevenLabs browser tab. Google
Flow and ChatGPT remain separate extensions.

## Install or update

1. Close Studio and any older Flowkit backend using port 8100. Back up your project
   folder and replace the complete source. Keep your databases, `output/`, and
   Python environment. Run `setup_desktop.bat`, then `start_desktop.bat`.
2. In Chrome's extension manager, load or reload `extensions/elevenlabs/`.
   Confirm **Flowkit ElevenLabs Bridge 1.0.21**. ChatGPT stays at 1.5.1 and does
   not need reloading for this update.
3. Open or refresh
   [ElevenLabs Text to Speech](https://elevenlabs.io/app/speech-synthesis/text-to-speech).
   Sign in and choose a voice. Use one speaker block.
4. Open the extension's native side panel and enable the bridge. Manual binding is
   optional for inspection/review; queued generation creates and binds its own tab.
   You can close the TTS page after signing in; a new page will open for the job.
5. Open **ElevenLabs** in Studio. Enter your script, preview the chunks, and click
   **Add narration to queue**. Jobs start when the page is ready and the queue is
   resumed. The requested model is **Eleven v4**.

A backend connection and a page connection are different. If the page receiver is
missing, a read-only probe can inject the packaged content script and retry once.
If repair fails, refresh the actual TTS page, check extension site access, and bind
it again. This repair does not submit text.

Studio detects a backend missing this release's required features. Update and
restart that backend; reloading only the extension cannot fix a mixed installation.
Existing jobs and audio are retained. In Studio 0.7.20, use **Restart local backend**
when offered, then **Check backend**. The warning includes process and source-folder
details; see [backend recovery](BACKEND_RECOVERY.md).

## What happens for each chunk

1. Find and close every existing ElevenLabs **Text to Speech** tab in this Chrome
   profile. Other ElevenLabs pages and unrelated tabs are kept.
2. Open one new Text to Speech tab and **Bind** it automatically. Wait for the editor
   and selected voice. The first chunk uses the voice restored by the website; later
   chunks must match the job's saved voice.
3. Clear any restored old text, using the page's **Clear text** control when available.
   Preserve the speaker, then refresh this newly opened tab. Wait for a different
   document, a ready editor, and the same voice. Even an empty editor is refreshed.
4. Select and verify Eleven v4. Paste the new chunk through ProseMirror's paste
   handler, preserving line breaks, and verify the retained text after rendering.
5. Wait for the enabled **Generate speech** button, read optional credit information,
   and click Generate once. These controls need not exist before entering text.
6. Wait for a new completed result, click **Download**, wait for Chrome to finish,
   then let the backend save the audio and acknowledge it before the next chunk.

This full cycle runs **for every chunk**. The old TTS tab is replaced only after the
previous audio has been saved and acknowledged. Review locks never trigger tab
replacement automatically. If TTS tabs are the only tabs open, a temporary blank tab
keeps the browser window available during replacement; it is removed after the new
TTS tab is bound. A failed replacement may keep that blank tab to report the error.

Progress distinguishes page preparation, text entry, generation, downloading, and
**Save audio**. The website's character counter is never used to validate input.
Backend chunking uses **Max characters per chunk** from Studio (default 3,000 UTF-16 code units, configurable from 100 to 3,000);
Japanese sentences and paragraph boundaries are preferred and the last chunk can
be shorter. Text order and source whitespace are preserved by the splitter.

The bridge expects a single speaker and the supplied English controls. A missing
voice, changed voice, unavailable model, or incomplete text produces a specific
error before Generate. The first saved chunk's voice is pinned for the rest of the job.

## Credits are optional information

Credits and an explicit cost quote are read **after text entry**, when the page
shows them, and again after generation. Unavailable values display a dash. A
missing, ambiguous, zero, or insufficient-looking balance does not block an enabled
Generate button. Cost is not inferred from the character count. Actual website
errors and a disabled Generate button still stop processing.

## Completion, downloads, and large files

Generation cards are observed for new-result/loading transitions. All current
cards must have enabled, non-loading **Download** buttons and no loading indicators,
stable for one second. Streamable playback alone does not establish completion.
Existing completed cards cannot satisfy a new generation without new-result evidence.
When the page provides Generation 1 and Generation 2, they are alternative readings;
the bridge saves Generation 1 (the lowest numbered variant), not both.

The bridge clicks the actual Download control. It does not fetch a playback URL.
A listener registered before the click tracks a new ElevenLabs download and names
it `flowkit-elevenlabs/<uuid>/audio.mp3` within Chrome's download directory. Keep the
worker tab dedicated to the queue and avoid other ElevenLabs downloads at that time.
For unattended downloads, disable Chrome's ask-where-to-save option; if Save As
appears, retain the proposed path.

The backend imports that exact file from `~/Downloads/flowkit-elevenlabs/`. If your
Chrome download directory differs, set this before starting Studio, for example:

```bat
set "ELEVENLABS_DOWNLOAD_DIR=D:\Downloads"
call start_desktop.bat
```

Chrome and the backend must use the same local filesystem. Native downloads have
**no application file-size cap**: 13 MB, 20 MB, and larger files are copied in blocks,
validated as audio, and saved atomically under `output/elevenlabs/<job-id>/`.
The original Chrome download is retained. The legacy inline WebSocket transfer
still has a 10 MiB limit; current browser downloads do not use that transfer.

Completed files can be played, saved, or exported in Studio. All completed chunks
are joined with FFmpeg when available; individual files remain if merging fails.
A single completed chunk is available as joined narration without FFmpeg.
Playback preview has a separate 100 MiB memory limit; Save and Export stream files.

## A paused queue is not a busy worker

| State | Meaning | Next action |
|---|---|---|
| Failed + paused | The bridge confirmed Generate was not submitted. | Fix the displayed cause, **Retry remaining**, then **Resume queue**. |
| Needs review | A submitted operation, download, disconnect, or save acknowledgement has an uncertain outcome. | Inspect the tab and Chrome downloads; release only once no generation is running. |
| Worker locked for review | The worker is deliberately blocked, not processing indefinitely. | Check the inline confirmation and click **Release after review**. |
| Completed | Audio is saved locally. | Play, save, or export it; completed chunks are not regenerated by retry. |

**Release after review** verifies the page is no longer generating and immediately
clears the worker lock. It leaves the queue paused and does not generate audio.
After release:

- If a job offers **Recover downloaded audio**, use it to import already downloaded
  files without another Generate. The queue stays paused and the original file stays
  in Chrome's download directory.
- Otherwise, **Retry remaining** queues unfinished chunks. For uncertain or cancelled
  chunks, an inline confirmation is required before **Generate remaining chunks**.
  A remotely completed but unsaved chunk can consume credits again if regenerated.
- Click **Resume queue** when the remaining queued work is ready to run.

Automatic recovery requires download metadata recorded by this release. Older failed
jobs may not have it, even if Chrome already downloaded a file. Preserve those files
and inspect them before choosing to regenerate. The bridge does not guess which
old download belongs to a chunk.

**Pause queue** stops new dispatch while an active chunk finishes and saves.
**Cancel pending** affects only unstarted chunks and preserves existing review errors.
Studio displays action errors beside their buttons and keeps draft text editable
while status polling updates the page.

## Time limits and troubleshooting

| Stage | Limit / behavior |
|---|---|
| New page readiness | 60 seconds before clearing text. |
| Refreshed page readiness | 60 seconds; checks the editor even while Chrome reports loading. |
| Generate button after entry | 30 seconds; re-queries controls after page renders. |
| Generation completion | 10 minutes by default. |
| Chrome download completion | 60 seconds. |
| Backend command | Generation limit plus 240 seconds for preparation and download. |
| Save acknowledgement | 10 seconds; an uncertain acknowledgement requires review. |

Timeouts show the last missing condition. Missing Download on an empty page is not
itself a busy signal. Missing credits never require review. If the page rejects a
paste or reverts its text, the bridge stops before Generate instead of narrating a
truncated script.

See [the integration reference](integrations/elevenlabs-bridge.md) for API details
and [the fresh-tab release notes](ELEVENLABS_FRESH_TABS.md) for this workflow change
and its validation limits.
The extension icons retain the attribution in `extensions/elevenlabs/LICENSE`.
