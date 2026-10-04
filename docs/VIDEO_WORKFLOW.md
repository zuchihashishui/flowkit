# Project sources and history — Studio 0.7.44

**One project = one complete video.** The project name is the topic/title. Select
only a project in **Projects**. Studio creates or reuses its single internal video
record automatically; there is no second title or video selector on the UI. The
internal `video_id` remains to preserve existing scene and source relationships.
A project may still have multiple narration, transcript, SRT and MP4 render
versions; those are versions of the same production, not separate video topics.
For another topic/video, create another project. A future Channel/Series layer
can group projects without changing this rule.

## Use the pipeline

1. Choose or create a project in Projects. Its name is the video title.
2. Generate narration in ElevenLabs. Completed chunks and joined audio keep their
   existing output paths. Completion does not start WhisperX.
3. In **Projects → Project sources & history**, click **Use for WhisperX** on a
   narration with merged audio. This selects its source in WhisperX; click
   **Create word JSON** when ready. **Choose audio file** also imports into the
   active project and keeps a backend copy.
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
Source changes invalidate the assembly preview. Switching projects clears prior
source selections and visible previews. A pending request remains owned by the
project selected when it was submitted; a late response cannot restore the old
project's source list. Native file pickers capture their destination before opening.

Generic ChatGPT testing/queue settings and provider connection/worker status stay
global. The providers have shared workers across videos; filtering the history
does not isolate provider capacity. SRT queue positions still count earlier jobs
from every video. The stage-specific histories show up to 500 recent jobs after
filtering; Projects' source history includes all resource versions.

## Existing data and upgrade

Update the complete source in your existing installation and restart Studio and
its backend. Keep the existing databases and `output/` directories. Browser
extension files and versions are unchanged by this release.

Existing projects with zero videos get their internal record on first selection.
Projects with one video reuse its ID and retain scenes/files; its title follows the
project name. SQLite guards prevent a second video or a move into an occupied
project. Older projects with multiple videos are left intact and show a migration
error instead of silently choosing one. They need an explicit data migration; this
release does not automatically split remote Google Flow projects.

Existing records have no owner until you choose one. Open **Projects → Project
sources & history → Unassigned**, select the destination project, and click
**Assign source chain to active project**. Studio shows the linked records before
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
scenes in place, or create a new project and import a separate copy of the
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
- `GET /api/workflow/resources?project_id=...&video_id=...`
- `GET /api/workflow/resources?unassigned=true`
- `POST /api/workflow/assignment-preview`
- `POST /api/workflow/assign`
- `POST /api/workflow/import-scenes`

The assignment and scene-import POST endpoints take `{project_id, video_id, kind, id}`. All state is
managed by the backend, so a later website or CLI can use the same relationships.
Electron verifies the backend's `project_video_sources` and `project_single_video` capabilities before scoped
operations, preventing an older backend from silently ignoring the new fields.

## Verification

**165 backend tests and 61 Electron DOM/IPC tests passed**, including one-to-one
creation, project selection, existing stage regressions, syntax and API capability
checks.

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
