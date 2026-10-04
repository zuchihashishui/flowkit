# Production dashboard and preflight

The Project page shows every video in the selected project. Narration, transcript,
SRT, prompt and media readiness comes from durable jobs and saved files. A result
from another video never satisfies a stage. When scenes have a recorded SRT
source, the dashboard follows those exact parent IDs instead of treating the
newest unrelated narration as the scene's source.

Current prompts must match both the document and segment revision. Current media
uses the same prompt/timing checks as assembly. Adding a video prompt does not
invalidate an unchanged image prompt. Deleted output files stop counting as ready.
Image and video coverage is combined for the recommended next step: a video clip
can replace the image for a scene. The separate image/video stage counters still
show how many of each type are available.

The suggested next stage is navigation only. A completed SRT first needs its
scenes imported; the dashboard does not silently import them or enqueue another
stage. An externally imported SRT may bypass WhisperX. Saved historical outputs
remain available even when they are no longer current for the scene revisions.

## Recovery

Existing queue services retain their restart behavior. The Recovery center reads
their durable state and links to the responsible stage. It does not resend jobs,
acknowledge browser results or release workers.

- Queued/running jobs: wait or inspect the existing job.
- Uncertain browser submissions: inspect the provider and downloads before retry.
- ElevenLabs download metadata: recover the downloaded audio first, without
  another generation. Completed chunks without merged narration can be merged
  from the saved files through audio recovery.
- Flow jobs with a saved remote result: resume polling/downloading that result.
- Interrupted local renders: resume and reuse valid scene checkpoints.
- Missing saved outputs: inspect the output directory and backup first.
- SRT timing exceptions: open the saved quality report for review.

Healthy completed results do not fill the Recovery center. Cancelled and failed
history is retained for manual action. Service history summaries currently use
the existing limit of the newest 500 jobs per service and video.

## Preflight

`POST /api/production/preflight` checks the current project/video, saved service
URL, extension capabilities, queue review/paused state, inputs, output directory
access and free disk space. Checks never open provider tabs, generate content,
download models or spend credits. Credit balances remain optional information.

WhisperX runs its existing import-only environment check, bounded to 20 seconds,
and verifies CUDA when GPU is selected. An explicit CPU selection is respected.
CLI prompt providers check for the installed CLI instead of requiring ChatGPT.
Assembly checks the exact selected mapping and saved files. Use the existing
**Check files & preview** for full stream checks; rendering does full decoding.

Warnings do not block. Failed checks block a new submission in Studio and the
pipeline CLI. Input readiness is revalidated by the existing submission APIs.
An environment/permission check cannot guarantee a future disk write or provider
availability; errors at execution remain recorded in the normal job service.

## API

- `GET /api/production/overview?project_id=...&video_id=...` (`video_id` optional).
- `GET /api/production/recovery?project_id=...&video_id=...` (read-only).
- `POST /api/production/preflight` with `project_id`, `video_id`, and `stage`.

Stages: `elevenlabs`, `whisperx`, `srt`, `image_prompts`, `video_prompts`, `images`,
`videos`, `assembly`. `prompts` is an alias for `image_prompts`.

Optional preflight fields are `source_id`, `source_kind`, `segment_ids`, `text`,
`provider`, `device`, `plan` (the normal assembly plan), and `direct_jobs` (the
normal desktop media batch). Sources and scene IDs must belong to the selected
video. Pass the submitted device/provider/options so the check matches the job.

Responses include `manual_stages: true`. Preflight returns `blocked` and checks
with `status: pass | warn | fail`. Recovery returns `automatic_resubmit: false`.
