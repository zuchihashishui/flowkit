# Project and video workflow — Studio 0.7.53

**One project can contain multiple videos.** A project groups related productions
and retains shared project metadata such as visual style, language and reference
assets. Every video has its own title, script, scenes, audio, transcript, SRT,
generation jobs and render versions.

In **Project**, select a project and use **Videos in this project** to create or
select a video. **Save video title** changes only that video's title. The header
shows both selections on every page. Studio remembers the last selected video for
each project. A sole existing video is selected automatically; a project with
multiple videos and no remembered selection waits for you to choose. Selecting
an empty project does not create a video implicitly.

## Use the pipeline

1. Choose or create a project in Project, then choose or create a video inside it.
2. Generate narration in ElevenLabs. Completed chunks and joined audio keep their
   existing output paths. Completion does not start WhisperX.
3. In **Project → Video sources & history**, click **Use for WhisperX** on a
   narration with merged audio. This selects its source in WhisperX; click
   **Create word JSON** when ready. **Choose audio file** also imports into the
   active video and keeps a backend copy.
4. Click **Use for SRT** on a completed transcript, or choose a JSON file in
   JSON → SRT. Review your prompt/model, then submit explicitly. The source JSON
   and prompt are retained with that SRT request.
5. Click **Import as Scenes** on a completed SRT. Scene text, order and integer
   millisecond timings are saved with the exact SRT source ID and original text.
   This does not send concept/prompt requests or create images.
6. Review Script & Scenes, then use its existing concept and media generation
   controls. Their segment IDs, concept versions and media snapshots remain intact.
7. Click **Use for Video Assembly** to select the SRT. Choose matching narration
   and images, preview the timeline, then click **Render MP4** explicitly.
   Assembly saves its own source copies and the exact image/timeline mapping.

Handoff buttons open/select a source; they do not enqueue the next stage.
Source changes invalidate the assembly preview. Switching projects or videos clears prior
source selections and visible previews. A pending request remains owned by the
video selected when it was submitted; a late response cannot restore the old
video's source list. Native file pickers capture their destination before opening.

Generic ChatGPT testing/queue settings and provider connection/worker status stay
global. The providers have shared workers across videos; filtering the history
does not isolate provider capacity. SRT queue positions still count earlier jobs
from every video. The stage-specific histories show up to 500 recent jobs after
filtering; Projects' source history includes all resource versions.

## Existing data and upgrade

Update the complete source in your existing installation and restart Studio and
its backend. Keep the existing databases and `output/` directories. Browser
extension files and versions are unchanged by this release.

Startup removes the old one-video-per-project insert/move triggers and the
project-name-to-video-title trigger. It does not delete, merge or recreate rows.
Existing video IDs, titles, scene IDs, files, jobs and resource ownership stay in
place. Older multi-video projects become selectable without splitting the remote
Google Flow project. Project and video titles are independent from this release.

Desktop media jobs now capture `video_id` alongside `project_id`. Legacy jobs use
saved document/segment/scene IDs to recover ownership. Jobs without those IDs can
use a project's sole existing video; this backfill happens before a second video
is created. Ambiguous jobs in multi-video projects remain without a video owner.
Queue's **Job scope** lets you view the active video, all videos in the project,
or legacy project jobs without a video. It does not regenerate or move files.
Provider activity and pause controls remain global across videos.

Existing records have no owner until you choose one. Open **Project → Video
sources & history → Unassigned**, select the destination project and video, and click
**Assign source chain to active video**. Studio shows the linked records before
you confirm. It assigns their known ancestors and descendants together in one
transaction. This operation neither generates files nor moves audio on disk.

- Active jobs must finish or be cancelled before their source chain is assigned.
- A chain already assigned to another video is not moved. Import a separate copy
  when you intentionally want to reuse material in another video.
- Only exact persisted source IDs can reconstruct old relationships. Old standalone
  imports without provenance remain separate roots; filenames are not evidence
  that two files belong together. Assign each known root deliberately.
- Missing linked sources are reported, without partially assigning the chain.
- Project/video DELETE API calls reject owners that still have saved resources,
  so the new relationships are not silently orphaned.
- The old WhisperX automatic setting is disabled once during migration. Electron
  saves manual mode. Explicit legacy CLI auto-discovery is limited to unassigned
  narration; project-linked narration always requires a manual submission.

If a collection already has scenes, another SRT import is rejected. Edit those
scenes in place, or create another video and import a separate copy of the
new SRT. Existing scene IDs, prompts and generated images are not replaced.
Multiple audio, WhisperX, SRT and render jobs are separate saved versions. Editing
scene text/timing/style continues to mark incompatible concepts outdated using
the existing storyboard revision checks.

## Persistence and API

Each service database gains an additive `resource_scope` table:

| Field | Purpose |
| --- | --- |
| `kind`, `resource_id` | Composite identity, pointing to the existing service row |
| `project_id`, `video_id` | Both set together, or both empty for unassigned data |
| `sources` | JSON array of exact `{kind, id}` input references |
| `created` | Time the ownership/provenance record was created |

| Kind | Existing database/table | Recorded parent |
| --- | --- | --- |
| `elevenlabs` | `elevenlabs_jobs.db` / `eleven_jobs` | Original narration script |
| `audio` | `whisperx_jobs.db` / `wx_sources` | Original imported audio |
| `whisperx` | `whisperx_jobs.db` / `wx_jobs` | `elevenlabs` or `audio` |
| `json` | `srt_jobs.db` / `srt_sources` | `whisperx`, when copied from its result |
| `srt` | `srt_jobs.db` / `srt_jobs` | Exact `json` copy |
| `asset` | `assembly_jobs.db` / `assembly_assets` | `srt`, `audio`, `elevenlabs`, or original import |
| `assembly` | `assembly_jobs.db` / `assembly_jobs` | Audio, SRT and selected image/video `asset` IDs |

The main database also gains `document_source`, keyed by `script_document.id`.
It stores the SRT kind/ID, import time and original content alongside the existing
video → document → segment → concept relationships. Manually imported SRT/JSON
is recorded as an external source with its original text.

Ownership and a new job/source row are written in the same local transaction.
Legacy assignment uses a transaction across the four attached SQLite databases.
Failures roll back instead of leaving only part of the chain assigned. Media stays
in backend-managed files; request bodies do not supply filesystem paths.

Creation endpoints accept `project_id` alone and resolve the internal `video_id`.
The existing pair of IDs remains supported. File imports use the same fields in
multipart forms. The backend checks that the video belongs to the
project and that every input belongs to that video. An unassigned source must be
assigned first. Legacy API callers can omit both fields; a linked source then
supplies its exact owner, otherwise the new root remains unassigned.

Endpoints:

- `POST /api/workflow/project` with `{project_id}` prepares/resolves the internal video.
- `POST /api/videos` with `{project_id, title, orientation}` creates a new video.
- `PATCH /api/videos/{id}` updates that video's title/settings.
- `POST /api/workflow/project` with `{project_id, video_id?}` returns all project videos and the selected video (protocol 3). It never creates a video. With several videos, omitted `video_id` leaves the selection empty.
- Production writes should send both `project_id` and `video_id`; project-only legacy requests resolve only when exactly one video exists.
- `GET /api/workflow/resources?project_id=...&video_id=...`
- `GET /api/workflow/resources?unassigned=true`
- `POST /api/workflow/assignment-preview`
- `POST /api/workflow/assign`
- `POST /api/workflow/import-scenes`

The assignment and scene-import POST endpoints take `{project_id, video_id, kind, id}`. All state is
managed by the backend, so a later website or CLI can use the same relationships.
Electron verifies the backend's `project_video_sources` and `project_multi_video` capabilities before scoped
operations, preventing an older backend from silently ignoring the new fields.

## Verification

The 0.7.53 checks cover additive migration from the old database triggers,
concurrent creation of distinct videos, independent names, explicit selection,
legacy media-job ownership, and source isolation between two videos in the same
project. UI checks cover create/select/rename, remembered video selection,
unsaved-edit protection, per-video queue filters, stale responses and assembly
drafts. No live provider generation is required for these tests.

Backend tests cover the complete fixture audio → JSON → SRT → scenes/assembly
chain, wrong-video rejection, imported files, migration, assignment preview,
cross-database rollback, scene preservation, source snapshots, history limits,
manual stages and delete protection. Existing real FFmpeg rendering tests cover
media output duration, streams and scene timing.

Electron DOM/IPC tests cover shared selection, source handoffs without generation,
stale responses, a video change during narration preview, native picker context,
older-backend rejection and existing stage controls.

These are automated local tests with fixture generation results. This release has
not been run end-to-end against a signed-in ElevenLabs/ChatGPT session, a real
WhisperX GPU model, or the native Windows Electron window.

Legacy `POST /api/videos` now returns the existing project video idempotently,
creating it only when absent. Its title comes from the project. Repeated selection
and concurrent calls cannot create duplicate videos. Renaming the project also
renames its sole internal video; ambiguous legacy collections are not renamed.
