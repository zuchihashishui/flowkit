const BRIDGE_URL = 'ws://127.0.0.1:8100/api/elevenlabs/ws';
const PAGE_URL = 'https://elevenlabs.io/app/speech-synthesis/text-to-speech';
let socket, initialized = false, enabled = true, tabId = null, state = 'IDLE', requestId = null;
let page = {}, pageConnected = false, phase = 'IDLE', progressMessage = '', lastError = '', executing = false, inspecting = false;
let generationDispatched = false, ownedTabId = null;
const closingTabs = new Set();
const events = [];
const isPage = url => { try { const u = new URL(url); return u.origin === 'https://elevenlabs.io' && u.pathname.replace(/\/$/,'') === '/app/speech-synthesis/text-to-speech'; } catch { return false; } };
const record = message => { events.unshift({time:new Date().toISOString(),message}); events.splice(60); };
const send = (message, peer = socket) => { if (peer?.readyState === 1) peer.send(JSON.stringify(message)); };
const ready = () => enabled && state === 'IDLE' && !executing && !inspecting;
const status = () => ({type:'status',enabled,connected:socket?.readyState === 1,autoPrepareTab:true,tabId,state,pageConnected,ready:ready(),busy:executing || inspecting || state === 'AWAITING_SAVE',needsReview:state === 'NEEDS_REVIEW',executing,inspecting,requestId,page,phase,progressMessage,lastError,events});
const announce = () => { const {events,...snapshot} = status(); send(snapshot); };
async function persist() { await chrome.storage.local.set({enabled,tabId,state,requestId}); announce(); }
async function boundPage() {
  if (!Number.isInteger(tabId)) throw new Error('Bind an ElevenLabs Text to Speech tab in the side panel.');
  const tab = await chrome.tabs.get(tabId);
  if (!isPage(tab.url)) throw new Error('The bound tab is no longer on ElevenLabs Text to Speech.');
  return tab;
}
async function inspectPage(quiet = false) {
  pageConnected = false; announce();
  try {
    const target = (await boundPage()).id;
    let result;
    try { result = await chrome.tabs.sendMessage(target,{type:'probe'},{frameId:0}); }
    catch (e) {
      // Only this read-only probe can be retried. A lost Generate reply is uncertain.
      if (!/Receiving end does not exist/i.test(e.message || '')) throw e;
      if ((await boundPage()).id !== target) throw new Error('The bound tab changed. Bind it again.');
      record('Page receiver missing. Loading the ElevenLabs bridge into the bound tab.');
      await chrome.scripting.executeScript({target:{tabId:target,frameIds:[0]},files:['content.js']});
      result = await chrome.tabs.sendMessage(target,{type:'probe'},{frameId:0});
    }
    if (!result?.ok || !result.page) throw new Error(result?.error || 'The page bridge did not respond.');
    if ((await boundPage()).id !== target) throw new Error('The bound tab changed. Bind it again.');
    page = result.page; pageConnected = true; if (state === 'IDLE') lastError = ''; announce(); return page;
  } catch (e) {
    page = {}; pageConnected = false;
    if (quiet) throw e;
    lastError = `Cannot connect to the ElevenLabs page. Refresh the Text to Speech tab, allow this extension on elevenlabs.io, then click Bind tab or Check page. Details: ${e.message}`;
    record(lastError); announce(); throw new Error(lastError);
  }
}
function reportPreparation(nextPhase, message, peer) {
  phase = nextPhase; progressMessage = message;
  send({type:'progress',requestId,phase,message},peer); announce();
}
function assertCurrentRun(peer, target) {
  if (state !== 'RUNNING' || socket !== peer || peer.readyState !== 1 || tabId !== target) throw new Error('Connection or bound tab changed during preparation. No new Generate request was sent.');
}
async function openFreshPage(message, peer) {
  // The first chunk reads the actual new page's voice. Later chunks use the
  // authoritative voice pinned by the backend, never stale old-tab metadata.
  const expectedVoice = message.expectedVoice || '';
  assertCurrentRun(peer,tabId);
  reportPreparation('CLOSING_TABS','Closing existing ElevenLabs Text to Speech tabs',peer);
  const allTabs = await chrome.tabs.query({});
  const existing = allTabs.filter(tab => isPage(tab.url || tab.pendingUrl));
  assertCurrentRun(peer,tabId);
  let keepAliveTabId = null, created = null;
  try {
    // Closing Chrome's last tab can stop the extension before tabs.create runs.
    // A temporary blank tab keeps the browser alive; the new TTS page is still
    // opened only after every old TTS tab has been closed.
    if (existing.length && existing.length === allTabs.length) {
      const placeholder = await chrome.tabs.create({url:'about:blank',active:false});
      if (!Number.isInteger(placeholder?.id)) throw new Error('Chrome could not keep the browser open while replacing its last Text to Speech tab. No speech was generated.');
      keepAliveTabId = placeholder.id;
      assertCurrentRun(peer,tabId);
    }
    // Detach before closing: onRemoved is also delivered for our own cleanup.
    tabId = null; page = {}; pageConnected = false; await persist();
    for (const tab of existing) closingTabs.add(tab.id);
    try {
      for (const tab of existing) {
        assertCurrentRun(peer,null);
        try { await chrome.tabs.remove(tab.id); }
        catch (error) {
          // Another user action may have closed a queried tab first. Any other
          // removal failure must stop rather than leave multiple TTS tabs.
          let stillPresent = false;
          try { await chrome.tabs.get(tab.id); stillPresent = true; } catch { /* Already closed. */ }
          if (stillPresent) throw error;
        }
      }
    } finally { for (const tab of existing) closingTabs.delete(tab.id); }
    assertCurrentRun(peer,null);
    reportPreparation('OPENING_TAB','Opening Text to Speech in a separate Chrome window',peer);
    const workerWindow = await chrome.windows.create({url:PAGE_URL,type:'normal',focused:true});
    created = workerWindow.tabs?.[0];
    assertCurrentRun(peer,null);
    if (!Number.isInteger(created?.id)) throw new Error('Chrome did not create a Text to Speech tab. No speech was generated.');
    tabId = created.id; ownedTabId = created.id;
    reportPreparation('BINDING_TAB','Binding the new Text to Speech tab automatically',peer);
    record(`Opened and bound new Text to Speech tab ${tabId}.`); await persist();
  } finally {
    if (keepAliveTabId !== null) {
      try {
        const placeholder = await chrome.tabs.get(keepAliveTabId);
        // Never close a placeholder the user has navigated to another site.
        if (placeholder.url === 'about:blank' && (!placeholder.pendingUrl || placeholder.pendingUrl === 'about:blank')) {
          let anotherTab = false;
          if (Number.isInteger(created?.id)) {
            try { await chrome.tabs.get(created.id); anotherTab = true; } catch { /* Check other remaining tabs below. */ }
          }
          if (!anotherTab) anotherTab = (await chrome.tabs.query({})).some(tab => tab.id !== keepAliveTabId);
          if (anotherTab) await chrome.tabs.remove(keepAliveTabId);
          else record('Kept one blank tab open because Chrome could not open the replacement Text to Speech page.');
        }
      } catch { record('The temporary blank tab was already closed or could not be cleaned up.'); }
    }
  }
  const target = created.id, deadline = Date.now() + 60000;
  assertCurrentRun(peer,target);
  let waiting = 'Waiting for the new Text to Speech editor', lastReport = '', differentVoice = '', differentSince = 0;
  reportPreparation('WAITING_NEW_PAGE',waiting,peer);
  while (Date.now() < deadline) {
    assertCurrentRun(peer,target);
    try {
      const checked = await inspectPage(true);
      assertCurrentRun(peer,target);
      if (!checked.documentToken) waiting = 'The new page document has not connected';
      else if (!checked.editorReady) waiting = checked.editorError || 'The Text to Speech editor is not visible; check sign-in and page loading';
      else if (!checked.voice) waiting = 'The selected voice is not visible; choose a voice in the speaker header or Settings';
      else if (checked.generating || checked.active) waiting = 'The new page still reports an active generation';
      else if (!expectedVoice || checked.voice === expectedVoice) return {target,expectedVoice:expectedVoice || checked.voice};
      else {
        if (differentVoice !== checked.voice) { differentVoice = checked.voice; differentSince = Date.now(); }
        if (Date.now() - differentSince >= 1500) throw Object.assign(new Error(`The voice changed on the new page: expected "${expectedVoice}", found "${checked.voice}". Restore the same voice before retrying.`),{code:'VOICE_CHANGED'});
        waiting = 'Waiting for the selected voice to finish restoring';
      }
    } catch (error) {
      assertCurrentRun(peer,target);
      if (error.code === 'VOICE_CHANGED') throw error;
      waiting = String(error.message || 'The page bridge is not connected').slice(0,250);
    }
    if (waiting !== lastReport) { lastReport = waiting; reportPreparation('WAITING_NEW_PAGE',waiting,peer); }
    await new Promise(resolve => setTimeout(resolve,500));
  }
  throw new Error(`The new Text to Speech page was not ready within 60 seconds. ${waiting}. No speech was generated.`);
}
async function clearAndReload(message, peer) {
  const target = (await boundPage()).id;
  assertCurrentRun(peer,target);
  reportPreparation('CLEARING_TEXT','Clearing the previous text before refreshing the page',peer);
  const cleared = await chrome.tabs.sendMessage(target,{type:'clearForReload',requestId,expectedVoice:message.expectedVoice},{frameId:0});
  if (!cleared?.ok || !cleared.documentToken || !cleared.voice) throw Object.assign(new Error(cleared?.error || 'The editor did not confirm it was empty. Refresh was not started.'),{code:cleared?.code || 'PREPARATION_FAILED'});
  assertCurrentRun(peer,target);
  reportPreparation('REFRESHING_PAGE','Text cleared. Reloading the same ElevenLabs tab',peer);
  pageConnected = false; page = {}; await persist();
  await chrome.tabs.reload(target);
  const deadline = Date.now() + 60000;
  let waiting = 'Waiting for the refreshed document', lastReport = '', differentVoice = '', differentSince = 0;
  reportPreparation('WAITING_PAGE','Waiting for a new page and the Text to Speech editor',peer);
  while (Date.now() < deadline) {
    assertCurrentRun(peer,target);
    try {
      // SPA editors can be ready while unrelated resources keep Chrome "loading".
      // A different document token is still mandatory before any new text is sent.
      const checked = await inspectPage(true);
      if (!checked.documentToken || checked.documentToken === cleared.documentToken) waiting = 'The new page document has not connected';
      else if (!checked.editorReady) waiting = checked.editorError || 'The Text to Speech editor is not visible';
      else if (!checked.voice) waiting = 'The selected voice is not visible; choose a voice in the speaker header or Settings';
      else if (checked.generating) waiting = 'The page still reports an active generation';
      else {
        assertCurrentRun(peer,target);
        if (checked.voice === cleared.voice) return {documentToken:checked.documentToken,voice:cleared.voice};
        // Hydration can briefly display a default voice before restoring the
        // user's choice. Confirm a stable mismatch rather than failing on it.
        if (differentVoice !== checked.voice) { differentVoice = checked.voice; differentSince = Date.now(); }
        if (Date.now() - differentSince >= 1500) throw new Error(`The voice changed after refresh: expected "${cleared.voice}", found "${checked.voice}". Restore the same voice before retrying.`);
        waiting = 'Waiting for the selected voice to finish restoring';
      }
    } catch (e) {
      assertCurrentRun(peer,target);
      if (/voice changed after refresh/.test(e.message)) throw e;
      waiting = String(e.message || 'The page bridge is not connected').slice(0,250);
    }
    if (waiting !== lastReport) { lastReport = waiting; reportPreparation('WAITING_PAGE',waiting,peer); }
    await new Promise(resolve => setTimeout(resolve,500));
  }
  throw new Error(`The refreshed Text to Speech page was not ready within 60 seconds. ${waiting}. No new speech was generated.`);
}
// A saved final chunk can close only the page created by this worker.
async function closeCompletedPage() {
  const target = ownedTabId;
  if (!Number.isInteger(target) || target !== tabId) return;
  let tab;
  try { tab = await chrome.tabs.get(target); } catch { return; }
  if (!isPage(tab.url) || (tab.pendingUrl && !isPage(tab.pendingUrl))) {
    record('Kept the worker tab because it was navigated away from Text to Speech.'); return;
  }
  const tabs = await chrome.tabs.query({});
  if (tabs.length === 1 && tabs[0].id === target) {
    await chrome.tabs.create({url:'about:blank',active:false});
  }
  closingTabs.add(target);
  try {
    await chrome.tabs.remove(target);
    tabId = null; ownedTabId = null; pageConnected = false; page = {};
    record('All chunks saved. Closed the Text to Speech worker tab.');
  } finally { closingTabs.delete(target); }
}
async function control(message, peer) {
  if (message.type === 'commit') {
    if (message.requestId !== requestId || executing || !['AWAITING_SAVE','NEEDS_REVIEW'].includes(state)) {
      send({type:'commitAck',requestId:message.requestId,ok:false,error:'No matching saved chunk is awaiting acknowledgement.'},peer); return;
    }
    if (message.ok && state !== 'AWAITING_SAVE') { send({type:'commitAck',requestId:message.requestId,ok:false,error:'The worker requires review and cannot be released by a save acknowledgement.'},peer); return; }
    if (message.ok && state === 'AWAITING_SAVE') {
      // Keep AWAITING_SAVE until cleanup finishes so another job cannot race it.
      lastError = '';
      if (message.jobComplete === true) {
        try { await closeCompletedPage(); }
        catch (error) { lastError = `Audio saved, but the worker tab could not close: ${error.message}`; record(lastError); }
      }
      state = 'IDLE'; phase = 'SAVED'; progressMessage = ''; requestId = null;
      record(message.jobComplete === true ? 'Narration audio saved by Studio.' : 'Audio saved by Studio. Ready for the next chunk.');
    }
    else { state = 'NEEDS_REVIEW'; phase = 'NEEDS_REVIEW'; record('Chunk requires review before the queue can continue.'); }
    await persist(); send({type:'commitAck',requestId:message.requestId,ok:true},peer); return;
  }
  if (message.type === 'probe' || message.type === 'review') {
    if (executing || inspecting || (message.type === 'probe' && state === 'AWAITING_SAVE')) {
      send({type:'result',requestId:message.requestId,ok:false,error:'Wait for the current chunk to finish and save.',code:'BUSY',notSubmitted:true},peer); return;
    }
    inspecting = true; announce();
    try {
      const inspected = await inspectPage();
      if (message.type === 'review') {
        if (inspected.generating || inspected.active) throw new Error('The page is still processing a chunk. Wait and review the result first.');
        state = 'IDLE'; phase = 'IDLE'; progressMessage = ''; requestId = null; lastError = ''; await persist(); record('Worker reset after explicit review.');
      }
      send({type:'result',requestId:message.requestId,ok:true,page:inspected,state,busy:false},peer);
    } catch (e) { send({type:'result',requestId:message.requestId,ok:false,error:e.message,notSubmitted:true},peer); }
    finally { inspecting = false; announce(); }
  }
}
async function generate(message, peer) {
  if (!ready()) { send({type:'result',requestId:message.requestId,ok:false,error:'The ElevenLabs worker is disabled or unavailable. Finish saving or review the current chunk before starting another.',code:'BUSY',notSubmitted:true,state,needsReview:state === 'NEEDS_REVIEW'},peer); return; }
  if (typeof message.requestId !== 'string' || !message.requestId || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 3000) {
    send({type:'result',requestId:message.requestId,ok:false,error:'Invalid chunk. Send 1–3,000 characters with a request ID.',code:'INVALID_REQUEST',notSubmitted:true,state,needsReview:state === 'NEEDS_REVIEW'},peer); return;
  }
  executing = true; generationDispatched = false; state = 'RUNNING'; phase = 'PREPARING'; progressMessage = ''; requestId = message.requestId; lastError = ''; record(`Starting chunk ${requestId}.`); await persist();
  let dispatched = false;
  try {
    const fresh = await openFreshPage(message,peer);
    const prepared = await clearAndReload({...message,expectedVoice:fresh.expectedVoice},peer);
    assertCurrentRun(peer,fresh.target);
    dispatched = true; generationDispatched = true;
    const result = await chrome.tabs.sendMessage(fresh.target,{type:'generate',requestId,text:message.text,model:message.model || 'Eleven v4',expectedVoice:fresh.expectedVoice || prepared.voice,expectedDocumentToken:prepared.documentToken,timeout:message.timeout},{frameId:0});
    if (socket !== peer || peer.readyState !== 1 || state !== 'RUNNING') throw new Error('Connection changed during generation. Inspect the page before retrying; audio may already exist.');
    if (!result?.ok) { const failure = new Error(result?.error || 'The page returned no generation result.'); Object.assign(failure,{code:result?.code,notSubmitted:result?.notSubmitted === true}); throw failure; }
    state = 'AWAITING_SAVE'; phase = 'AWAITING_SAVE'; progressMessage = ''; record('Audio received. Waiting for Studio to save the file.');
    page = {...page,voice:result.voice,model:result.model,credits:result.credits || {balance:result.creditsAfter ?? null,balanceText:'',cost:null},creditsRemaining:result.creditsAfter ?? null,estimatedCost:result.credits?.cost ?? null};
    await persist(); send({...result,type:'result',requestId:message.requestId},peer);
  } catch (e) {
    const notSubmitted = e.notSubmitted === true || !dispatched;
    // A definite failure before Generate cannot have spent credits. Pause/fail
    // the job in Studio, but do not force an uncertain-result review workflow.
    // Lost page replies and every failure after submission remain quarantined.
    state = notSubmitted ? 'IDLE' : 'NEEDS_REVIEW'; phase = notSubmitted ? 'FAILED' : 'NEEDS_REVIEW';
    progressMessage = ''; lastError = e.message; if (notSubmitted) requestId = null;
    record(e.message); await persist();
    send({type:'result',requestId:message.requestId,ok:false,error:e.message,code:e.code || 'BRIDGE_ERROR',notSubmitted,state,needsReview:state === 'NEEDS_REVIEW'},peer);
  } finally { executing = false; generationDispatched = false; announce(); }
}
let nativeDownloadBusy = false;
async function downloadCompletedAudio(target, rid) {
  if (!chrome.downloads?.onDeterminingFilename) throw new Error('Reload the extension and allow its Downloads permission.');
  if (nativeDownloadBusy) throw new Error('An audio download is already in progress.');
  nativeDownloadBusy = true;
  const token = crypto.randomUUID(), relative = `flowkit-elevenlabs/${token}/audio.mp3`;
  const started = Date.now(); let downloadId = null, conflict = false;
  const origin = value => { try { return new URL(value).origin === 'https://elevenlabs.io'; } catch { return false; } };
  const listener = (item,suggest) => {
    if (!Number.isFinite(Date.parse(item.startTime)) || Date.parse(item.startTime) < started - 1000 || (!origin(item.referrer) && !origin(item.url))) { suggest(); return; }
    if (downloadId !== null) { conflict = true; suggest(); return; }
    downloadId = item.id;
    suggest({filename:relative,conflictAction:'uniquify'});
  };
  try {
    chrome.downloads.onDeterminingFilename.addListener(listener);
    const clicked = await chrome.tabs.sendMessage(target,{type:'clickDownload',requestId:rid},{frameId:0});
    if (!clicked?.ok) throw new Error(clicked?.error || 'The completed audio Download button could not be clicked.');
    while (Date.now() - started < 60000) {
      if (conflict) throw new Error('Multiple ElevenLabs downloads started. Review the files before retrying.');
      if (downloadId !== null) {
        const [item] = await chrome.downloads.search({id:downloadId});
        if (!item || item.state === 'interrupted') throw new Error(`Audio download interrupted: ${item?.error || 'file unavailable'}. Use Download to recover the generated audio.`);
        if (item.state === 'complete') {
          if (item.exists === false || !item.filename.replaceAll('\\','/').endsWith('/'+relative)) throw new Error('Audio download was saved outside the expected Flowkit folder. Recover the file manually.');
          return {path:item.filename,token};
        }
      }
      await new Promise(resolve => setTimeout(resolve,250));
    }
    throw new Error('Audio download did not complete within 60 seconds. Check Chrome Downloads and any Save As dialog. No new speech was generated.');
  } finally {
    chrome.downloads.onDeterminingFilename.removeListener(listener);
    nativeDownloadBusy = false;
  }
}
function connect() {
  if (!initialized || socket?.readyState === 0 || socket?.readyState === 1) return;
  const peer = socket = new WebSocket(BRIDGE_URL);
  peer.onopen = () => { record('Connected to Flowkit Studio.'); announce(); };
  peer.onmessage = event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'generate') void generate(message,peer);
    else if (['probe','review','commit'].includes(message.type)) void control(message,peer);
  };
  peer.onclose = async () => {
    if (socket !== peer) return;
    if (state === 'RUNNING' || state === 'AWAITING_SAVE') { state = 'NEEDS_REVIEW'; phase = 'NEEDS_REVIEW'; lastError = 'Connection lost during an unfinished chunk. Inspect the page before retrying.'; await persist(); }
    record('Disconnected. Start Flowkit Studio to reconnect.');
  };
  peer.onerror = () => { lastError = 'Cannot connect to the local backend at 127.0.0.1:8100.'; };
}
chrome.runtime.onMessage.addListener((message,sender,reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'downloadAudio') {
    if (sender.tab?.id !== tabId || sender.frameId !== 0 || message.requestId !== requestId || state !== 'RUNNING' || !executing) {
      reply({ok:false,error:'No matching active ElevenLabs chunk.'}); return;
    }
    downloadCompletedAudio(tabId,requestId).then(nativeDownload => reply({ok:true,nativeDownload}),e => reply({ok:false,error:e.message}));
    return true;
  }
  if (message.type === 'elevenlabsProgress') {
    if (sender.tab?.id !== tabId || (sender.frameId !== undefined && sender.frameId !== 0) || message.requestId !== requestId || state !== 'RUNNING') return;
    phase = String(message.phase || '').slice(0,80); progressMessage = String(message.message || '').slice(0,250);
    if (message.credits && typeof message.credits === 'object') {
      const value = message.credits;
      const credits = {balance:Number.isFinite(value.balance) ? value.balance : null,
        cost:Number.isFinite(value.cost) ? value.cost : null,
        balanceText:typeof value.balanceText === 'string' ? value.balanceText.slice(0,120) : ''};
      page = {...page,credits,creditsRemaining:credits.balance,estimatedCost:credits.cost};
      announce();
    }
    send({type:'progress',requestId,phase,message:progressMessage}); reply({ok:true}); return;
  }
  if (sender.tab) return;
  (async () => {
    if (!initialized) throw new Error('The extension is starting. Try again in a moment.');
    if (message.type === 'status') return status();
    if (message.type === 'setEnabled') { enabled = !!message.enabled; await persist(); record(enabled ? 'Bridge enabled.' : 'Bridge disabled; the current chunk can finish.'); return status(); }
    if (message.type === 'bindTab') {
      if (executing || inspecting || !['IDLE','NEEDS_REVIEW'].includes(state)) throw new Error('Finish or review the current chunk in Studio before changing the tab.');
      inspecting = true; announce();
      try {
        const selected = await chrome.tabs.get(message.tabId);
        if (!isPage(selected.url)) throw new Error('Choose an ElevenLabs Text to Speech tab.');
        ownedTabId = null; tabId = selected.id; page = {}; pageConnected = false; if (state === 'IDLE') lastError = '';
        await persist(); await inspectPage(); record(`Bound tab ${tabId}${state === 'NEEDS_REVIEW' ? '; review is still required in Studio' : ''}.`);
      } finally { inspecting = false; announce(); }
      return status();
    }
    if (message.type === 'probe') {
      if (executing || inspecting || state === 'AWAITING_SAVE') throw new Error('Wait for the current chunk to finish and save.');
      inspecting = true; announce(); try { await inspectPage(); lastError = ''; return status(); } finally { inspecting = false; announce(); }
    }
    if (message.type === 'reconnect') { if (executing || state === 'AWAITING_SAVE') throw new Error('Wait for the current chunk to finish and save.'); if (socket) socket.close(); connect(); return status(); }
    if (message.type === 'clearEvents') { events.length = 0; return status(); }
    throw new Error('Unknown extension command.');
  })().then(reply).catch(e => reply({ok:false,error:e.message})); return true;
});
async function initialize() {
  const saved = await chrome.storage.local.get(['enabled','tabId','state','requestId']);
  enabled = saved.enabled !== false; tabId = Number.isInteger(saved.tabId) ? saved.tabId : null; requestId = saved.requestId || null;
  if (saved.state && saved.state !== 'IDLE') { state = 'NEEDS_REVIEW'; phase = state; lastError = 'The extension restarted with an unfinished chunk. Review it in Studio before continuing.'; }
  await persist(); initialized = true; connect();
  if (Number.isInteger(tabId)) {
    inspecting = true;
    try { await inspectPage(true); } catch { /* A stale tab does not block automatic preparation. Review locks are retained. */ }
    finally { inspecting = false; announce(); }
  }
}
chrome.tabs.onRemoved.addListener(async id => {
  if (closingTabs.has(id)) return;
  if (id !== tabId) return;
  const preparing = executing && !generationDispatched && state === 'RUNNING';
  const unfinished = (executing && generationDispatched) || state === 'AWAITING_SAVE' || state === 'NEEDS_REVIEW';
  tabId = null; pageConnected = false; page = {};
  if (!preparing) { state = unfinished ? 'NEEDS_REVIEW' : 'IDLE'; phase = state; }
  progressMessage = ''; lastError = preparing ? 'The new Text to Speech tab was closed before Generate. No speech was generated.' : unfinished ? 'The bound ElevenLabs tab was closed during an unfinished chunk. Reopen it and review the worker in Studio.' : '';
  await persist();
});
chrome.alarms.create('elevenlabs-reconnect',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'elevenlabs-reconnect') { connect(); announce(); } });
setInterval(() => { connect(); announce(); },20000);
chrome.sidePanel?.setPanelBehavior({openPanelOnActionClick:true}).catch(() => {});
initialize().catch(e => { lastError = e.message; });
