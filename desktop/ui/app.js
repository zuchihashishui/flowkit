'use strict';
const $ = id => document.getElementById(id);
const api = (method, path, body) => window.studio.api(method, path, body);
const ACTIVE = ['RUNNING', 'SUBMITTING', 'DOWNLOADING'];
let projects = [], scenes = [], jobs = [], paused = false, refreshing = false;
let loadedProject = '', loadedCollection = '', sceneRequest = 0, projectRequest = 0;
let editingScene = null, editorDirty = false, sceneSaving = false, detailId = null, bulkExporting = false;
const selectedScenes = new Set();
const exported = new Set(), exportFailed = new Set(), exporting = new Set(), previewUrls = new Map();
function syncProjectContext() {
  const p=projects.find(p=>p.id===loadedProject);
  $('active-project-name').textContent=p?.name||'No project selected';
  $('active-project-name').title=p?.id||'';
  document.querySelectorAll('#project-list [data-project-id]').forEach(row=>{
    row.dataset.active=String(row.dataset.projectId===loadedProject);
    row.querySelector('button').textContent=row.dataset.projectId===loadedProject?'Selected':'Select project';
  });
  const page=document.querySelector('[data-page].active')?.dataset.page;
  const shared=['chatgpt','settings'].includes(page);
  $('project-scope-note').hidden=!shared;
  $('project-scope-note').textContent='Active project is shared across Studio. This tool currently uses a shared library/history; its existing records are not filtered by project.';
}
function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}
function show(page) {
  if (page === 'storyboard') action(() => window.storyboard?.open());
  document.querySelectorAll('[data-view]').forEach(e => e.hidden = e.dataset.view !== page);
  document.querySelectorAll('[data-page]').forEach(e => e.classList.toggle('active', e.dataset.page === page));
  $('heading').textContent = document.querySelector(`[data-page="${page}"]`).textContent;
  syncProjectContext();
}
async function action(fn, control) {
  if (control) control.disabled = true;
  try { return await fn(); } catch (e) { 
    console.error('[Action Error]', e);
    notice(e.message, true); 
  }
  finally { if (control) control.disabled = false; }
}
function option(value, text) { const e = document.createElement('option'); e.value = value; e.textContent = text; return e; }
function element(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function button(text, fn) {
  const e = element('button', text); e.type = 'button';
  e.onclick = () => action(fn, e); return e;
}
function projectId() {
  const id = $('project-select').value;
  if (!id) throw Error('Select a project first.');
  return id;
}
function sceneLabel(s) { return 'Scene ' + String(s.display_order + 1).padStart(3, '0'); }
function chosenScenes() {
  if (loadedProject !== $('project-select').value || loadedCollection !== $('video-select').value) throw Error('Wait for the selected project to load.');
  if (editorDirty) throw Error('Save or discard your scene edits before submitting.');
  const selected = scenes.filter(s => selectedScenes.has(s.id));
  if (!selected.length || selected.length > 100) throw Error('Select 1–100 scenes in Project.');
  return selected;
}
function updateInputSummary() {
  const count = scenes.filter(s => selectedScenes.has(s.id)).length;
  $('scene-selection').textContent = `${count} of ${scenes.length} scenes selected`;
  for (const kind of ['video', 'image', 'voice']) {
    const storyboardMode = $(kind + '-mode').value === 'storyboard';
    const batch = $(kind + '-mode').value !== 'single';
    if (kind !== 'voice') $(kind + '-storyboard').hidden = !storyboardMode;
    $(kind + '-prompt').disabled = batch;
    const summary = kind === 'voice' ? $('voice-input-summary') : $(kind + '-form').querySelector('[data-input-summary]');
    summary.textContent = storyboardMode ? `${window.storyboard?.count() || 0} script segments selected. Uses saved concepts from the database.` : batch ? `${count} selected scene(s). Change the selection in Project.${kind === 'voice' ? ' Each scene needs narration text.' : ''}` : 'Enter a single ' + (kind === 'voice' ? 'narration.' : 'prompt.');
  }
}
function discardSceneEdit() {
  if (sceneSaving) { notice('Wait for the scene to finish saving.', true); return false; }
  if (editorDirty && !confirm('Discard unsaved scene changes?')) return false;
  $('scene-editor').hidden = true; editingScene = null; editorDirty = false; return true;
}
async function refreshProjects() {
  projects = await api('GET', '/api/projects');
  let previous = $('project-select').value;
  if(!previous&&!loadedProject)try{previous=localStorage.getItem('active-project-id')||'';}catch{}
  $('project-select').replaceChildren(option('', 'Select a project'), ...projects.map(p => option(p.id, p.name)));
  if (projects.some(p => p.id === previous)) $('project-select').value = previous;
  $('project-list').replaceChildren();
  for (const p of projects) {
    const row = element('div', undefined, 'item');
    row.dataset.projectId=p.id;
    row.append(element('strong', p.name), element('small', p.id), button('Select project', async () => {
      $('project-select').value = p.id; await selectProject();
    }));
    $('project-list').append(row);
  }
  if (!projects.length) $('project-list').textContent = 'No projects yet. Connect Flow, then create your first project.';
  syncProjectFilter();
  syncProjectContext();
}
async function selectProject(reload=false) {
  if(!reload&&$('project-select').value===loadedProject){syncProjectContext();return;}
  if(sceneSaving){$('project-select').value=loadedProject;notice('Wait for the scene to finish saving.',true);return;}
  if(editorDirty&&!confirm('Discard unsaved scene changes?')){$('project-select').value=loadedProject;return;}
  if (window.storyboard && !window.storyboard.canChangeProject()) { $('project-select').value = loadedProject; return; }
  editorDirty=false;
  discardSceneEdit();
  window.storyboard?.projectChanged();
  const id = $('project-select').value, request = ++projectRequest;
  ++sceneRequest; loadedProject = id; loadedCollection = ''; scenes = []; selectedScenes.clear(); renderScenes();
  try{localStorage.setItem('active-project-id',id);}catch{}
  detailId=null;
  for(const kind of ['image','video','voice']){
    $(kind+'-preview').replaceChildren();
    if(previewUrls.has(kind)){URL.revokeObjectURL(previewUrls.get(kind));previewUrls.delete(kind);}
  }
  syncProjectFilter();syncProjectContext();renderJobs();
  document.dispatchEvent(new CustomEvent('project-changed',{detail:{id,name:projects.find(p=>p.id===id)?.name||''}}));
  $('video-select').replaceChildren(option('', 'Select a video'));
  window.workflow?.set({project_id:id,video_id:''});
  $('edit-name').value = projects.find(p => p.id === id)?.name || '';
  if (!id) return;
  const workspace = await api('POST', '/api/workflow/project', {project_id:id});
  if (request !== projectRequest) return;
  $('video-select').append(option(workspace.video_id, workspace.title));
  $('video-select').value=workspace.video_id;await loadScenes();
  notice('Project selected.');
}
async function loadScenes() {
  const id = $('video-select').value, request = ++sceneRequest;
  if(id!==loadedCollection&&window.storyboard?.canChangeVideo&&!window.storyboard.canChangeVideo(id)){$('video-select').value=loadedCollection;return;}
  window.workflow?.set({project_id:loadedProject,video_id:id});
  try{localStorage.setItem('active-video:'+loadedProject,id);}catch{}
  const previousIds = loadedCollection === id ? new Set(scenes.map(s => s.id)) : new Set();
  if (loadedCollection !== id) selectedScenes.clear();
  const result = id ? await api('GET', '/api/scenes?video_id=' + encodeURIComponent(id)) : [];
  if (request !== sceneRequest) return;
  scenes = result; loadedCollection = id;
  const ids = new Set(scenes.map(s => s.id));
  for (const sid of selectedScenes) if (!ids.has(sid)) selectedScenes.delete(sid);
  for (const s of scenes) if (!previousIds.has(s.id)) selectedScenes.add(s.id);
  renderScenes();
}
function editScene(scene) {
  if (!$('video-select').value) throw Error('Select a project and wait for it to load.');
  if (!discardSceneEdit()) return;
  editingScene = scene?.id || null;
  $('scene-editor-title').textContent = scene ? 'Edit ' + sceneLabel(scene) : 'Add scene';
  $('scene-prompt').value = scene?.prompt || '';
  $('scene-image-prompt').value = scene?.image_prompt || '';
  $('scene-video-prompt').value = scene?.video_prompt || '';
  $('scene-narration').value = scene?.narrator_text || '';
  $('scene-editor').hidden = false; $('scene-prompt').focus();
}
function renderScenes() {
  $('scenes').replaceChildren();
  for (const s of scenes) {
    const row = element('div', undefined, 'item'), top = element('div', undefined, 'item-top');
    const label = element('label', undefined, 'scene-select'), check = element('input');
    check.type = 'checkbox'; check.checked = selectedScenes.has(s.id); check.dataset.sceneId = s.id;
    check.onchange = () => { check.checked ? selectedScenes.add(s.id) : selectedScenes.delete(s.id); updateInputSummary(); };
    label.append(check, element('strong', sceneLabel(s)));
    top.append(label, button('Edit scene', () => editScene(s)));
    const text = element('div', undefined, 'scene-meta');
    text.append(element('p', s.video_prompt || s.prompt || '(No prompt)'), element('small', s.narrator_text ? 'Narration: ' + s.narrator_text.slice(0, 160) : 'No narration text'));
    row.append(top, text); $('scenes').append(row);
  }
  if (!scenes.length) $('scenes').textContent = 'Select a project, then add a scene or import scene prompts.';
  updateInputSummary();
}
async function refreshVoices() {
  const voices = await api('GET', '/api/tts/templates'), previous = $('voice-template').value;
  $('voice-template').replaceChildren(option('', 'Select a voice'), ...voices.map(v => option(v.name, v.name)));
  if (voices.some(v => v.name === previous)) $('voice-template').value = previous;
  $('voice-list').replaceChildren(...voices.map(v => element('div', v.name, 'item')));
}
async function exportJob(id) {
  if (exporting.has(id)) return false;
  exporting.add(id);
  try {
    const folder = await window.studio.exportJob(id); exported.add(id); exportFailed.delete(id); notice('Saved to ' + folder); return true;
  } catch (e) { exportFailed.add(id); throw e; } finally { exporting.delete(id); }
}
async function preview(job) {
  const project=loadedProject;
  const result = await window.studio.preview(job.id, 0), kind = result.kind;
  if(project!==loadedProject)return;
  if (previewUrls.has(kind)) URL.revokeObjectURL(previewUrls.get(kind));
  const url = URL.createObjectURL(new Blob([result.bytes], {type: result.mime})); previewUrls.set(kind, url);
  const media = element(kind === 'image' ? 'img' : kind === 'voice' ? 'audio' : 'video'); media.src = url;
  if (kind === 'image') media.alt = job.payload.label; else media.controls = true;
  $(kind + '-preview').replaceChildren(media); show(kind);
}
function syncProjectFilter() {
  $('job-project-context').textContent=loadedProject?'Project: '+(projects.find(p=>p.id===loadedProject)?.name||loadedProject)+' · Change in Project':'All jobs · Select an active project in Project to filter.';
}
function projectJobs(){return loadedProject?jobs.filter(j=>j.payload.project_id===loadedProject):jobs;}
function filteredJobs() {
  const search = $('job-search').value.trim().toLowerCase(), kind = $('job-kind').value, state = $('job-state').value;
  return projectJobs().filter(j => (!kind || j.payload.kind === kind) && (!state || (state === 'ACTIVE' ? ACTIVE.includes(j.state) : j.state === state)) && (!search || [j.id, j.payload.label, j.payload.prompt].some(s => (s || '').toLowerCase().includes(search))));
}
function showJobDetails(job) { detailId = job.id; show('queue'); renderDetails(); }
function renderDetails() {
  const job = jobs.find(j => j.id === detailId);
  $('job-details').hidden = !job;
  if (!job) return;
  const p = job.payload;
  $('job-detail-text').textContent = `${p.label}\nJob ID: ${job.id}\nState: ${job.state}\nCreated: ${new Date(job.created * 1000).toLocaleString()}\nProject: ${projects.find(x => x.id === p.project_id)?.name || p.project_id || 'None'}\nScene ID: ${p.scene_id || 'None'}\nScript segment: ${p.segment_id || 'None'}\nConcept ID: ${p.concept_id || 'None'}\nNarration timing (ms): ${p.start_ms ?? '—'} → ${p.end_ms ?? '—'}\nMedia: ${p.kind}\n${p.kind === 'voice' ? 'Voice: ' + p.template + ' · Speed: ' + p.speed : 'Orientation: ' + p.orientation + (p.kind === 'video' ? ' · Duration: ' + p.duration + ' seconds' : ' · Model: ' + (p.image_model || 'Backend default'))}\n\nFull prompt\n${p.prompt}\n\nError\n${job.error || 'None'}\n\nBackend files\n${job.files.join('\n') || 'No files yet'}`;
}
async function cancelJobs(ids) {
  if (!ids.length) throw Error('No matching queued jobs.');
  if (!confirm(`Cancel ${ids.length} queued job(s)? Active generations are not stopped.`)) return;
  const r = await api('POST', '/api/desktop/jobs/cancel', {ids});
  await refreshJobs(); notice(`${r.cancelled.length} job(s) cancelled. ${r.skipped.length} skipped because they are no longer queued.`);
}
function renderJobs() {
  const lists = {all: $('all-jobs'), image: $('image-jobs'), video: $('video-jobs'), voice: $('voice-jobs')};
  const visible = filteredJobs(), visibleIds = new Set(visible.map(j => j.id));
  Object.values(lists).forEach(e => e.replaceChildren());
  const scoped=projectJobs();
  for (const job of scoped) for (const key of ['all', job.payload.kind]) {
    if ((key === 'all' && !visibleIds.has(job.id)) || (key !== 'all' && lists[key].children.length >= 5)) continue;
    const row = element('div', undefined, 'item'), top = element('div', undefined, 'item-top');
    row.dataset.jobId = job.id;
    top.append(element('strong', job.payload.label), element('span', job.state, 'badge ' + job.state));
    row.append(top, element('small', job.payload.kind.toUpperCase() + ' · ' + new Date(job.created * 1000).toLocaleString()), element('p', job.payload.prompt.slice(0, 140)));
    if (job.error) row.append(element('small', job.error));
    const controls = element('div', undefined, 'actions'); controls.append(button('Details', () => showJobDetails(job)));
    if (job.state === 'COMPLETED') controls.append(button('Preview', () => preview(job)), button(exported.has(job.id) ? 'Exported · export files' : 'Export files', () => exportJob(job.id)));
    if (job.can_resume) controls.append(button('Resume saved result', async () => { await api('POST', `/api/desktop/jobs/${job.id}/resume`, {}); await refreshJobs(); }));
    if (job.state === 'QUEUED') controls.append(button('Cancel', () => cancelJobs([job.id])));
    row.append(controls); lists[key].append(row);
  }
  for (const e of Object.values(lists)) if (!e.children.length) e.textContent = e === lists.all ? 'No jobs match these filters.' : 'No jobs yet.';
  const counts = [['Queued', scoped.filter(j => j.state === 'QUEUED').length], ['In progress', scoped.filter(j => ACTIVE.includes(j.state)).length], ['Completed', scoped.filter(j => j.state === 'COMPLETED').length], ['Need attention', scoped.filter(j => ['FAILED', 'NEEDS_REVIEW'].includes(j.state)).length], ['Cancelled', scoped.filter(j => j.state === 'CANCELLED').length]];
  $('queue-stats').replaceChildren(...counts.map(([name, count]) => { const e = element('div', undefined, 'stat'); e.append(element('strong', String(count)), element('small', name)); return e; }));
  $('queue-summary').textContent = `${scoped.length} jobs · Queue ${paused ? 'paused' : 'running'}`;
  $('filter-summary').textContent = `${visible.length} matching job(s)`;
  $('pause').textContent = paused ? 'Resume queue' : 'Pause queue';
  $('cancel-filtered').disabled = !visible.some(j => j.state === 'QUEUED');
  $('export-filtered').disabled = bulkExporting || !visible.some(j => j.state === 'COMPLETED');
  renderDetails();
}
async function refreshJobs() {
  const data = await api('GET', '/api/desktop/jobs'); jobs = data.jobs; paused = data.paused; syncProjectFilter(); renderJobs();
  if ($('auto-export').checked && !bulkExporting) {
    const job = jobs.find(j => j.state === 'COMPLETED' && !exported.has(j.id) && !exportFailed.has(j.id) && !exporting.has(j.id));
    if (job) await action(() => exportJob(job.id));
  }
}
async function submitMedia(kind) {
  if ($(kind + '-mode').value === 'storyboard') return window.storyboard.generateMedia(kind);
  const pid = projectId(), batch = $(kind + '-mode').value === 'scenes';
  const inputs = batch ? chosenScenes() : [{prompt: $(kind + '-prompt').value, video_prompt: $(kind + '-prompt').value}];
  const payload = inputs.map(s => ({kind, project_id: pid, scene_id: s.id || '', label: batch ? sceneLabel(s) : kind === 'video' ? 'Prompt to Video' : 'Prompt to Image', prompt: kind === 'video' ? (s.video_prompt || s.prompt || '') : (s.image_prompt || s.prompt || ''), orientation: $(kind + '-ratio').value, duration: Number($('duration').value), image_model: kind === 'image' ? $('image-model').value || null : null}));
  if (payload.some(j => !j.prompt.trim() || j.prompt.length > 5000)) throw Error('Every prompt must contain 1–5000 characters.');
  if (!confirm(`Submit ${payload.length} ${kind} job(s)? This uses Google Flow credits.`)) return;
  await api('POST', '/api/desktop/jobs', {jobs: payload}); await refreshJobs(); notice(`${payload.length} job(s) queued.`);
}
function onForm(id, fn) { $(id).onsubmit = e => { e.preventDefault(); action(fn, e.submitter); }; }
document.querySelectorAll('[data-page]').forEach(b => b.onclick = () => show(b.dataset.page));
document.addEventListener('storyboard-selection', updateInputSummary);
for (const kind of ['video', 'image', 'voice']) $(kind + '-mode').onchange = () => { updateInputSummary(); if ($(kind + '-mode').value === 'storyboard') action(() => window.storyboard?.open()); };
onForm('project-form', async () => {
  if (!discardSceneEdit()) return;
  const body = {name: $('project-name').value, description: $('project-description').value, material: $('material').value};
  if ($('flow-id').value.trim()) body.flow_project_id = $('flow-id').value.trim();
  const p = await api('POST', '/api/projects', body); await refreshProjects(); $('project-select').value = p.id; await selectProject(); notice('Project created.');
});
onForm('edit-project', async () => { await api('PATCH', '/api/projects/' + projectId(), {name: $('edit-name').value}); await refreshProjects(); notice('Project updated.'); });
onForm('scene-editor', async () => {
  if (sceneSaving) return;
  const collection = loadedCollection;
  if (!collection || collection !== $('video-select').value) throw Error('Select a project and wait for its scenes to load.');
  const body = {prompt: $('scene-prompt').value.trim(), image_prompt: $('scene-image-prompt').value.trim() || null, video_prompt: $('scene-video-prompt').value.trim() || null, narrator_text: $('scene-narration').value.trim() || null};
  if (!body.prompt) throw Error('Enter a scene prompt.');
  sceneSaving = true;
  const fields = Array.from($('scene-editor').querySelectorAll('textarea'));
  fields.forEach(field => field.disabled = true);
  try {
    if (editingScene) await api('PATCH', '/api/scenes/' + editingScene, body);
    else await api('POST', '/api/scenes', {...body, video_id: collection, display_order: scenes.length ? Math.max(...scenes.map(s => s.display_order)) + 1 : 0});
  } finally {
    sceneSaving = false;
    fields.forEach(field => field.disabled = false);
  }
  editorDirty = false; discardSceneEdit(); await loadScenes(); notice('Scene saved. Existing queued jobs are unchanged.');
});
$('scene-editor').oninput = () => { editorDirty = true; };
$('cancel-scene-edit').onclick = discardSceneEdit;
$('add-scene').onclick = () => action(() => editScene(null));
$('select-scenes').onclick = () => { scenes.forEach(s => selectedScenes.add(s.id)); renderScenes(); };
$('clear-scenes').onclick = () => { selectedScenes.clear(); renderScenes(); };
onForm('video-form', () => submitMedia('video')); onForm('image-form', () => submitMedia('image'));
onForm('voice-import', async () => {
  const v = await window.studio.importVoice($('voice-name').value, $('voice-transcript').value, $('voice-consent').checked);
  if (v) { await refreshVoices(); $('voice-template').value = v.name; notice('Reference voice imported.'); }
});
onForm('voice-form', async () => {
  const template = $('voice-template').value, batch = $('voice-mode').value === 'scenes';
  if (!template) throw Error('Select a reference voice.');
  const inputs = batch ? chosenScenes() : [{narrator_text: $('voice-prompt').value}];
  const payload = inputs.map(s => ({kind: 'voice', project_id: $('project-select').value, scene_id: s.id || '', label: batch ? sceneLabel(s) + ' · Narration' : 'Narration · ' + template, prompt: s.narrator_text || '', template, speed: Number($('voice-speed').value)}));
  if (payload.some(j => !j.prompt.trim() || j.prompt.length > 5000)) throw Error('Every selected scene needs narration text of 1–5000 characters. Edit it in Project.');
  if (batch && !confirm(`Generate narration for ${payload.length} selected scene(s)?`)) return;
  await api('POST', '/api/desktop/jobs', {jobs: payload}); await refreshJobs(); notice(`${payload.length} narration job(s) queued.`);
});
$('project-select').onchange = () => action(selectProject);
$('video-select').onchange = () => action(async () => { if (!discardSceneEdit()) { $('video-select').value = loadedCollection; return; } await loadScenes(); });
$('refresh-projects').onclick = () => action(refreshProjects);
$('refresh-jobs').onclick = () => action(refreshJobs);
$('load-scenes').onclick = () => action(async () => { if (discardSceneEdit()) await loadScenes(); });
$('import-scenes').onclick = () => action(async () => {
  const vid = $('video-select').value;
  if (!vid) throw Error('Select a project and wait for it to load.');
  if (!discardSceneEdit()) return;
  const file = await window.studio.importPrompts(); if (!file) return;
  if (vid !== $('video-select').value) throw Error('The collection changed. Choose the file again.');
  const items = file.name.toLowerCase().endsWith('.json') ? JSON.parse(file.text) : file.text.split(/\r?\n/).filter(s => s.trim()).map(s => ({prompt: s}));
  if (!Array.isArray(items) || !items.length || items.length > 100 || items.some(s => !s || typeof s.prompt !== 'string' || !s.prompt.trim() || ['prompt', 'image_prompt', 'video_prompt', 'narrator_text'].some(k => s[k] != null && (typeof s[k] !== 'string' || s[k].length > 5000)))) throw Error('Expected 1–100 scene objects with a prompt. Each text field is limited to 5000 characters.');
  if (!confirm(`Import ${items.length} scenes?`)) return;
  const base = scenes.length ? Math.max(...scenes.map(s => s.display_order)) + 1 : 0; let count = 0;
  try {
    for (const s of items) { await api('POST', '/api/scenes', {video_id: vid, display_order: base + count, prompt: s.prompt, image_prompt: s.image_prompt || null, video_prompt: s.video_prompt || s.prompt, narrator_text: s.narrator_text || null}); count++; }
  } catch (e) { throw Error(`${count} scenes imported before error: ${e.message}. Refresh before retrying.`); }
  finally { if ($('video-select').value === vid) await loadScenes(); }
  notice(`Imported ${count} scenes.`);
}, $('import-scenes'));
$('pause').onclick = () => action(async () => { await api('POST', '/api/desktop/pause', {paused: !paused}); await refreshJobs(); }, $('pause'));
for (const id of ['job-search', 'job-kind', 'job-state']) $(id).addEventListener(id === 'job-search' ? 'input' : 'change', renderJobs);
$('change-project').onclick=()=>show('projects');
$('close-job-details').onclick = () => { detailId = null; renderDetails(); };
$('cancel-filtered').onclick = () => action(() => cancelJobs(filteredJobs().filter(j => j.state === 'QUEUED').slice(0, 1000).map(j => j.id)), $('cancel-filtered'));
$('export-filtered').onclick = () => action(async () => {
  const items = filteredJobs().filter(j => j.state === 'COMPLETED');
  if (!items.length) throw Error('No matching completed jobs.');
  bulkExporting = true; let success = 0, failed = 0, skipped = 0; renderJobs();
  try {
    for (const job of items) { try { (await exportJob(job.id)) ? success++ : skipped++; } catch { failed++; } }
  } finally { bulkExporting = false; renderJobs(); }
  notice(`Export finished: ${success} saved, ${failed} failed, ${skipped} already exporting.`, failed > 0);
});
$('auto-export').onchange = () => action(async () => {
  const control = $('auto-export'), value = control.checked; control.disabled = true;
  try { await window.studio.updateSettings({autoExport: value}); notice('Auto-export preference saved.'); }
  catch (e) { control.checked = !value; throw e; } finally { control.disabled = false; }
});
$('choose-output').onclick = () => action(async () => { const s = await window.studio.chooseOutput(); $('output-dir').value = s.output; exported.clear(); exportFailed.clear(); });
$('open-output').onclick = () => action(() => window.studio.openOutput());
$('open-flow').onclick = () => action(() => window.studio.openFlow());
$('extension-folder').onclick = () => action(() => window.studio.openExtension());
$('diagnostics').onclick = () => action(async () => {
  $('diagnostic-result').textContent = 'Checking…'; const d = await api('GET', '/api/desktop/diagnostics');
  $('diagnostic-result').textContent = `FFmpeg: ${d.ffmpeg ? 'Ready' : 'Missing'}\nFFprobe: ${d.ffprobe ? 'Ready' : 'Missing'}\nOmniVoice imports: ${d.tts_installed ? 'Ready' : 'Missing or incompatible'}\nTTS Python: ${d.tts_python}\nBackend output: ${d.output_dir}\n\nA successful import check does not download or test the voice model.`;
}, $('diagnostics'));
async function heartbeat() {
  if (refreshing) return; refreshing = true;
  try {
    const h = await api('GET', '/health'); $('health').textContent = 'Backend connected · ' + h.version;
    $('flow').textContent = h.extension_connected ? 'Flow extension connected' : 'Flow extension disconnected'; await refreshJobs();
  } catch { $('health').textContent = 'Backend unavailable'; $('flow').textContent = 'Run setup, then restart the app.'; }
  finally { refreshing = false; }
}
async function initialize() {
  const settings = await window.studio.settings(); $('output-dir').value = settings.output; $('extension-path').textContent = settings.extension;
  $('auto-export').checked = settings.autoExport !== false; updateInputSummary();
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await api('GET', '/health'); await refreshProjects(); if($('project-select').value)await selectProject(); await refreshVoices();
      const mats = await api('GET', '/api/materials'); $('material').replaceChildren(...mats.map(m => option(m.id, m.name)));
      const models = await api('GET', '/api/models');
      $('image-model').replaceChildren(option('', 'Backend default'), ...Object.entries(models.image_models || {}).map(([name, key]) => option(key, name)));
      notice('Ready. Connect the Chrome extension to create images and videos.'); await heartbeat(); return;
    } catch (e) { if (attempt === 14) throw e; await new Promise(r => setTimeout(r, 1000)); }
  }
}
action(initialize); setInterval(heartbeat, 5000);
