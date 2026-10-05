'use strict';
(() => {
  let data = null, collection = '', owner = '', requestId = 0, busy = false;
  let documentDirty = false, editorDirty = false, edited = null, shownVersion = '', pollBusy = false;
  let inputDirty = false, inputSrt = null, promptName = '';
  const checked = new Set();
  const path = suffix => '/api/storyboard/videos/' + collection + (suffix || '');
  function discard() {
    if (busy) { notice('Wait for the current storyboard action to finish.', true); return false; }
    if ((documentDirty || editorDirty || inputDirty) && !confirm('Discard unsaved input, script or concept edits?')) return false;
    documentDirty = editorDirty = inputDirty = false; inputSrt = null; edited = null; $('sb-editor').hidden = true; return true;
  }
  async function run(fn, control) {
    if (busy) return;
    busy = true;
    const controls = [...document.querySelectorAll('[data-view="storyboard"] input,[data-view="storyboard"] textarea,[data-view="storyboard"] select,[data-view="storyboard"] button')];
    const disabled = controls.map(e => e.disabled); controls.forEach(e => e.disabled = true);
    try { await action(fn, control); } finally { busy = false; controls.forEach((e,i) => e.disabled = disabled[i]); }
  }
  function assertCollection() {
    if (!collection || collection !== $('video-select').value || owner !== $('project-select').value) throw Error('Choose the active video in Project first.');
  }
  function assertSaved() {
    assertCollection();
    if (documentDirty || editorDirty || inputDirty) throw Error('Save or discard input/script/concept edits first.');
    if (!data?.document) throw Error('Save the script before importing audio or segments.');
  }
  function selected(limit=200) {
    assertSaved();
    const result = data.segments.filter(s => checked.has(s.id));
    if (!result.length || result.length > limit) throw Error(`Select 1–${limit} script segments.`);
    return result;
  }
  function timestamp(ms) {
    const h = Math.floor(ms/3600000), m = Math.floor(ms/60000)%60, s = Math.floor(ms/1000)%60;
    return [h,m,s].map(x=>String(x).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');
  }
  function segmentStatus(s) {
    if (s.job && ['QUEUED','RUNNING'].includes(s.job.state)) return 'Concept '+s.job.state;
    if (s.ready) return 'v'+s.active_concept.version+' · Image '+(s.active_concept.image_prompt?'ready':'missing')+' · Video '+(s.active_concept.video_prompt?'ready':'missing');
    if (s.active_concept) return 'Outdated concept';
    return s.job?.state || 'No concept';
  }
  function rowJob(s){return s.prompt_jobs?s.prompt_jobs[$('sb-prompt-kind').value]:s.job;}
  function rowState(s) {
    const job=rowJob(s);
    if(job?.state==='RUNNING')return 'running';
    if(job?.state==='QUEUED')return 'queued';
    if(['FAILED','NEEDS_REVIEW','INTERRUPTED'].includes(job?.state))return 'error';
    if(s.ready&&s.active_concept?.[$('sb-prompt-kind').value+'_prompt']?.trim())return 'completed';
    if(job?.state==='CANCELLED')return 'cancelled';
    if(s.active_concept&&!s.ready||job?.state==='STALE')return 'stale';
    return 'pending';
  }
  const labels={pending:'Not started',queued:'Queued',running:'Running',completed:'Completed',error:'Error / review',cancelled:'Cancelled',stale:'Outdated'};
  function visibleRows(){
    const filter=$('sb-filter').value,query=$('sb-search').value.trim().toLowerCase();
    return (data?.segments||[]).filter(s=>{
      const state=rowState(s);
      return (filter==='all'||filter===state||filter==='unfinished'&&state!=='completed')&&(!query||[s.ordinal,s.text,s.active_concept?.[$('sb-prompt-kind').value+'_prompt'],s.job?.error].join(' ').toLowerCase().includes(query));
    });
  }
  function fillInputs(){
    inputSrt=null;inputDirty=false;promptName=data?.document?.prompt_name||'';
    $('sb-template').value=data?.document?.prompt_template||'';
    $('sb-srt-file').textContent=data?.document?.srt_name||(data?.segments.length?`${data.segments.length} saved SRT rows`:'No SRT selected.');
    $('sb-prompt-file').textContent=promptName||($('sb-template').value?'Saved prompt instructions':'No prompt TXT selected.');
    $('sb-input-message').textContent=data?.segments.length?'Rows are saved. Choose a TXT to update their prompt instructions.':'Select an SRT and a prompt TXT, then load them.';
  }
  function selectionChanged() { render(); document.dispatchEvent(new Event('storyboard-selection')); }
  function renderRows(target, mode) {
    target.replaceChildren();
    const batches=new Map();
    if(mode==='editor')for(const item of data?.segments||[]){const batch=rowJob(item)?.text_batch_id;if(batch){if(!batches.has(batch))batches.set(batch,[]);batches.get(batch).push(String(item.ordinal).padStart(3,'0'));}}
    for (const s of mode==='editor'?visibleRows():data?.segments || []) {
      const tr=element('tr'); const box=element('input'); box.type='checkbox';box.checked=checked.has(s.id);box.dataset.segmentId=s.id;
      box.setAttribute('aria-label','Select segment '+s.ordinal);
      box.onchange=()=>{box.checked?checked.add(s.id):checked.delete(s.id);selectionChanged();};
      const td=element('td');td.append(box);tr.append(td);
      tr.append(element('td',String(s.ordinal).padStart(3,'0')+'\n'+timestamp(s.start_ms)+'\n'+timestamp(s.end_ms)+'\n'+((s.end_ms-s.start_ms)/1000).toFixed(3)+' s'));
      const text=element('td');text.append(element('p',s.text));tr.append(text);
      const concept=element('td');concept.append(element('p',s.active_concept ? ((mode==='video'||mode==='editor'&&$('sb-prompt-kind').value==='video')?s.active_concept.video_prompt:s.active_concept.image_prompt) : 'Create a concept first.'));tr.append(concept);
      const status=element('td');
      if(mode==='editor'){const badge=element('span',labels[rowState(s)],'sb-badge');badge.dataset.state=rowState(s);status.append(badge);tr.dataset.state=rowState(s);tr.dataset.rowId=s.id;}
      else status.textContent=segmentStatus(s);
      if(mode==='editor'&&rowJob(s)?.text_batch_id){
        const batch=rowJob(s).text_batch_id;
        const rows=batches.get(batch);
        status.append(element('small','Batch: '+rows.join(', ')));
      }
      const error=mode==='editor'?rowJob(s)?.error:s.job?.error;
      if(error)status.append(element('small',error));
      for(const j of s.media_jobs||[])status.append(element('small',j.kind+' · '+j.state+((j.current??(j.concept_id===s.active_concept_id))?'':' · older prompt')));
      tr.append(status);
      if(mode==='editor') {
        const actions=element('td'), group=element('div',undefined,'actions');
        group.append(button('Edit / versions',()=>openEditor(s)),button('Play segment',async()=>{
          if(!data.document.audio_path)throw Error('Import narration audio first.');
          const audio=$('sb-audio');audio.currentTime=s.start_ms/1000;audio.dataset.stopMs=String(s.end_ms);await audio.play();
        }));
        if(failedScene(s,'concept'))group.append(button('Retry row',()=>run(()=>retryConceptRows([s]))));
        actions.append(group);tr.append(actions);
      }
      target.append(tr);
    }
    if(!data?.segments.length){const tr=element('tr'),td=element('td','Import SRT / JSON in SRT to Prompt to load timed segments.');td.colSpan=mode==='editor'?6:5;tr.append(td);target.append(tr);}
    else if(!target.children.length){const tr=element('tr'),td=element('td','No rows match this filter.');td.colSpan=6;tr.append(td);target.append(tr);}
  }
  function render() {
    $('sb-count').textContent=`${checked.size} of ${data?.segments.length||0} segments selected`;
    const counts={};for(const s of data?.segments||[])counts[rowState(s)]=(counts[rowState(s)]||0)+1;
    $('sb-summary').replaceChildren(...Object.entries(labels).map(([state,label])=>element('span',`${label}: ${counts[state]||0}`)));
    const outputs=(data?.prompt_outputs||[]).filter(item=>item.kind===$('sb-prompt-kind').value);
    $('sb-output-folders').replaceChildren(...outputs.map(item=>element('p','TXT folder: '+item.directory)));
    $('sb-output-folders').hidden=!outputs.length;
    $('sb-warnings').textContent=(data?.warnings||[]).join('\n');
    $('sb-status').textContent=data?.document ? `${data.video.title} · ${data.segments.length} segments · ${data.segments.filter(s=>s.ready).length} current concepts` : 'Save your script, then import audio and SRT / JSON segments.';
    const source=data?.document?.source;
    if(source)$('sb-status').textContent+=source.source_id?` · Source: ${source.kind} / ${source.source_id}`:' · Source: manually imported segments';
    renderRows($('sb-rows'),'editor');
    for(const kind of ['image','video']) {
      $(kind+'-storyboard-name').textContent=data ? data.video.title+' · '+checked.size+' selected segments' : 'Choose a script in SRT to Prompt.';
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
  function renderWorkers(status) {
    $('sb-workers').hidden=$('sb-provider').value!=='chatgpt-web';
    if($('sb-workers').hidden)return;
    $('sb-workers-status').textContent=status.error||(!status.available?'Gateway unavailable':!status.extensionConnected?'ChatGPT extension disconnected':status.settings?.paused?'Queue paused':status.needsReview?'Account needs review':'Work / Temporary OFF · 1 tab · 5 numbered rows → ZIP → next group');
    const phases={WAITING_SETUP:'Waiting for another tab to finish input / upload / Send',OPENING_TAB:'Opening tab',BINDING_TAB:'Binding tab',WAITING_PAGE:'Waiting for ChatGPT input',SELECTING_MODE:'Selecting Work',ENABLING_TEMPORARY:'Enabling Temporary Chat',SELECTING_MODEL:'Checking model',TYPING:'Entering numbered SRT rows',ATTACHING_FILE:'Uploading prompt TXT',SENDING:'Sending batch',WAITING_RESPONSE:'Waiting for response',VERIFYING_COMPLETION:'Checking completed response',DOWNLOADING_ZIP:'Downloading ZIP',AWAITING_SAVE:'Checking ZIP and saving TXT files'};
    $('sb-worker-rows').replaceChildren(...(status.workers||[]).map(w=>{
      const row=element('tr'),phase=w.progress?.phase;
      row.append(element('td',w.id),element('td',Number.isInteger(w.tabId)?String(w.tabId):'Not open'),element('td',w.error?w.state:(phases[phase]||phase?.replaceAll('_',' ')||w.state)));
      row.append(element('td',w.error||[w.state==='RUNNING'&&w.started?Math.max(0,Math.round((Date.now()-w.started)/1000))+' s elapsed':'',w.progress?.chars?String(w.progress.chars)+' response characters':''].filter(Boolean).join(' · ')));
      return row;
    }));
  }
  async function reload(fields=false) {
    assertCollection();const ticket=++requestId,vid=collection,pid=owner;
    const [result,workers]=await Promise.all([api('GET',path()),$('sb-provider').value==='chatgpt-web'?api('GET','/api/chatgpt/status').catch(e=>({error:'Could not read worker status: '+e.message})):null]);
    if(ticket!==requestId||vid!==collection||pid!==$('project-select').value)return;
    const oldIds=new Set(data?.segments.map(s=>s.id)||[]);
    data=result;
    const ids=new Set(data.segments.map(s=>s.id));
    for(const id of checked)if(!ids.has(id))checked.delete(id);
    for(const s of data.segments)if(!oldIds.has(s.id))checked.add(s.id);
    if(fields){$('sb-script').value=data.document?.script_text||'';$('sb-style').value=data.document?.visual_style||'';documentDirty=false;fillInputs();}
    showAudio();render();renderWorkers(workers||{});
  }
  async function open() {
    const pid=$('project-select').value;
    if(!pid){$('sb-status').textContent='Create or select an active project in Project first.';return;}
    if(owner!==pid){if(!discard())return;data=null;checked.clear();collection='';owner=pid;}
    if(window.workflow){
      const ctx=window.workflow.context(),prior=collection;
      if(ctx.project_id!==pid||!ctx.video_id){$('sb-status').textContent='Select a video in Project first.';return;}
      collection=ctx.video_id;
      $('sb-collection').replaceChildren(option(collection,'Active video'));$('sb-collection').value=collection;
      await reload(prior!==collection||!data);return;
    }
    const videos=await api('GET','/api/videos?project_id='+encodeURIComponent(pid));
    if(pid!==$('project-select').value)return;
    $('sb-collection').replaceChildren(option('','Select a collection'),...videos.map(v=>option(v.id,v.title)));
    const prior=collection;
    const active=window.workflow?.context().video_id;
    collection=active&&videos.some(v=>v.id===active)?active:videos.some(v=>v.id===collection)?collection:videos.find(v=>v.id===$('video-select').value)?.id||videos[0]?.id||'';
    $('sb-collection').value=collection;
    if(window.workflow)$('sb-collection').disabled=true;
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
  $('sb-template').oninput=()=>{inputDirty=true;$('sb-input-message').textContent='Unsaved prompt instructions.';};
  $('sb-choose-srt').onclick=()=>run(async()=>{
    assertCollection();
    if(data?.segments.length)throw Error('This video already has rows. Select a new video to import another SRT; you can update the prompt TXT here.');
    const f=await window.studio.importScriptSource('srt');if(!f)return;
    if(!f.name.toLowerCase().endsWith('.srt'))throw Error('Choose an SRT file.');
    inputSrt=f;inputDirty=true;$('sb-srt-file').textContent=f.name;$('sb-input-message').textContent='SRT selected. Choose the prompt TXT and click Load SRT / save prompt.';
  });
  $('sb-choose-prompt').onclick=()=>run(async()=>{
    assertCollection();const f=await window.studio.importScriptSource('prompt');if(!f)return;
    if(!f.text.trim()||f.text.length>100000)throw Error('Prompt TXT must contain 1–100,000 characters.');
    promptName=f.name;$('sb-template').value=f.text;inputDirty=true;$('sb-prompt-file').textContent=f.name;$('sb-input-message').textContent='Prompt selected. Click Load SRT / save prompt.';
  });
  $('sb-inputs').onsubmit=e=>{e.preventDefault();run(async()=>{
    assertCollection();const template=$('sb-template').value;
    if(!template.trim())throw Error('Choose a non-empty prompt TXT first.');
    if(documentDirty||editorDirty)throw Error('Save or discard advanced script / concept edits first.');
    if(inputSrt)await api('POST',path('/prompt-input'),{srt_content:inputSrt.text,srt_name:inputSrt.name,prompt_template:template,prompt_name:promptName});
    else {
      if(!data?.segments.length)throw Error('Choose an SRT file first.');
      await api('PUT',path(),{script_text:data.document.script_text||'',visual_style:data.document.visual_style||'',prompt_template:template,prompt_name:promptName});
    }
    await reload(true);notice(`${data.segments.length} SRT rows ready. Select Image or Video prompt, then Start selected rows.`);
  });};
  $('sb-discard-inputs').onclick=()=>{if(!busy&&(!inputDirty||confirm('Discard unsaved SRT / TXT changes?')))fillInputs();};
  $('sb-filter').onchange=render;$('sb-search').oninput=render;
  $('sb-select-visible').onclick=()=>{checked.clear();for(const s of visibleRows())checked.add(s.id);selectionChanged();};
  $('sb-select-unfinished').onclick=()=>{checked.clear();for(const s of data?.segments||[])if(!['completed','queued','running'].includes(rowState(s)))checked.add(s.id);selectionChanged();};
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
  $('sb-prompt-kind').onchange=()=>{$('sb-prompt-heading').textContent=$('sb-prompt-kind').value==='video'?'Video prompt':'Image prompt';render();};
  function providerChanged(){const web=$('sb-provider').value==='chatgpt-web';$('sb-model').disabled=web;$('sb-model').placeholder=web?'Uses the Chat page model':'Provider default';$('sb-prompt-kind').disabled=!web;$('sb-workers').hidden=!web;}
  $('sb-provider').onchange=providerChanged;providerChanged();
  $('sb-refresh').onclick=()=>action(()=>open());
  $('sb-check-provider').onclick=()=>run(async()=>{
    const result=await api('GET','/api/storyboard/providers');$('sb-provider-status').textContent=result.providers.map(p=>p.id+': '+(p.status || (p.installed?'installed (sign-in not verified)':'not on PATH'))).join(' · ');
  });
  $('sb-select-all').onclick=()=>{(data?.segments||[]).forEach(s=>checked.add(s.id));selectionChanged();};
  $('sb-select-none').onclick=()=>{checked.clear();selectionChanged();};
  $('sb-create-concepts').onclick=()=>run(async()=>{
    const items=selected(1000);
    if($('sb-provider').value==='chatgpt-web'&&!data.document.prompt_template?.trim())throw Error('Choose and save your prompt TXT first.');
    if(!confirm(`Create prompts for up to ${items.length} row(s)? One Work tab sends up to 5 numbered rows, downloads and saves the ZIP, then sends the next group. The prompt TXT is attached only for the first group.`))return;
    notice('Preparing one Work tab for prompt ZIP batches…');
    const result=await api('POST',path('/generate-concepts'),{segment_ids:items.map(s=>s.id),provider:$('sb-provider').value,prompt_kind:$('sb-provider').value==='chatgpt-web'?$('sb-prompt-kind').value:'both',model:$('sb-model').value.trim()||null,regenerate:$('sb-regenerate').checked});
    await reload();notice(`${result.ids.length} row(s) queued${result.batch_count?' in '+result.batch_count+' batch(es) of up to 5':''}; ${result.skipped.length} skipped because current or pending concepts already exist.`);
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
    if(!body.title.trim()||!body.description.trim()||(!body.image_prompt.trim()&&!body.video_prompt.trim()))throw Error('Enter a title, description and at least one prompt.');
    await api('POST','/api/storyboard/segments/'+s.id+'/concepts',body);editorDirty=false;await reload();openEditor(data.segments.find(x=>x.id===s.id));notice('New concept version saved and selected.');
  });};
  $('sb-activate').onclick=()=>run(async()=>{const s=editedSegment();if(editorDirty)throw Error('Save or discard edits before switching versions.');const id=$('sb-version').value;if(!id)throw Error('Choose a saved version.');await api('POST','/api/storyboard/concepts/'+id+'/select',{});await reload();openEditor(data.segments.find(x=>x.id===s.id));notice('Concept version selected.');});
  $('sb-audio').ontimeupdate=()=>{const audio=$('sb-audio');if(audio.dataset.stopMs&&audio.currentTime*1000>=Number(audio.dataset.stopMs)){audio.pause();delete audio.dataset.stopMs;}};
  $('sb-audio').onerror=()=>notice('Audio playback is unavailable. Check the backend and audio format.',true);
  for(const kind of ['image','video'])$('sb-to-'+(kind==='image'?'images':'videos')).onclick=()=>{show(kind);$(kind+'-mode').value='storyboard';updateInputSummary();};
  document.querySelectorAll('[data-open-storyboard]').forEach(b=>b.onclick=()=>show('storyboard'));
  function failedScene(s,kind){
    const terminal=['FAILED','NEEDS_REVIEW','INTERRUPTED','CANCELLED'];
    if(kind==='concept')return terminal.includes(rowJob(s)?.state);
    const jobs=(s.media_jobs||[]).filter(j=>j.kind===kind&&(j.current??(j.concept_id===s.active_concept_id)));
    return s.ready&&jobs.length&&!jobs.some(j=>['QUEUED','SUBMITTING','RUNNING','DOWNLOADING','COMPLETED'].includes(j.state))&&terminal.includes(jobs[0].state);
  }
  async function retryConceptRows(items){
    assertSaved();
    if($('sb-provider').value==='chatgpt-web'&&!data.document.prompt_template?.trim())throw Error('Choose and save your prompt TXT first.');
    if(!confirm(`Retry ${items.length} failed row(s)? Check uncertain ChatGPT requests before retrying.`))return;
    const r=await api('POST',path('/retry-failed'),{segment_ids:items.map(s=>s.id),kind:'concept',reviewed:true,provider:$('sb-provider').value,prompt_kind:$('sb-provider').value==='chatgpt-web'?$('sb-prompt-kind').value:'both',model:$('sb-model').value.trim()||null});
    await reload();notice(`${r.ids.length} failed rows queued again.`);
  }
  for(const kind of ['concept','image','video']){
    const prefix=kind==='concept'?'sb':kind;
    $(prefix+'-select-failed').onclick=()=>run(async()=>{assertSaved();checked.clear();for(const s of data.segments)if(failedScene(s,kind))checked.add(s.id);selectionChanged();});
    $(prefix+'-retry-failed').onclick=()=>run(async()=>{
      const items=selected(kind==='concept'?1000:200).filter(s=>failedScene(s,kind));
      if(!items.length)throw Error('No selected failed scenes need retry. Successful and active results are kept.');
      if(kind==='concept'){await retryConceptRows(items);return;}
      if(!confirm(`Retry ${items.length} failed scene(s)? Saved remote media will resume without regeneration where possible. Inspect uncertain requests first; new requests may use credits.`))return;
      const r=await api('POST',path('/retry-failed'),{segment_ids:items.map(s=>s.id),kind,reviewed:true,provider:$('sb-provider').value,prompt_kind:$('sb-provider').value==='chatgpt-web'?$('sb-prompt-kind').value:'both',model:$('sb-model').value.trim()||null});
      await reload();await refreshJobs();notice(`${r.ids.length} new retries; ${r.resumed.length} saved remote results resumed; ${r.skipped.length} scenes skipped.`);
    });
  }
  window.storyboard={
    open,count:()=>checked.size,
    canChangeProject:()=>owner===$('project-select').value||discard(),
    canChangeVideo:id=>collection===id||!collection||discard(),
    openSegment:async id=>{await open();const segment=data?.segments.find(s=>s.id===id);if(segment)openEditor(segment);},
    canImportSource:()=>discard(),
    projectChanged:()=>{if(owner!==$('project-select').value){++requestId;owner='';collection='';data=null;checked.clear();$('sb-script').value='';$('sb-style').value='';$('sb-collection').replaceChildren(option('','Select a collection'));fillInputs();showAudio();render();}},
    generateMedia:async kind=>{
      const items=selected();if(items.some(s=>!s.ready||!s.active_concept?.[kind+'_prompt']?.trim()))throw Error('Selected segments need current concepts and a saved prompt for this media type. Create it in SRT to Prompt.');
      if(!confirm(`Generate ${kind} for up to ${items.length} selected segment(s)? Uses Google Flow credits.`))return;
      const r=await api('POST',path('/generate-media'),{segment_ids:items.map(s=>s.id),kind,orientation:$(kind+'-ratio').value,duration:Number($('duration').value),duration_mode:kind==='video'&&$('video-duration-auto').checked?'srt':'manual',image_model:kind==='image'?$('image-model').value||null:null,regenerate:$(kind+'-regenerate').checked});
      await reload();await refreshJobs();notice(`${r.ids.length} media job(s) queued; ${r.skipped.length} existing jobs/results skipped.${r.durations?.some(d=>d.short)?' Some scenes exceed 10 seconds; their clips need hold/loop during assembly.':''}`);
    }
  };
  document.addEventListener('workflow-changed',()=>{
    const ctx=window.workflow?.context();
    if(!ctx||(ctx.project_id===owner&&ctx.video_id===collection))return;
    ++requestId;owner=ctx.project_id;collection=ctx.video_id;data=null;checked.clear();edited=null;documentDirty=editorDirty=false;
    $('sb-editor').hidden=true;$('sb-script').value='';$('sb-style').value='';fillInputs();showAudio();render();
    if(!document.querySelector('[data-view="storyboard"]').hidden)action(open);
  });
  setInterval(async()=>{
    if(pollBusy||busy||!collection||owner!==$('project-select').value)return;
    if(!data?.segments.some(s=>['QUEUED','RUNNING'].includes(s.job?.state)||Object.values(s.prompt_jobs||{}).some(j=>['QUEUED','RUNNING'].includes(j?.state))||s.media_jobs?.some(j=>['QUEUED','SUBMITTING','RUNNING','DOWNLOADING'].includes(j.state))))return;
    pollBusy=true;try{await reload();}catch(e){$('sb-status').textContent='Refresh failed: '+e.message;}finally{pollBusy=false;}
  },4000);
})();
