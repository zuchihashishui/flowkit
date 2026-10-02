const $ = id => document.getElementById(id);
let latest = {}, working = false, actionError = '';
const workerLabels = {IDLE:'Ready',RUNNING:'Processing',AWAITING_SAVE:'Saving audio',NEEDS_REVIEW:'Waiting for review'};
const phaseLabels = {IDLE:'Ready',FAILED:'Stopped before Generate',SAVED:'Audio saved',PREPARING:'Preparing page',CLOSING_TABS:'Closing previous Text to Speech tabs',OPENING_TAB:'Opening a new Text to Speech tab',BINDING_TAB:'Binding the new tab',WAITING_NEW_PAGE:'Waiting for the new page',CLEARING_TEXT:'Clearing previous text',REFRESHING_PAGE:'Refreshing page',WAITING_PAGE:'Waiting for the editor',SELECTING_MODEL:'Selecting model',ENTERING_TEXT:'Entering text',WAITING_GENERATE_BUTTON:'Waiting for Generate',READING_CREDITS:'Reading optional credits',GENERATING:'Generating speech',WAITING_DOWNLOAD:'Waiting for completed audio',VERIFYING_DOWNLOAD:'Verifying Download',DOWNLOADING:'Downloading audio',AWAITING_SAVE:'Saving audio',NEEDS_REVIEW:'Review required'};
async function command(message) { const result = await chrome.runtime.sendMessage(message); if (result?.error && result.ok === false) throw new Error(result.error); return result; }
async function refresh() {
  latest = await command({type:'status'});
  $('enabled').checked = latest.enabled;
  $('connection').textContent = latest.connected ? 'Backend connected' : 'Backend disconnected'; $('dot').classList.toggle('on',latest.connected);
  const review = latest.needsReview || latest.state === 'NEEDS_REVIEW';
  const autoPrepareReady = latest.autoPrepareTab && latest.ready && latest.enabled && latest.connected && !review;
  const preparingTab = latest.busy && ['CLOSING_TABS','OPENING_TAB','BINDING_TAB','WAITING_NEW_PAGE'].includes(latest.phase);
  $('page-connection').textContent = review ? 'Worker held for review · No tabs will be replaced'
    : preparingTab ? 'Preparing a fresh Text to Speech tab…'
    : autoPrepareReady ? 'Ready · A new Text to Speech tab will open for the next chunk'
    : latest.pageConnected ? `Page connected · Tab ${latest.tabId}`
    : latest.autoPrepareTab ? 'Automatic tab setup · No manual binding is needed'
    : latest.tabId == null ? 'Page not bound · Choose a tab and click Bind tab' : 'Page not connected · Click Check page to repair';
  $('state').textContent = review ? 'Waiting for review' : latest.phase === 'FAILED' ? 'Paused after an error' : autoPrepareReady ? 'Ready to open a new tab' : workerLabels[latest.state] || latest.state;
  $('phase').textContent = review ? 'Review required' : autoPrepareReady && latest.phase !== 'FAILED' ? 'Waiting for the next chunk' : phaseLabels[latest.phase] || latest.phase; $('request').textContent = [latest.requestId || 'No active chunk',latest.progressMessage].filter(Boolean).join(' · ');
  $('notice').textContent = actionError || latest.lastError || '';
  const page = latest.page || {}, credit = page.credits || {};
  $('model').textContent = page.model || 'Unknown'; $('voice').textContent = page.voice || 'Choose a voice on ElevenLabs';
  $('credits').textContent = credit.balanceText || (page.creditsRemaining == null ? '—' : String(page.creditsRemaining));
  $('cost').textContent = page.estimatedCost == null ? 'Not shown by page' : `${page.estimatedCost} credits`;
  $('activity').replaceChildren(...(latest.events || []).map(item => { const li = document.createElement('li'); li.textContent = `${new Date(item.time).toLocaleTimeString()} — ${item.message}`; return li; }));
  const selected = $('tab').value || String(latest.tabId || ''), tabs = await chrome.tabs.query({url:'https://elevenlabs.io/*'});
  $('tab').replaceChildren(new Option('Choose a tab',''),...tabs.filter(tab => new URL(tab.url).pathname.replace(/\/$/,'') === '/app/speech-synthesis/text-to-speech').map(tab => new Option(`${tab.id} · ${tab.title || 'ElevenLabs'}`,String(tab.id))));
  $('tab').value = selected;
  $('bind').disabled = !!latest.busy; $('probe').disabled = !!latest.busy || (!!latest.autoPrepareTab && !Number.isInteger(latest.tabId)); $('open').disabled = !!latest.busy; $('focus').disabled = !latest.tabId;
}
async function action(fn,clearError = true) { if (working) return; working = true; if (clearError) actionError = ''; try { await fn(); await refresh(); } catch (e) { actionError ||= e.message; $('notice').textContent = actionError; } finally { working = false; } }
$('enabled').addEventListener('change',() => action(() => command({type:'setEnabled',enabled:$('enabled').checked})));
$('refresh').addEventListener('click',() => action(async () => {}));
$('reconnect').addEventListener('click',() => action(() => command({type:'reconnect'})));
$('clear').addEventListener('click',() => action(() => command({type:'clearEvents'})));
$('bind').addEventListener('click',() => action(() => { if (!$('tab').value) throw new Error('Choose a Text to Speech tab before clicking Bind tab.'); return command({type:'bindTab',tabId:Number($('tab').value)}); }));
$('probe').addEventListener('click',() => action(() => command({type:'probe'})));
$('open').addEventListener('click',() => action(() => chrome.tabs.create({url:'https://elevenlabs.io/app/speech-synthesis/text-to-speech'})));
$('focus').addEventListener('click',() => action(async () => { const tab = await chrome.tabs.update(latest.tabId,{active:true}); await chrome.windows.update(tab.windowId,{focused:true}); }));
void action(async () => {});
setInterval(() => { if (!working) void action(async () => {},false); },3000);
