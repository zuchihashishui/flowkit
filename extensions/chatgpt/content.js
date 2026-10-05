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

  function composerScope() {
    const editor=findInput();
    return editor?.closest('[data-type="unified-composer"], [data-testid="composer"], #composer-background') || editor?.closest('form') || editor?.parentElement?.parentElement || editor?.parentElement;
  }

  function sendButtons() {
    const scope=composerScope();
    if(!scope)return [];
    return [...scope.querySelectorAll('button, [role="button"]')].filter(btn=>{
      if(!visible(btn))return false;
      const label=(btn.getAttribute('aria-label')||btn.getAttribute('title')||btn.textContent||'').trim();
      if(/stop|cancel|dictat|voice/i.test(label)||btn.getAttribute('data-testid')==='stop-button')return false;
      return btn.id==='composer-submit-button'||btn.getAttribute('data-testid')==='send-button'||/^(send(?: prompt| message)?|gửi(?: tin nhắn)?|送信)$/i.test(label)||
        !label&&btn.matches('button[type="submit"]')&&btn.form?.contains(findInput());
    });
  }

  function findSendButton() {
    const enabled=sendButtons().filter(btn=>!btn.disabled&&!btn.closest('[aria-disabled="true"], [data-loading="true"], [inert]'));
    return enabled.length===1?enabled[0]:null;
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
    return [...document.querySelectorAll('button[aria-label="Stop"], button[aria-label="Stop streaming"], [data-testid="stop-button"], button[aria-label*="Stop"]')].some(hasVisibleState);
  }

  function visible(el) {
    return el && el.offsetParent !== null && !el.closest('[hidden], [aria-hidden="true"]');
  }

  function composerButton(mode) {
    return [...document.querySelectorAll('[role="group"][aria-label="Composer mode"] button')]
      .find(el => visible(el) && (el.textContent || '').trim().toLowerCase() === mode);
  }

  function checkComposerStillSelected(mode) {
    // Temporary Chat can hide the switch. If it remains visible, reject any reset.
    const button = composerButton(mode);
    if (button && button.getAttribute('aria-pressed') !== 'true') {
      throw new Error('The composer mode changed during setup. No prompt was sent. Check Chat / Work and Temporary Chat settings.');
    }
  }

  async function selectComposerMode(mode) {
    if (!['chat', 'work'].includes(mode)) throw new Error('Invalid composer mode. Choose Chat or Work.');
    // Re-query after each render; ChatGPT may replace the entire mode group.
    let clicked = false;
    for (let i = 0; i < 20; i++) {
      const button = composerButton(mode);
      if (button?.getAttribute('aria-pressed') === 'true') return;
      // Entering Temporary Chat can remove the mode switch entirely.
      // Positive Temporary UI is sufficient for Chat, never for Work.
      if(mode==='chat'&&!button&&!composerButton('work')&&temporaryEnabled())return;
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !clicked) {
        button.click(); clicked = true;
      }
      await sleep(500);
    }
    throw new Error(`Cannot verify ${mode === 'chat' ? 'Chat' : 'Work'} composer mode. No prompt was sent. Check the Composer mode buttons in the worker tab.`);
  }

  function temporaryEnabled() {
    const toggles = document.querySelectorAll('button[aria-label="Temporary chat"], [role="switch"][aria-label="Temporary chat"]');
    if ([...toggles].some(el => visible(el) && (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'on' || el.getAttribute('aria-checked') === 'true'))) return true;
    // Positive UI evidence only; the existence of the entry button is not proof.
    return [...document.querySelectorAll('button, [role="switch"], h1, h2, [role="heading"]')].some(el => {
      if (!visible(el)) return false;
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
      if (/^(exit temporary chat|turn off temporary chat|temporary chat is on)$/.test(label)) return true;
      return /^(H1|H2)$/.test(el.tagName) && /^temporary chat$/.test(label);
    });
  }

  async function enableTemporaryChat() {
    if (temporaryEnabled()) return;
    const button = [...document.querySelectorAll('button[aria-label="Temporary chat"], [role="switch"][aria-label="Temporary chat"]')].find(visible);
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('Temporary Chat button not found or unavailable. No prompt was sent. Text jobs require Chat / Temporary Chat; JSON to SRT uses Work / regular chat. Check the worker tab.');
    button.click();
    let choseUnpersonalized = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      // Some versions offer a personalization choice before entering the chat.
      const option = [...document.querySelectorAll('button, [role="option"], [role="menuitem"]')]
        .find(el => visible(el) && /^Unpersonalized$/i.test((el.textContent || '').trim()));
      if (option && !choseUnpersonalized) { option.click(); choseUnpersonalized = true; continue; }
      if (temporaryEnabled()) return;
    }
    throw new Error('Cannot verify Temporary Chat is active. No prompt was sent. Check the tab and share the HTML after enabling Temporary Chat.');
  }

  async function disableTemporaryChat() {
    if (!temporaryEnabled()) return;
    const button = [...document.querySelectorAll('button, [role="switch"]')].find(el => {
      if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
      return /^(exit temporary chat|turn off temporary chat|temporary chat is on)$/.test(label) ||
        label === 'temporary chat' && (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'on' || el.getAttribute('aria-checked') === 'true');
    });
    if (!button) throw new Error('Cannot exit Temporary Chat for this regular-chat request. No prompt was sent. Open a regular chat in the worker tab.');
    button.click();
    for (let i=0;i<20;i++) {
      await sleep(500);
      if (!temporaryEnabled() && findInput()) return;
    }
    throw new Error('Cannot verify Temporary Chat is OFF. No prompt was sent. Check the worker tab.');
  }

  function pageFailure() {
    const alerts = [...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(visible);
    const text = alerts.map(el => el.textContent || '').join(' ');
    if (/usage limit|message limit|too many requests|rate limit|reached.{0,40}limit/i.test(text)) {
      const error = new Error('ChatGPT usage limit: ' + text.slice(0,400)); error.code = 'RATE_LIMIT'; return error;
    }
    if (/something went wrong|network error|generation failed|response interrupted|unable to load conversation/i.test(text))return new Error('ChatGPT page error: '+text.slice(0,400));
    if (/sign in.{0,30}continue|log in.{0,30}continue/i.test(text)) return new Error('ChatGPT requires sign-in. Check the worker tab.');
    return null;
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

  const modelPickerSelector = 'button[aria-label="Select ChatGPT model"], button[data-codex-intelligence-trigger="true"], button[data-testid="model-switcher"], button[data-testid="model-switcher-dropdown-button"]';
  const normalizeLabel = text => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const effortLabels = {none:'None',minimal:'Minimal',low:'Light',medium:'Medium',high:'High',xhigh:'Extra High',max:'Max',ultra:'Ultra',persistent:'Persistent'};
  function cleanLabel(el) {
    const clone=el.cloneNode(true);
    clone.querySelectorAll('svg, [aria-hidden="true"], [hidden], .sr-only').forEach(n=>n.remove());
    return (clone.textContent || '').replace(/\s+/g,' ').trim();
  }
  function modelPicker() { return [...document.querySelectorAll(modelPickerSelector)].find(visible); }
  function modelSelection() {
    const picker=modelPicker();
    if(!picker)return {model:'',effort:''};
    const effort=picker.getAttribute('data-selected-reasoning-effort') || '';
    const name=picker.querySelector('[class*="ModelPickerTriggerModelText-"], [data-selected-model-name]');
    return {model:name?cleanLabel(name):cleanLabel(picker),effort};
  }
  function parseModelSelection(value) {
    if(!value || ['auto','current'].includes(value))return null;
    const parts=value.split('::').map(s=>s.trim());
    if(parts.length>2 || !parts[0])throw Error('Use an exact model name, optionally followed by :: High.');
    const effort=parts[1] || '';
    const effortKey=Object.keys(effortLabels).find(k=>normalizeLabel(k)===normalizeLabel(effort)||normalizeLabel(effortLabels[k])===normalizeLabel(effort));
    if(effort&&!effortKey)throw Error('Unknown reasoning effort: '+effort);
    return {model:parts[0],effort:effortKey || ''};
  }
  function modelMatches(target) {return normalizeLabel(modelSelection().model)===normalizeLabel(target.model);}
  function effortMatches(target) {return !target.effort || modelSelection().effort===target.effort;}
  function checkModelSelection(target) {
    if(target && (!modelMatches(target)||!effortMatches(target)))throw Error('Requested model / reasoning effort could not be verified. No prompt was sent.');
  }
  async function selectModel(value) {
    const target=parseModelSelection(value);
    if(!target)return null; // No opening menus, no model or effort changes.
    if(modelMatches(target)&&effortMatches(target))return target;
    const picker=modelPicker();
    if(!picker || picker.disabled || picker.getAttribute('aria-disabled')==='true')throw Error('Cannot find an enabled Select ChatGPT model button. No prompt was sent.');
    const previousMenus=new Set([...document.querySelectorAll('[role="menu"], [role="listbox"]')].filter(visible));
    let ticks=0;
    const wait=async()=>{if(ticks++>=20)throw Error('Model selection timed out. No prompt was sent.');await sleep(500);};
    const menus=()=>{
      const trigger=modelPicker(),controlled=trigger?.getAttribute('aria-controls');
      return [...document.querySelectorAll('[role="menu"], [role="listbox"]')].filter(el=>visible(el)&&(el.id===controlled||!previousMenus.has(el)));
    };
    const options=()=>[...new Set(menus().flatMap(menu=>[...menu.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"], button')]))]
      .filter(el=>visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&!el.hasAttribute('data-disabled'));
    function exactOption(label) {
      const normalized=normalizeLabel(label);
      const matches=options().filter(el=>normalizeLabel(el.getAttribute('aria-label'))===normalized||normalizeLabel(cleanLabel(el))===normalized||
        [...el.querySelectorAll('span, div')].some(child=>visible(child)&&normalizeLabel(cleanLabel(child))===normalized));
      // Prefer the innermost actionable element; refuse two distinct exact choices.
      const leaves=matches.filter(el=>!matches.some(other=>other!==el&&el.contains(other)));
      if(leaves.length>1)throw Error('Multiple matching model options. No prompt was sent.');
      return leaves[0];
    }
    async function open(){const p=modelPicker();if(p?.getAttribute('aria-expanded')!=='true'){p?.click();await wait();}}
    async function choose(label,verified,submenus) {
      await open();let clicked=false,opened=new Set();
      while(ticks<20){
        if(verified())return;
        const option=exactOption(label);
        if(option&&!clicked){option.click();clicked=true;}
        else if(!clicked){
          const submenu=options().find(el=>el.getAttribute('aria-haspopup')==='menu'&&submenus.includes(normalizeLabel(cleanLabel(el)))&&!opened.has(el));
          if(submenu){opened.add(submenu);submenu.click();}
        }
        await wait();
      }
      throw Error('Requested option "'+label+'" was not found or did not activate. No prompt was sent.');
    }
    try{
      if(!modelMatches(target))await choose(target.model,()=>modelMatches(target),['model','models']);
      if(!effortMatches(target))await choose(effortLabels[target.effort],()=>effortMatches(target),['reasoning effort','effort','thinking effort']);
      checkModelSelection(target);
      return target;
    }finally{
      // Close only this picker, not an unrelated menu on the page.
      const p=modelPicker();if(p?.getAttribute('aria-expanded')==='true')p.click();
    }
  }

  let activeRequest = null,activePhase='',submitted=false;
  // Only live page memory: reload/new chat must receive the TXT again.
  let textSession = null;
  function currentTextSessionProof() {
    if(!textSession||temporaryEnabled()!==textSession.temporary||window.location.href!==textSession.url)return null;
    const mode=composerButton(textSession.mode);if(mode&&mode.getAttribute('aria-pressed')!=='true')return null;
    const latest=assistantMessages().at(-1);
    if(!latest||messageKey(latest)!==textSession.lastAnswer||assistantText(latest)!==textSession.answerText)return null;
    return {id:textSession.id,proof:textSession.proof,url:textSession.url};
  }
  function progress(phase, extra={}) {
    if(!activeRequest)return;
    activePhase=phase;
    try{chrome.runtime.sendMessage({type:'jobProgress',requestId:activeRequest,phase,...extra})?.catch(()=>{});}catch{}
  }
  function hasVisibleState(el) {
    return !el.closest('[hidden], [aria-hidden="true"]') && getComputedStyle(el).display!=='none' && getComputedStyle(el).visibility!=='hidden';
  }
  function responseScope(latest) {
    const scope=latest?.closest('[data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"], [data-turn-key], article[data-testid^="conversation-turn"], [data-testid^="conversation-turn-"], [data-message-author-role="assistant"]');
    if(!scope?.matches('[data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]'))return scope;
    // The supplied Temporary layout puts turn-action-controls outside the
    // search unit. Ascend only within this answer, never into another turn.
    for(let parent=scope.parentElement,depth=0;parent&&depth<4;parent=parent.parentElement,depth++){
      if(parent.matches('body, main, html'))break;
      const keys=new Set([...parent.querySelectorAll('[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"]')].map(messageKey));
      if(keys.size!==1||!keys.has(messageKey(latest)))break;
      if(parent.querySelector('.turn-action-controls button[aria-label="Copy"], .turn-action-controls button[aria-label="Rate response"], .turn-action-controls button[aria-label="Regenerate response"], .turn-action-controls button[aria-label="Copy response"]'))return parent;
    }
    return scope;
  }
  function generationPhase(latest) {
    const scope=responseScope(latest) || document;
    const status=[...scope.querySelectorAll('[role="status"], [data-testid="thinking-indicator"]')].filter(hasVisibleState).map(el=>el.textContent||'').join(' ');
    if(/\b(thinking|reasoning)\b/i.test(status))return 'THINKING';
    if(/\b(searching|running|working|using tools)\b/i.test(status))return 'USING_TOOLS';
    if([...scope.querySelectorAll('[aria-busy="true"], [data-is-streaming="true"]')].some(hasVisibleState))return 'WORKING';
    if(isStreaming())return 'GENERATING';
    return null;
  }
  function completionEvidence(latest) {
    if(latest.closest('[data-local-conversation-final-assistant="true"]'))return 'final-assistant-marker';
    const scope=responseScope(latest);
    // Temporary Chat places its toolbar beside the markdown root inside an
    // assistant search unit. Never mistake a code-block Copy for completion.
    if(scope && [...scope.querySelectorAll('[data-testid="copy-turn-action-button"], button[aria-label="Copy response"], button[aria-label="Good response"], button[aria-label="Bad response"], button[aria-label="Copy"], button[aria-label="Rate response"], button[aria-label="Regenerate response"]')].some(el=>!el.closest('pre, code, [data-markdown-text-style="assistant-message"]')&&hasVisibleState(el)))return 'response-actions';
    return '';
  }
  async function discoverModels() {
    if(activeRequest||isStreaming())throw Error('Wait for the active response before inspecting models.');
    const picker=modelPicker();
    if(!picker)throw Error('Model picker not found in this tab.');
    const initial=modelSelection(),wasOpen=picker.getAttribute('aria-expanded')==='true';
    const oldMenus=new Set([...document.querySelectorAll('[role="menu"], [role="listbox"]')].filter(visible));
    const models=new Set(initial.model?[initial.model]:[]),efforts=new Set(),visited=new Set();
    let menuFound=false;
    try{
      if(!wasOpen)picker.click();
      for(let i=0;i<12;i++){
        await sleep(250);
        const controlled=modelPicker()?.getAttribute('aria-controls');
        const menus=[...document.querySelectorAll('[role="menu"], [role="listbox"]')].filter(el=>visible(el)&&(el.id===controlled||!oldMenus.has(el)));
        if(!menus.length)continue;menuFound=true;
        const options=[...new Set(menus.flatMap(menu=>[...menu.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"], button')]))].filter(el=>visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&!el.hasAttribute('data-disabled'));
        for(const el of options){
          const label=(el.getAttribute('aria-label') || cleanLabel(el.querySelector('[data-model-name]') || el.querySelector('span') || el)).trim();
          const key=Object.keys(effortLabels).find(k=>normalizeLabel(label)===normalizeLabel(effortLabels[k]));
          if(key){efforts.add(key);continue;}
          // Known model-shaped labels only; never present account/menu actions as models.
          if(label.length<=70 && (/^(GPT[- ]|ChatGPT\b|o[1-9](?:\b|-))/i.test(label)||el.hasAttribute('data-model-id')||el.hasAttribute('data-model-name')))models.add(label);
        }
        const submenu=options.find(el=>el.getAttribute('aria-haspopup')==='menu'&&['model','models','reasoning effort','effort','thinking effort','more models','legacy models'].includes(normalizeLabel(cleanLabel(el)))&&!visited.has(el));
        if(submenu){visited.add(submenu);submenu.click();continue;}
        // Allow lazy menu population before concluding the scan.
      }
      if(modelSelection().model!==initial.model||modelSelection().effort!==initial.effort)throw Error('Model changed during inspection. Review the tab before submitting.');
      return {models:[...models],efforts:[...efforts],current:initial,partial:true,menuFound,
        note:menuFound?'Observed options only; submenus and account availability may differ. Custom names remain supported.':'Menu could not be read; only the current model is shown. Refresh the tab or provide the open-menu HTML.',checkedAt:Date.now()};
    }finally{const p=modelPicker();if(!wasOpen&&p?.getAttribute('aria-expanded')==='true')p.click();}
  }
  async function preflight(msg) {
    const checks=[],add=(name,ok,detail)=>checks.push({name,ok:!!ok,detail});
    const failure=pageFailure();add('Page access',!failure,failure?.message||'No sign-in or usage-limit alert found');
    add('Idle page',!isStreaming()&&!activeRequest,'No active generation');
    const input=findInput();add('Input editor',!!input,'Visible input editor required');
    const mode=composerButton(msg.composerMode||'chat');add('Composer mode',!!mode&&!mode.disabled&&mode.getAttribute('aria-disabled')!=='true','Requested Chat / Work button must be available; this check does not switch modes');
    add('Send control',[...document.querySelectorAll('button[aria-label="Send"], [data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"]')].some(hasVisibleState),'May be disabled while the editor is empty');
    if(msg.temporary)add('Temporary Chat',temporaryEnabled()||[...document.querySelectorAll('button[aria-label="Temporary chat"]')].some(el=>visible(el)&&!el.disabled),'Availability only; activation is verified again before sending');
    let catalog=null;
    const target=parseModelSelection(msg.model);
    if(target&&!activeRequest&&!isStreaming()){
      try{catalog=await discoverModels();add('Model',catalog.models.some(name=>normalizeLabel(name)===normalizeLabel(target.model)),'Requested model must be observed in this tab');
        if(target.effort)add('Reasoning effort',catalog.current.effort===target.effort||catalog.efforts.includes(target.effort),'Requested effort must be observed');
      }catch(e){add('Model menu',false,e.message);}
    }
    return {passed:checks.every(c=>c.ok),checks,catalog,current:modelSelection(),checkedAt:Date.now(),note:'No prompt sent. The actual job verifies all settings again after opening its new conversation.'};
  }

  function normalizedPrompt(text) {
    return String(text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').normalize('NFC').trim();
  }

  function editorText(input) {
    if (!input) return '';
    if (input.getAttribute('contenteditable') !== 'true') return input.value || '';
    // A paragraph boundary is one newline even next to an empty paragraph or
    // a hard break. Looking at value.endsWith('\n') collapses real blank lines.
    const block = node => node?.nodeType === 1 && /^(P|DIV|LI|PRE|BLOCKQUOTE|UL|OL|H[1-6])$/.test(node.tagName);
    const read = node => {
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      // ProseMirror adds a caret placeholder at the end of a text block. A lone
      // browser <br> in an empty paragraph is a placeholder too, not extra text.
      if (node.tagName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
      if (block(node) && node.childNodes.length === 1 && node.firstChild.nodeName === 'BR') return '';
      let value = '', previous = null;
      for (const child of node.childNodes) {
        const part = read(child);
        if (previous && (block(previous) || block(child))) value += '\n';
        value += part;
        previous = child;
      }
      return value;
    };
    return read(input);
  }

  function checkEnteredPrompt(text) {
    const entered = normalizedPrompt(editorText(findInput()));
    const expected = normalizedPrompt(text);
    if (!expected || entered !== expected) {
      throw new Error(`ChatGPT did not retain the complete prompt (expected ${expected.length} characters, found ${entered.length}). No prompt was sent. Refresh the worker tab before retrying.`);
    }
  }

  async function typeMessage(text) {
    let input=findInput();
    for(let i=0;!input&&i<60;i++){await sleep(250);input=findInput();}
    if (!input) throw new Error("Cannot find ChatGPT input field after waiting for the composer");

    input.focus();
    await sleep(200);

    // Scope selection to this editor, then use the same browser editing command
    // for short and long prompts. Direct DOM assignment can leave React /
    // ProseMirror's internal document unchanged despite visible text.
    if (input.getAttribute('contenteditable') === 'true') {
      const range = document.createRange();
      range.selectNodeContents(input);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      input.select();
    }
    document.execCommand('insertText', false, text);

    let stable = 0;
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      // Re-query after editor renders; never trust the detached node we typed into.
      if (normalizedPrompt(editorText(findInput())) === normalizedPrompt(text)) {
        if (++stable >= 2) { checkEnteredPrompt(text); return; }
      } else stable = 0;
    }
    checkEnteredPrompt(text);
    throw new Error('ChatGPT input did not stabilize. No prompt was sent. Refresh the worker tab before retrying.');
  }

  function attachmentState(name) {
    const editor = findInput();
    const scope = composerScope();
    if (!scope) return 'missing';
    const named = [...scope.querySelectorAll('[title], [aria-label], [data-filename], [data-file-name], span, p, div, button')].filter(el =>
      visible(el) && !el.contains(editor) && !editor?.contains(el) && !el.closest('[data-user-message-bubble], [data-message-author-role], [data-markdown-text-style]') &&
      (el.getAttribute('title') === name || el.getAttribute('data-filename') === name || el.getAttribute('data-file-name') === name ||
      (el.getAttribute('aria-label') || '').includes(name) || (el.textContent || '').replace(/\s+/g,'').trim() === name));
    if (!named.length) return 'missing';
    const cards = named.map(el => el.closest('[data-testid*="file"], [data-testid*="attachment"], [data-file-id], [data-file-reference]') || el);
    // A spinner elsewhere in the composer is not evidence that this file is uploading.
    // Completed cards may retain a hidden progress node: only visible state counts.
    const busySelector='[role="progressbar"], [aria-busy="true"], [data-loading="true"], .animate-spin';
    const busy = cards.some(el => [el,...el.querySelectorAll(busySelector)].some(node=>node.matches(busySelector)&&hasVisibleState(node)));
    const status=scope.cloneNode(true);status.querySelectorAll('textarea, [contenteditable], [hidden], [aria-hidden="true"]').forEach(el=>el.remove());
    const failed = cards.some(el => /upload failed|error uploading|unable to upload|unsupported file|file too large/i.test(
      el.textContent || '')) || /upload failed|error uploading|unable to upload|unsupported file|file too large/i.test(status.textContent || '');
    return failed?'failed':busy?'uploading':'ready';
  }

  async function attachFile(attachment, textPrompt=false) {
    let file;
    if(textPrompt){
      if(attachment?.name!=='prompt-instructions.txt'||typeof attachment.text!=='string'||!attachment.text.trim()||attachment.text.length>100000)throw Error('Invalid prompt TXT attachment. No prompt was sent.');
      file=new File([attachment.text],attachment.name,{type:'text/plain'});
    }else{
    if (!attachment || !/^transcript-[a-f0-9-]{36}\.json$/.test(attachment.name) ||
        typeof attachment.base64 !== 'string' || attachment.base64.length > 22369624) throw Error('Invalid JSON attachment. No prompt was sent.');
    const bytes = Uint8Array.from(atob(attachment.base64), ch => ch.charCodeAt(0));
    JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ''));
    file = new File([bytes], attachment.name, {type:'application/json'});
    }
    const extension=textPrompt?'.txt':'.json',mime=textPrompt?'text/plain':'application/json',label=textPrompt?'TXT':'JSON';
    const fileInput = () => [...document.querySelectorAll('input[type="file"]')].find(el => {
      const accept = (el.getAttribute('accept') || '').toLowerCase();
      return !el.disabled && (!accept || accept.includes(extension) || accept.includes(mime) || accept.includes('*/*'));
    });
    let input = fileInput();
    if (!input) {
      const add = [...document.querySelectorAll('button')].find(el => visible(el) &&
        /^(Add files|Attach files|Upload files|Add photos & files|Add photos and files|Open.*attachment)/i.test(el.getAttribute('aria-label') || el.textContent || ''));
      if (add) add.click();
      for (let i=0;i<20 && !input;i++) {await sleep(250);input=fileInput();}
    }
    if (!input) throw Error(label+' file input was not found. No prompt was sent. Open the attachment menu and check the page.');
    const transfer = new DataTransfer();transfer.items.add(file);input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
    let stable = 0, state = 'missing';
    for (let i=0;i<240;i++) {
      await sleep(500);
      const failure=pageFailure();if(failure)throw failure;
      state=attachmentState(attachment.name);
      if(state==='failed')throw Error(label+' upload failed. No prompt was sent. Check the attachment in the Work tab.');
      progress('WAITING_ATTACHMENT',{detail:state==='missing'?'Waiting for the attached file card':state==='uploading'?'File upload is still busy':'Checking the completed file upload'});
      if(state==='ready') {
        if(++stable>=2)return;
      }else stable=0;
    }
    throw Error(label+' attachment did not become ready within 120 seconds ('+state+'). No prompt was sent. Check the upload in the worker tab.');
  }

  async function clickSend(text, attachmentName) {
    let detail='';
    for (let i = 0; i < (attachmentName ? 400 : 10); i++) {
      const failure=pageFailure();if(failure)throw failure;
      const btn = findSendButton();
      const fileState=attachmentName?attachmentState(attachmentName):'ready';
      if(fileState==='failed')throw Error('Attachment upload failed before Send. No prompt was sent.');
      if (btn && fileState==='ready') {
        checkEnteredPrompt(text);
        const before=new Set(assistantMessages().map(messageKey));
        const users=new Set([...document.querySelectorAll('[data-user-message-bubble], [data-message-author-role="user"]')].map(messageKey));
        // Once clicked the result can be uncertain; never automatically click again.
        submitted=true;
        btn.click();
        progress('VERIFYING_SUBMISSION');
        for(let tick=0;tick<60;tick++){
          const error=pageFailure();if(error)throw error;
          const userSent=[...document.querySelectorAll('[data-user-message-bubble], [data-message-author-role="user"]')].some(el=>!users.has(messageKey(el))&&hasVisibleState(el)&&normalizedPrompt(assistantText(el)).replace(/\s+/g,' ')===normalizedPrompt(text).replace(/\s+/g,' '));
          if(isStreaming()||assistantMessages().some(el=>!before.has(messageKey(el)))||userSent)return;
          await sleep(250);
        }
        throw Error('Timeout confirming Send after 15 seconds. The button was clicked once, but ChatGPT did not confirm a new message. Review the Work tab before retrying; no second click was made.');
      }
      const buttons=sendButtons();
      detail=fileState!=='ready'?'Attachment: '+fileState:!buttons.length?'Send button not found in the active composer':buttons.filter(b=>!b.disabled&&b.getAttribute('aria-disabled')!=='true').length>1?'More than one Send button in the active composer':'Send button is disabled';
      progress('WAITING_SEND_BUTTON',{detail});
      await sleep(300);
    }
    throw new Error('Send could not start: '+detail+'. No prompt was sent.');
  }

  let pendingSrtLink = null;
  function findSrtLink(message, zip=false) {
    const links = [...message.querySelectorAll('a[href], button[aria-label], [role="link"], [role="button"][data-file-reference="true"], [role="button"][aria-label^="Download "]')].filter(el => {
      if (!visible(el) || el.disabled || el.closest('[aria-busy="true"], [aria-disabled="true"], [data-loading="true"]')) return false;
      const label = [el.textContent, el.getAttribute('data-markdown-copy-text'), el.getAttribute('download'), el.getAttribute('title'), el.getAttribute('aria-label'), el.getAttribute('href')].join(' ');
      return (zip?/\.zip(?:$|[\s?#"'<>])/i:/\.srt(?:$|[\s?#"'<>])/i).test(label);
    });
    if (links.length > 1 && new Set(links.map(el=>el.getAttribute('href')||el.textContent)).size > 1) throw Error('More than one '+(zip?'ZIP':'SRT')+' file was returned. Select the correct file in ChatGPT; no file was downloaded.');
    return links[0] || null;
  }

  async function waitForNewResponse(beforeMessages, timeout = MAX_WAIT, srtOutput = false, downloadSrt = false, downloadPromptZip = false) {
    let lastText = "";
    let stableCount = 0;
    let lastKey = null;
    let lastChange = Date.now();

    for (let elapsed = 0; elapsed < timeout; elapsed += POLL_INTERVAL) {
      await sleep(POLL_INTERVAL);

      const failure = pageFailure(); if (failure) throw failure;
      const candidates = assistantMessages().filter(el => !beforeMessages.has(messageKey(el)));
      const latest = candidates[candidates.length - 1];
      if (!latest) { stableCount = 0; progress(generationPhase(null)||'WAITING_RESPONSE'); continue; }
      const key = messageKey(latest);
      const text = assistantText(latest);
      const phase=generationPhase(latest);
      // Work can return an interactive file span without a final-message marker
      // or response toolbar. A ready file is evidence only for file-output jobs;
      // generation must still stop and the response must pass the stable polls.
      const readyFile=(downloadSrt||downloadPromptZip) && !phase ? findSrtLink(latest,downloadPromptZip) : null;
      const evidence=completionEvidence(latest) || (readyFile?.matches('[data-file-reference="true"][aria-busy="false"]') ? (downloadPromptZip?'zip-file-ready':'srt-file-ready') : '');
      if(text!==lastText || key!==lastKey)lastChange=Date.now();
      progress(phase || (evidence?'VERIFYING_COMPLETION':'WAITING_COMPLETION'),{chars:text.length,lastChange,completionEvidence:evidence});
      if (phase || !text || !evidence) {
        stableCount = 0;
      } else if (text !== lastText || key !== lastKey) {
        stableCount = 0;
      } else if (++stableCount >= 4) {
        if(downloadSrt||downloadPromptZip) {
          const link=findSrtLink(latest,downloadPromptZip);
          if(link){
            pendingSrtLink={element:link,requestId:activeRequest,zip:downloadPromptZip};
            return {content:text,hasSrtFile:downloadSrt,hasPromptZip:downloadPromptZip};
          }
          throw Error('ChatGPT finished without a downloadable '+(downloadPromptZip?'.zip':'.srt')+' link. The response remains in the tab. No new prompt was sent.');
        }
        if(srtOutput) {
          const blocks=[...latest.querySelectorAll('pre code')].filter(el=>!el.closest('[hidden], [aria-hidden="true"]'));
          if(blocks.length){
            // Keep exceptions/statistics outside the SRT, too. The backend saves
            // the full response before extracting the fenced subtitle content.
            const notes=latest.cloneNode(true);
            notes.querySelectorAll('pre').forEach(node=>node.remove());
            return [blocks.map(block=>'```srt\n'+block.textContent.trim()+'\n```').join('\n\n'),assistantText(notes)].filter(Boolean).join('\n\n');
          }
        }
        return text;
      }
      lastText = text;
      lastKey = key;
    }

    // Partial text must never be accepted as a completed answer.
    const error=new Error("Timeout: no verified completed response from ChatGPT; review the tab before retrying");
    error.partialResponse=lastText;throw error;
  }

  // ── Message handler ──────────────────────────────────────

  async function handleChatRequest(msg) {
    if(activeRequest)return {ok:false,error:'This tab already has an active request'};
    activeRequest=msg.requestId || 'local-request';activePhase='PREPARING';submitted=false;
    try {
      if (isStreaming()) throw new Error("ChatGPT is already generating. Wait before submitting.");
      if(msg.downloadPromptZip&&(!msg.textSessionId||msg.composerMode!=='work'||msg.temporary!==false))throw Error('Prompt ZIP batches require Work / Temporary OFF.');
      if(msg.textSessionId&&((msg.downloadPromptZip?(msg.temporary!==false||msg.composerMode!=='work'):(msg.temporary!==true||msg.composerMode!=='chat'))||msg.customGPT||msg.attachment))throw Error(msg.downloadPromptZip?'Text to Prompt ZIP requires Work / Temporary OFF. No text was sent.':'Text to Prompt requires Chat / Temporary ON. No text was sent.');

      if(msg.promptAttachment&&(!msg.textSessionId||msg.continueConversation||msg.attachment))throw Error('Prompt TXT is allowed only on the first Text to Prompt turn. No prompt was sent.');

      // Start new conversation if requested
      if (msg.newConversation !== false) {
        await startNewChat();
      }

      const composerMode = msg.composerMode ?? 'chat';
      const customGPT=msg.customGPT===true;
      const continuing=msg.continueConversation===true;
      if(continuing&&(msg.newConversation!==false||window.location.href!==msg.conversationUrl||!assistantMessages().length))throw Error('The saved conversation is no longer available. No text was sent.');
      if(continuing&&msg.textSessionId){
        const proof=currentTextSessionProof();
        if(proof?.id!==msg.textSessionId||proof?.proof!==msg.textSessionProof)throw Error((msg.downloadPromptZip?'Work':'Temporary')+' conversation memory changed. No text was sent.');
      }else if(continuing&&msg.temporary!==false)throw Error('Temporary continuation requires verified page memory. No text was sent.');
      if(!continuing)textSession=null;
      if(customGPT){
        const target=new URL(msg.pageUrl),here=new URL(window.location.href);
        const correctPath=continuing?here.pathname.startsWith(target.pathname.replace(/\/$/,'')+'/c/'):here.pathname.replace(/\/$/,'')===target.pathname.replace(/\/$/,'');
        if(target.origin!=='https://chatgpt.com'||!/^\/g\/g-[A-Za-z0-9_-]+\/?$/.test(target.pathname)||here.origin!==target.origin||!correctPath||msg.attachment||msg.temporary)throw Error('The requested GPT is not ready. No text was sent.');
      }
      // Temporary mode may hide the Chat/Work switch, so exit before choosing Work.
      if (msg.temporary === false && temporaryEnabled()) {progress('DISABLING_TEMPORARY');await disableTemporaryChat();}
      progress('SELECTING_MODE');
      if(!customGPT&&!continuing)await selectComposerMode(composerMode);
      if (msg.temporary){progress('ENABLING_TEMPORARY');await enableTemporaryChat();}
      progress('SELECTING_MODEL');
      const selectedModel = continuing?null:await selectModel(customGPT?'auto':msg.model);
      if(!customGPT)checkComposerStillSelected(composerMode);
      if (msg.temporary === false && temporaryEnabled()) throw new Error('Temporary Chat is still active for a regular-chat request. No prompt was sent.');
      checkModelSelection(selectedModel);
      const beforeMessages = new Set(assistantMessages().map(messageKey));
      const failure=pageFailure();if(failure)throw failure;
      progress('TYPING');
      await typeMessage(msg.userMessage);
      const attachment=msg.promptAttachment||msg.attachment;
      if (attachment) {
        progress('ATTACHING_FILE');await attachFile(attachment,!!msg.promptAttachment);
        // Both JSON and TXT use the same upload, editor recovery and Send path.
        if(normalizedPrompt(editorText(findInput()))!==normalizedPrompt(msg.userMessage)){
          progress('TYPING');await typeMessage(msg.userMessage);
        }
      }
      if (msg.temporary && !temporaryEnabled()) throw new Error("Temporary Chat is no longer confirmed. No prompt was sent.");
      if (msg.temporary === false && temporaryEnabled()) throw new Error('Temporary Chat became active during setup. No prompt was sent.');
      if(continuing&&msg.textSessionId&&currentTextSessionProof()?.proof!==msg.textSessionProof)throw Error((msg.downloadPromptZip?'Work':'Temporary')+' conversation changed before sending. No text was sent.');
      if(!customGPT)checkComposerStillSelected(composerMode);
      checkModelSelection(selectedModel);
      progress('SENDING');
      await clickSend(msg.userMessage, msg.attachment?.name||msg.promptAttachment?.name);
      submitted=true;
      // A failed progress notification must not discard an already sent answer.
      try{await chrome.runtime.sendMessage?.({type:'requestSubmitted',requestId:msg.requestId});}catch{}

      const response = await waitForNewResponse(beforeMessages, msg.timeout, !!msg.attachment, msg.downloadSrt===true, msg.downloadPromptZip===true);
      let nativeDownload;
      if(response?.hasSrtFile){
        progress('DOWNLOADING_SRT');
        const saved=await chrome.runtime.sendMessage({type:'downloadSrt',requestId:msg.requestId});
        if(!saved?.ok)throw Error(saved?.error||'SRT download failed. The file remains available in ChatGPT.');
        return {ok:true,content:response.content,nativeDownload:saved.nativeDownload,conversation_url:window.location.href};
      }

      if(response?.hasPromptZip){
        progress('DOWNLOADING_ZIP');
        const saved=await chrome.runtime.sendMessage({type:'downloadPromptZip',requestId:msg.requestId});
        if(!saved?.ok)throw Error(saved?.error||'ZIP download failed. The file remains in the Work tab.');
        nativeDownload=saved.nativeDownload;
      }

      if(msg.textSessionId){
        // Completion was verified above. Failure to reuse the conversation
        // must not discard this answer; the next turn can reattach the TXT.
        textSession=null;
        const latest=assistantMessages().filter(el=>!beforeMessages.has(messageKey(el))).at(-1);
        if(latest&&temporaryEnabled()===(msg.temporary===true))textSession={id:msg.textSessionId,proof:msg.requestId,url:window.location.href,lastAnswer:messageKey(latest),answerText:assistantText(latest),temporary:msg.temporary===true,mode:composerMode};
      }
      return { ok: true, content: response?.hasPromptZip?response.content:response, nativeDownload, conversation_url: window.location.href, textSessionProof:currentTextSessionProof() };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code,phase:activePhase,submitted,partialResponse:err.partialResponse };
    } finally { activeRequest=null; }
  }

  // ── Listen for messages from background script ───────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if(msg.type==='stopSrt'){
      if(activeRequest!==msg.requestId){sendResponse({ok:false});return;}
      const stop=[...document.querySelectorAll('button[aria-label="Stop"], button[aria-label="Stop streaming"], [data-testid="stop-button"]')].find(hasVisibleState);
      if(stop)stop.click();
      sendResponse({ok:true});return;
    }
    if(msg.type==='clickSrtDownload'||msg.type==='clickPromptZipDownload'){
      const pending=pendingSrtLink;
      if(!pending||!!pending.zip!==(msg.type==='clickPromptZipDownload')||pending.requestId!==msg.requestId||activeRequest!==msg.requestId||!pending.element.isConnected){
        sendResponse({ok:false,error:'The completed output file link is no longer available.'});return;
      }
      pendingSrtLink=null;
      pending.element.click();sendResponse({ok:true});return;
    }
    if (msg.type === 'discoverModels' || msg.type === 'preflight') {
      (msg.type==='discoverModels'?discoverModels():preflight(msg)).then(data=>sendResponse({ok:true,data})).catch(e=>sendResponse({ok:false,error:e.message}));return true;
    }
    if(msg.type==='prepareSrt'){
      (async()=>{
        if(activeRequest||isStreaming())throw Error('This tab is already working.');
        activeRequest='prepare-srt';
        try{if(temporaryEnabled())await disableTemporaryChat();await selectComposerMode('work');checkComposerStillSelected('work');return {ok:true};}
        finally{activeRequest=null;}
      })().then(sendResponse).catch(error=>sendResponse({ok:false,error:error.message}));return true;
    }
    if (msg.type === "probe") {
      sendResponse({ok:true, streaming:isStreaming(), temporary:temporaryEnabled()}); return;
    }
    if (msg.type === "ping") {
      sendResponse({ ok: true, submissionAck:true, verifiedSend:true, promptZip:true, inputReady:!!findInput(), url: window.location.href, textSessionProof:currentTextSessionProof() });
      return;
    }

    if (msg.type === "chat") {
      handleChatRequest(msg).then(sendResponse);
      return true; // Will respond asynchronously
    }
  });

  console.log("[ChatGPT Gateway] Content script loaded on", window.location.href);
})();
