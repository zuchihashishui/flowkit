(() => {
 'use strict';
 const $ = id => document.getElementById(id), api = (method, route, body) => (window.workflow?.api||window.studio.api)(method, '/api/elevenlabs/' + route, body);
 let jobs = [], selectedId = '', selectedJob = null, busy = false, refreshPromise = null, refreshAgain = false, previewUrl = '', detailRequest = 0, latestStatus = null, retryId = '', jobsSignature = '', detailSignature = '';
 const message = (text, id = 'el-message', error = false) => { $(id).textContent = text; $(id).classList.toggle('error', error); };
 const reviewRequired = s => !!(s?.reviewRequired || s?.needsReview || s?.settings?.needs_review || s?.state === 'NEEDS_REVIEW');
 const processing = s => !!(s?.processing ?? (s?.active || (s?.busy && !reviewRequired(s))));
 const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
 const chars = text => Array.from(text || '').length;
 const display = value => value == null || value === '' ? '—' : String(value);
 function button(text, action, target = 'el-jobs-message') { const el = node('button', text); el.type = 'button'; el.onclick = () => run(action, el, target); return el; }
 async function run(action, control, target = 'el-message') {
  if (busy || control?.disabled) return;
  busy = true; message('', target); syncControls();
  try { return await action(); } catch (e) { message(e.message || String(e), target, true); }
  finally { busy = false; syncControls(); }
 }
 function bind(id, action, target) { $(id).onclick = () => run(action, $(id), target); }
 const labels = {QUEUED:'Queued',RUNNING:'In progress',COMPLETED:'Completed',NEEDS_REVIEW:'Needs review',FAILED:'Failed',CANCELLED:'Cancelled',PARTIAL:'Partially saved',PAUSED:'Paused'};
 const stateLabel = state => labels[state] || state || 'Unknown';
 const stages = {
  DISPATCHING:['Starting chunk','Preparing a new ElevenLabs tab for this chunk.',0],
  PREPARING:['Preparing page','Preparing the Text to Speech editor.',0],
  CLOSING_TABS:['Closing previous Text to Speech tabs','Closing all ElevenLabs Text to Speech tabs in this Chrome profile. Other tabs stay open.',0],
  OPENING_TAB:['Opening a separate Text to Speech window','Opening one fresh tab for this chunk.',0],
  BINDING_TAB:['Binding the new tab','Connecting the new Text to Speech tab to the worker automatically.',0],
  WAITING_NEW_PAGE:['Waiting for the new page','Waiting for the new Text to Speech editor. ElevenLabs must be signed in.',0],
  CLEARING_TEXT:['Clearing previous text','Preparing the editor for the next chunk.',0],
  REFRESHING_PAGE:['Refreshing ElevenLabs','Reloading the same browser tab.',0],
  WAITING_PAGE:['Waiting for the editor','Waiting for the refreshed page and selected voice, up to 60 seconds.',0],
  SELECTING_MODEL:['Checking model and voice','Confirming the page settings.',0],
  ENTERING_TEXT:['Entering narration','Adding this chunk to the Text to Speech editor.',1],
  WAITING_GENERATE_BUTTON:['Waiting for Generate','Waiting for the enabled Generate speech button, up to 30 seconds.',1],
  READING_CREDITS:['Preparing to generate','Reading any available credits for display only.',1],
  GENERATING:['Generating speech','ElevenLabs is creating this chunk.',2],
  WAITING_DOWNLOAD:['Waiting for audio to finish','Waiting for the new result’s Download button.',2],
  VERIFYING_DOWNLOAD:['Audio ready','Confirming the completed result before downloading.',2],
  DOWNLOADING:['Downloading audio','Chrome is downloading the completed audio file.',3],
  SAVING_AUDIO:['Saving audio to this job','Importing the completed Chrome download into Studio.',4],
  AWAITING_SAVE:['Saving audio to this job','Waiting for Studio to finish saving the downloaded file.',4]
 };
 function syncControls() {
  // The editor stays usable while the queue is paused, disconnected or under review.
  document.querySelectorAll('[data-view="elevenlabs"] button').forEach(el => { el.disabled = busy; });
  $('el-review-confirm').disabled = busy;
  $('el-retry-confirm').disabled = busy;
  $('el-retry-submit').disabled = busy || !$('el-retry-confirm').checked;
  $('el-export-all').disabled = busy || !(selectedJob?.chunks || []).some(c => c.state === 'COMPLETED');
  const s = latestStatus, review = reviewRequired(s), running = processing(s), incompatible = !!s?.compatibilityError;
  $('el-generate').disabled = busy || incompatible;
  $('el-preview').disabled = busy || incompatible;
  $('el-retry-submit').disabled = busy || incompatible || review || running || !$('el-retry-confirm').checked;
  $('el-pause').disabled = busy || incompatible || !s || !!s.settings?.paused;
  $('el-resume').disabled = busy || incompatible || !s || review || !s.settings?.paused;
  $('el-review').disabled = busy || incompatible || !review || !!s?.active || !$('el-review-confirm').checked;
  $('el-probe').disabled = busy || incompatible || running || (!!s?.autoPrepareTab && !Number.isInteger(s.tabId));
  $('el-backend-restart').disabled = busy || !incompatible || !s?.backendDiagnostics?.canRestart || typeof window.studio.backendAction !== 'function';
  $('el-backend-check').disabled = busy;
  document.querySelectorAll('[data-el-retry],[data-el-recover]').forEach(el => { el.disabled = busy || incompatible || review || running; });
  document.querySelectorAll('[data-el-cancel]').forEach(el => { el.disabled = busy || incompatible; });
 }
 function clearBackendErrors(previousError = '') {
  for (const id of ['el-message', 'el-control-message', 'el-jobs-message', 'el-backend-message']) {
   const el = $(id);
   if (el.classList.contains('error') && ((previousError && el.textContent.includes(previousError)) || /Backend update required|older or incompatible backend/i.test(el.textContent))) message('', id);
  }
 }
 function renderBackend(status) {
  const incompatible = !!status.compatibilityError, d = status.backendDiagnostics || {};
  $('el-backend-help').hidden = !incompatible;
  const lines = [
   `Backend API: ${display(d.studioApi)} · Studio version: ${display(d.studioVersion)}`,
   `Process ID: ${display(d.pid)}`,
   `Backend source: ${display(d.root)}`,
   `Python: ${display(d.python)}`,
   `Studio source: ${display(d.localRoot)}`
  ];
  if (d.missingFeatures?.length) lines.push(`Missing capabilities: ${d.missingFeatures.join(', ')}`);
  $('el-backend-details').textContent = lines.join('\n');
  $('el-backend-reason').textContent = typeof window.studio.backendAction !== 'function' ? 'Close Studio and start the updated desktop app to use backend recovery.'
   : d.restartReason || (d.canRestart ? 'Restart the verified local Flowkit backend with this Studio source. No narration will be generated or retried.' : 'This backend cannot be restarted from Studio. Stop the older Flowkit backend, then check again.');
 }
 function renderNextAction() {
  const s = latestStatus || {}, review = reviewRequired(s), failed = jobs.some(j => ['FAILED','NEEDS_REVIEW','PARTIAL','CANCELLED'].includes(j.state));
  $('el-next-action').textContent = s.compatibilityError ? s.backendDiagnostics?.canRestart ? 'Next: Restart local backend above, then check the queue. Your script remains editable.' : 'Next: follow the backend recovery instructions above, then Check backend. Your script remains editable.' : review ? 'Next: check the box above and Release after review. No audio will be generated by releasing.'
   : processing(s) ? 'The active chunk is processing. You can keep editing another script.'
   : failed ? 'Next: open Narration jobs below. Recover downloaded audio if available, or retry remaining chunks. Then Resume queue.'
   : s.settings?.paused ? 'Next: Resume queue to process queued chunks.' : 'You can enter or paste a script at any time.';
  const errorJob = jobs.find(j => j.state === 'NEEDS_REVIEW' && j.error) || jobs.find(j => j.state === 'FAILED' && j.error);
  $('el-activity-error').hidden = !s.compatibilityError && (!errorJob || processing(s));
  $('el-activity-error').textContent = s.compatibilityError || (errorJob ? `${errorJob.title || 'Untitled narration'}: ${errorJob.error}` : '');
 }
 function renderStatus(status) {
  const previousError = latestStatus?.compatibilityError;
  latestStatus = status;
  if (previousError && !status.compatibilityError) clearBackendErrors(previousError);
  renderBackend(status);
  const page = status.page || {}, settings = status.settings || {};
  const review = reviewRequired(status);
  const connected = status.extensionConnected ?? status.connected;
  const autoPrepareReady = !!(connected && status.enabled && status.ready && status.autoPrepareTab);
  $('el-connection').textContent = `Extension ${connected ? 'connected' : 'disconnected'} · Bridge ${status.enabled ? 'on' : 'off'} · Queue ${review ? 'needs review' : settings.paused ? 'paused' : 'running'} · ${review ? 'Worker locked for review' : processing(status) ? 'Worker processing' : autoPrepareReady ? 'Ready to open a new tab' : status.ready ? 'Page ready' : 'Page not ready — use Bind tab / Check connection'}`;
  const voice = page.voice?.name || page.voice || page.voice_name;
  $('el-voice').value = typeof voice === 'string' && voice ? voice : 'Choose a voice on the ElevenLabs website';
  const credit = page.credits || {};
  const remaining = [page.credit_balance_text,page.credits_text,credit.balanceText,credit.balance_text,credit.balance,credit.remaining,page.creditsRemaining,page.remaining_credits,typeof credit === 'number' ? credit : null].find(v => v != null && v !== '');
  const cost = page.estimatedCost ?? page.estimated_cost ?? page.cost ?? credit.cost;
  $('el-credits').textContent = `Available credits: ${display(remaining)} · ${cost == null ? 'Cost not shown by page' : 'Current chunk cost: ' + display(cost)}`;
  const p = status.progress || {};
  const working = processing(status);
  const phase = status.state === 'AWAITING_SAVE' ? 'AWAITING_SAVE' : p.phase;
  const stage = status.compatibilityError ? ['Backend update required','Use backend recovery below before generating.',-1] : review ? ['Review required','Inspect the ElevenLabs tab and downloaded audio before continuing.',-1]
    : !connected ? ['Extension disconnected','Open the ElevenLabs extension and reconnect to Studio.',-1]
    : working ? stages[phase] || ['Processing chunk','Waiting for the next progress update.',-1]
    : settings.paused ? ['Queue paused','Resume when you are ready to process queued chunks.',-1]
    : autoPrepareReady ? ['Ready to open a new tab','Each chunk closes previous Text to Speech tabs, opens and binds a new tab, then clears and refreshes it before entering text. No manual binding is needed.',-1]
    : status.ready ? ['Ready for the next chunk','Completed chunks are saved. Queued work will start automatically.',-1]
    : ['Connect your ElevenLabs tab','Use Bind tab in the extension, then Check connection.',-1];
  $('el-stage-title').textContent = stage[0];
  $('el-progress').textContent = [stage[1],working && !review ? p.message : '',status.active ? `Chunk ${status.active.chunk_index} in progress` : '',page.error].filter(Boolean).join('\n');
  [...$('el-steps').children].forEach((el,i) => {
   el.className = stage[2] < 0 ? '' : i === stage[2] ? 'current' : i < stage[2] ? 'done' : '';
   if (i === stage[2]) el.setAttribute('aria-current','step'); else el.removeAttribute('aria-current');
  });
  $('el-review-help').hidden = !review;
  if (!review) $('el-review-confirm').checked = false;
  renderNextAction();
  $('el-technical').textContent = [page.bridgeVersion ? `Page bridge: ${page.bridgeVersion}` : '',status.state ? `Worker: ${status.state}` : '',...Object.entries(p).filter(([,v]) => ['string','number','boolean'].includes(typeof v)).map(([k,v]) => `${k}: ${v}`)].filter(Boolean).join('\n') || 'No activity details.';
  syncControls();
 }
 async function backendAction(action) {
  message(action === 'restart' ? 'Restarting the local backend… Your script and saved audio are retained.' : 'Checking the backend…', 'el-backend-message');
  if (typeof window.studio.backendAction === 'function') {
   const result = await window.studio.backendAction(action);
   const d = result?.backendDiagnostics || (typeof result?.compatible === 'boolean' ? result : null);
   if (d) renderStatus({...latestStatus, ...(result.status || {}), backendDiagnostics:d, compatibilityError:d.compatible ? '' : d.message || latestStatus?.compatibilityError || 'Backend update required.'});
  } else if (action === 'restart') throw Error('Restart Studio with the updated desktop app to use backend recovery.');
  await refresh();
  if (latestStatus?.compatibilityError) {
   message(latestStatus.backendDiagnostics?.restartReason || latestStatus.compatibilityError, 'el-backend-message', true);
  } else {
   message('', 'el-backend-message');
   message(action === 'restart' ? 'Local backend restarted and ready. Check the queue state below; no chunks were retried.' : 'Backend is compatible and ready.', 'el-control-message');
  }
 }
 async function retryJob(id, reviewed) {
  const result = await api('POST', `jobs/${id}/retry`, {reviewed});
  selectedId = result.id || result.job?.id || id;
  retryId = ''; $('el-retry-confirmation').hidden = true; $('el-retry-confirm').checked = false;
  message(`${result.queued ?? 'Remaining'} chunk(s) queued. Saved audio is retained. Resume the queue when ready.`, 'el-jobs-message');
  await refresh();
 }
 function requestRetry(j) {
  if (j.retry_requires_review === false) return retryJob(j.id, false);
  retryId = j.id; $('el-retry-title').textContent = `Retry: ${j.title || 'Untitled narration'}`;
  $('el-retry-confirm').checked = false; $('el-retry-confirmation').hidden = false;
  $('el-retry-confirmation').scrollIntoView?.({block:'nearest'});
 }
 async function recoverJob(j) {
  message('Importing downloaded audio. No speech will be generated.', 'el-jobs-message');
  const result = await api('POST', `jobs/${j.id}/recover`, {reviewed:true});
  selectedId = j.id;
  message([`${result.recovered || 0} downloaded chunk(s) recovered. No new audio was generated.`, ...(result.errors || []).map(e => `Chunk ${e.chunk_index}: ${e.error}`)].join('\n'), 'el-jobs-message', !!result.errors?.length);
  await refresh();
 }
 function renderJobs() {
  const counts = {}; jobs.forEach(j => { counts[j.state] = (counts[j.state] || 0) + 1; });
  $('el-job-summary').textContent = Object.entries(counts).map(([key, count]) => `${stateLabel(key)}: ${count}`).join(' · ') || 'No narration jobs yet.';
  renderNextAction();
  const signature = JSON.stringify(jobs);
  if (signature === jobsSignature) { syncControls(); return; }
  jobsSignature = signature;
  $('el-job-rows').replaceChildren(...jobs.map(j => {
   const row = node('tr'), cell = text => { const td = node('td', text); row.append(td); return td; };
   const title = cell(j.title || 'Untitled narration'); title.append(node('small', j.created ? new Date(j.created * 1000).toLocaleString() : j.id));
   cell(String(j.characters ?? '—')); cell(`${j.completed_chunks || 0} / ${j.total_chunks || 0}`); cell(stateLabel(j.state));
   const actions = cell(); actions.append(button('Details', () => loadDetail(j.id)));
   if (['QUEUED', 'RUNNING', 'PAUSED'].includes(j.state)) {
    const cancel = button('Cancel pending', async () => {
    const result = await api('POST', `jobs/${j.id}/cancel`, {});
    message(`${result.cancelled || 0} pending chunk(s) cancelled.${result.active_continues ? ' The active chunk will finish and save.' : ''}`, 'el-jobs-message'); await refresh();
    });
    cancel.dataset.elCancel = j.id; actions.append(cancel);
   }
   if (j.recoverable_downloads > 0) {
    const recover = button('Recover downloaded audio', () => recoverJob(j)); recover.dataset.elRecover = j.id; actions.append(recover);
   }
   if (['NEEDS_REVIEW', 'FAILED', 'CANCELLED', 'PARTIAL'].includes(j.state)) {
    const retry = button('Retry remaining', () => requestRetry(j)); retry.dataset.elRetry = j.id; actions.append(retry);
   }
   return row;
  }));
  if (retryId && !jobs.some(j => j.id === retryId && ['NEEDS_REVIEW','FAILED','CANCELLED','PARTIAL'].includes(j.state))) {
   retryId = ''; $('el-retry-confirmation').hidden = true; $('el-retry-confirm').checked = false;
  }
  syncControls();
 }
 async function loadDetail(id) {
  const request = ++detailRequest; selectedId = id;
  const detail = await api('GET', 'jobs/' + id);
  if (request !== detailRequest || selectedId !== id) return;
  selectedJob = detail.job || detail;
  const signature = JSON.stringify(selectedJob);
  if (signature === detailSignature) return;
  detailSignature = signature;
  const j = selectedJob; $('el-job-detail').hidden = false;
  $('el-detail-title').textContent = j.title || 'Untitled narration';
  $('el-detail-state').textContent = `${stateLabel(j.state)} · ${j.completed_chunks || 0}/${j.total_chunks ?? j.chunks?.length ?? 0} chunks saved · ${j.model || 'Eleven v4'} · ${j.id}`;
  const total = j.total_chunks ?? j.chunks?.length ?? 0, saved = j.completed_chunks || 0;
  $('el-saved-progress').max = Math.max(1,total); $('el-saved-progress').value = saved;
  $('el-saved-count').textContent = `${saved} of ${total} chunks saved${j.merged_url ? ' · Joined audio available' : j.merge_error ? ' · Audio joining needs attention' : saved && saved === total ? ' · Joined audio not yet available' : ''}`;
  $('el-detail-error').textContent = [j.error, j.merge_error].filter(Boolean).join('\n');
  $('el-preview-merged').hidden = $('el-save-merged').hidden = $('el-whisperx').hidden = !j.merged_url;
  $('el-export-all').disabled = !(j.chunks || []).some(c => c.state === 'COMPLETED');
  $('el-chunk-rows').replaceChildren(...(j.chunks || []).map((chunk, ordinal) => {
   const row = node('tr'), cell = text => { const td = node('td', text); row.append(td); return td; };
   cell(String(ordinal + 1)); cell(String(chunk.characters ?? chars(chunk.text)));
   const details = node('details'), summary = node('summary', (chunk.text || '').slice(0, 100) || 'Show text');
   details.append(summary, node('pre', chunk.text || '')); cell().append(details);
   cell(stateLabel(chunk.state)).append(node('small', chunk.error || ''));
   const actions = cell();
   if (chunk.metadata?.nativeDownload?.path) actions.append(node('small', `Chrome download: ${chunk.metadata.nativeDownload.path}`));
   if (chunk.recoverable_download) actions.append(node('small', 'Downloaded audio can be recovered from Narration jobs above.'));
   if (chunk.state === 'COMPLETED' && chunk.audio_url) actions.append(button('Play', () => play(j.id, chunk.index, `Chunk ${ordinal + 1}`), 'el-audio-message'), button('Save audio', () => save(j.id, chunk.index), 'el-audio-message'));
   return row;
  }));
 }
 async function refresh() {
  if (refreshPromise) { refreshAgain = true; return refreshPromise; }
  refreshPromise = (async () => {
   do {
    refreshAgain = false;
    const [status, result] = await Promise.all([api('GET', 'status'), api('GET', 'jobs')]);
    jobs = result.jobs || []; renderStatus(status); renderJobs();
    if (selectedId) await loadDetail(selectedId);
   } while (refreshAgain);
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
 }
 function chunkSize() {
  const value = Number($('el-chunk-size').value);
  if (!Number.isInteger(value) || value < 100 || value > 3000) throw Error('Enter a whole number from 100 to 3,000 for Max characters per chunk.');
  return value;
 }
 async function preview(text = $('el-text').value, max_chunk_characters = chunkSize()) {
  if (!text.trim()) throw Error('Enter narration text first.');
  const result = await api('POST', 'preview', {text, max_chunk_characters});
  if ($('el-text').value === text && Number($('el-chunk-size').value) === max_chunk_characters) {
   const chunks = result.chunks || [];
   $('el-preview-summary').textContent = `${result.characters ?? chars(text)} characters · ${chunks.length} chunks · Text order is preserved`;
   $('el-chunk-preview').replaceChildren(...chunks.map((chunk, index) => {
    const details = node('details'); details.append(node('summary', `Chunk ${index + 1} · ${chunk.characters ?? chars(chunk.text)} characters`), node('pre', chunk.text || '')); return details;
   }));
  }
  return result;
 }
 async function play(id, index, label) {
  const result = await window.studio.elevenlabsAudio(id, index, 'preview');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(new Blob([result.bytes], {type: result.mime}));
  $('el-audio').src = previewUrl; $('el-audio').hidden = false; $('el-audio-label').textContent = label;
  // The player is exposed immediately; playback stays under the user's control.
 }
 async function save(id, index) {
  const result = await window.studio.elevenlabsAudio(id, index, 'save');
  message(result.canceled ? 'Save cancelled.' : 'Audio saved to ' + result.path, 'el-audio-message');
 }
 $('el-text').addEventListener('input', () => {
  $('el-character-count').textContent = `${chars($('el-text').value).toLocaleString()} characters`;
  $('el-preview-summary').textContent = 'Text changed. Preview chunks to update the split.';
  $('el-chunk-preview').replaceChildren();
 });
 $('el-chunk-size').addEventListener('input', () => {
  $('el-preview-summary').textContent = 'Chunk size changed. Preview chunks to update the split.';
  $('el-chunk-preview').replaceChildren();
 });
 $('el-form').onsubmit = event => { event.preventDefault(); return run(async () => {
  const ctx = window.workflow?.requireContext();
  const text = $('el-text').value, title = $('el-title').value.trim();
  const max_chunk_characters = chunkSize();
  await preview(text, max_chunk_characters);
  window.workflow?.assertCurrent(ctx);
  const result = await api('POST', 'jobs', {text, title, model: 'Eleven v4', max_chunk_characters});
  selectedId = result.id || result.job?.id || ''; message('Narration queued. Audio will be downloaded after each completed chunk.'); await refresh();
  if (reviewRequired(latestStatus) || latestStatus?.settings?.paused) message('Narration queued and waiting. Follow the next step in ElevenLabs connection to release or resume the queue.');
 }, $('el-generate')); };
 bind('el-preview', preview);
 bind('el-open', () => window.workflow?.context().project_id&&window.studio.openProjectPage?window.studio.openProjectPage(window.workflow.context().project_id,'elevenlabs_url'):window.studio.elevenlabsAction('open'));
 bind('el-extension', () => window.studio.elevenlabsAction('extension'));
 bind('el-probe', async () => { message('Checking the selected ElevenLabs tab without generating speech…', 'el-control-message'); const result = await api('POST', 'probe', {}); await refresh(); message(result.error || 'Connection check complete.', 'el-control-message', !!result.error); }, 'el-control-message');
 bind('el-refresh', refresh, 'el-jobs-message');
 bind('el-backend-restart', () => backendAction('restart'), 'el-backend-message');
 bind('el-backend-check', () => backendAction('status'), 'el-backend-message');
 for (const action of ['pause', 'resume']) bind('el-' + action, async () => {
  await api('POST', 'control', {action}); await refresh();
  message(action === 'pause' ? 'Queue paused. An active chunk will finish and save.' : 'Queue resumed. Queued chunks will run when the page is ready.', 'el-control-message');
 }, 'el-control-message');
 $('el-review-confirm').addEventListener('change', syncControls);
 $('el-retry-confirm').addEventListener('change', syncControls);
 bind('el-review', async () => {
  if (!$('el-review-confirm').checked) return;
  message('Releasing the worker… No audio will be generated.', 'el-control-message');
  await api('POST', 'control', {action:'review', reviewed:true}); await refresh();
  message('Worker released. The queue stays paused. Recover downloaded audio or retry missing chunks in Narration jobs, then Resume queue.', 'el-control-message');
 }, 'el-control-message');
 bind('el-retry-submit', () => retryId && $('el-retry-confirm').checked && retryJob(retryId, true), 'el-jobs-message');
 bind('el-retry-cancel', () => { retryId = ''; $('el-retry-confirmation').hidden = true; $('el-retry-confirm').checked = false; }, 'el-jobs-message');
 bind('el-export-all', async () => { if (!selectedId) return; const result = await window.studio.elevenlabsExport(selectedId); message(result.canceled ? 'Export cancelled.' : `Exported ${result.count} audio file(s) to ${result.path}`, 'el-audio-message'); }, 'el-audio-message');
 bind('el-whisperx', () => selectedJob && window.openWhisperX?.(selectedJob.id), 'el-audio-message');
 bind('el-preview-merged', () => selectedJob && play(selectedJob.id, 'merged', 'Joined narration'), 'el-audio-message');
 bind('el-save-merged', () => selectedJob && save(selectedJob.id, 'merged'), 'el-audio-message');
 document.querySelector('[data-page="elevenlabs"]').addEventListener('click', () => refresh().catch(e => message(e.message, 'el-control-message', true)));
 setInterval(() => { if (!busy && !refreshPromise && !document.querySelector('[data-view="elevenlabs"]').hidden) refresh().catch(e => message(e.message, 'el-control-message', true)); }, 3000);
 syncControls();
 window.addEventListener('beforeunload', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
 document.addEventListener('workflow-changed',async()=>{selectedId='';jobs=[];$('el-job-detail').hidden=true;$('el-audio').pause();$('el-audio').removeAttribute('src');$('el-audio').hidden=true;renderJobs();await Promise.allSettled([refresh()]);try{await refresh();}catch(e){message(e.message);}});
})();
