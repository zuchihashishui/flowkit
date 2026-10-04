# Video Assembly

> Studio 0.7.53: a project may contain multiple videos. Select the project and active video in **Project**. Sources, jobs and assembly drafts follow that video. Existing unowned records remain **Unassigned** until explicitly linked. See [Video workflow](VIDEO_WORKFLOW.md).

Flowkit Studio 0.7.52 assembles images and optional video clips locally using FFmpeg. It does not make generation requests. Update the complete source and restart Studio and the backend. Browser extensions and WhisperX dependencies do not need updating for this feature.

## Workflow

1. Open **Merge Audio + SRT + Media**, or click **Assemble video** on a completed JSON → SRT job.
2. Select an existing completed SRT or **Choose SRT file**. Files must be UTF-8, with cue numbers starting at 1 and valid, non-overlapping timestamps. Scene segmentation is taken directly from that SRT.
3. Choose an existing ElevenLabs merged narration / imported WhisperX audio, or **Choose audio file**. Supported formats: MP3, WAV, M4A, AAC, FLAC, OGG and OPUS.
4. **Choose image folder** imports supported files immediately inside that folder; it does not scan subfolders. **Choose image files** selects specific files. PNG, JPG/JPEG and WebP are supported. Importing an image set selects that new set. Ctrl-click the image list to include/exclude images already imported.
5. Choose the media mapping:
   - **Match scene numbers:** `001.png` → cue 1, `002.png` → cue 2. Plain `1.jpg` also works. Only numeric filename stems are matched. Duplicate candidates such as `1.jpg` plus `001.png` require a manual choice.
   - **Assign by filename order:** natural numeric filename order (`scene2` before `scene10`). Check the resulting mapping before rendering.
6. Select landscape 1920×1080 / 1280×720 or portrait 1080×1920, 24/30/60 fps, and fit or crop.
7. Click **Check files & preview**. The scene table shows subtitle text/timing, visual timing, and the assigned image/video. Use a scene's dropdown to change its media, **View image** for a thumbnail, or **Preview clip** for a muted original clip. Missing media block rendering. Extra media are listed as unused. Clip preview support depends on Electron's codecs; FFmpeg can render other supported imported formats.
8. Click **Render MP4**. Follow progress, cancel a queued/active render, preview the finished video, or **Save MP4 as…** to another folder.

Form selections and mapping are retained locally between Studio launches. Source assets and jobs are retained by the backend. Completed output is stored automatically at `output/assembly/<job-id>/video.mp4`, alongside `subtitles.srt`, `timeline.json`, and an FFmpeg log. This sidecar SRT is retained even when subtitles are disabled in the MP4.

## Optional video clips

**Visual sources** defaults to **Images only**. You can render narration + SRT + images without importing any clip, and without `transcript_video.json`.

| Mode | Behavior |
| --- | --- |
| Images only | All scenes use images. Previously selected clips are excluded from the render request. |
| Images + video | Choose an image or video for each scene. A video-only visual track also works; no placeholder images are required. |

Video files and folders support MP4, MOV, MKV, WebM and M4V. As with images, only files directly inside a selected folder are imported. Importing a video set replaces the selected clips, while retaining the image selection. Clips are copied into the active project's assembly assets.

Use the **full narration and full-timeline SRT**, with timestamps on the original audio timeline. Each SRT cue has one corresponding image or clip. The assembler does not use the WhisperX split time, introduce an opening section, or split a scene at a custom time.

- In **filename order**, images and videos are assigned from one combined, naturally sorted list, one asset per SRT scene.
- In **number matching**, both types use the original SRT cue number: `001.mp4` → scene 1, `002.png` → scene 2. In mixed mode, `001.png` plus `001.mp4` is ambiguous and requires a manual choice.
- Manual dropdown choices take precedence. Switching modes or media sets resets these choices and requires another preview.
- Each assigned clip starts from its beginning. Long clips are trimmed to the visual span. Short clips **Hold last frame** by default, or **Loop clip** if selected. The preview reports short clips. Clips are never sped up or slowed down to fit.
- **Clip audio is always muted**. Only the selected narration is included in the output.

Mixed rendering first prepares each visual segment with a common resolution and frame rate, then joins them and adds narration/subtitles. The UI reports the current segment and rendering progress. New image-only renders also use per-scene checkpoints; legacy queued jobs retain their original renderer. Settings, selected media and manual mappings are saved per active video. Drafts using a removed visual mode retain their imported files, reset the scene mapping and require a new preview.

## Timeline behavior

- The audio is the master duration. Narration is not sped up, slowed down or cut to remove pauses.
- The first visual is visible from time 0, including any silence before the first cue.
- Visual N remains until the start of the next cue, including the gap after cue N ends.
- The final visual remains until the narration ends.
- Visual changes are rounded to the nearest video frame; audio timing and the SRT timestamps remain as supplied. A subtitle file extending more than 0.1 seconds beyond the narration is rejected. Cues closer than one selected video frame are rejected.
- There are no crossfades or camera movements in this version; visual changes are direct cuts.

## Subtitles and framing

**Burn into video** is the default: captions remain visible in any player. FFmpeg must include the `subtitles` filter / libass. The chosen font must be installed on the rendering machine. For Japanese on Windows, **Yu Gothic** is a useful default; on Linux choose an installed Japanese font such as **Noto Sans CJK JP**. FFmpeg can fall back to a different font when the requested one is missing; review the exported subtitles to confirm glyph coverage.

**Selectable subtitle track** embeds `mov_text` in MP4. Player support and display style vary; this does not automatically create a separate uploaded YouTube caption track. **No visible subtitles** still uses the SRT to time image changes.

**Fit entire frame** preserves the full image or clip with black padding. **Fill frame** preserves aspect ratio and crops edges to fill the frame. Output uses H.264 video and AAC audio, with CPU encoding. One assembly runs at a time; FFmpeg uses a bounded number of threads.

## Input retention and recovery

Studio copies input files to `output/assembly/assets`; moving the original file later does not break a queued job. Existing SRT/audio sources are copied when the timeline is first prepared. Audio, image and video imports have no fixed application file-size cap; sufficient disk space is required. SRT files are limited to 8 MiB, selections to 1,000 images and 1,000 clips, and timelines to 3,000 cues.

A cancelled or failed render keeps the original imported assets and completed scene checkpoints. Partial scene files are cleaned on orderly cancellation. Jobs interrupted by a shutdown are marked interrupted; they do not restart without your action. Click **Resume render** on a failed, cancelled or interrupted job to continue the same saved plan. Studio verifies the input/settings fingerprint and SHA-256 of each cached scene before reuse; changed or damaged checkpoints are rendered again. Final muxing restarts if interrupted. Completed renders remove temporary scene files. Failed jobs retain them, so allow disk space for both the scene clips and final output. Changing sources or render settings requires a new render. Rendering has a six-hour timeout per attempt.

Native Electron dialogs select input/export paths; the renderer only submits asset/job IDs. MP4 export streams the file to disk, and the in-app player streams the backend MP4 instead of loading the complete video into memory.

## Validation performed

Automated tests rendered real MP4s with FFmpeg in all three subtitle modes. Tests checked resolution, duration, audio/subtitle streams, image colors before/after cue transitions, opening silence, inter-cue pauses and trailing audio. Other checks cover missing/duplicate image mappings, invalid inputs, cancellation/interruption, Electron mapping edits, native file import and streamed MP4 export.

The optional-video tests also render real mixed and clip-only MP4s, checking freeze/loop behavior, trimming, SRT cue transitions, source/output frame-rate conversion, unchanged SRT, narration-only audio and cleanup of intermediate files. API/desktop tests cover video import, streamed preview, optional selections, migration of retired mode settings, project ownership and saved input lineage.

These checks run in the development Linux environment. The user's Windows FFmpeg build, installed Japanese fonts and actual source media still determine local rendering results.


## Production controls (0.7.52)

- **Load video scene media** associates completed Flow image/video jobs by project, document, scene, current concept and exact timing. Select the SRT first: its text and cue times must match the project's current scenes. Studio copies generated files to assembly assets; repeated loading reuses existing copies. In mixed mode, video is preferred when both exist; the scene dropdown lets you choose an alternate result. Missing/stale media are reported, never generated automatically.
- **Check files & preview** inspects the actual selected files using FFprobe, not just saved database entries. Missing/empty/unreadable files block rendering. Low resolution and short clips produce warnings; short clips can hold the final frame or loop. Header/stream inspection cannot guarantee every frame decodes; rendering performs full decoding.
- **Text to Prompt**, **Prompt to Image** and **Prompt to Video** offer **Select failed** and **Retry failed**. Completed and active scenes are skipped. Failed Flow jobs with saved remote results resume retrieval using the original job. Other failures need explicit review before a new request, which may use provider credits. Successes, original prompts and media versions are retained.
- **Match SRT scene duration** defaults on for scene batches in Prompt to Video: choose the smallest supported 4/6/8/10-second duration covering the cue. A 9-second cue requests 10 seconds and assembly trims it. Cues over 10 seconds are flagged for hold/loop during assembly. Provider/model support still determines whether the requested generation succeeds. Manual duration remains available; single-prompt generation is unchanged.
- All stage transitions stay manual. Loading files, checking the timeline or completing media generation does not start the next stage.

Additional automated checks cover project/SRT ownership, repeated scene imports, stale concepts, failed-only retries, rounded generation duration, UI preflight blocking and resume controls. Real FFmpeg tests simulate interruption after one scene, then verify successful resume and re-encoding of a deliberately damaged checkpoint. Provider output in these tests is fixture data, not a live paid generation.
