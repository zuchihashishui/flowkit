# Project defaults and video overrides

A project owns shared browser destinations and production defaults. Each video inherits them and may override individual fields. Saved jobs retain the resolved values from when they were created.

1. Select a project in **Project** and edit **Project Settings**.
2. Set the service URLs and production defaults, then save.
3. Select a video. **Video production settings** displays inherited values. Enable **Override for this video** beside a field to customize it.
4. Save video settings. **Use project defaults** clears the override checkboxes; save to confirm this change.
5. Stage forms receive the resolved settings when you select the video. Explicit edits in a stage form apply to that request; use **Apply video defaults to stage forms** to clear such option edits. Existing jobs and outputs are not changed.

Available defaults:

- Text to Speech: model, optional expected voice label, maximum chunk characters (100–3,000; default 3,000).
- WhisperX: model, device (GPU/CUDA by default), language code or automatic detection, batch size, and transcript video/image boundary.
- Google Flow: orientation and optional image model ID.
- Assembly: output size, frame rate, fit/crop, subtitles, font, and still-image motion (none by default, slow zoom in, slow zoom out).
- SRT: optional shared instructions. Blank uses the built-in instructions. These instructions are separate from image/video GPT requests, which send only the scene text.

The expected voice label is a check, **not automatic voice selection**. Choose the voice on ElevenLabs, or use a supported voice parameter in the project's ElevenLabs URL. The bridge verifies an expected label before generation. Later chunks must retain the actual voice used for the first saved chunk.

Changing project defaults updates inherited fields of all videos. Explicit video overrides remain intact. Unsaved settings block starting new jobs and ask before switching to another project/video. A settings load failure also blocks starting new jobs until reload succeeds.

## API

- `GET /api/projects/{project_id}/settings`: five saved URLs, `revision`, and nested `production`.
- `PUT /api/projects/{project_id}/settings`: the same shape and the last-read revision. An old URL-only client omitting `production` preserves existing production defaults.
- `GET /api/videos/{video_id}/settings`: `project_id`, `video_id`, `revision`, `project_revision`, `overrides`, `inherited`, and `effective`.
- `PUT /api/videos/{video_id}/settings`: `{ "revision": 0, "overrides": { "tts": { "max_chunk_characters": 1200 } } }`. Sparse nested fields inherit the rest. Send `overrides: {}` to reset all fields.

Concurrent edits return HTTP 409 and require reloading. Unknown sections/options and invalid values return HTTP 422. URL fields remain project-owned; a video cannot redirect provider URLs independently.

TTS and WhisperX enqueue endpoints use inherited settings only for omitted fields. Explicit request options take precedence and are frozen in the new job. Retrying an existing TTS job retains its original browser destination and settings.

Migration is additive: `video_settings` stores overrides and revisions separately from project settings. Existing videos with no row inherit their project's defaults. No existing IDs, titles, scenes, audio, or render jobs are rewritten by this migration.
