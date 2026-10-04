# Worker windows — Studio 0.7.46

Update the complete source and restart Studio, including its backend and ChatGPT
gateway. Reload `extensions/chatgpt` (1.8.2) and `extensions/googleflow` (0.6.1)
in Chrome. ElevenLabs remains at 1.0.22 with the behavior from 0.7.45.

## ChatGPT

- SRT uses one fresh Work window. It closes only after Studio validates and saves
  the SRT and confirms the result through the existing commit protocol.
- Text to Prompt uses the existing three separate worker windows. They remain
  available throughout both the regular prompt queue and the storyboard concept
  queue. When all work has finished and been saved, managed worker tabs close.
- Closed workers keep their assignments as idle slots. The next request recreates
  their windows automatically; closing a finished batch does not require rebinding.
- The gateway blocks new text reservations during cleanup. Running, awaiting-save,
  and review workers cannot be cleaned up. SRT reservations remain separate.
- Windows created by Prepare 3 windows are managed. Existing bindings created by
  that action are migrated; manually assigned ordinary tabs remain open.

## Google Flow

Automated RPCs use a managed Flow tab in a separate normal Chrome window. Concurrent
calls share its creation and wait for the same new page to load. Existing unrelated
and manually opened Flow tabs are preserved. Generation concurrency is unchanged;
one Flow page can serve multiple RPCs.

The backend tracks the current session's desktop media jobs and scene requests.
Cleanup waits for pending requests, active generation, polling and desktop file
saving. Desktop jobs must finish their downloads and save file paths; scene requests
must save their results. The extension confirms closure through the correlated
request transport; a busy extension defers cleanup. Raw Flow API submissions alone
do not signal final file saving and therefore do not trigger this queue cleanup.

Failed or interrupted current-session work retains the page for inspection. An
explicit retry that saves the missing result can release it. Saved results are never
marked failed or generated again because tab cleanup fails.

## Shared behavior

Only managed tabs still on the expected site are removed. Other tabs in the same
window are retained. If the worker is Chrome's final tab, a blank tab keeps Chrome
and its extension connection alive. Closing a tab does not delete normal ChatGPT
conversation history or Google Flow projects.

Automated tests cover queue drain, save acknowledgements, parallel reservations,
separate windows, creation races, last-tab protection, manual/navigated tabs, and
reopening the next batch. Live signed-in Windows Chrome generation has not been
executed in this environment.
