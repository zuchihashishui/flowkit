# WhisperX: merged audio to aligned JSON

Studio 0.7.30 adds a **WhisperX** page and **Create word JSON** next to saved ElevenLabs joined audio. The ElevenLabs extension is unchanged.

## Windows setup

1. Install Python 3.12 and ensure FFmpeg is available on PATH (the same FFmpeg used for narration joining).
2. Run `tools/whisperx/setup_windows.bat` once. Choose NVIDIA CUDA or CPU. It installs a separate `.venv-whisperx` environment; the Flowkit backend and OmniVoice environment are not modified.
3. The CUDA option installs PyTorch 2.8 with CUDA 12.8 wheels. Install a compatible NVIDIA driver and the CUDA 12.8 toolkit/libraries required by WhisperX. A CUDA import check does not guarantee that CTranslate2 inference will run. GPU errors remain visible in the job log; CPU is an available alternative.
4. Restart Studio and its backend. Open **WhisperX → Check environment**. This verifies imports and reports CUDA/FFmpeg availability; it does not download/test speech models.
5. Choose a merged narration, model, language (Japanese or auto-detect), device and batch size. Click **Create word JSON**. The initial run downloads the ASR, VAD and language alignment models and requires internet access.
6. Use **Preview words** or the individual **Save transcript…** buttons after completion.

To use an existing environment, set `WHISPERX_PYTHON_BIN` to its full Python executable path before starting Studio. Use a Windows Python executable for a Windows backend; a WSL Python path cannot be launched directly by the Windows backend.

Linux/WSL: run `bash tools/whisperx/setup_linux.sh` for CPU or append `cuda` for the GPU environment. Run the backend in the same OS/environment context. The installer requires Python venv support and FFmpeg separately.

## Workflow

Studio 0.7.34 defaults to **NVIDIA GPU / CUDA** in the desktop form, API and worker. Existing saved Auto settings switch to CUDA once on update; saved CPU choices and existing jobs retain their device. Later selections of Auto or CPU persist normally through **Save settings**. CUDA mode reports an error if CUDA is unavailable; select Auto explicitly to allow CPU fallback. This update does not change the installed WhisperX/PyTorch versions or setup scripts. Restart Studio and its backend after updating.

The source list contains narrations with merged audio and audio imported using **Choose audio file**. Supported imports: MP3, WAV, M4A, FLAC, OGG, OPUS and AAC. Studio copies selected files to `output/whisperx/_imports/` in chunks, without a fixed application file-size cap. The original file is unchanged. Imported sources persist across restarts and are manually queued using **Create word JSON**. Media decoding happens in the transcription worker; a file extension alone does not guarantee that the audio is valid. A single-chunk narration also qualifies. The worker uses IDs and backend-owned audio paths, never arbitrary executable/path values from the renderer.

One transcription process runs at a time. The UI reports **Starting → Speech model → Read audio → Transcribe → Alignment model → Align timestamps → Save JSON → Verify → Completed**. Cancel stops the local transcription process. Logs are in `output/whisperx/<transcription-id>/worker.log`.

**Studio 0.7.43:** stages are manual in Electron. Select the active project in Projects, choose its audio and click **Create word JSON**. Any old automatic-transcription preference is disabled once during migration. Project-linked narrations never auto-enqueue; legacy CLI callers may explicitly re-enable automatic discovery for unassigned narrations only. See [Video workflow](VIDEO_WORKFLOW.md).

The queue/settings survive backend restarts. An interrupted running job is marked **INTERRUPTED**, never silently reported as complete. Pending jobs resume. The worker has a six-hour execution limit; model download time is included.

## JSON

Saved at `output/whisperx/<transcription-id>/transcript.json`. **Save transcript.json** exports the full file to a selected location. Studio 0.7.49 also saves the two derived files described below.

- `language`: detected/selected language.
- `segments`: native aligned WhisperX segments, including text, timestamps, words and character alignments where available.
- `word_segments`: native flat list of word units with `word`, `start`, `end`, `score` when supplied by WhisperX.
- `metadata`: engine/version, source filename, settings, seconds as timestamp units, count and warning for unaligned words.

Missing timestamps are preserved as missing values; no times or scores are invented. For Japanese/Chinese, WhisperX may produce character-level units rather than linguistically segmented words. No speaker diarization, translation, ChatGPT call, SRT re-segmentation or 3–15 second scene assembly occurs in this stage. The JSON is suitable as the input for those later stages.

## Validation scope

Local tests cover subprocess dispatch, persisted JSON, cancellation, failure reporting, automatic queue rules, API validation, UI operations and preservation of native alignment fields. A real model transcription and CUDA execution must still be checked on the target machine after installing the environment.

Upstream references: [WhisperX README](https://github.com/m-bain/whisperX), [alignment implementation](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py), [dependency definitions](https://github.com/m-bain/whisperX/blob/main/pyproject.toml).


## Progress for long narrations

Studio 0.7.33 adds **Transcription progress** to the WhisperX page. Update the complete source and restart Studio/backend. This update needs no model downloads, dependency upgrades or extension reloads of its own. A previously queued job uses the updated runner when started; an already-running process keeps its original code until it finishes or is cancelled.

The display includes:

- **Current stage percent:** transcription uses the fraction of native speech chunks completed; alignment uses processed input segments. This is not an overall time estimate or an audio-duration fraction. Percent resets for each stage.
- **Segments processed:** the current count and total where the engine exposes them.
- **Source words / characters processed:** during alignment, cumulative input text in processed segments. Japanese and Chinese count non-whitespace characters (including punctuation); other languages count whitespace-delimited source words. Counts include segments that could not be fully aligned; they are not a count of successfully timestamped words. The final output word-unit count comes from the saved JSON and can differ.
- **Audio position reached:** the end timestamp of the last reported segment; it includes any preceding silence and need not track stage percent linearly. Total decoded audio length is shown separately.
- **Elapsed time** and **time since the last worker update**. UI status refreshes approximately every three seconds; elapsed time ticks every second. There is no simulated progress between worker reports. A long model load, download, VAD pass or GPU batch may legitimately produce no segment update for a while.

Model loading, decoding and JSON saving show an indeterminate bar when no trustworthy percentage exists. Native 100% for transcription means recognition has finished; alignment and saving may still remain. A job is marked completed only after the backend verifies the saved JSON. Failures and cancellation preserve the last measured progress and stop the elapsed clock.

The runner uses native progress callbacks when present. For WhisperX 3.7.0/3.7.4 transcription it reads native progress and transcript-position output. Their alignment progress printout occurs in the text-preparation pass, so Studio instead observes completion of segments in the verified second pass. The original align function is still called once with the same segment objects; audio, batching and alignment options are unchanged. If a different implementation cannot be identified, it keeps stage/elapsed reporting instead of inferring a false percentage. No live transcript text is added to the Electron progress panel; the native transcript diagnostics are retained in the local worker log.

A database migration adds progress and runtime fields without removing existing jobs or files. Older completed jobs remain available even though their historic runtime/progress was not recorded.

Validation: tests cover callback and 3.7-style progress, recognition output/timestamp parsing, alignment preprocessing versus completed segments, Japanese character counts, unchanged return objects, live subprocess progress before completion, persistence/migration, late events after cancellation, and Electron rendering. These are controlled runner/subprocess tests; they do not run a full WhisperX model on the user's GPU.


## Three transcript files (Studio 0.7.49)

The WhisperX form has **Video duration (seconds)**, default **100**. Choose a
value from 0 to 86,400 seconds, including fractional seconds. **Save settings**
remembers it for future sessions; creating a job snapshots the current value
for that job. Polling does not overwrite an edited value.

After transcription/alignment, the backend writes these files under
`output/whisperx/<job-id>/`:

| File | Content |
|---|---|
| `transcript.json` | Original complete WhisperX result; splitting never rewrites it |
| `transcript_video.json` | Opening transcript, normally words starting before the selected time |
| `transcript_image.json` | Remaining transcript, normally words starting at or after that time |

A word starting exactly at the boundary belongs to image. A word starting before
it and ending after it is kept whole in video. This is a text partition at word
boundaries, not an audio cut: timestamps, scores and source language remain
unchanged. The image part keeps times such as 100.2 seconds; they are not reset
to zero. Japanese/Chinese alignment may consist of individual characters.

A segment crossing the boundary is split using the matching original text and
word records. Punctuation and spacing are retained. Native character alignment
is partitioned too. Duplicate nested/flat word lists remain equivalent where
both represent the same native alignment. Source words and text are not
translated, re-recognized or sent to another model.

When timing is absent, no timestamps are invented. Untimed words stay with the
preceding side; leading untimed words follow the next timed word. If a segment
cannot be split because alignment is absent or differs from its text, it stays
whole on its starting side and a warning explains the limitation. Unmatched
flat alignment is partitioned separately with a warning. All original text and
records are retained across the two files, but an exact temporal separation
cannot be guaranteed for incomplete or inconsistent alignment.

For audio shorter than the selected opening duration, the image file normally
contains empty `segments` and `word_segments` arrays. Both files are still
created. A duration of zero places the transcript in image.

Each derived file includes `metadata.transcript_split` with the chosen duration,
part name, requested range, original-audio time reference, source SHA-256,
counts and warnings. Full-audio duration metadata remains the duration of the
original audio; it is not changed to the excerpt's length. These are excerpts
of one audio timeline, not standalone audio transcripts rebased to zero.

The UI shows the chosen split, counts and warnings on completed jobs. Use
**Preview words → JSON file** to inspect each result and the separate save
buttons to export the three files. **Create SRT** continues to use the original
full transcript; this release does not change later-stage routing.

### Change the split on an existing job

Set **Video duration (seconds)** in the form, then click **Split saved JSON** on
the desired completed job. This creates or replaces only its two derived files.
It does not rerun WhisperX, generate speech, alter the original JSON or charge
provider credits. The job displays the new split after completion. Older jobs
with only `transcript.json` support this action as well; they are not rewritten
automatically merely by opening the UI.

New transcription jobs reach COMPLETED only after all three JSON files have
been saved. The progress panel adds **Split JSON** after verification. Cancelling
or failing a job does not falsely report three successfully saved results.

### API and validation

- `POST /api/whisperx/jobs` and `/settings` accept `video_duration_seconds`.
- `POST /api/whisperx/jobs/<id>/split` accepts the same value for a completed job.
- Existing `/result` and `/preview` still refer to the complete transcript.
- `/result/video`, `/result/image`, `/preview/video` and `/preview/image` expose
  the derived files. Variant names are restricted to `full`, `video`, `image`.
- `/status` advertises `transcript_split_version: 1`; an older backend cannot
  silently accept a new UI request while producing only one file.

Automated tests cover exact boundary/crossing words, custom/fractional/zero
thresholds, empty parts, missing alignment, punctuation, millisecond input,
unchanged source bytes, source hashes, repeated splitting and a 10,000-character
Japanese fixture. Service tests exercise real subprocess completion with a
simulated WhisperX runner, old-job splitting, downloads and persisted options.
Electron/IPC tests exercise the form, previews, export names, project handoffs
and stale-backend detection. No WhisperX model/GPU run or native Windows dialog
was performed for this change; the existing recognition runner is unchanged.

### Retry an interrupted local transcription

After a backend restart, an in-flight transcription becomes **Interrupted** and waits for you. Use **Retry job** on a Failed or Interrupted job to queue the same saved audio, model, device, language, batch size and transcript split settings. This is a local WhisperX retry; it does not call ElevenLabs or generate narration again.

The retry creates a new job ID and preserves the previous attempt, log and any partial files. It retains the original project/video ownership even if project defaults have changed. Completed transcripts cannot be overwritten through this action. A missing source file or another queued/running transcription for the same audio blocks retry with an actionable message.
