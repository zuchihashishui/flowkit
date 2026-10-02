# Fresh Text to Speech tabs — Studio 0.7.20 / Bridge 1.0.17

Every chunk follows this order:

1. Close all currently open ElevenLabs Text to Speech tabs in the extension's Chrome profile.
2. Open one new Text to Speech tab.
3. Bind the new tab automatically and wait for its editor and voice.
4. Clear restored text and refresh the new tab.
5. Wait for the refreshed editor, enter the chunk, and click Generate speech.
6. Download and save the completed audio; wait for save acknowledgement.

The same cycle repeats for the next chunk. Only exact Text to Speech URLs are
closed, including query parameters and a trailing slash. Other ElevenLabs pages,
ChatGPT, Google Flow, and unrelated tabs are not closed. When no unrelated tab exists,
a temporary blank tab keeps a browser window open during replacement. The blank tab
is removed after the new TTS tab is bound; it may remain after a failed replacement
so Chrome can report the error.

## Usage

Sign into ElevenLabs in Chrome and select the voice you want the website to restore.
Enable **Flowkit ElevenLabs Bridge** and add narration to the Studio queue. No existing
TTS tab or manual Bind is required for generation. The new page must still be signed
in; a fresh tab does not create a session or bypass login. Manual Bind and Check page
remain available for inspecting a tab and resolving a review lock.

The first chunk uses the voice shown on the new page. Later chunks must match the
voice of the job's saved audio. If the website restores another voice, the bridge
reports it before generating. Eleven v4 selection, Japanese text chunking, optional
credits, and the existing native download/save mechanism are retained.

Progress now includes **Closing previous tabs**, **Opening new tab**, **Binding tab**,
and **Waiting for new page**, followed by the existing clear/refresh/input/generation
stages. A deliberate old-tab closure does not cause Needs review. Closing the new
tab before Generate is a pre-submit failure; losing it after submission remains
uncertain and requires review. Tab replacement never runs during an unresolved
review or before save acknowledgement.

## Update all three parts

Close Studio, copy the full 0.7.20 source into the existing folder, and keep databases,
`output/`, and `.venv`. Dependencies have not changed from 0.7.19. Open Studio and use
**Restart local backend** if an older process is still serving port 8100. Reload the
ElevenLabs extension in Chrome and verify **1.0.17**. The backend requires the new
`elevenlabs_auto_prepare_tab` capability; otherwise an old backend would keep waiting
for manual binding. ChatGPT and Google Flow extensions have not changed.

Existing review jobs are not automatically retried. Inspect their results and release
review first, then choose the unfinished work to queue and resume.

## Validation scope

Release checks: **543 Python tests and 253 JavaScript/UI tests passed**.
JavaScript syntax and diff checks passed.

Regression tests cover multiple old TTS tabs, no existing tabs, a stale remembered
tab, last-window protection, unrelated tab preservation, automatic binding, exact
clear/refresh/generate order, two chunks separated by save acknowledgement, missing
page receivers, page timeout, voice mismatch, and closure before/after submission.
Backend tests cover both fresh-tab and legacy bound-tab handshakes over local
HTTP/WebSocket transport. UI tests cover preparation progress and readiness without
manual binding. These are automated tests; a signed-in ElevenLabs generation and
native Windows Chrome operation have not been executed in this environment.
