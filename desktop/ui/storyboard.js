'use strict';
(() => {
  let data = null, collection = '', owner = '', requestId = 0, busy = false;
  let documentDirty = false, editorDirty = false, edited = null, shownVersion = '', pollBusy = false;
  const checked = new Set();
  const path = suffix => '/api/storyboard/videos/' + collection + (suffix || '');
  function discard() {
    if (busy) { notice('Wait for the current storyboard action to finish.', true); return false; }
    if ((documentDirty || editorDirty) && !confirm('Discard unsaved script or concept edits?')) return false;
    documentDirty = editorDirty = false; edited = null; $('sb-editor').hidden = true; return true;
  }
  async function run(fn, control) {
    if (busy) return;
    busy = true;
    const controls = [...document.querySelectorAll('[data-view="storyboard"] input,[data-view="storyboard"] textarea,[data-view="storyboard"] select,[data-view="storyboard"] button')];
    const disabled = controls.map(e => e.disabled); controls.forEach(e => e.disabled = true);
    try { await action(fn, control); } finally { busy = false; controls.forEach((e,i) => e.disabled = disabled[i]); }
  }
  function assertCollection() {
    if (!collection || owner !== $('project-select').value) throw Error('Choose a script in the active project first.');
  }
  function assertSaved() {
    assertCollection();
    if (documentDirty || editorDirty) throw Error('Save or discard script/concept edits first.');
    if (!data?.document) throw Error('Save the script before importing audio or segments.');
  }
  function selected() {
    assertSaved();
    const result = data.segments.filter(s => checked.has(s.id));
    if (!result.length || result.length > 100) throw Error('Select 1–100 script segments.');
    return result;
  }
  function timestamp(ms) {
    const h = Math.floor(ms/3600000), m = Math.floor(ms/60000)%60, s = Math.floor(ms/1000)%60;
    return [h,m,s].map(x=>String(x).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');
  }
  function segmentStatus(s) {
    if (s.job && ['QUEUED','RUNNING'].includes(s.job.state)) return 'Concept '+s.job.state;
    if (s.ready) return 'Ready · v'+s.active_concept.version;
    if (s.active_concept) return 'Outdated concept';
    return s.job?.state || 'No concept';
  }
  function selectionChanged() { render(); document.dispatchEvent(new Event('storyboard-selection')); }
  function renderRows(target, mode) {
    target.replaceChildren();
    for (const s of data?.segments || []) {
      const tr=element('tr'); const box=element('input'); box.type='checkbox';box.checked=checked.has(s.id);box.dataset.segmentId=s.id;
      box.setAttribute('aria-label','Select segment '+s.ordinal);
      box.onchange=()=>{box.checked?checked.add(s.id):checked.delete(s.id);selectionChanged();};
      const td=element('td');td.append(box);tr.append(td);
      tr.append(element('td',String(s.ordinal).padStart(3,'0')+'\n'+timestamp(s.start_ms)+'\n'+timestamp(s.end_ms)+'\n'+((s.end_ms-s.start_ms)/1000).toFixed(3)+' s'));
      const text=element('td');text.append(element('p',s.text));tr.append(text);
      const concept=element('td');concept.append(element('p',s.active_concept ? (mode==='video'?s.active_concept.video_prompt:s.active_concept.image_prompt) : 'Create a concept first.'));tr.append(concept);
      const status=element('td',segmentStatus(s));
      if(s.job?.error)status.append(element('small',s.job.error));
      for(const j of s.media_jobs||[])status.append(element('small',j.kind+' · '+j.state+(j.concept_id!==s.active_concept_id?' · older concept':'')));
      tr.append(status);
      if(mode==='editor') {
        const actions=element('td'), group=element('div',undefined,'actions');
        group.append(button('Edit / versions',()=>openEditor(s)),button('Play segment',async()=>{
          if(!data.document.audio_path)throw Error('Import narration audio first.');
          const audio=$('sb-audio');audio.currentTime=s.start_ms/1000;audio.dataset.stopMs=String(s.end_ms);await audio.play();
        }));
        actions.append(group);tr.append(actions);
      }
      target.append(tr);
    }
    if(!data?.segments.length){const tr=element('tr'),td=element('td','Import SRT / JSON in Script & Scenes to load timed segments.');td.colSpan=mode==='editor'?6:5;tr.append(td);target.append(tr);}
  }
  function render() {
    $('sb-count').textContent=`${checked.size} of ${data?.segments.length||0} segments selected`;
    $('sb-warnings').textContent=(data?.warnings||[]).join('\n');
    $('sb-status').textContent=data?.document ? `${data.video.title} · ${data.segments.length} segments · ${data.segments.filter(s=>s.ready).length} current concepts` : 'Save your script, then import audio and SRT / JSON segments.';
    renderRows($('sb-rows'),'editor');
    for(const kind of ['image','video']) {
      $(kind+'-storyboard-name').textContent=data ? data.video.title+' · '+checked.size+' selected segments' : 'Choose a script in Script & Scenes.';
      renderRows($(kind+'-storyboard-rows'),kind);
    }
    document.dispatchEvent(new Event('storyboard-selection'));
  }
  function showAudio() {
    const doc=data?.document,audio=$('sb-audio');
    $('sb-audio-name').textContent=doc?.audio_name?doc.audio_name+' · '+((doc.audio_duration_ms||0)/1000).toFixed(3)+' seconds':'No audio imported.';
    audio.hidden=!doc?.audio_path;
    if(doc?.audio_path){
      const url='http://127.0.0.1:8100/api/storyboard/videos/'+collection+'/audio?v='+encodeURIComponent(doc.audio_path);
      if(audio.getAttribute('src')!==url)audio.src=url;
    } else audio.removeAttribute('src');
  }
  async function reload(fields=false) {
    assertCollection();const ticket=++requestId,vid=collection,pid=owner;
    const result=await api('GET',path());
    if(ticket!==requestId||vid!==collection||pid!==$('project-select').value)return;
    const oldIds=new Set(data?.segments.map(s=>s.id)||[]);
    data=result;
    const ids=new Set(data.segments.map(s=>s.id));
    for(const id of checked)if(!ids.has(id))checked.delete(id);
    for(const s of data.segments)if(!oldIds.has(s.id))checked.add(s.id);
    if(fields){$('sb-script').value=data.document?.script_text||'';$('sb-style').value=data.document?.visual_style||'';documentDirty=false;}
    showAudio();render();
  }
  async function open() {
    const pid=$('project-select').value;
    if(!pid){$('sb-status').textContent='Create or select an active project in Projects first.';return;}
    if(owner!==pid){if(!discard())return;data=null;checked.clear();collection='';owner=pid;}
    const videos=await api('GET','/api/videos?project_id='+encodeURIComponent(pid));
    if(pid!==$('project-select').value)return;
    $('sb-collection').replaceChildren(option('','Select a collection'),...videos.map(v=>option(v.id,v.title)));
    const prior=collection;
    collection=videos.some(v=>v.id===collection)?collection:videos.find(v=>v.id===$('video-select').value)?.id||videos[0]?.id||'';
    $('sb-collection').value=collection;
    if(collection)await reload(prior!==collection || !data);else{data=null;render();}
  }
  function openEditor(s) {
    if(editorDirty&&!confirm('Discard unsaved editor changes?'))return;
    edited=s.id;editorDirty=false;$('sb-editor').hidden=false;
    $('sb-editor-title').textContent='Segment '+String(s.ordinal).padStart(3,'0');
    $('sb-start').value=s.start_ms;$('sb-end').value=s.end_ms;$('sb-text').value=s.text;
    $('sb-version').replaceChildren(option('','New concept'),...s.concepts.map(c=>option(c.id,'v'+c.version+' · '+c.provider+(c.id===s.active_concept_id?' · selected':''))));
    $('sb-version').value=s.active_concept_id||'';shownVersion=$('sb-version').value;fillConcept(s.active_concept);
    $('sb-editor').scrollIntoView?.({block:'start',behavior:'smooth'});
  }
  function fillConcept(c) {
    for(const [id,key] of [['sb-concept-title','title'],['sb-description','description'],['sb-image-prompt','image_prompt'],['sb-video-prompt','video_prompt']])$(id).value=c?.[key]||'';
  }
  function editedSegment() {
    assertCollection();const s=data?.segments.find(s=>s.id===edited);if(!s)throw Error('Choose a segment to edit.');return s;
  }
  $('sb-document').oninput=()=>documentDirty=true;
  $('sb-editor').oninput=()=>editorDirty=true;
  $('sb-document').onsubmit=e=>{e.preventDefault();run(async()=>{
    assertCollection();await api('PUT',path(),{script_text:$('sb-script').value,visual_style:$('sb-style').value});documentDirty=false;await reload(true);notice('Script saved. Existing concepts may need updating.');
  });};
  $('sb-import-script').onclick=()=>run(async()=>{const f=await window.studio.importScriptSource('script');if(f){if(f.text.length>200000)throw Error('Script exceeds 200,000 characters.');$('sb-script').value=f.text;documentDirty=true;notice('Script loaded. Save it before creating concepts.');}});
  $('sb-audio-import').onclick=()=>run(async()=>{assertSaved();const r=await window.studio.importScriptAudio(collection);if(r){await reload();notice('Audio copied and linked to this script.');}});
  $('sb-import-segments').onclick=()=>run(async()=>{
    assertSaved();const f=await window.studio.importScriptSource('segments');if(!f)return;
    await api('POST',path('/segments'),{format:f.name.toLowerCase().endsWith('.srt')?'srt':'json',content:f.text});await reload();notice('Segments imported with original timestamps.');
  });
  $('sb-collection').onchange=()=>{const next=$('sb-collection').value;if(!discard()){$('sb-collection').value=collection;return;}collection=next;data=null;checked.clear();if(collection)action(()=>reload(true));else render();};
  $('sb-new').onclick=()=>{if(!discard())return;run(async()=>{
    const pid=projectId(),title=$('sb-title').value.trim();if(!title)throw Error('Enter a script title.');
    const v=await api('POST','/api/videos',{project_id:pid,title});owner=pid;collection=v.id;data=null;checked.clear();
    await api('PUT',path(),{script_text:'',visual_style:''});await open();notice('New script created.');
  });};
  $('sb-refresh').onclick=()=>action(()=>open());
  $('sb-check-provider').onclick=()=>run(async()=>{
    const result=await api('GET','/api/storyboard/providers');$('sb-provider-status').textContent=result.providers.map(p=>p.id+': '+(p.status || (p.installed?'installed (sign-in not verified)':'not on PATH'))).join(' · ');
  });
  $('sb-select-all').onclick=()=>{(data?.segments||[]).forEach(s=>checked.add(s.id));selectionChanged();};
  $('sb-select-none').onclick=()=>{checked.clear();selectionChanged();};
  $('sb-create-concepts').onclick=()=>run(async()=>{
    const items=selected();if(!confirm(`Create concepts for up to ${items.length} segment(s) using ${$('sb-provider').value}? One AI request per segment; provider quotas apply.`))return;
    const result=await api('POST',path('/generate-concepts'),{segment_ids:items.map(s=>s.id),provider:$('sb-provider').value,model:$('sb-model').value.trim()||null,regenerate:$('sb-regenerate').checked});
    await reload();notice(`${result.ids.length} concept job(s) queued; ${result.skipped.length} skipped because current or pending concepts already exist.`);
  });
  $('sb-cancel-concepts').onclick=()=>run(async()=>{assertCollection();if(!confirm('Cancel all queued concept jobs in this script? The active job continues.'))return;const r=await api('POST',path('/cancel-concepts'),{});await reload();notice(`${r.cancelled} queued concept job(s) cancelled.`);});
  $('sb-editor-close').onclick=()=>{if(editorDirty&&!confirm('Discard unsaved editor changes?'))return;editorDirty=false;edited=null;$('sb-editor').hidden=true;};
  $('sb-version').onchange=()=>{if(editorDirty&&!confirm('Discard unsaved concept edits?')){$('sb-version').value=shownVersion;return;}const s=editedSegment();$('sb-start').value=s.start_ms;$('sb-end').value=s.end_ms;$('sb-text').value=s.text;shownVersion=$('sb-version').value;fillConcept(s.concepts.find(c=>c.id===$('sb-version').value));editorDirty=false;};
  $('sb-save-segment').onclick=()=>run(async()=>{
    const s=editedSegment();const r={start_ms:Number($('sb-start').value),end_ms:Number($('sb-end').value),text:$('sb-text').value};
    if(!Number.isInteger(r.start_ms)||!Number.isInteger(r.end_ms)||!r.text.trim())throw Error('Enter integer millisecond timestamps and narration text.');
    await api('PATCH','/api/storyboard/segments/'+s.id,r);await reload();editorDirty=true;notice('Segment updated. Your concept edits remain in the editor; save them as a new version.');
  });
  $('sb-editor').onsubmit=e=>{e.preventDefault();run(async()=>{
    const s=editedSegment();if(s.text!==$('sb-text').value||s.start_ms!==Number($('sb-start').value)||s.end_ms!==Number($('sb-end').value))throw Error('Save segment text and timing first.');
    const body={title:$('sb-concept-title').value,description:$('sb-description').value,image_prompt:$('sb-image-prompt').value,video_prompt:$('sb-video-prompt').value};
    if(Object.values(body).some(v=>!v.trim()))throw Error('Complete all concept fields.');
    await api('POST','/api/storyboard/segments/'+s.id+'/concepts',body);editorDirty=false;await reload();openEditor(data.segments.find(x=>x.id===s.id));notice('New concept version saved and selected.');
  });};
  $('sb-activate').onclick=()=>run(async()=>{const s=editedSegment();if(editorDirty)throw Error('Save or discard edits before switching versions.');const id=$('sb-version').value;if(!id)throw Error('Choose a saved version.');await api('POST','/api/storyboard/concepts/'+id+'/select',{});await reload();openEditor(data.segments.find(x=>x.id===s.id));notice('Concept version selected.');});
  $('sb-audio').ontimeupdate=()=>{const audio=$('sb-audio');if(audio.dataset.stopMs&&audio.currentTime*1000>=Number(audio.dataset.stopMs)){audio.pause();delete audio.dataset.stopMs;}};
  $('sb-audio').onerror=()=>notice('Audio playback is unavailable. Check the backend and audio format.',true);
  for(const kind of ['image','video'])$('sb-to-'+(kind==='image'?'images':'videos')).onclick=()=>{show(kind);$(kind+'-mode').value='storyboard';updateInputSummary();};
  document.querySelectorAll('[data-open-storyboard]').forEach(b=>b.onclick=()=>show('storyboard'));
  window.storyboard={
    open,count:()=>checked.size,
    canChangeProject:()=>owner===$('project-select').value||discard(),
    projectChanged:()=>{if(owner!==$('project-select').value){++requestId;owner='';collection='';data=null;checked.clear();$('sb-script').value='';$('sb-style').value='';$('sb-collection').replaceChildren(option('','Select a collection'));showAudio();render();}},
    generateMedia:async kind=>{
      const items=selected();if(items.some(s=>!s.ready))throw Error('Selected segments need current concepts. Create or update them in Script & Scenes.');
      if(!confirm(`Generate ${kind} for up to ${items.length} selected segment(s)? Uses Google Flow credits.`))return;
      const r=await api('POST',path('/generate-media'),{segment_ids:items.map(s=>s.id),kind,orientation:$(kind+'-ratio').value,duration:Number($('duration').value),image_model:kind==='image'?$('image-model').value||null:null,regenerate:$(kind+'-regenerate').checked});
      await reload();await refreshJobs();notice(`${r.ids.length} media job(s) queued; ${r.skipped.length} existing jobs/results skipped.`);
    }
  };
  setInterval(async()=>{
    if(pollBusy||busy||!collection||owner!==$('project-select').value)return;
    if(!data?.segments.some(s=>['QUEUED','RUNNING'].includes(s.job?.state)||s.media_jobs?.some(j=>['QUEUED','SUBMITTING','RUNNING','DOWNLOADING'].includes(j.state))))return;
    pollBusy=true;try{await reload();}catch(e){$('sb-status').textContent='Refresh failed: '+e.message;}finally{pollBusy=false;}
  },4000);
})();
