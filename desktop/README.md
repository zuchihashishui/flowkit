# Flowkit Studio 0.7.39

An English-language Electron desktop application connected to the Python backend.
This is a source release, not a prebuilt Windows installer.

## New in 0.7.21

- New ElevenLabs previews and jobs target 900–1,199 characters per chunk, always below 1,200 UTF-16 units. Sentence and paragraph boundaries are preferred.
- Restart the updated backend. Existing jobs and audio remain unchanged; create a new job to apply the smaller split. The ElevenLabs extension is unchanged.

## New in 0.7.20

Each ElevenLabs chunk closes existing TTS tabs, opens one fresh TTS tab, binds it
without manual setup, clears old text, refreshes, and then enters/generates the new
chunk. Other tabs stay open. New progress stages show the tab preparation.
Update the backend and reload ElevenLabs Bridge 1.0.21; see the
[fresh-tab workflow](../docs/ELEVENLABS_FRESH_TABS.md). Dependencies are unchanged.

## New in 0.7.19

The ElevenLabs backend compatibility warning now includes **Check backend** and
**Restart local backend**, plus PID, source folder, Python and missing features.
On Windows, restart verifies the exact Flowkit process before stopping it, pauses
known queues, refuses active work, and verifies the replacement backend identity.
A running old process can survive closing Studio if it was started separately.
See [backend recovery](../docs/BACKEND_RECOVERY.md).

## New in 0.7.18

- ElevenLabs distinguishes pre-Generate failures from uncertain submitted work.
  Review locks display clearly and release immediately after a successful check.
- Recovery can import recorded Chrome downloads without regenerating narration.
  Inline confirmations and local errors replace native ElevenLabs dialogs; drafts
  remain editable during polling. Old backend processes are detected before use.
- ProseMirror paste preserves Japanese paragraphs and blank lines; credits remain
  optional and native audio downloads have no application size cap.
- ChatGPT verifies the complete prompt before Send, including long inputs.
  Google Flow no longer automatically resubmits an uncertain write to another profile.
- See [the stability review](../docs/STABILITY_REVIEW_0.7.18.md) and
  [ElevenLabs recovery guide](../docs/ELEVENLABS_EXTENSION.md).

## New in 0.7.0

- Google Flow processes three image/video jobs at a time. Requests retain a
  minimum three-second spacing. Queue and extension views show stages, active
  slots, effective throttling and cooldown. See [Flow progress](../docs/GOOGLEFLOW_PROGRESS.md).
- The **ElevenLabs** page previews Japanese-friendly 900–1,199-character chunks,
  queues Text to Speech using Eleven v4 and the website's selected voice, shows
  credits and per-chunk progress, and previews/saves individual or joined audio.
  Its independent extension is `extensions/elevenlabs/`. See
  [setup](../docs/integrations/elevenlabs-bridge.md).
- Existing ChatGPT features and local OmniVoice cloning remain separate from
  ElevenLabs. All three browser extensions can be installed together.

## New in 0.3

**Script & Scenes** stores a long script, source audio, timed SRT/JSON segments and
versioned AI-written visual concepts. Text to Image/Video can read this database
list directly. See `../docs/STORYBOARD_DATABASE.md` for the workflow, database design,
provider setup expectations and limitations. Example imports are in `examples/`.

Concept writing uses ChatGPT Web through its separate extension, or a signed-in
AI CLI on your machine (Codex, Claude or Antigravity). Flow's extension generates media.
The CLI check verifies PATH availability only. Source audio is optional when writing
concepts but needed for playback and duration checks.

## Included from 0.2

- Add and edit scenes directly, including separate image prompts, video prompts
  and narration text. Unsaved changes are protected when switching collections.
- Select individual scenes, select all, or clear the selection. Image/video batches
  use only checked scenes (1–100 per submission).
- Generate narration for checked scenes using their `narrator_text` and the chosen
  voice. Missing narration blocks the entire batch so no scenes are silently skipped.
- Search jobs by prompt, label or ID; filter by project, media type and status.
  Counts show queued, active, completed, cancelled and attention-needed jobs.
- Open job details to inspect the full prompt, settings, error and backend files.
- Export completed results matching the current filters in one action.
- Cancel queued jobs individually or by the current filters (up to 1000 at once).
  Active jobs are never interrupted. Cancellation does not refund Flow credits.
- Queue pause and the auto-export preference survive application restarts.

To update an existing installation, close the app/backend, back up your project
folder, and copy the new source into that folder. Keep your existing database
files, `output/` and `.venv/`. Run `setup_desktop.bat` again, then start
the app. New queue preferences are initialized automatically; no manual SQL is needed.

## Windows

1. Extract the complete repository into a writable folder.
2. Install Python 3.11 or 3.12 (including the `py` launcher), Node.js 22 with npm,
   and FFmpeg. Both `ffmpeg` and `ffprobe` must be on PATH.
3. Double-click `setup_desktop.bat` in the repository root. Internet is needed.
4. Double-click `start_desktop.bat`.
5. In Chrome, open `chrome://extensions`, enable Developer mode, and Load unpacked
   using the repository's `extensions/googleflow` folder. Settings → Open extension folder
   helps locate it. Sign in to Google Flow in Chrome and keep that tab open.
6. Wait for **Flow extension connected**, then create or reuse a Flow project.

The app starts the local backend on port 8100 and the extension bridge on 9222.
If a backend is already running, stop it first when installing this update so the
new desktop endpoints are loaded. Existing databases remain in the repository.
The app stops only the backend process it started. Queued work resumes next launch.

## Linux / macOS source launch

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cd desktop
npm ci
npm start
```

A graphical desktop is required. Existing external Python environments can be
selected with an absolute `FLOWKIT_PYTHON` path.

## Voice cloning

The **Voice Cloning** page imports your reference audio and its transcript, then
uses the repository's local OmniVoice service to synthesize new speech. Importing
a reference does not train a new model. Use audio you have permission to use.
FFmpeg converts samples to mono 24 kHz WAV and keeps up to the first 120 seconds.

Install the optional dependencies into the same Python environment, following
the upstream repository's documented versions:

```bat
.venv\Scripts\python.exe -m pip install torch==2.8.0 torchaudio==2.8.0 omnivoice
```

Alternatively set `TTS_PYTHON_BIN` to an existing compatible environment. Settings
→ Check dependencies checks imports; it does not verify inference. First synthesis
downloads the model and the current upstream service runs on CPU. Actual synthesis
and Windows dependency compatibility still require a machine-level test.

## Connected features

| Screen | Backend integration |
| --- | --- |
| Projects | Existing `/api/projects`, `/api/videos`, `/api/scenes` |
| Text to Image | Desktop queue → existing Flow image generation |
| Text to Video | Desktop queue → existing Omni Flash text-to-video and status polling |
| Voice Cloning | Reference import → existing voice templates and TTS generation |
| Queue & Downloads | Persistent SQLite jobs, preview and native folder export |

Create a scene collection and import TXT (one prompt per line) or JSON:

```json
[{"prompt":"A paper boat floating on water", "video_prompt":"0-4s: A paper boat drifts across still water. 4-8s: The camera follows it.", "narrator_text":"A quiet journey begins."}]
```

Check scenes in **Projects**, then choose **Selected scenes from Projects** in
a generation screen to submit up to 100 scenes in one desktop batch. Jobs are processed serially using Flowkit's shared
generation throttle. These are independent text generations: character references,
video stitching, uploading to YouTube, and database-server connectors are not
implemented by this desktop release. Imported scenes use Flowkit's SQLite database.
Desktop results are kept in their own job history, not the legacy scene completion
fields. Voice narration is submitted from its own screen using **Single narration**
or **Selected scene narration from Projects**. Scene edits affect future jobs;
already queued jobs retain their original prompt snapshots.

Files are downloaded to the backend output directory, checked with FFprobe, then
exported to your chosen folder (default: Videos/Flowkit). Auto-export operates while
the app is open. **Pause queue** pauses new jobs after the active job finishes and
remains paused after restart until you press **Resume queue**.
Remote workflow IDs are saved so failed polling/downloads can resume without another
generation charge. An interrupted submission without a saved result becomes
**NEEDS_REVIEW**: inspect Google Flow before manually submitting another job.

No OpenAI API key is required for these desktop features. Google Flow access and
credits are required for images/videos. The app does not replace Chrome sign-in.

## Development verification

```sh
python -m pytest tests/unit/test_desktop.py -q
cd desktop
npm run check
npm test
```

Local tests cover validation, recovery, media checks and API integration with fake
generation responses. They do not establish successful generation on Google Flow.

## Verification of this release

- Full Python unit suite: 416 passed, including 18 desktop and 18 storyboard tests.
- Seven JavaScript UI/IPC tests passed. They exercise scene selection/editing,
  batch narration, filtering/export/cancellation, preference persistence and the
  script → segments → concepts → media UI flow.
- JavaScript syntax checks passed.
- Real FFmpeg reference-audio conversion and FFprobe validation passed.
- The earlier live backend startup, health and desktop job-list smoke test passed.
- Native Electron launch was attempted but this runner has no working graphical
  display. Windows launch scripts are provided but were not executed on Windows.
- Google Flow generation and OmniVoice model inference have not been tested in
  this environment. Browser sign-in and voice model dependencies are still needed.
