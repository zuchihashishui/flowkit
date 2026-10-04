# Project Settings — Studio 0.7.54

A project contains multiple videos. Browser destinations belong to the project; scripts, narration, transcripts, SRT scenes, prompts and generated media belong to each video.

## Setup

1. Replace the complete source, then restart Studio, its backend and ChatGPT gateway.
2. Reload **ChatGPT Bridge 1.9.0**, **ElevenLabs Bridge 1.0.23** and **Google Flow Bridge 0.6.2** in Chrome. They remain three separate extensions.
3. In **Project**, select a project and edit **Project Settings**. Save once; every video in that project uses these URLs.
4. Create/select a video, then start each production stage manually.

| Setting | Accepted destination | Used by |
| --- | --- | --- |
| ChatGPT URL · JSON → SRT | `https://chatgpt.com/`, optionally with a query | One fresh Work worker with the selected SRT model and JSON attachment |
| GPT URL · Image prompts | ChatGPT home or `https://chatgpt.com/g/g-…` | Image prompt jobs |
| GPT URL · Video prompts | ChatGPT home or `https://chatgpt.com/g/g-…` | Video prompt jobs |
| ElevenLabs · Text to Speech URL | `https://elevenlabs.io/app/speech-synthesis/text-to-speech`, optionally with a query | Fresh TTS window for every narration chunk |
| Google Flow URL | `https://flow.google.com/` or `/project/<UUID>`; legacy `labs.google/fx/tools/flow` links also accepted | Image/video generation and polling |

Use GPT home links, not existing conversation links. ElevenLabs query parameters are preserved, but the extension still checks the actual voice shown by the page; a URL alone cannot guarantee a voice selection.

A Flow URL containing a project UUID selects that remote Flow project without changing Studio project/video IDs. A Flow home URL keeps the existing remote project ID behavior. Existing data and IDs are retained.

## Text to Prompt with custom GPTs

- Put your shared instructions, style, output language and output format in the custom GPT. Configure it to return **one plain prompt, up to 5,000 characters**.
- In **Text to Prompt**, choose **Image prompt** or **Video prompt**, select scenes, then **Create Concepts**. The default provider is **ChatGPT Web / Project GPT**.
- Each request sends exactly the saved scene text as one user message. There is no instruction wrapper, script context, neighboring scene text, timestamp JSON or attachment. It uses the current GPT/page model.
- Studio prepares up to three separate worker windows automatically. Each worker navigates to the saved GPT home URL for the next scene, avoiding previous conversation context. Tabs are reused throughout the queue and closed after saved results are acknowledged and the queue drains.
- Custom GPT requests use regular chat; they may appear in ChatGPT history. The extension does not promise Temporary Chat or history deletion for GPTs. Standard ChatGPT home destinations use Chat / Temporary Chat.
- The plain response becomes the selected prompt field. The other field is preserved. Generating a video prompt after an image prompt does not invalidate saved images with unchanged source revisions, prompt and timing.
- Failed scenes remain selectable for an explicit retry. Already completed prompts/media are skipped unless regeneration is selected.
- CLI providers retain their existing JSON concept format and generate both prompt fields with context. SRT remains one separate Work request with JSON; it does not use the image/video GPT worker pool.

The manual ChatGPT testing/batch screen and extension **Prepare 3 windows** button remain standard ChatGPT tools. Scene-to-GPT production automatically routes jobs using Project Settings, without requiring that manual preparation step. Active worker cards show each request’s destination URL.

## Persistence and updates

Project settings use an additive `project_settings` table with revision checks. Save conflicts require reloading current values. Switching projects with unsaved edits prompts before discarding them.

New narration, SRT, concept and media jobs freeze their project URL settings. Changing a project’s settings does not reroute queued/running jobs. Retrying an existing narration/media job keeps its original settings; creating a new prompt/SRT job captures current settings. Historical jobs without a snapshot keep their legacy destinations.

Known incompatible extensions are rejected before generation instead of silently using another URL. No generation is automatically retried after an uncertain submission.

## Verification

Automated checks exercise separate project settings, restart persistence, stale-save protection, exact scene text requests, URL snapshots, independent prompt fields, media reuse, three worker routing, TTS refresh, Flow request isolation, gateway capability checks, native IPC and Electron UI behavior. Browser/provider responses are simulated; these checks do not prove successful live generation in a signed-in provider account.
