# Studio pipeline CLI

This CLI uses the same local backend, project/video ownership, queues, browser extensions and saved artifacts as Electron. It does not implement browser automation or publish to YouTube. Keep Studio/backend and the necessary extensions running. Sign in to the provider sites normally and configure **Project Settings** first.

## Start with one stage

Copy `docs/examples/studio-pipeline.json` beside a UTF-8 `script.txt`. Replace both IDs with an existing project and one of its videos. A video should have no scenes yet, or scenes imported from the exact SRT this run uses. Paths in the manifest are relative to the manifest file. Project/video defaults fill omitted settings; explicit manifest options override them. Generation URL selection uses the saved project settings at each submission, just as Electron does.

Windows:

```bat
scripts\studio_cli.bat preflight --manifest C:\work\video.json --stage elevenlabs
scripts\studio_cli.bat run --manifest C:\work\video.json
```

Linux / WSL (use the backend running inside that same environment):

```bash
bash scripts/studio_cli.sh run --manifest /home/me/video.json
```

The CLI prints an absolute `run.json` checkpoint path. **Keep that path.** The default behavior completes **one stage, then pauses** so you can inspect results in Studio. Continue the same run:

```bat
scripts\studio_cli.bat run --resume C:\work\output\runs\RUN_ID\run.json
```

Stages are `audio`, `whisperx`, `srt`, `scenes`, `image_prompts`, `video_prompts` (mixed only), `images`, `videos` (mixed only), `assembly`. The image/video prompt and media stages each enqueue the whole selected scene list once; the backend manages concurrency. This initial CLI supports at most 200 scenes per run. Larger imports remain usable in Electron in selected batches.

## Explicit continuous processing

```bat
scripts\studio_cli.bat run --manifest C:\work\video.json --continuous
scripts\studio_cli.bat run --resume C:\work\output\runs\RUN_ID\run.json --continuous --until images
```

`--continuous` authorizes moving to subsequent stages. Without it, `--until` only limits how far the run may go; it does not bypass pauses. There is no automatic approval of SRT quality warnings. When a quality report requires review, inspect the saved `srt-quality.json`, approve the reviewable exceptions in Studio, then resume. Alignment errors must be fixed before proceeding.

All provider stages run read-only preflight checks before their first submission. These cannot guarantee that a website will remain logged in or unchanged after the check. A failed/uncertain browser job stops the CLI; review and recover or retry **only those scenes** in Studio, then resume.

The CLI watches for up to 3600 seconds per invocation by default. Use `--wait-timeout 7200` for longer work or `--wait-timeout 0` for no CLI wait limit. This does not change provider generation timeouts. Closing the CLI or reaching this limit does **not** cancel backend work. Resume the same checkpoint to watch the recorded jobs again.

## Existing audio, transcripts and SRT

Instead of `narration_file`, use either:

```json
"audio_file": "merged.mp3"
```

or an existing source already assigned to the same project and video:

```json
"audio_source": {"kind": "elevenlabs", "id": "EXISTING_NARRATION_JOB_UUID"}
```

Use `kind: "audio"` for an imported WhisperX audio source. Optional `whisperx_id` and `srt_id` reuse completed jobs. They must belong to this video **and** the exact upstream audio/transcript chain. The SRT stage uses the full transcript, preserving the complete narration timeline. WhisperX's optional `transcript_video.json` and `transcript_image.json` are also exported when available.

Use `srt_instructions_file` for custom scene-boundary instructions, or store instructions in Project Settings. The backend retains its timestamp validation protocol.

## Still-image motion and optional scene videos

Images only, with a slow zoom in:

```json
"media": {"visual_mode": "images"},
"assembly": {"image_motion": "zoom_in"}
```

`image_motion` accepts `none` (default), `zoom_in`, or `zoom_out`. Motion applies to still images only. Generated clips retain their original motion.

Mixed scenes, video for cues whose start is before 100 seconds and images for the rest:

```json
"media": {
  "visual_mode": "mixed",
  "video_scene_seconds": 100,
  "duration_mode": "srt"
},
"assembly": {"image_motion": "zoom_out"}
```

Alternatively specify `"video_scene_ordinals": [1, 2, 5]` instead of the cutoff. These are SRT scene numbers. No unrelated video intro is added. Clips shorter than a scene use the assembly `clip_end` choice (`freeze` or `loop`). The generated media duration still follows Flow's supported durations.

Allowed override groups:

| Group | Options |
| --- | --- |
| `tts` | `model`, `max_chunk_characters` |
| `whisperx` | `model`, `device`, `language`, `batch_size`, `video_duration_seconds` |
| `srt` | `model`, `timeout`, `duration_seconds` |
| `media` | `orientation`, `image_model`, `visual_mode`, `video_scene_seconds`, `video_scene_ordinals`, `duration`, `duration_mode` |
| `assembly` | `size`, `fps`, `fit`, `image_motion`, `subtitles`, `font`, `clip_end` |

## Checkpoints and safe recovery

The run stores immutable narration/instructions, explicit defaults, source IDs, scene revisions, request bodies, job IDs and artifact checksums. A checkpoint is replaced atomically before and after each submission. One OS lock prevents two CLI processes from using the same checkpoint simultaneously. Keep a copy of the run folder when backing up your production work; backend-only backups do not include CLI files saved outside the backend directory.

Do not create another `--manifest` run merely because a request is slow. That starts a **new** run and may generate paid work again. Always use `--resume` for an interrupted run. Scene text/timing edits detected after import stop the saved run so it cannot silently combine different revisions.

```bat
scripts\studio_cli.bat status --resume C:\work\output\runs\RUN_ID\run.json
scripts\studio_cli.bat status --project-id PROJECT_UUID --video-id VIDEO_UUID
```

If the submission response is lost, the backend may already have accepted the work. The checkpoint records `UNCERTAIN` and will **never resend automatically**. Inspect Studio, provider pages and downloads. Save the actual backend response in a JSON file (`{"id":"..."}` for a single job; `{"ids":["..."],"skipped":[]}` for a batch), then associate it with the unresolved operation shown by `status`:

```bat
scripts\studio_cli.bat reconcile --resume C:\work\output\runs\RUN_ID\run.json --operation audio.submit --response-file C:\work\recovered.json --reviewed
```

The CLI verifies the recovered IDs against the selected video and known source chain. For an operation that you have verified was **never submitted**, explicitly release that operation for another attempt:

```bat
scripts\studio_cli.bat reconcile --resume C:\work\output\runs\RUN_ID\run.json --operation audio.submit --not-submitted --reviewed
```

`--not-submitted` is a user assertion after review, not an automatic safety check. Do not use it merely because a job has not completed.

Completed exports (`merged.mp3` when generated by ElevenLabs, transcript JSON files, `subtitles.srt`, `video.mp4`) sit beside `run.json`. Source assets and all normal jobs remain available in Studio. There is no automatic provider retry, queue release, credit-balance override, history deletion, SRT approval or YouTube upload.
