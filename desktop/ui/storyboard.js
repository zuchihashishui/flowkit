'use strict';
(() => {
  let data = null, collection = '', owner = '', requestId = 0, busy = false;
  let documentDirty = false, editorDirty = false, edited = null, shownVersion = '', pollBusy = false;
<<<<<<< HEAD
  let optionsDirty = false;
  let inputDirty = false, inputSrt = null, promptName = '';
  const instructionLabels={image:'Image',video_4s:'Video 4s',video_6s:'Video 6s',video_8s:'Video 8s',video_10s:'Video 10s'};
  let promptOptions={templates:{},row_instructions:{}},activeInstruction='image';
  const webProvider=()=>$('sb-provider').value.startsWith('chatgpt-web');
  const rowInstruction=s=>{const choice=promptOptions.row_instructions?.[s.id]||(s.ordinal<=(promptOptions.video_row_count??15)?'video':'image');if(choice==='image')return 'image';const ms=s.end_ms-s.start_ms;return 'video_'+([4,6,8,10].find(n=>ms<=n*1000)||10)+'s';};
  const rowKind=s=>rowInstruction(s)==='image'?'image':'video';
  function stashTemplate(){const old=promptOptions.templates[activeInstruction];const text=$('sb-template').value;if(!old&&!text&&!promptName)return;promptOptions.templates[activeInstruction]={text,name:promptName,source:old?.source==='folder'&&old.text===text&&old.name===promptName?'folder':'manual'};}
  function showFiles(){
    for(const key of Object.keys(instructionLabels)){const file=promptOptions.templates[key];$('sb-file-'+key).textContent=(file?.name||(file?.text?'Saved instructions':'No TXT loaded'))+(file?.source==='folder'?(file.text?' · Auto-loaded':' · File unavailable'):'');}
    const info=data?.document?.prompt_instruction_files||data?.prompt_instruction_files;
    if($('sb-instructions-folder'))$('sb-instructions-folder').textContent=info?.directory?'Auto-load folder: '+info.directory:'Choose a project and video to locate its prompts folder.';
    if($('sb-instructions-warnings'))$('sb-instructions-warnings').textContent=(info?.warnings||[]).join('\n');
  }
  function showTemplate(){showFiles();const f=promptOptions.templates[activeInstruction]||{text:'',name:''};$('sb-template').value=f.text;promptName=f.name;$('sb-prompt-file').textContent=f.name||'No TXT loaded for '+instructionLabels[activeInstruction];}
  function generationOptions(){const size=Number($('sb-batch-size').value);if(!Number.isInteger(size)||size<1||size>20)throw Error('Rows per message must be a whole number from 1 to 20.');return {provider:webProvider()?'chatgpt-web':$('sb-provider').value,prompt_kind:webProvider()?'image':'both',use_row_instructions:webProvider(),batch_size:size,composer_mode:'chat',model:$('sb-model').value.trim()||(webProvider()?'GPT-5.6 Sol':null)};}
  async function saveOptions(){const n=Number($('sb-video-row-count').value);if(!Number.isInteger(n)||n<0||n>1000)throw Error('Video row count must be a whole number from 0 to 1000.');promptOptions.video_row_count=n;stashTemplate();const g=generationOptions();if(webProvider())promptOptions.chatgpt_model=g.model;promptOptions.batch_size=g.batch_size;promptOptions.composer_mode=g.composer_mode;await api('PUT',path('/prompt-options'),promptOptions);optionsDirty=false;if($('sb-unsaved'))$('sb-unsaved').textContent='Saved';}
=======
  let inputDirty = false, inputSrt = null, promptName = '';
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
  const checked = new Set();
  const path = suffix => '/api/storyboard/videos/' + collection + (suffix || '');
  function discard() {
    if (busy) { notice('Wait for the current storyboard action to finish.', true); return false; }
<<<<<<< HEAD
    if (!closePromptEditor()) return false;
    if ((documentDirty || editorDirty || inputDirty || optionsDirty) && !confirm('Discard unsaved input, script or concept edits?')) return false;
    documentDirty = editorDirty = inputDirty = optionsDirty = false; inputSrt = null; edited = null; $('sb-editor').hidden = true; return true;
=======
    if ((documentDirty || editorDirty || inputDirty) && !confirm('Discard unsaved input, script or concept edits?')) return false;
    documentDirty = editorDirty = inputDirty = false; inputSrt = null; edited = null; $('sb-editor').hidden = true; return true;
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
  }
  async function run(fn, control) {
    if (busy) return;
    busy = true;
    const controls = [...document.querySelectorAll('[data-view="storyboard"] input,[data-view="storyboard"] textarea,[data-view="storyboard"] select,[data-view="storyboard"] button')];
    const disabled = controls.map(e => e.disabled); controls.forEach(e => e.disabled = true);
    try { await action(fn, control); } finally { busy = false; controls.forEach((e,i) => e.disabled = disabled[i]);document.querySelectorAll('[data-instruction-row]').forEach(e=>e.disabled=false); }
  }
  function assertCollection() {
    if (!collection || collection !== $('video-select').value || owner !== $('project-select').value) throw Error('Choose the active video in Project first.');
  }
  function assertSaved(allowOptions=false) {
    assertCollection();
<<<<<<< HEAD
    if (documentDirty || editorDirty || inputDirty || (!allowOptions && optionsDirty)) throw Error('Save or discard input/script/concept edits first.');
=======
    if (documentDirty || editorDirty || inputDirty) throw Error('Save or discard input/script/concept edits first.');
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    if (!data?.document) throw Error('Save the script before importing audio or segments.');
  }
  function selected(limit=200,allowOptions=false) {
    assertSaved(allowOptions);
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
<<<<<<< HEAD
  function rowJob(s){return s.prompt_jobs?s.prompt_jobs[rowKind(s)]:s.job;}
=======
  function rowJob(s){return s.prompt_jobs?s.prompt_jobs[$('sb-prompt-kind').value]:s.job;}
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
  function rowState(s) {
    const job=rowJob(s);
    if(job?.state==='RUNNING')return 'running';
    if(job?.state==='QUEUED')return 'queued';
    if(['FAILED','NEEDS_REVIEW','INTERRUPTED'].includes(job?.state))return 'error';
<<<<<<< HEAD
    if(s.ready&&s.active_concept?.[rowKind(s)+'_prompt']?.trim())return job?.instruction_type&&job.instruction_type!==rowInstruction(s)?'pending':'completed';
=======
    if(s.ready&&s.active_concept?.[$('sb-prompt-kind').value+'_prompt']?.trim())return 'completed';
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    if(job?.state==='CANCELLED')return 'cancelled';
    if(s.active_concept&&!s.ready||job?.state==='STALE')return 'stale';
    return 'pending';
  }
  const labels={pending:'Not started',queued:'Queued',running:'Running',completed:'Completed',error:'Error / review',cancelled:'Cancelled',stale:'Outdated'};
  function visibleRows(){
    const filter=$('sb-filter').value,query=$('sb-search').value.trim().toLowerCase();
    return (data?.segments||[]).filter(s=>{
      const state=rowState(s);
<<<<<<< HEAD
      return (filter==='all'||filter===state||filter==='unfinished'&&state!=='completed')&&(!query||[s.ordinal,s.text,s.active_concept?.[rowKind(s)+'_prompt'],s.job?.error].join(' ').toLowerCase().includes(query));
    });
  }
  function fillInputs(){
    inputSrt=null;inputDirty=false;optionsDirty=false;promptName=data?.document?.prompt_name||'';
    promptOptions=JSON.parse(JSON.stringify(data?.document?.prompt_options||data?.prompt_options||{templates:{},row_instructions:{}}));promptOptions.templates??={};promptOptions.row_instructions??={};
    if(!promptOptions.templates.image&&data?.document?.prompt_template)promptOptions.templates.image={text:data?.document?.prompt_template||'',name:promptName};
    activeInstruction='image';$('sb-instruction-file').value='image';showTemplate();
    $('sb-batch-size').value=promptOptions.batch_size||10;
    if(webProvider())$('sb-model').value=promptOptions.chatgpt_model||'GPT-5.6 Sol';
    $('sb-video-row-count').value=promptOptions.video_row_count??15;
    if(webProvider())$('sb-provider').value='chatgpt-web-chat';
=======
      return (filter==='all'||filter===state||filter==='unfinished'&&state!=='completed')&&(!query||[s.ordinal,s.text,s.active_concept?.[$('sb-prompt-kind').value+'_prompt'],s.job?.error].join(' ').toLowerCase().includes(query));
    });
  }
  function fillInputs(){
    inputSrt=null;inputDirty=false;promptName=data?.document?.prompt_name||'';
    $('sb-template').value=data?.document?.prompt_template||'';
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    $('sb-srt-file').textContent=data?.document?.srt_name||(data?.segments.length?`${data.segments.length} saved SRT rows`:'No SRT selected.');
    $('sb-prompt-file').textContent=promptName||($('sb-template').value?'Saved prompt instructions':'No prompt TXT selected.');
    $('sb-input-message').textContent=data?.segments.length?'Rows are saved. Choose a TXT to update their prompt instructions.':'Select an SRT and a prompt TXT, then load them.';
  }
<<<<<<< HEAD
  function updateTableSelection(){const box=$('sb-select-table');if(!box)return;const rows=visibleRows(),n=rows.filter(s=>checked.has(s.id)).length;box.checked=!!rows.length&&n===rows.length;box.indeterminate=n>0&&n<rows.length;box.disabled=!rows.length;}
  function selectionChanged() {
    updateTableSelection();
    // Keep the focused checkbox and the table's scroll position intact.
    if($('sb-unsaved'))$('sb-unsaved').textContent=optionsDirty?'Unsaved settings / row choices':'';
    $('sb-count').textContent=`${checked.size} of ${data?.segments.length||0} segments selected`;
    $('sb-rows').querySelectorAll('input[data-segment-id]').forEach(box=>{box.checked=checked.has(box.dataset.segmentId);});
    document.dispatchEvent(new Event('storyboard-selection'));
  }
  function renderRows(target, mode) {
    const destination=target;target=document.createDocumentFragment();
    const batches=new Map();
    if(mode==='editor')for(const item of data?.segments||[]){const batch=rowJob(item)?.text_batch_id;if(batch){if(!batches.has(batch))batches.set(batch,[]);batches.get(batch).push(String(item.ordinal).padStart(3,'0'));}}
    for (const s of mode==='editor'?visibleRows():data?.segments || []) {
      const tr=element('tr');tr.dataset.dirty=String(optionsDirty);tr._record=JSON.stringify(s); const box=element('input'); box.type='checkbox';box.checked=checked.has(s.id);box.dataset.segmentId=s.id;
      box.setAttribute('aria-label','Select segment '+s.ordinal);
      box.onchange=()=>{box.checked?checked.add(s.id):checked.delete(s.id);selectionChanged();};
      const td=element('td');td.append(box);tr.append(td);
      if(mode==='editor')tr.append(element('td',String(s.ordinal).padStart(3,'0')));
      tr.append(element('td',(mode==='editor'?'':String(s.ordinal).padStart(3,'0')+'\n')+timestamp(s.start_ms)+'\n'+timestamp(s.end_ms)+'\n'+((s.end_ms-s.start_ms)/1000).toFixed(3)+' s'));
      const text=element('td');text.append(element('p',s.text));const kindCell=element('td'),instructionCell=element('td');
      if(mode==='editor'){const picker=element('select');picker.dataset.instructionRow=s.id;picker.setAttribute('aria-label','Prompt instructions for scene '+s.ordinal);for(const [key,label] of [['image','Image'],['video','Video']])picker.append(option(key,label));picker.value=rowKind(s);picker.disabled=busy;picker.onchange=()=>{promptOptions.row_instructions[s.id]=picker.value;optionsDirty=true;render();};kindCell.append(picker);instructionCell.append(element('small',rowKind(s)==='video'?instructionLabels[rowInstruction(s)]+' · '+((s.end_ms-s.start_ms)/1000).toFixed(2)+'s SRT'+(s.end_ms-s.start_ms>10000?' · Scene exceeds 10s':''):'Image instructions'));}tr.append(text);if(mode==='editor')tr.append(kindCell,instructionCell);
      const concept=element('td'),kind=mode==='video'||mode==='editor'&&rowKind(s)==='video'?'video':'image';
      const prompt=button(s.active_concept?.[kind+'_prompt']||'Add '+kind+' prompt…',()=>openPromptEditor(s,kind));
      prompt.type='button';prompt.className='scene-prompt-open';prompt.setAttribute('aria-label','Edit '+kind+' prompt for scene '+s.ordinal);prompt.title='View full prompt and edit';concept.append(prompt);tr.append(concept);
=======
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
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
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
<<<<<<< HEAD
    if(!data?.segments.length){const tr=element('tr'),td=element('td','Import SRT / JSON in SRT to Prompt to load timed segments.');td.colSpan=mode==='editor'?9:5;tr.append(td);target.append(tr);}
    else if(!target.children.length){const tr=element('tr'),td=element('td','No rows match this filter.');td.colSpan=9;tr.append(td);target.append(tr);}
    if(window.studioTables)window.studioTables.reconcile(destination,target);else destination.replaceChildren(target);
=======
    if(!data?.segments.length){const tr=element('tr'),td=element('td','Import SRT / JSON in SRT to Prompt to load timed segments.');td.colSpan=mode==='editor'?6:5;tr.append(td);target.append(tr);}
    else if(!target.children.length){const tr=element('tr'),td=element('td','No rows match this filter.');td.colSpan=6;tr.append(td);target.append(tr);}
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
  }
  function render() {
    updateTableSelection();if($('sb-unsaved'))$('sb-unsaved').textContent=optionsDirty?'Unsaved settings / row choices':'';
    $('sb-count').textContent=`${checked.size} of ${data?.segments.length||0} segments selected`;
    const counts={};for(const s of data?.segments||[])counts[rowState(s)]=(counts[rowState(s)]||0)+1;
    $('sb-summary').replaceChildren(...Object.entries(labels).map(([state,label])=>element('span',`${label}: ${counts[state]||0}`)));
<<<<<<< HEAD
    const outputs=(data?.prompt_outputs||[]).filter(item=>item.kind==='mixed'||item.kind===$('sb-prompt-kind').value);
=======
    const outputs=(data?.prompt_outputs||[]).filter(item=>item.kind===$('sb-prompt-kind').value);
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    $('sb-output-folders').replaceChildren(...outputs.map(item=>element('p','TXT folder: '+item.directory)));
    $('sb-output-folders').hidden=!outputs.length;
    $('sb-warnings').textContent=(data?.warnings||[]).join('\n');
    $('sb-status').textContent=data?.document ? `${data.video.title} · ${data.segments.length} segments · ${data.segments.filter(s=>s.ready).length} current concepts` : 'Save your script, then import audio and SRT / JSON segments.';
    const source=data?.document?.source;
    if(source)$('sb-status').textContent+=source.source_id?` · Source: ${source.kind} / ${source.source_id}`:' · Source: manually imported segments';
    renderRows($('sb-rows'),'editor');
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
<<<<<<< HEAD
    $('sb-workers').hidden=!webProvider();
    if($('sb-workers').hidden)return;
    $('sb-workers-status').textContent=status.error||(!status.available?'Gateway unavailable':!status.extensionConnected?'ChatGPT extension disconnected':status.settings?.paused?'Queue paused':status.needsReview?'Account needs review':`Extension ${status.extensionVersion||'unknown'} · Chat / Temporary OFF · 1 tab · Video: 1 row + TXT each time → text · Image: ${$('sb-batch-size').value} rows → ZIP`);
    const phases={WAITING_SETUP:'Waiting for another tab to finish input / upload / Send',OPENING_TAB:'Opening tab',BINDING_TAB:'Binding tab',WAITING_PAGE:'Waiting for ChatGPT input',SELECTING_MODE:'Selecting conversation mode',ENABLING_TEMPORARY:'Enabling Temporary Chat',SELECTING_MODEL:'Checking model',TYPING:'Entering numbered SRT rows',ATTACHING_FILE:'Uploading prompt TXT',WAITING_ATTACHMENT:'Checking attached file',WAITING_SEND_BUTTON:'Waiting for Send button',VERIFYING_SUBMISSION:'Confirming message was sent',SENDING:'Sending prompt',WAITING_RESPONSE:'Waiting for response',VERIFYING_COMPLETION:'Checking completed response',DOWNLOADING_ZIP:'Downloading ZIP',AWAITING_SAVE:'Saving prompt results'};
=======
    $('sb-workers').hidden=$('sb-provider').value!=='chatgpt-web';
    if($('sb-workers').hidden)return;
    $('sb-workers-status').textContent=status.error||(!status.available?'Gateway unavailable':!status.extensionConnected?'ChatGPT extension disconnected':status.settings?.paused?'Queue paused':status.needsReview?'Account needs review':'Work / Temporary OFF · 1 tab · 5 numbered rows → ZIP → next group');
    const phases={WAITING_SETUP:'Waiting for another tab to finish input / upload / Send',OPENING_TAB:'Opening tab',BINDING_TAB:'Binding tab',WAITING_PAGE:'Waiting for ChatGPT input',SELECTING_MODE:'Selecting Work',ENABLING_TEMPORARY:'Enabling Temporary Chat',SELECTING_MODEL:'Checking model',TYPING:'Entering numbered SRT rows',ATTACHING_FILE:'Uploading prompt TXT',WAITING_ATTACHMENT:'Checking attached file',WAITING_SEND_BUTTON:'Waiting for Send button',VERIFYING_SUBMISSION:'Confirming message was sent',SENDING:'Sending batch',WAITING_RESPONSE:'Waiting for response',VERIFYING_COMPLETION:'Checking completed response',DOWNLOADING_ZIP:'Downloading ZIP',AWAITING_SAVE:'Checking ZIP and saving TXT files'};
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    $('sb-worker-rows').replaceChildren(...(status.workers||[]).map(w=>{
      const row=element('tr'),phase=w.progress?.phase;
      row.append(element('td',w.id),element('td',Number.isInteger(w.tabId)?String(w.tabId):'Not open'),element('td',w.error?w.state:(phases[phase]||phase?.replaceAll('_',' ')||w.state)));
      row.append(element('td',w.error||[w.progress?.detail||'',w.state==='RUNNING'&&w.started?Math.max(0,Math.round((Date.now()-w.started)/1000))+' s elapsed':'',w.progress?.chars?String(w.progress.chars)+' response characters':''].filter(Boolean).join(' · ')));
      return row;
    }));
  }
  async function reload(fields=false) {
    assertCollection();const ticket=++requestId,vid=collection,pid=owner;
<<<<<<< HEAD
    const [result,workers]=await Promise.all([api('GET',path()),webProvider()?api('GET','/api/chatgpt/status').catch(e=>({error:'Could not read worker status: '+e.message})):null]);
=======
    const [result,workers]=await Promise.all([api('GET',path()),$('sb-provider').value==='chatgpt-web'?api('GET','/api/chatgpt/status').catch(e=>({error:'Could not read worker status: '+e.message})):null]);
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    if(ticket!==requestId||vid!==collection||pid!==$('project-select').value)return;
    const oldIds=new Set(data?.segments.map(s=>s.id)||[]);
    data=result;
    const ids=new Set(data.segments.map(s=>s.id));
    for(const id of checked)if(!ids.has(id))checked.delete(id);
    for(const s of data.segments)if(!oldIds.has(s.id))checked.add(s.id);
    if(fields){$('sb-script').value=data.document?.script_text||'';$('sb-style').value=data.document?.visual_style||'';documentDirty=false;fillInputs();}
<<<<<<< HEAD
    else if(!inputDirty&&!optionsDirty){
      const incoming=data.document?.prompt_options?.templates||data.prompt_options?.templates||{};
      for(const key of Object.keys(instructionLabels)){
        if(promptOptions.templates[key]?.source==='folder')delete promptOptions.templates[key];
        if(incoming[key]?.source==='folder')promptOptions.templates[key]=JSON.parse(JSON.stringify(incoming[key]));
      }
      showTemplate();
    }
=======
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
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
  let promptEditor=null;
  function closePromptEditor(force=false){
    if(!promptEditor)return true;
    promptEditor.close(force);return !promptEditor;
  }
  function openPromptEditor(scene,kind){
    if(busy||!closePromptEditor())return;
    assertCollection();
    const vid=collection,pid=owner,key=kind+'_prompt',original=scene.active_concept?.[key]||'';
    const form=element('form',undefined,'scene-prompt-form'),label=element('label',kind==='image'?'Image prompt':'Video prompt');
    const input=element('textarea');input.value=original;input.rows=18;input.maxLength=50000;input.required=true;input.spellcheck=false;input.setAttribute('aria-label',kind==='image'?'Image prompt':'Video prompt');label.append(input);
    const actions=element('div',undefined,'actions'),save=element('button','Save prompt'),cancel=element('button','Cancel');save.type='submit';cancel.type='button';actions.append(save,cancel);
    form.append(element('p',scene.text,'scene-prompt-narration'),label,actions);
    let saving=false;
    const popup=window.studioPopups.modal(form,`Scene ${String(scene.ordinal).padStart(3,'0')} · ${kind==='image'?'Image':'Video'} prompt`,{
      canClose:()=>!saving&&(input.value===original||confirm('Discard unsaved prompt changes?')),
      onClose:()=>{popup.dialog.remove();if(promptEditor===popup)promptEditor=null;}
    });
    promptEditor=popup;popup.dialog.classList.add('scene-prompt-popup');cancel.onclick=()=>popup.close();
    form.onsubmit=e=>{e.preventDefault();if(!input.value.trim()){popup.feedback.textContent='Enter a prompt before saving.';input.focus();return;}
      void run(async()=>{
        saving=true;input.disabled=true;popup.feedback.textContent='Saving prompt…';popup.feedback.classList.remove('error');
        try{
          assertCollection();
          if(collection!==vid||owner!==pid)throw Error('The selected video changed. Reopen its prompt.');
          if(documentDirty||editorDirty)throw Error('Save or discard script/scene editor changes before saving this prompt.');
          const latest=await api('GET','/api/storyboard/videos/'+encodeURIComponent(vid)),current=latest.segments?.find(s=>s.id===scene.id);
          assertCollection();
          if(collection!==vid||owner!==pid||latest.video?.id!==vid||latest.video?.project_id!==pid)throw Error('The selected video changed. Reopen its prompt.');
          if(!current||current.active_concept_id!==scene.active_concept_id||current.revision!==scene.revision||current.text!==scene.text)throw Error('This scene changed while editing. Copy your edits and reopen the latest prompt.');
          const concept=current.active_concept||{};
          await api('POST','/api/storyboard/segments/'+encodeURIComponent(scene.id)+'/concepts',{
            title:concept.title||scene.text.slice(0,150)||'Scene prompt',description:concept.description||scene.text.slice(0,3000)||'Scene prompt',
            image_prompt:concept.image_prompt||'',video_prompt:concept.video_prompt||'',[key]:input.value.trim()
          });
          popup.close(true);
          if(collection===vid&&owner===pid){await reload();notice(`Scene ${String(scene.ordinal).padStart(3,'0')} ${kind} prompt saved as a new version.`);}
        }catch(error){popup.feedback.textContent=error.message||String(error);popup.feedback.classList.add('error');}
        finally{saving=false;input.disabled=false;}
      },save);
    };
    popup.open();
  }
  function openEditor(s) {
    if(editorDirty&&!confirm('Discard unsaved editor changes?'))return;
    edited=s.id;editorDirty=false;$('sb-editor').hidden=false;
    $('sb-editor-title').textContent='Segment '+String(s.ordinal).padStart(3,'0');
    $('sb-start').value=s.start_ms;$('sb-end').value=s.end_ms;$('sb-text').value=s.text;
    $('sb-version').replaceChildren(option('','New concept'),...s.concepts.map(c=>option(c.id,'v'+c.version+' · '+c.provider+(c.id===s.active_concept_id?' · selected':''))));
    $('sb-version').value=s.active_concept_id||'';shownVersion=$('sb-version').value;fillConcept(s.active_concept);
    $('sb-editor').scrollTop=0;$('sb-text').focus({preventScroll:true});
  }
  function fillConcept(c) {
    for(const [id,key] of [['sb-concept-title','title'],['sb-description','description'],['sb-image-prompt','image_prompt'],['sb-video-prompt','video_prompt']])$(id).value=c?.[key]||'';
  }
  function editedSegment() {
    assertCollection();const s=data?.segments.find(s=>s.id===edited);if(!s)throw Error('Choose a segment to edit.');return s;
  }
  window.discardPromptOptions=()=>{if((inputDirty||optionsDirty)&&!confirm('Discard unsaved instructions and row choices?'))return;fillInputs();render();};
  window.removePromptInstruction=key=>{if(busy||!confirm('Remove '+instructionLabels[key]+' instructions from this video? Click Apply to save.'))return;stashTemplate();promptOptions.templates[key]={text:'',name:''};if(activeInstruction===key)showTemplate();else showFiles();inputDirty=true;optionsDirty=true;if($('sb-unsaved'))$('sb-unsaved').textContent='Unsaved instructions';};
  window.usePromptInstructionFolder=key=>run(async()=>{
    assertCollection();
    if(!data?.document)throw Error('Load the SRT first; new videos auto-load instructions from their folder.');
    if(inputDirty||optionsDirty||inputSrt)throw Error('Save or discard your unsaved instructions/settings first.');
    if(!confirm('Use '+instructionLabels[key]+' instructions from this video’s prompts folder instead of the saved manual instructions?'))return;
    promptOptions.templates[key]={text:'',name:'',source:'folder'};
    if(activeInstruction===key)showTemplate();
    await saveOptions();await reload(true);
  });
  window.promptInstructionEditor=key=>{stashTemplate();activeInstruction=key;$('sb-instruction-file').value=key;showTemplate();const panel=$('sb-template').closest('details');if(panel)panel.open=true;$('sb-template').focus({preventScroll:true});};
  $('sb-document').oninput=()=>documentDirty=true;
  $('sb-template').oninput=()=>{inputDirty=true;$('sb-input-message').textContent='Unsaved prompt instructions.';};
  $('sb-choose-srt').onclick=()=>run(async()=>{
    assertCollection();
    if(data?.segments.length)throw Error('This video already has rows. Select a new video to import another SRT; you can update the prompt TXT here.');
    const f=await window.studio.importScriptSource('srt');if(!f)return;
    if(!f.name.toLowerCase().endsWith('.srt'))throw Error('Choose an SRT file.');
    inputSrt=f;inputDirty=true;$('sb-srt-file').textContent=f.name;$('sb-input-message').textContent='SRT selected. Choose the prompt TXT and click Load SRT / save prompt.';
  });
<<<<<<< HEAD
  $('sb-video-row-count').onchange=()=>{const n=Number($('sb-video-row-count').value);if(!Number.isInteger(n)||n<0||n>1000){notice('Enter a whole number from 0 to 1000.',true);return;}promptOptions.video_row_count=n;promptOptions.row_instructions={};optionsDirty=true;render();};
  $('sb-batch-size').onchange=()=>{optionsDirty=true;if($('sb-unsaved'))$('sb-unsaved').textContent='Unsaved settings';};
  $('sb-save-options').onclick=()=>run(async()=>{assertCollection();if(inputSrt)throw Error('Load the selected SRT before saving prompt settings.');await saveOptions();inputDirty=false;notice('Prompt instructions and row choices saved for this video.');});
  $('sb-instruction-file').onchange=()=>{stashTemplate();activeInstruction=$('sb-instruction-file').value;showTemplate();};
  for(const key of Object.keys(instructionLabels))$('sb-upload-'+key).onclick=()=>run(async()=>{
    assertCollection();const f=await window.studio.importScriptSource('prompt');if(!f)return;
    if(!f.name.toLowerCase().endsWith('.txt')||!f.text.trim()||f.text.length>97000)throw Error('Choose a non-empty TXT file up to 97,000 characters.');
    stashTemplate();promptOptions.templates[key]={text:f.text,name:f.name};activeInstruction=key;$('sb-instruction-file').value=key;showTemplate();inputDirty=true;optionsDirty=true;
    $('sb-input-message').textContent='Instructions updated. Load SRT / save prompt, or Save prompt settings.';
  });
  $('sb-choose-prompt').onclick=()=>run(async()=>{
    assertCollection();const f=await window.studio.importScriptSource('prompt');if(!f)return;
    if(!f.text.trim()||f.text.length>97000)throw Error('Prompt TXT must contain 1–97,000 characters.');
    promptName=f.name;$('sb-template').value=f.text;inputDirty=true;$('sb-prompt-file').textContent=f.name;$('sb-input-message').textContent='Prompt selected. Click Load SRT / save prompt.';
  });
  $('sb-inputs').onsubmit=e=>{e.preventDefault();run(async()=>{
    assertCollection();stashTemplate();const imageFile=promptOptions.templates.image||{};const template=imageFile.text||'';
    if(!template.trim())throw Error('Choose a non-empty prompt TXT first.');
    if(documentDirty||editorDirty)throw Error('Save or discard advanced script / concept edits first.');
    if(inputSrt)await api('POST',path('/prompt-input'),{srt_content:inputSrt.text,srt_name:inputSrt.name,prompt_template:template,prompt_name:imageFile.name||''});
    else {
      if(!data?.segments.length)throw Error('Choose an SRT file first.');
      await api('PUT',path(),{script_text:data.document.script_text||'',visual_style:data.document.visual_style||'',prompt_template:template,prompt_name:imageFile.name||''});
    }
    await saveOptions();await reload(true);notice(`${data.segments.length} SRT rows ready. Choose each row’s instructions, then Start selected rows.`);
=======
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
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
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
<<<<<<< HEAD
  $('sb-prompt-kind').onchange=()=>{$('sb-prompt-heading').textContent='Prompt for chosen row type';render();};
  function providerChanged(){const web=webProvider();$('sb-model').disabled=false;$('sb-model').value=web?(promptOptions.chatgpt_model||'GPT-5.6 Sol'):'';$('sb-model').placeholder=web?'Exact ChatGPT model name':'Provider default';$('sb-prompt-kind').disabled=!web;$('sb-workers').hidden=!web;}
  $('sb-model').oninput=()=>{optionsDirty=true;selectionChanged();};
  $('sb-provider').onchange=()=>{optionsDirty=true;providerChanged();};providerChanged();
=======
  $('sb-prompt-kind').onchange=()=>{$('sb-prompt-heading').textContent=$('sb-prompt-kind').value==='video'?'Video prompt':'Image prompt';render();};
  function providerChanged(){const web=$('sb-provider').value==='chatgpt-web';$('sb-model').disabled=web;$('sb-model').placeholder=web?'Uses the Chat page model':'Provider default';$('sb-prompt-kind').disabled=!web;$('sb-workers').hidden=!web;}
  $('sb-provider').onchange=providerChanged;providerChanged();
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
  $('sb-refresh').onclick=()=>action(()=>open());
  $('sb-check-provider').onclick=()=>run(async()=>{
    const result=await api('GET','/api/storyboard/providers');$('sb-provider-status').textContent=result.providers.map(p=>p.id+': '+(p.status || (p.installed?'installed (sign-in not verified)':'not on PATH'))).join(' · ');
  });
  if($('sb-select-table'))$('sb-select-table').onchange=()=>{for(const s of visibleRows())$('sb-select-table').checked?checked.add(s.id):checked.delete(s.id);selectionChanged();};
  $('sb-select-all').onclick=()=>{(data?.segments||[]).forEach(s=>checked.add(s.id));selectionChanged();};
  $('sb-select-none').onclick=()=>{checked.clear();selectionChanged();};
  const startStatus=document.createElement('p');startStatus.id='sb-start-status';startStatus.setAttribute('role','status');startStatus.setAttribute('aria-live','polite');
  $('sb-create-concepts').parentElement.insertAdjacentElement('afterend',startStatus);
  $('sb-create-concepts').onclick=()=>run(async()=>{
<<<<<<< HEAD
    startStatus.textContent='Checking selected rows…';
    try {
    const items=selected(1000,webProvider());
    startStatus.textContent='Saving prompt settings…';
    if(webProvider())await saveOptions();
    if(!confirm(`Create prompts for ${items.length} row(s) in a new Chat tab? Video: one row and its TXT each time. Image: up to ${$('sb-batch-size').value} rows per message, TXT on the first batch.`)){startStatus.textContent='Cancelled. No prompt jobs submitted.';return;}
    startStatus.textContent='Opening a new Chat tab and sending TXT + SRT…';
    notice('Preparing one '+(generationOptions().composer_mode==='chat'?'Chat':'Work')+' tab: Video first, then Image…');
    const result=await api('POST',path('/generate-concepts'),{segment_ids:items.map(s=>s.id),...generationOptions(),fresh_start:webProvider(),regenerate:$('sb-regenerate').checked});
    await reload();notice(`${result.ids.length} row(s) queued${result.batch_count?' in '+result.batch_count+' batch(es) of up to '+result.batch_size:''}; ${result.skipped.length} skipped because current or pending concepts already exist.`);
    startStatus.textContent=`${result.ids.length} rows queued; ${result.skipped.length} skipped. See row status for progress.`;
    } catch(error) {startStatus.textContent='Start failed: '+(error.message||String(error));console.error('[SRT to Prompt start]',error);throw error;}
=======
    const items=selected(1000);
    if($('sb-provider').value==='chatgpt-web'&&!data.document.prompt_template?.trim())throw Error('Choose and save your prompt TXT first.');
    if(!confirm(`Create prompts for up to ${items.length} row(s)? One Work tab sends up to 5 numbered rows, downloads and saves the ZIP, then sends the next group. The prompt TXT is attached only for the first group.`))return;
    notice('Preparing one Work tab for prompt ZIP batches…');
    const result=await api('POST',path('/generate-concepts'),{segment_ids:items.map(s=>s.id),provider:$('sb-provider').value,prompt_kind:$('sb-provider').value==='chatgpt-web'?$('sb-prompt-kind').value:'both',model:$('sb-model').value.trim()||null,regenerate:$('sb-regenerate').checked});
    await reload();notice(`${result.ids.length} row(s) queued${result.batch_count?' in '+result.batch_count+' batch(es) of up to 5':''}; ${result.skipped.length} skipped because current or pending concepts already exist.`);
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
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
  $('sb-to-board').onclick=()=>run(async()=>{const ids=[...checked];show('scene-board');await window.sceneBoard.selectSegments(ids);});
  document.querySelectorAll('[data-open-storyboard]').forEach(b=>b.onclick=()=>show('storyboard'));
  function failedScene(s,kind){
    const terminal=['FAILED','NEEDS_REVIEW','INTERRUPTED','CANCELLED'];
    if(kind==='concept')return terminal.includes(rowJob(s)?.state);
    const jobs=(s.media_jobs||[]).filter(j=>j.kind===kind&&(j.current??(j.concept_id===s.active_concept_id)));
    return s.ready&&jobs.length&&!jobs.some(j=>['QUEUED','SUBMITTING','RUNNING','DOWNLOADING','COMPLETED'].includes(j.state))&&terminal.includes(jobs[0].state);
  }
  async function retryConceptRows(items){
    assertSaved();
<<<<<<< HEAD
    if(webProvider())await saveOptions();
    if(!confirm(`Retry ${items.length} failed row(s)? Check uncertain ChatGPT requests before retrying.`))return;
    const r=await api('POST',path('/retry-failed'),{segment_ids:items.map(s=>s.id),kind:'concept',reviewed:true,...generationOptions()});
=======
    if($('sb-provider').value==='chatgpt-web'&&!data.document.prompt_template?.trim())throw Error('Choose and save your prompt TXT first.');
    if(!confirm(`Retry ${items.length} failed row(s)? Check uncertain ChatGPT requests before retrying.`))return;
    const r=await api('POST',path('/retry-failed'),{segment_ids:items.map(s=>s.id),kind:'concept',reviewed:true,provider:$('sb-provider').value,prompt_kind:$('sb-provider').value==='chatgpt-web'?$('sb-prompt-kind').value:'both',model:$('sb-model').value.trim()||null});
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    await reload();notice(`${r.ids.length} failed rows queued again.`);
  }
  for(const kind of ['concept']){
    const prefix=kind==='concept'?'sb':kind;
    $(prefix+'-select-failed').onclick=()=>run(async()=>{assertSaved();checked.clear();for(const s of data.segments)if(failedScene(s,kind))checked.add(s.id);selectionChanged();});
    $(prefix+'-retry-failed').onclick=()=>run(async()=>{
      const items=selected(kind==='concept'?1000:200).filter(s=>failedScene(s,kind));
      if(!items.length)throw Error('No selected failed scenes need retry. Successful and active results are kept.');
      if(kind==='concept'){await retryConceptRows(items);return;}
      if(!confirm(`Retry ${items.length} failed scene(s)? Saved remote media will resume without regeneration where possible. Inspect uncertain requests first; new requests may use credits.`))return;
      const r=await api('POST',path('/retry-failed'),{segment_ids:items.map(s=>s.id),kind,reviewed:true,...generationOptions()});
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

  };
  document.addEventListener('workflow-changed',()=>{
    const ctx=window.workflow?.context();
    if(!ctx||(ctx.project_id===owner&&ctx.video_id===collection))return;
<<<<<<< HEAD
    closePromptEditor(true);++requestId;owner=ctx.project_id;collection=ctx.video_id;data=null;checked.clear();edited=null;documentDirty=editorDirty=false;
=======
    ++requestId;owner=ctx.project_id;collection=ctx.video_id;data=null;checked.clear();edited=null;documentDirty=editorDirty=false;
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    $('sb-editor').hidden=true;$('sb-script').value='';$('sb-style').value='';fillInputs();showAudio();render();
    if(!document.querySelector('[data-view="storyboard"]').hidden)action(open);
  });
  setInterval(async()=>{
    if(pollBusy||busy||!collection||owner!==$('project-select').value)return;
    if(!data?.segments.some(s=>['QUEUED','RUNNING'].includes(s.job?.state)||Object.values(s.prompt_jobs||{}).some(j=>['QUEUED','RUNNING'].includes(j?.state))||s.media_jobs?.some(j=>['QUEUED','SUBMITTING','RUNNING','DOWNLOADING'].includes(j.state))))return;
    pollBusy=true;try{await reload();}catch(e){$('sb-status').textContent='Refresh failed: '+e.message;}finally{pollBusy=false;}
  },4000);
})();
