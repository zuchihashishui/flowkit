# Google Flow queue and progress

The Desktop image/video queue now runs up to **three jobs concurrently**. A
job occupies its slot until its image/video is downloaded and checked with
FFprobe, or the job fails. Local voice cloning has its own single-job lane.
An open, signed-in Flow tab is sufficient; this does not create three tabs.

The shared generation RPC guard defaults to three in-flight generation RPCs
and a minimum three-second gap between starts. Jobs overlap; requests are
not fired as an unrestricted burst. `FLOW_GENERATION_MAX_CONCURRENT` and
`FLOW_GENERATION_MIN_INTERVAL_S` environment overrides continue to apply to
Desktop, direct API calls and the legacy queue. Previously the generation
guard defaulted to one, and Desktop awaited an entire job before scanning
again two seconds later.

The legacy project worker retains its existing defaults: five active jobs,
ten seconds between API starts (`API_COOLDOWN`), and a five-second queue scan.
It shares the generation RPC guard with Desktop. These are local limits,
not guarantees about Google's account limits or completion time.

## Progress surfaces

Both the Google Flow popup and side panel show:

- Desktop active slots, queued jobs, saved files and jobs needing attention.
- Per-job stages, elapsed time and the last error.
- Effective generation RPC capacity, minimum start spacing and cooldown.
- Current bridge RPCs in flight, including metadata/poll requests.

The Desktop queue summary is read from `GET /api/desktop/flow-progress` every
two seconds while a popup/panel is open. It returns at most 50 rows, with
active jobs first; the extension shows the first 12. No prompts, remote
media URLs or filesystem paths are included. An unavailable or older backend
shows an error instead of presenting stale progress as live.

Stages distinguish queued, starting, submitting/generating an image,
submitting a video, polling video generation, downloading/verifying,
completed, failed, cancelled and needs review. Image generation includes
time spent waiting for the shared submission guard because its RPC returns
the generated image result in one call. No invented percentage is displayed.

The RPC log labels a successful HTTP return as **returned**, not **done**.
A returned RPC may only acknowledge a video submission; the Desktop job is
completed only after the media file is saved and validated. HTTP errors are
counted as failed bridge requests, and one finishing RPC cannot clear the
running badge while another RPC is active.

## Pause, cooldown and recovery

Pausing the Desktop queue stops new jobs from being claimed; jobs already
claimed finish. Google's unusual-activity cooldown (default 120 seconds)
is preserved. Fresh queued jobs wait during cooldown; saved remote results
can still poll or download. A request already in flight cannot be recalled.
Waiting submissions check cooldown again after their minimum spacing delay.

Shutdown cancels local tasks and retains durable states. On restart, saved
remote results resume without generating again; uncertain submissions move
to `NEEDS_REVIEW`. Download failures retain their remote result for explicit
resume. No automatic retry is introduced for uncertain generations.

Restart the backend and reload `extensions/googleflow/` after updating. If
the local environment sets the generation concurrency to one, that override
still wins; the UI shows the effective value.

Tests cover three overlapping jobs, bounded capacity, queue pause, cooldown,
saved-download recovery, safe progress rendering and overlapping RPC badges.
These are simulated browser/Flow tests, not a claim of live generation success.
