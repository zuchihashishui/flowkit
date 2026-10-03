# ElevenLabs browser bridge

This integration drives the signed-in **Text to Speech** page using
`extensions/elevenlabs/`. It requires no ElevenLabs API key and uses page controls,
not undocumented provider endpoints. Setup and troubleshooting are maintained in
[the extension guide](../ELEVENLABS_EXTENSION.md).

## Local architecture

Studio uses `/api/elevenlabs/*` on the local Python backend. The extension connects
to `ws://127.0.0.1:8100/api/elevenlabs/ws`; only loopback WebSocket clients with a
Chrome extension origin are accepted. Keep the backend bound to loopback.

`elevenlabs_jobs.db` persists jobs, chunks, queue settings, errors, and native download
metadata. Files are stored under `output/elevenlabs/<job-id>/`. The bridge submits one
chunk at a time. Each chunk closes existing TTS tabs, opens and auto-binds a new tab,
clears/restores the editor with a refresh, then submits the new text. It retains the reservation until the file is saved and the extension
acknowledges the commit. The first saved voice is pinned across the job.

The splitter preserves exact source text and prefers paragraph/sentence boundaries
within 75–100% of the selected maximum in UTF-16 code units. The default maximum is 3,000 units; the last chunk can be
shorter. `characters`, `start`, and `end` use Unicode code points. Concatenating chunk
text reconstructs the source. A job accepts at most 500,000 code points.

Credits and current cost are optional display data read after entry. Neither the
page counter nor missing credit information blocks generation. The selected model
must be found and verified; the default is the page label `Eleven v4`.

## Audio persistence and recovery

Current extension results contain `nativeDownload` metadata. The backend checks the
expected UUID-based path beneath the configured downloads directory, copies in 1 MiB
blocks, inspects the audio signature, validates with FFprobe when available, and
atomically saves the file. Native files have no application size cap. The legacy
`audioBase64` result remains limited to 10 MiB of decoded data.

Download metadata is persisted before import so a directory error, disk error, or
restart can be recovered without Generate. Recovery imports only known downloaded
files; it does not discover or associate arbitrary old files. Jobs from previous
versions may lack the metadata required for recovery. Originals are preserved.

All completed chunks are optionally joined using FFmpeg into mono 44.1 kHz,
192 kbit/s MP3, without intentional pauses. A single completed chunk is directly
available through the merged route. Missing FFmpeg or a merge error leaves each
saved chunk available; incomplete jobs are not merged.

## Failure states

A confirmed `notSubmitted:true` error fails the chunk and pauses the queue. It does
not require review unless another existing worker lock is still unresolved. A lost
response or uncertain submitted operation becomes `NEEDS_REVIEW`; no automatic paid
retry occurs. Saved chunks remain `COMPLETED` even when the final acknowledgement
is uncertain.

`status.processing` / `busy` describe active work; `reviewRequired` / `needsReview`
describe a review lock. `blocked` includes paused/review states. Explicit successful
review clears stale worker state immediately and leaves the queue paused. Retry and
recovery preserve completed chunks. Review does not imply retry or resume.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/elevenlabs/status` | Connection, page, progress, active work, and queue state |
| POST | `/api/elevenlabs/probe` | Inspect the bound tab without generation |
| POST | `/api/elevenlabs/preview` | `{text}` returns exact chunks |
| POST | `/api/elevenlabs/jobs` | `{text,title?,model?}` saves a narration job |
| GET | `/api/elevenlabs/jobs` | Recent jobs and queue settings |
| GET | `/api/elevenlabs/jobs/{id}` | Job, chunks, download metadata, and audio links |
| POST | `/api/elevenlabs/control` | `{action:"pause"\|"resume"\|"review",reviewed?:true}` |
| POST | `/api/elevenlabs/jobs/{id}/cancel` | Cancel unstarted chunks |
| POST | `/api/elevenlabs/jobs/{id}/retry` | Queue unfinished chunks; `reviewed:true` required for uncertain/cancelled work |
| POST | `/api/elevenlabs/jobs/{id}/recover` | `{reviewed:true}` imports recorded downloads without Generate |
| GET | `/api/elevenlabs/audio/{id}/{index}` | Download saved chunk, starting at index 1 |
| GET | `/api/elevenlabs/audio/{id}/merged` | Download joined narration |

Recovery requires a released, inactive worker, pauses the queue, and returns
`{recovered,errors:[{chunk_index,error}],job}`. Jobs expose `recoverable_downloads`
and `retry_requires_review`; chunks expose `recoverable_download`. These describe
recorded metadata, not a guarantee that the original file still exists.

Audio API requests address database IDs and chunk indexes, never arbitrary paths.
Studio also checks `/health` for `studio_api:3` and required `studio_features`
capabilities before ElevenLabs mutations, warning if an older backend is still running.

## WebSocket protocol

- Extension announces `status` with `enabled`, `ready`, `tabId`, `busy`, `state`,
  `needsReview`, `autoPrepareTab`, and `page`. An explicit `autoPrepareTab:true` permits
  a ready idle worker to receive a chunk without a bound tab; it then creates and
  binds its own tab. Older workers still require a valid bound tab. This capability
  resets when the connection changes and never overrides review/busy/paused gates.
- Backend sends `generate` with `requestId`, `text`, `model`, `expectedVoice`, and
  `timeout` in milliseconds, default 600,000.
- Extension reports `progress` for that request and a final `result` with `ok` plus
  `nativeDownload`, `mimeType`, voice/model, and optional credit information.
  Legacy inline audio may use `audioBase64` instead. Failed results include `error`
  and may include `code`, `notSubmitted`, and current review/worker state.
- Backend sends `commit` with `ok:true` after persistence. Only a matching successful
  `commitAck` releases the reservation. `commit` with `ok:false` holds uncertain work
  for review. Proven pre-submit failures do not enter that acknowledgement flow.
- Read-only `probe` and explicit `review` commands have their own request IDs.

Responses must belong to the active socket and exact request. Late results cannot
complete another job. The backend allows generation timeout plus 240 seconds for
preparation/download, and 10 seconds for commit acknowledgement.

## Validation scope

Automated coverage includes real local HTTP/WebSocket transport, queue transitions,
restarts, download recovery, large-file import, Electron IPC/UI behavior, and actual
ProseMirror model updates using paragraph and inline speaker schemas. Browser service
and provider generation interactions use test doubles or sanitized page fixtures.
These checks do not establish successful paid generation in a signed-in account or
native Windows Electron operation. See the [release review](../STABILITY_REVIEW_0.7.18.md).

Preview and job creation accept `max_chunk_characters` (integer 100–3000, default 3000). Studio exposes this as **Max characters per chunk**. Existing jobs keep their persisted chunks.
