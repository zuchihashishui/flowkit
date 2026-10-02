# Browser extensions

Each provider has its own independently loaded Chrome extension.

| Folder | Provider | Status |
| --- | --- | --- |
| `googleflow/` | Google Flow | Implemented |
| `chatgpt/` | ChatGPT | Implemented |
| `elevenlabs/` | ElevenLabs | Implemented: Text to Speech, Eleven v4, one tab with sequential chunks |

In chrome://extensions, use Load unpacked for each provider folder containing a manifest.json. Do not load the extensions parent folder.

## Migration from Studio 0.4.5 and earlier

Google Flow moved from extension/ to extensions/googleflow/. Disable the old Flow extension, then load the new folder. Confirm it connects before removing the old extension entry. Changing the unpacked path can create a new Chrome extension identity; local extension preferences/counters may need to be configured again. Do not enable both old and new Flow copies at the same time. ChatGPT stays in extensions/chatgpt/ and can be reloaded as before. Backend databases and output files have not moved.
