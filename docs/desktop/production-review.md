# Production dashboard and Scene Board

The Project page shows progress for every video in the selected project. Each stage card opens the corresponding tool with that video selected. Selecting a card does not start a job.

The stages are narration, word JSON, SRT, image prompts, video prompts, images, video clips and the final render. Video prompts and clips are optional. Readiness describes saved current results, not only whether a provider once returned success. Scene coverage counts a valid image or video for each scene, so a video clip does not require an additional image.

Use **Check next step** for a read-only report of missing inputs, connections and other prerequisites. Generation buttons also run a scoped check before enqueueing. If the project or video changes while a check is pending, its result cannot authorize work in the new context.

## Recovery center

Recovery lists queued, running, failed and uncertain jobs alongside saved results that can be recovered. Its buttons open the owning video and the matching recovery controls. Media downloads open their exact job in Queue & Downloads; uncertain ChatGPT submissions open Settings → ChatGPT Web; saved SRT quality exceptions open SRT. Other jobs open their production stage. It never automatically resubmits a remote request. Inspect uncertain provider results before retrying to avoid creating a duplicate and spending credits again.

## Scene Board

Each row combines the original SRT timing and narration, separate image and video prompts, saved current media, and job activity. Existing older media stays retained but is marked separately. An image prompt remains valid when only its video prompt is added, and vice versa.

- Filter by failed scenes, review required, missing prompts, missing images or clips, or saved media.
- Search scene text and prompts. Page through 25 scenes at a time.
- Image thumbnails load from saved output, with at most three concurrent preview reads. Open an image or video for a larger preview.
- Selection, search and filters are remembered separately for each project/video pair.
- Choose the retry target, select failed scenes and click **Retry selected failed scenes**. At most 200 selected scenes are submitted in one action. Successful and active results are preserved. Download-only resumes use the existing backend behavior when a remote result is already known.
- **Edit scene** opens its editor in Text to Prompt. Edits and generation remain explicit actions.

Thumbnail URLs are cached for up to 50 recent results and released when changing videos. Delayed replies from a previous project or video are discarded. These UI checks do not verify live account access by themselves; provider errors can still occur after a successful preflight.
