# Vendored component

Source: https://github.com/Draivix/chatgpt-gateway
Commit: e9b3f6a4e984409d5bd09f0d0eb1544c0c366e31
License: MIT, retained in this folder and extensions/chatgpt/LICENSE.

Only the local Node/WebSocket gateway and Chrome extension are integrated.
The upstream Camoufox, auto-login and MCP subprojects are not included.

Flowkit modifications: explicit tab selection; page navigation before content messaging;
DOM completion polling rejects timeout/partial output; model selection failures are
visible; one active request; fail-closed review state after disconnect; loopback bind;
reject cross-origin browser HTTP calls; bounded bodies; no automatic replay;
server identity/protocol health check; simplified popup; persistent Python audit.

This remains DOM automation, not direct ChatGPT backend API or native SSE forwarding.
No authentication challenges are bypassed. Users sign in manually in Chrome.
