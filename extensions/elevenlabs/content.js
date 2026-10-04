// The bridge operates only the visible TTS UI; it never reads session tokens or calls private APIs.
(() => {
  const bridgeVersion = '1.0.23', previous = window.__flowkitElevenLabsBridge;
  const documentToken = window.__flowkitElevenLabsDocumentToken ||= crypto.randomUUID();
  // A boolean left by 1.0.0 or an invalidated extension context must not block repair.
  try {
    if (previous?.version === bridgeVersion && previous.runtime?.id === chrome.runtime.id
        && previous.runtime.onMessage.hasListener(previous.listener)) return;
  } catch { /* The extension was reloaded; its old receiver is no longer usable. */ }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => {
    if (!el || el.closest('[hidden],[aria-hidden="true"]') || !el.getClientRects().length) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const all = selector => [...document.querySelectorAll(selector)];
  const first = selector => all(selector).find(visible);
  const usable = el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const text = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  function generateCandidates() {
    const speechLabel = /^(?:re)?generate\s+speech(?:\s+(?:Ctrl|Control|Cmd|Command|⌘).*Enter)?$/i;
    return all('button,[role="button"]').filter(el => visible(el)
      && !el.closest('[contenteditable="true"],[data-testid="audio-player"],[role="dialog"],nav')
      && getComputedStyle(el).visibility !== 'hidden'
      && getComputedStyle(el).display !== 'none'
      && (el.getAttribute('data-testid') === 'tts-generate'
        || speechLabel.test((el.getAttribute('aria-label') || '').trim())
        || speechLabel.test(text(el))));
  }
  function generateButton() {
    const candidates = generateCandidates();
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  const generating = () => generateButton()?.getAttribute('data-loading') === 'true' || generateButton()?.getAttribute('aria-busy') === 'true' || generationCards().some(card => card.loading);
  const normalizeName = value => value.replace(/\s+/g,' ').normalize('NFC').trim();
  const modelName = () => normalizeName((first('[data-testid="tts-model-selector"]')?.getAttribute('aria-label') || '').replace(/^Select model\s*-\s*/i, ''));
  function voiceName() {
    const selector = first('[data-testid="tts-voice-selector"]');
    const selected = normalizeName((selector?.getAttribute('aria-label') || '').replace(/^Select voice\s*-\s*/i, ''));
    if (selected && !/^Select voice$/i.test(selected)) return selected;
    // Settings may be closed. The single dialogue block also exposes its voice
    // in a non-editable header; never read narration or another speaker's label.
    let root;
    try { root = editor().root; } catch { return ''; }
    const dialogue = [...root.querySelectorAll('.node-dialogueNode')].filter(visible);
    if (dialogue.length !== 1) return '';
    const names = [...dialogue[0].querySelectorAll('[contenteditable="false"] button')]
      .filter(button => visible(button) && !button.hasAttribute('aria-label'))
      .map(button => [...button.querySelectorAll('span.truncate')].filter(visible).map(text).join(' ').trim())
      .filter(Boolean);
    return names.length === 1 ? normalizeName(names[0]) : '';
  }
  const error = (message, code) => Object.assign(new Error(message), {code});
  let active = false, pendingDownload = null;

  const balancePattern = /^(?:([\d,.]+\s*[KMB]?)\s+credits?\s+(?:free|remaining|available|left)|(?:balance|credits?\s+(?:remaining|available))\s*:?\s*([\d,.]+\s*[KMB]?))$/i;
  const excludedCreditArea = '[contenteditable="true"],[data-testid="audio-player"],[role="dialog"],[role="tooltip"],nav';
  function creditVisible(el) {
    if (!el || el.closest('[hidden],[aria-hidden="true"]')) return false;
    // display:contents has no client rectangles but its text is still visible.
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }
  function creditLabels() {
    const labels = all('span,p,div,output').filter(el => !el.closest(excludedCreditArea)
      && el.childElementCount < 4 && text(el).length < 100 && balancePattern.test(text(el)) && creditVisible(el));
    let local = generateButton()?.parentElement;
    const localScopes = [];
    for (let i = 0; local && i < 5 && !['BODY','HTML'].includes(local.tagName); i++,local = local.parentElement) {
      if (local.querySelector('[contenteditable="true"],[data-testid="audio-player"]')) break;
      localScopes.push(local);
    }
    const leaves = labels.filter(el => !labels.some(other => other !== el && el.contains(other)))
      .filter(el => localScopes.some(scope => scope.contains(el))
        || el.closest('div.hstack.justify-between.items-center')
        || /free to use on v4/i.test(el.closest('[data-agent-tooltip]')?.getAttribute('data-agent-tooltip') || ''));
    const modelLabels = leaves.filter(el => /free to use on v4/i.test(el.closest('[data-agent-tooltip]')?.getAttribute('data-agent-tooltip') || ''));
    return modelLabels.length ? modelLabels : leaves;
  }
  function creditScopes() {
    // Read the balance's meaning, not utility classes or the Generate DOM hierarchy.
    const labels = creditLabels();
    if (labels.length > 1) return [];
    const buttonScope = generateButton()?.parentElement;
    if (labels.length === 1) {
      const label = labels[0];
      const row = label.closest('div.hstack.justify-between.items-center');
      const scope = row && !row.closest(excludedCreditArea) ? row : label;
      return buttonScope?.contains(scope) ? [scope,buttonScope] : [scope];
    }
    return buttonScope ? [buttonScope] : [];
  }
  function visibleCreditText(el) {
    if (!creditVisible(el)) return '';
    return [...el.childNodes].map(node => node.nodeType === Node.TEXT_NODE
      ? node.textContent : node.nodeType === Node.ELEMENT_NODE ? visibleCreditText(node) : '')
      .join(' ').replace(/\s+/g,' ').trim();
  }
  function numberValue(raw) {
    const m = raw.trim().match(/^([\d,]+(?:\.\d+)?)\s*([KMB])?$/i);
    if (!m) return null;
    const n = Number(m[1].replaceAll(',', '')), scale = ({K:1000,M:1000000,B:1000000000})[m[2]?.toUpperCase()] || 1;
    if (!Number.isFinite(n)) return null;
    // Abbreviated balances are rounded: compare against a conservative lower bound.
    const resolution = scale / (10 ** ((m[1].split('.')[1] || '').length));
    return {value:n * scale, lowerBound:Math.max(0, n * scale - (scale > 1 ? resolution : 0)), approximate:scale > 1};
  }
  function credits() {
    const scopes = creditScopes();
    let balance = null, cost = null, balanceText = '', costText = '';
    // Only inspect the generation footer, not promotional banners or historical records.
    for (const el of new Set(scopes.flatMap(scope => [scope, ...scope.querySelectorAll('span,p,[data-testid]')]))) {
      if (!creditVisible(el)) continue;
      const t = visibleCreditText(el);
      let m = t.match(/(?:^|\s)([\d,.]+\s*[KMB]?)\s+credits?\s+(?:free|remaining|available|left)\b/i)
        || t.match(/(?:balance|credits?\s+(?:remaining|available))\s*:?\s*([\d,.]+\s*[KMB]?)\b/i);
      if (m && !balance) { balance = numberValue(m[1]); balanceText = m[0].trim(); }
      m = t.match(/(?:cost|requires?|uses?)\s*:?\s*([\d,]+(?:\.\d+)?)\s+credits?\b/i)
        || t.match(/\b([\d,]+(?:\.\d+)?)\s+credits?\s+(?:will be used|per generation|to generate)\b/i);
      if (m) { cost = Number(m[1].replaceAll(',', '')); costText = m[0]; }
    }
    return {balance:balance?.value ?? null,balanceLowerBound:balance?.lowerBound ?? null,approximate:!!balance?.approximate,cost,balanceText,costText};
  }
  function optionalCredits() {
    try { return credits(); }
    catch { return {balance:null,cost:null,balanceText:'',costText:''}; }
  }
  function editor() {
    const root = first('[data-agent-id="tts-textarea"][contenteditable="true"]') || first('.tiptap[contenteditable="true"]');
    if (!root) throw error('The ElevenLabs text editor was not found. Open Text to Speech and refresh the tab.', 'EDITOR_NOT_FOUND');
    const blocks = [...root.querySelectorAll('[data-testid="tts-editor"]')].filter(visible);
    if (blocks.length !== 1) throw error('Use a single speaker block before starting the queue. The bridge preserves the selected voice.', 'MULTI_SPEAKER');
    return {root, node:blocks[0].querySelector('[data-node-view-content-react]') || blocks[0].querySelector('[data-node-view-content]') || blocks[0]};
  }
  function probe() {
    let editorReady = false, editorError = '';
    try { editor(); editorReady = true; } catch (e) { editorError = e.message; }
    const credit = optionalCredits();
    return {bridgeVersion,documentToken,url:location.href,model:modelName(),voice:voiceName(),credits:credit,creditsRemaining:credit.balance,estimatedCost:credit.cost,generating:generating(),active,editorReady,editorError,generateReady:usable(generateButton())};
  }
  function progress(requestId, phase, extra = {}) {
    Promise.resolve(chrome.runtime.sendMessage({type:'elevenlabsProgress',requestId,phase,...extra})).catch(() => {});
  }
  async function selectModel(requested) {
    if (requested !== 'Eleven v4') throw error('This bridge currently supports the Eleven v4 page workflow.', 'MODEL_UNSUPPORTED');
    if (!first('[data-testid="tts-model-selector"]')) {
      const settings = first('[data-testid="tts-settings-tab"]')
        || all('[role="tab"]').find(el => usable(el) && text(el) === 'Settings');
      if (usable(settings)) {
        settings.click();
        for (let i = 0; i < 20 && !first('[data-testid="tts-model-selector"]'); i++) await sleep(250);
      }
    }
    if (modelName() === requested) return;
    const trigger = first('[data-testid="tts-model-selector"]');
    if (!usable(trigger)) throw error('The model selector is unavailable. Open the Settings tab in ElevenLabs.', 'MODEL_NOT_FOUND');
    trigger.click();
    let option;
    for (let i = 0; i < 20 && !option; i++) {
      await sleep(250);
      option = all('[role="option"],[role="menuitem"],[role="menuitemradio"],button').find(el => el !== trigger && usable(el) && (text(el) === requested || el.getAttribute('aria-label') === requested));
    }
    if (!option) throw error('Eleven v4 was not found in the model menu. Select it manually, then retry the chunk.', 'MODEL_NOT_FOUND');
    option.click();
    for (let i = 0; i < 20; i++) { if (modelName() === requested) return; await sleep(250); }
    throw error('The page did not confirm Eleven v4. No speech was generated.', 'MODEL_NOT_CONFIRMED');
  }
  async function selectEditorContents() {
    const {root,node} = editor();
    root.focus();
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    // ProseMirror maintains its own selection. Give it the selectionchange
    // before paste, otherwise it can paste into the previous cursor position.
    document.dispatchEvent(new Event('selectionchange'));
    await sleep(0);
    const current = editor();
    if (current.node !== node || !selection.rangeCount || !node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) {
      throw error('The editor selection changed before text could be replaced. No speech was generated. Keep the Text to Speech tab idle while the queue runs.', 'EDITOR_SELECTION_CHANGED');
    }
    return current;
  }
  async function typeText(value) {
    const {node} = await selectEditorContents();
    // Let ProseMirror's paste handler update its document and React state. A DOM
    // insertion plus a synthetic input event can leave the application's state stale.
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', value);
    // ProseMirror's plain-text parser folds consecutive blank lines. Supplying
    // an escaped single paragraph with explicit breaks preserves them and does
    // not turn each line into another speaker. This is clipboard data only;
    // the page's paste handler still owns the editor transaction.
    const paragraph = document.createElement('p');
    value.replace(/\r\n?/g,'\n').split('\n').forEach((line,index) => {
      if (index) paragraph.append(document.createElement('br'));
      paragraph.append(document.createTextNode(line));
    });
    const copied = document.createElement('div');
    copied.setAttribute('data-pm-slice','1 1 []'); copied.append(paragraph);
    clipboard.setData('text/html',copied.outerHTML);
    const paste = new ClipboardEvent('paste', {bubbles:true,cancelable:true,composed:true,clipboardData:clipboard});
    node.dispatchEvent(paste);
    if (!paste.defaultPrevented) throw error('The ElevenLabs editor did not accept the paste event. No speech was generated. Refresh the Text to Speech page and try again.', 'EDITOR_PASTE_NOT_HANDLED');
    // Do not insert again or dispatch a second input event: the paste handler owns
    // the transaction, including line breaks, audio tags and the character count.
    // React/ProseMirror may replace nodes after the DOM insertion. Re-read the
    // current editor until its full text remains equivalent, before Generate.
    const expected = comparableText(value), deadline = Date.now() + 8000;
    let entered = '', matchedSince = null;
    while (Date.now() < deadline) {
      await sleep(250);
      entered = comparableText(editorText(editor().node));
      if (entered === expected) {
        matchedSince ??= Date.now();
        if (Date.now() - matchedSince >= 750) return;
      } else matchedSince = null;
    }
    const wanted = Array.from(expected), actual = Array.from(entered);
    let mismatch = 0;
    while (mismatch < Math.min(wanted.length,actual.length) && wanted[mismatch] === actual[mismatch]) mismatch++;
    throw error(`The editor did not retain the complete chunk after 8 seconds. No speech was generated. [Bridge ${bridgeVersion}; expected=${wanted.length}; entered=${actual.length}; first difference=${mismatch + 1}]`, 'EDITOR_MISMATCH');
  }
  function comparableText(value) {
    // Keep internal line breaks, punctuation, tags and Japanese characters.
    // Normalize only equivalent line endings, HTML spaces, Unicode composition
    // and outer whitespace that editors may trim at paragraph boundaries.
    return value.replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').normalize('NFC').trim();
  }

  async function clearBeforeReload(message) {
    if (active || generating()) return {ok:false,error:'The page is still generating. Wait before clearing text.',code:'BUSY',notSubmitted:true};
    active = true;
    try {
      let voice = voiceName();
      const voiceDeadline = Date.now() + 5000;
      while (!voice && Date.now() < voiceDeadline) { await sleep(250); voice = voiceName(); }
      if (!voice) throw error(`Cannot read the selected voice from Settings or the speaker header. Open the voice selector and choose a voice. The page was not cleared or refreshed. [Bridge ${bridgeVersion}]`, 'VOICE_UNKNOWN');
      if (message.expectedVoice && normalizeName(message.expectedVoice) !== voice) throw error(`The selected voice changed: expected "${normalizeName(message.expectedVoice)}", found "${voice}". Restore the earlier voice to keep this narration consistent. The page was not cleared.`, 'VOICE_CHANGED');
      const {root,node} = editor();
      if (editorText(node).trim() !== '') {
        const clear = [...(node.closest('.node-dialogueNode') || root).querySelectorAll('button[aria-label="Clear text"]')].find(usable);
        if (clear) clear.click();
        else {
          await selectEditorContents();
          if (!document.execCommand('delete',false)) throw error('Could not clear the editor. The page was not refreshed.', 'EDITOR_CLEAR_FAILED');
        }
      }
      const deadline = Date.now() + 5000;
      let emptySince = null;
      while (Date.now() < deadline) {
        await sleep(250);
        if (editorText(editor().node).trim() === '') {
          emptySince ??= Date.now();
          if (Date.now() - emptySince >= 500) return {ok:true,documentToken,voice};
        } else emptySince = null;
      }
      throw error('The editor did not become empty. The page was not refreshed.', 'EDITOR_CLEAR_FAILED');
    } catch (e) { return {ok:false,error:e.message,code:e.code || 'EDITOR_CLEAR_FAILED',notSubmitted:true}; }
    finally { active = false; }
  }
  async function waitForGenerationControls() {
    // An empty TTS editor may not render Generate or its footer at all. Start
    // this wait only AFTER entering text, and re-query React's current elements.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const failure = pageError(); if (failure) throw failure;
      const button = generateButton();
      if (usable(button) && !generating()) return;
      await sleep(250);
    }
    const candidates = generateCandidates();
    const detail = `Bridge ${bridgeVersion}; matching buttons=${candidates.length}; enabled=${candidates.filter(usable).length}`;
    if (candidates.length > 1) throw error(`Multiple Generate speech buttons are visible. No speech was generated. [${detail}]`, 'GENERATE_AMBIGUOUS');
    if (!candidates.length) throw error(`Generate speech did not appear within 30 seconds after entering text. No speech was generated. [${detail}]`, 'GENERATE_NOT_FOUND');
    throw error(`Generate speech did not become ready within 30 seconds after entering text. No speech was generated. [${detail}]`, 'PAGE_NOT_READY');
  }
  function editorText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.matches('[contenteditable="false"],script,style')) return '';
    if (node.tagName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
    const children = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE || child.nodeType === Node.ELEMENT_NODE);
    // A lone <br> in an otherwise empty paragraph/div is an editing placeholder.
    if (children.length === 1 && children[0].nodeName === 'BR') return '';
    const block = child => child.nodeType === Node.ELEMENT_NODE && /^(P|DIV|LI|H[1-6])$/.test(child.tagName);
    let output = '';
    children.forEach((child,index) => {
      if (index && (block(child) || block(children[index-1]))) output += '\n';
      output += editorText(child);
    });
    return output;
  }
  function pageError() {
    const t = all('[role="alert"],[role="dialog"] [role="status"]').filter(visible).map(text).join(' ');
    if (/insufficient|not enough|out of credits|credit limit/i.test(t)) return error(t.slice(0,350), 'INSUFFICIENT_CREDITS');
    if (/try again|failed|error|rate limit|too many requests/i.test(t)) return error(t.slice(0,350), 'GENERATION_FAILED');
    return null;
  }
  function currentAudio() {
    const player = first('[data-testid="audio-player"]');
    const audio = player?.querySelector('audio');
    const download = player?.querySelector('[data-testid="audio-player-download-button"]');
    const label = [...(player?.querySelectorAll('p') || [])].map(text).find(t => /^Generation\s+\d+$/.test(t)) || '';
    return {download,source:audio?.currentSrc || audio?.src || '',ready:downloadReady(download),label};
  }
  function downloadReady(button) {
    return usable(button) && button.getAttribute('data-loading') !== 'true' && button.getAttribute('aria-busy') !== 'true';
  }
  function generationCards() {
    // Find the closest result group beside Generate, excluding unrelated history
    // and the global audio player. Dynamic data-agent-id values are not selectors.
    let scope = generateButton()?.parentElement;
    for (let depth = 0; scope && depth < 6 && !scope.matches('body,html'); depth++, scope = scope.parentElement) {
      const cards = [...scope.querySelectorAll('p')].filter(el => visible(el) && /^Generation\s+\d+$/.test(text(el))).map(label => {
        const node = label.parentElement;
        if (node.closest('[data-testid="audio-player"]')) return null;
        const play = node.querySelector('button[aria-label="Play"]');
        if (!play) return null;
        const download = node.querySelector('button[aria-label="Download"]');
        const loading = download?.getAttribute('data-loading') === 'true' || [...node.querySelectorAll('.animate-spin,[role="progressbar"],[aria-busy="true"],span')].some(el => visible(el) && (el.matches('.animate-spin,[role="progressbar"],[aria-busy="true"]') || /^Loading\.{0,3}$/.test(text(el))));
        return {label:text(label),node,play,download,loading,ready:!loading && downloadReady(download)};
      }).filter(Boolean);
      if (cards.length) return cards;
    }
    return [];
  }
  async function waitForCompletedAudio(message, submit) {
    const oldSource = currentAudio().source;
    const before = new Map(generationCards().map(card => [card.label,card.ready]));
    const fresh = new Set(); let sawCards = before.size > 0, started = false;
    const observe = () => {
      if (!started) return;
      const cards = generationCards(); sawCards ||= cards.length > 0;
      for (const card of cards) if (!card.ready || before.get(card.label) !== true) fresh.add(card.label);
    };
    // Observe before clicking so short loading transitions aren't lost between polls.
    const observer = new MutationObserver(observe);
    observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','aria-disabled','aria-busy','data-loading','class','hidden','aria-hidden','src']});
    const start = Date.now(), deadline = start + Math.max(30000,Math.min(Number(message.timeout) || 600000,900000));
    let stableSince = 0, stableKey = '', selected = null;
    let lastPhase = '', lastReport = 0;
    const report = (phase, detail) => {
      if (phase !== lastPhase || Date.now() - lastReport >= 5000) {
        lastPhase = phase; lastReport = Date.now();
        progress(message.requestId,phase,{message:`${detail} · ${Math.floor((Date.now()-start)/1000)}s elapsed`});
      }
    };
    try {
      started = true; submit(); observe();
      while (Date.now() < deadline) {
        observe(); const failure = pageError(); if (failure) throw failure;
        const cards = generationCards(), audio = currentAudio();
        if (sawCards) {
          const sorted = [...cards].sort((a,b) => Number(a.label.match(/\d+$/)[0])-Number(b.label.match(/\d+$/)[0]));
          const choice = sorted[0];
          const complete = choice && new Set(cards.map(c=>c.label)).size === cards.length && cards.every(c=>c.ready) && fresh.has(choice.label) && !generating();
          report(complete ? 'VERIFYING_DOWNLOAD' : 'WAITING_DOWNLOAD',`${cards.filter(c=>c.ready).length}/${cards.length} variants have Download ready`);
          if (!complete) { stableSince = 0; stableKey = ''; selected = null; }
          else {
            const key = cards.map(c=>c.label).join('|');
            if (key !== stableKey || selected?.download !== choice.download) { stableKey = key; stableSince = Date.now(); selected = choice; }
            if (Date.now() - stableSince >= 1000) {
              return choice.download;
            }
          }
        } else {
          // Compatibility with pages exposing only the global player, no cards.
          const complete = audio.source && audio.source !== oldSource && audio.ready && !generating();
          if (!complete) { stableKey = ''; stableSince = 0; }
          else if (stableKey !== audio.source) { stableKey = audio.source; stableSince = Date.now(); }
          else if (Date.now() - stableSince >= 1000) return audio.download;
          report('WAITING_DOWNLOAD','Waiting for new audio and an enabled Download button');
        }
        await sleep(500);
      }
      throw error('Timed out waiting for a completed new generation and its downloadable audio. Inspect ElevenLabs before retrying; credits may already have been used.', 'GENERATION_TIMEOUT');
    } finally { observer.disconnect(); }
  }
  async function downloadAudio(button, requestId) {
    if (!downloadReady(button)) throw error('The completed Download button is no longer ready.', 'DOWNLOAD_NOT_READY');
    pendingDownload = {button,requestId,clicked:false};
    try {
      const result = await chrome.runtime.sendMessage({type:'downloadAudio',requestId});
      if (!result?.ok || !result.nativeDownload) throw error(result?.error || 'The browser download did not complete. Recover the audio with Download; do not generate again.', 'AUDIO_DOWNLOAD');
      return {nativeDownload:result.nativeDownload};
    } finally { pendingDownload = null; }
  }
  async function generate(message) {
    let submitted = false;
    if (message.expectedDocumentToken && message.expectedDocumentToken !== documentToken) return {ok:false,error:'The page changed after refresh. Review the tab before retrying.',code:'PAGE_CHANGED',notSubmitted:true};
    if (active || generating()) return {ok:false,error:'The ElevenLabs page is already generating speech.',code:'BUSY',notSubmitted:true};
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 3000) return {ok:false,error:'Each text chunk must contain 1–3,000 characters.',code:'INVALID_TEXT',notSubmitted:true};
    active = true;
    try {
      progress(message.requestId,'SELECTING_MODEL');
      await selectModel(message.model || 'Eleven v4');
      const voice = voiceName();
      if (!voice) throw error('The selected voice could not be verified. Open Settings and choose a voice.', 'VOICE_UNKNOWN');
      if (message.expectedVoice && normalizeName(message.expectedVoice) !== voice) throw error(`The selected voice changed: expected "${normalizeName(message.expectedVoice)}", found "${voice}". Restore the same voice before continuing.`, 'VOICE_CHANGED');
      progress(message.requestId,'ENTERING_TEXT'); await typeText(message.text);
      progress(message.requestId,'WAITING_GENERATE_BUTTON'); await waitForGenerationControls();
      const quote = optionalCredits();
      progress(message.requestId,'READING_CREDITS',{credits:quote});
      const creditFailure = pageError(); if (creditFailure) throw creditFailure;
      if (modelName() !== (message.model || 'Eleven v4') || voiceName() !== voice) throw error('The model or voice changed during preparation. No speech was generated.', 'SETTINGS_CHANGED');
      if (!usable(generateButton()) || generating()) throw error('The Generate button did not become ready.', 'PAGE_NOT_READY');
      const newAudio = await waitForCompletedAudio(message,() => {
        submitted = true; generateButton().click(); progress(message.requestId,'GENERATING',{credits:quote,creditsBefore:quote.balance,estimatedCost:quote.cost});
      });
      progress(message.requestId,'DOWNLOADING'); const audio = await downloadAudio(newAudio,message.requestId);
      const latestCredits = optionalCredits();
      return {ok:true,...audio,credits:latestCredits,creditsBefore:quote.balance,creditsAfter:latestCredits.balance,estimatedCost:quote.cost,creditsApproximate:quote.approximate,creditCheck:'informational-only',voice,model:modelName()};
    } catch (e) { return {ok:false,error:e.message,code:e.code || 'PAGE_ERROR',notSubmitted:!submitted}; }
    finally { active = false; }
  }
  const listener = (message,sender,reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'clickDownload') {
      const pending = pendingDownload;
      if (!active || !pending || pending.clicked || pending.requestId !== message.requestId || !pending.button.isConnected || !downloadReady(pending.button)) {
        reply({ok:false,error:'No matching completed audio is awaiting Download.'}); return;
      }
      pending.clicked = true;
      try { pending.button.click(); reply({ok:true}); }
      catch (e) { reply({ok:false,error:e.message}); }
      return;
    }
    if (message.type === 'probe') { reply({ok:true,page:probe()}); return; }
    if (message.type === 'clearForReload') { clearBeforeReload(message).then(reply); return true; }
    if (message.type === 'generate') { generate(message).then(reply); return true; }
  };
  chrome.runtime.onMessage.addListener(listener);
  window.__flowkitElevenLabsBridge = {version:bridgeVersion,runtime:chrome.runtime,listener};
})();
