# Script-to-media workflow — desktop 0.3

## The two AI steps

**Create Concepts** uses a locally installed and signed-in Codex, Claude or
Antigravity CLI. It writes a visual description plus English image/video prompts.
The existing CLI adapters are reused. It does not use ChatGPT web or an OpenAI API
key entered in the desktop app; provider access, authentication and quotas still
apply. Choose the CLI you actually installed. “Installed” does not verify sign-in.

**Generate Images / Generate Videos** uses the existing Flow extension in signed-in
Chrome. Concept generation does not itself submit a Flow generation request.

The two queues are separate. **Pause queue** in Queue & Downloads controls media
jobs; **Cancel queued concepts** in Script & Scenes controls queued concept jobs.
An active concept request continues. Closing the app interrupts active CLI work;
on restart uncertain concept jobs require review instead of automatic retries.

## UI steps

1. Select/create a project in **Projects**. New Google Flow projects still require
   the Chrome extension. Existing local projects can prepare scripts without Flow.
2. Open **Script & Scenes**, choose a collection or enter a title and click
   **New script**. A collection is the existing `video` record.
3. Paste/import the full script, enter a shared visual style, and click
   **Save script & style**. The style should describe recurring characters and
   composition rules, rather than changing those details independently per segment.
4. **Import narration audio** copies the original into the backend output directory.
   FFprobe checks its audio stream and duration. The UI can play a selected interval;
   it does not cut or alter your original recording. Files are limited to 512 MiB.
5. **Import SRT / JSON** loads already segmented narration into the database.
   Timestamps are preserved in integer milliseconds. Gaps are reported; overlapping
   cues are rejected. Audio/segment duration mismatches are reported for review.
6. Tick up to 100 segments and press **Create Concepts**. One AI request per segment
   runs serially. Existing current concepts and pending requests are skipped unless
   you explicitly choose new versions. Each request includes the segment, neighboring
   text, shared style and the first 8,000 characters of the script. The full script
   remains stored. For long scripts, put essential continuity guidance in the style.
7. Use **Edit / versions** to review narration, timing, visual description, and both
   prompts. **Save as new concept version** preserves previous versions. Changing
   source text/timing/style makes old concepts outdated; outdated concepts cannot
   generate media until reviewed into a new version or regenerated.
8. Click **Open Text to Image** (or Video). Input is **Script concepts from database**.
   The table uses the same persisted records and selection. Press **Add to queue**.
   Every selected segment needs a current concept. Matching queued/completed results
   are skipped by default; the explicit regenerate option allows another generation.
9. Preview/export completed results in **Queue & Downloads**. The job snapshot keeps
   the exact prompt, concept ID, segment ID and narration timestamps used at submission.

Imports are limited to 1–1000 segments, 5000 characters per segment. Re-importing into
a collection with existing segments is blocked so existing IDs cannot be silently
replaced. Edit segments in place or create another collection for a different cut.

## Database design

New tables are added to `flow_agent.db` on startup. Existing project, video, scene
and request tables are preserved. SQL definitions: `agent/services/storyboard_schema.py`.

| Table | Important columns | Relationship |
| --- | --- | --- |
| `script_document` | `id`, `video_id`, `script_text`, `visual_style`, `revision`, `audio_path`, `audio_name`, `audio_duration_ms` | One document per existing video/collection |
| `script_segment` | `id`, `document_id`, `ordinal`, `start_ms`, `end_ms`, `text`, `revision`, `active_concept_id` | Ordered timed narration segments |
| `scene_concept` | `id`, `segment_id`, `version`, `segment_revision`, `document_revision`, `title`, `description`, `image_prompt`, `video_prompt`, `provider`, `source_text` | Immutable concept versions; one selected version per segment |
| `concept_job` | `id`, `segment_id`, `state`, `payload`, `error`, `concept_id` | Persistent AI queue; input snapshots include provider/model/context |
| Desktop `jobs` in `desktop_jobs.db` | Existing JSON payload plus `document_id`, `segment_id`, `concept_id`, `start_ms`, `end_ms` | Logical references and immutable prompts; files remain attached to the original job |

Foreign keys connect documents, segments, concepts and concept jobs to their parent
records. The selected concept pointer is checked by the API for segment ownership
and source revisions. `ordinal` is unique within each document. A partial unique
index permits at most one queued/running concept job per segment.

Concept requests finish as `COMPLETED`, `FAILED`, or `STALE`. A stale result remains
in version history but cannot replace a concept edited while AI was working.
Interrupted active requests become `NEEDS_REVIEW`. Queued requests may be cancelled.

Old generated images and videos remain associated with their original concept
version. Choosing another concept never relabels those files as new results.
Replacing source audio keeps previously uploaded files on disk; this release does
not automatically delete source media.

## Import formats

SRT uses its original timestamps and multiline cue text. Blank lines separate cues.
Both comma and dot millisecond separators are accepted.

```json
[
  {"start_ms": 0, "end_ms": 8400, "text": "First narration segment."},
  {"start_ms": 8400, "end_ms": 15200, "text": "Second narration segment."}
]
```

Whisper-style JSON is accepted as an array or `{ "segments": [...] }`, with
`start`/`end` in seconds and `text`. Seconds are rounded once to integer milliseconds.
They are not rounded to whole seconds or resliced to match Flow clip lengths.

## Limits and verification

This release does not transcribe audio, stitch a finished video, guarantee consistent
characters across generated images, or automate ChatGPT web. Flow clip duration is
chosen separately from narration duration; automatic time-fitting is not implemented.

Tests use fake AI responses to verify persistence, invalid JSON handling, source
revision conflicts, cancellation, duplicates and media-job snapshots. Real audio
validation, database round trips and UI/IPC wiring are tested. Actual CLI inference,
Google Flow output and native Windows Electron display require testing on your PC.
