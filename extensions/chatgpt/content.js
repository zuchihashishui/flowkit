// ChatGPT Gateway — Content script
// Injected into chatgpt.com, handles DOM automation
(function () {
  "use strict";

  const POLL_INTERVAL = 1500;
  const MAX_WAIT = 180_000; // 3 minutes

  // ── Helpers ──────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findInput() {
    const selectors = [
      'div.ProseMirror[contenteditable="true"][role="textbox"][data-composer-markdown][aria-label="Work with ChatGPT"]',
      'div.ProseMirror[contenteditable="true"][role="textbox"][data-composer-markdown][aria-label="Ask ChatGPT"]',
      'div.ProseMirror[contenteditable="true"][role="textbox"][data-composer-markdown]',
      "#prompt-textarea",
      'div[contenteditable="true"][id="prompt-textarea"]',
      "textarea",
      '[contenteditable="true"]',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.offsetParent !== null && !el.closest('[hidden], [aria-hidden="true"]')) return el;
      }
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[type="submit"][aria-label="Send"]',
      '[data-testid="send-button"]',
      "#composer-submit-button",
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true" && !btn.closest("[hidden], [aria-hidden=\"true\"]")) return btn;
    }
    return null;
  }

  // Modern Chat/Work markup plus the older ChatGPT assistant wrapper.
  function assistantMessages() {
    const selector = '[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]';
    return [...document.querySelectorAll(selector)]
      .filter(el => !el.closest('[hidden], [aria-hidden="true"], [data-user-message-bubble]'))
      // A modern markdown root nested in a legacy wrapper is one message.
      .filter(el => !el.matches('[data-message-author-role="assistant"]') ||
        !el.querySelector('[data-markdown-text-style="assistant-message"]'));
  }

  function messageKey(el) {
    const selected = el.closest('[data-chatgpt-selection-message-id]');
    if (selected) return 'message:' + selected.getAttribute('data-chatgpt-selection-message-id');
    const legacy = el.closest('[data-message-id]');
    if (legacy) return 'message:' + legacy.getAttribute('data-message-id');
    const unit = el.closest('[data-chatgpt-search-message-ids]');
    if (unit) return 'message:' + unit.getAttribute('data-chatgpt-search-message-ids').trim().split(/\s+/)[0];
    return el; // Node identity fallback for older layouts without IDs.
  }

  function assistantText(el) {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('button, svg, script, style, [hidden], [aria-hidden="true"], .sr-only, .turn-action-controls').forEach(n => n.remove());
    copy.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    copy.querySelectorAll('p, li, pre, h1, h2, h3, h4, h5, h6, tr, blockquote').forEach(n => n.append('\n'));
    return (copy.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  }

  function isStreaming() {
    return !!document.querySelector(
      'button[aria-label="Stop"], button[aria-label="Stop streaming"], [data-testid="stop-button"], button[aria-label*="Stop"]'
    );
  }

  // ── Actions ──────────────────────────────────────────────

  async function startNewChat() {
    // Try the "New chat" button/link
    const selectors = [
      'a[href="/"]',
      '[data-testid="create-new-chat-button"]',
      'nav a[href="/"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        await sleep(1500);
        return;
      }
    }
    // Fallback: navigate
    window.location.href = "https://chatgpt.com/";
    await sleep(2500);
  }

  async function selectModel(modelSlug) {
    if (!modelSlug || modelSlug === "auto") return;

    // Try clicking the model picker
    const pickerSelectors = [
      '[data-testid="model-switcher"]',
      'button[aria-haspopup="listbox"]',
      'button[aria-haspopup="menu"]',
    ];

    let picker = null;
    for (const sel of pickerSelectors) {
      picker = document.querySelector(sel);
      if (picker) break;
    }

    if (!picker) throw new Error("Cannot find model picker. Select the model manually and use auto.");

    picker.click();
    await sleep(800);

    // Find model option
    const options = document.querySelectorAll(
      '[role="option"], [role="menuitemradio"], [role="menuitem"]'
    );
    const slug = modelSlug.toLowerCase();
    for (const opt of options) {
      const text = (opt.textContent || "").toLowerCase();
      if (text.includes(slug) || text.includes(slug.replace(/-/g, " "))) {
        opt.click();
        await sleep(500);
        return;
      }
    }
    // Close picker if model not found
    document.body.click();
    await sleep(300);
    throw new Error("Requested model was not found. Select it manually and use auto.");
  }

  async function typeMessage(text) {
    const input = findInput();
    if (!input) throw new Error("Cannot find ChatGPT input field");

    input.focus();
    await sleep(200);

    // Select all existing content and delete it
    document.execCommand("selectAll");
    document.execCommand("delete");
    await sleep(100);

    // Insert text — execCommand works with both textarea and contenteditable
    // For long texts, chunk it to avoid issues
    if (text.length > 4000) {
      // For very long text, set directly and dispatch events
      if (input.getAttribute("contenteditable") === "true") {
        // ProseMirror/contenteditable
        const p = document.createElement("p");
        p.textContent = text;
        input.innerHTML = "";
        input.appendChild(p);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      document.execCommand("insertText", false, text);
    }

    await sleep(400);

    // Verify text was entered
    const currentText =
      input.getAttribute("contenteditable") === "true"
        ? (input.textContent || "").trim()
        : (input.value || "").trim();

    if (!currentText) {
      // Retry with direct assignment
      if (input.getAttribute("contenteditable") === "true") {
        input.textContent = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await sleep(400);
    }
  }

  async function clickSend() {
    // Wait a moment for the send button to become enabled
    for (let i = 0; i < 10; i++) {
      const btn = findSendButton();
      if (btn && !btn.disabled) {
        btn.click();
        return;
      }
      await sleep(300);
    }
    throw new Error("Send button not found or disabled");
  }

  async function waitForNewResponse(beforeMessages, timeout = MAX_WAIT) {
    let lastText = "";
    let stableCount = 0;
    let lastKey = null;

    for (let elapsed = 0; elapsed < timeout; elapsed += POLL_INTERVAL) {
      await sleep(POLL_INTERVAL);

      const candidates = assistantMessages().filter(el => !beforeMessages.has(messageKey(el)));
      const latest = candidates[candidates.length - 1];
      if (!latest) { stableCount = 0; continue; }
      const key = messageKey(latest);
      const text = assistantText(latest);
      if (isStreaming() || !text) {
        stableCount = 0;
      } else if (text !== lastText || key !== lastKey) {
        stableCount = 0;
      } else if (++stableCount >= 4) {
        return text;
      }
      lastText = text;
      lastKey = key;
    }

    // Partial text must never be accepted as a completed answer.
    throw new Error("Timeout: no response from ChatGPT");
  }

  // ── Message handler ──────────────────────────────────────

  async function handleChatRequest(msg) {
    try {
      if (isStreaming()) throw new Error("ChatGPT is already generating. Wait before submitting.");

      // Start new conversation if requested
      if (msg.newConversation !== false) {
        await startNewChat();
        await selectModel(msg.model);
      }

      if (msg.selectModel) await selectModel(msg.model);
      const beforeMessages = new Set(assistantMessages().map(messageKey));
      await typeMessage(msg.userMessage);
      await clickSend();

      const response = await waitForNewResponse(beforeMessages, msg.timeout);

      return { ok: true, content: response, conversation_url: window.location.href };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── Listen for messages from background script ───────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ping") {
      sendResponse({ ok: true, url: window.location.href });
      return;
    }

    if (msg.type === "chat") {
      handleChatRequest(msg).then(sendResponse);
      return true; // Will respond asynchronously
    }
  });

  console.log("[ChatGPT Gateway] Content script loaded on", window.location.href);
})();
