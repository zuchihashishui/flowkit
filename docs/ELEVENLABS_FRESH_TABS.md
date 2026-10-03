# Separate Text to Speech windows — Studio 0.7.45 / Bridge 1.0.22

The automated worker opens its Text to Speech tab in a separate normal Chrome
window. The side panel's Open ElevenLabs button also opens a separate window.
After the backend has saved every chunk of a narration job, its successful commit
includes `jobComplete: true`. Only then does the extension close its own worker tab.
Local narration merging continues in the backend after this acknowledgement.

Intermediate chunks and failed/review jobs do not trigger final cleanup. A tab
navigated away from Text to Speech is preserved. Cleanup removes only the worker
tab, not other tabs the user may have added to that window. A blank tab is kept if
necessary to avoid shutting down Chrome. If Chrome refuses cleanup, saved audio
remains successful and the extension records a warning.

Update the complete source, restart Studio/backend, and reload
`extensions/elevenlabs` in Chrome (version 1.0.22). No dependencies changed.
Automated backend and extension tests cover save acknowledgements, separate-window
creation, intermediate chunks, cleanup failure, navigation and last-tab protection.
Live signed-in Windows Chrome generation was not tested in this environment.

## Existing preparation sequence

Every chunk follows this order:

1. Close all currently open ElevenLabs Text to Speech tabs in the extension's Chrome profile.
2. Open one new Text to Speech tab in a separate Chrome window.
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
