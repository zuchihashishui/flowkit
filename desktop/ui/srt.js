(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const api=(method,route,body)=>(window.workflow?.api||window.studio.api)(method,'/api/srt/'+route,body);
 let busy=false, importing=false, selected='', signature='', qualityJob='', qualityTicket=0;
 let importedSources=[], whisperxSources=[];
 const recentImports=new Map(), inFlight=new Map(), sourceErrors={}, loaded=new Set();
 const say=text=>{$('srt-message').textContent=text;};
 let prepared=null,preparing=null,blockingJob=null;
 const contextKey=()=>JSON.stringify(window.workflow?.context()||{});
 async function prepareTab(){
  if(preparing)return preparing;
  window.projectSettings?.assertSaved();window.videoSettings?.assertSaved();
  const key=contextKey();
  say('Opening a separate ChatGPT window, binding the tab and selecting Work…');
  const pending=(async()=>{
   const result=await api('POST','prepare',{token:prepared?.key===key?prepared.token:undefined});
   if(contextKey()!==key)throw Error('Active video changed. Open SRT for the selected video.');
   if(['running','queued'].includes(result.state)){
    prepared=null;blockingJob=result.job_id;$('srt-stop-blocking').hidden=!blockingJob;
    $('srt-stop-blocking').textContent='Stop existing SRT job · '+(result.job_id||'').slice(0,8);
    say(result.message);void refresh();return result;
   }
   blockingJob=null;$('srt-stop-blocking').hidden=true;
   if(!result.token)throw Error('Update and restart Studio/backend/gateway, then reload ChatGPT Bridge 1.9.1.');
   prepared={...result,key};
   say('ChatGPT window ready · Tab selected and bound · Work selected. Choose JSON and click Create SRT to attach and send.');
   return prepared;
  })();
  preparing=pending;
  try{return await pending;}finally{if(preparing===pending)preparing=null;}
 }

 const defaults=`Convert the attached transcript JSON into a complete UTF-8 .srt file. Create the actual file and return its download link, not intermediate boundary JSON.

Each cue represents one image scene. Preserve the original language and all spoken words in order. Use the real timestamps in units, segments[].words or word_segments; do not duplicate parallel word lists or invent timing. For Japanese or Chinese, combine characters into complete clauses and ideas.

Prefer natural scenes lasting 3–15 seconds. Start at 00:00:00,000; each cue ends where the next starts. Use confirmed audio duration for the final end, or the largest transcript end if duration is unavailable, and explain that limitation outside the file. Preserve content and real timing if all constraints cannot be met, and report exceptions separately.

Use consecutive numbering and HH:MM:SS,mmm --> HH:MM:SS,mmm timestamps. Separate cues with a blank line. Return the downloadable .srt file plus cue count, end time, shortest/longest duration and any exceptions. Do not return scene_end_unit_ids in place of the SRT file.`;
 const legacyDefault="Choose natural scene boundaries for the attached indexed transcript. Each scene will correspond to one image in the final video. Only JSON is attached, not audio.\n\nPreserve the source language and every spoken word, without duplicating the transcript. Japanese / Chinese units may be characters, so group sentences and related clauses before choosing boundaries. Prefer one complete idea per scene, with 3\u201315 seconds including pauses. Merge short adjacent ideas when appropriate. Split long passages at natural clauses or real pauses; never cut a word or a tightly connected phrase solely to hit a target. Do not force equal scene lengths.\n\nUse only source timing and positions marked can_start_scene. Return the boundary JSON requested by Studio, never rewritten transcript text, timestamps, an SRT block or a download link. Studio preserves the source text, fills the timeline continuously from zero and writes HH:MM:SS,mmm --> HH:MM:SS,mmm timestamps itself. If duration metadata is missing, the full audio tail cannot be verified; Studio will flag this. Long silence or unavailable timing may require duration exceptions; preserve the natural grouping instead of inventing timing.";
 function upgradeLegacyPrompt(){if($('srt-prompt').value===legacyDefault){$('srt-prompt').value=defaults;$('srt-prompt').dispatchEvent(new Event('input',{bubbles:true}));}}
 if(window.productionDefaults)window.productionDefaults.registerBaseline('srt-prompt',defaults);
 else {
  try{$('srt-prompt').value=localStorage.getItem('srt-prompt')||defaults;}catch{$('srt-prompt').value=defaults;}
  $('srt-prompt').addEventListener('input',()=>{try{localStorage.setItem('srt-prompt',$('srt-prompt').value);}catch{}});
 }
 $('srt-use-template').onclick=()=>{
  $('srt-prompt').value=defaults;
  $('srt-prompt').dispatchEvent(new Event('input',{bubbles:true}));
  say('JSON → SRT template loaded. Review or edit it before creating a job.');
 };
 function controls(){
  $('srt-start').disabled=busy||importing;
  $('srt-choose').disabled=importing;
  $('srt-check').disabled=busy||importing;
  $('srt-approve').disabled=busy||importing;
  $('srt-choose').textContent=importing?'Choosing / importing JSON…':'Choose JSON file';
 }
 async function action(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){say(e.message);}finally{busy=false;controls();}}
 function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>action(fn);return b;}
 function errorText(error){
  const text=error?.message||String(error);
  if(/No handler registered.*srt-import|srtImport is not a function/.test(text))return 'Restart Studio completely to load the JSON file picker. Reloading the page is not enough.';
  if(/Backend HTTP 404.*\/api\/srt\/(status|import)/.test(text))return 'JSON → SRT is missing from the running backend. Update the complete source, then restart Studio and its backend.';
  return text;
 }
 function renderSources(){
  // A status request started before an import may return an older source list.
  const files=new Map(importedSources.map(s=>[s.id,s]));
  for(const [id,source] of recentImports)files.set(id,source);
  const sources=[...whisperxSources,...[...files.values()].map(s=>({...s,title:'File: '+s.title}))];
  const current=selected||$('srt-source').value,next=JSON.stringify(sources);
  if(signature!==next){signature=next;$('srt-source').replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=sources.length?'Select transcript JSON':'No transcript JSON loaded';$('srt-source').append(placeholder);for(const s of sources){const o=document.createElement('option');o.value=s.id;o.textContent=s.title+' · '+s.id;$('srt-source').append(o);}}
  if(sources.some(s=>s.id===current)){$('srt-source').value=current;selected='';}
  const summary=sources.length?`${whisperxSources.length} completed WhisperX result(s) · ${files.size} imported JSON file(s).`:Object.keys(sourceErrors).length?'Some transcript sources could not be loaded. You can still choose a JSON file.':loaded.size===2?'No completed WhisperX JSON or imported files yet. Complete a transcription or choose a JSON file.':'Loading transcript sources… You can choose a JSON file now.';
  $('srt-source-status').textContent=[summary,...Object.values(sourceErrors)].filter(Boolean).join(' ');
 }
 function renderBridge(bridge){
   const supported=['json-attachment-v1','fresh-srt-tab-v1','dedicated-srt-v1'].every(c=>bridge.capabilities?.includes(c));
   const w=bridge.srtWorker,progress=w&&w.state!=='IDLE'?(w.progress?.phase||w.state):'';
   $('srt-bridge').textContent=!bridge.extensionConnected?'ChatGPT extension disconnected. Turn on ChatGPT Bridge; SRT opens and binds its own tab.':!supported?'Reload ChatGPT Bridge 1.8.0 or later and restart Studio/backend/gateway to enable the dedicated SRT worker.':`Bridge ${bridge.enabled?'on':'off'} · SRT: ${bridge.availableSrtSlots?'Ready':'Waiting'} · One request / one dedicated tab · New tab opens and binds automatically${bridge.settings?.paused?' · Queue paused':''}${progress?' · '+progress:''}`;
 }
 function renderQuality(report,job=''){
  qualityJob=job;$('srt-quality').hidden=false;
  $('srt-quality-status').textContent=report.status+(report.approved?' · Exceptions accepted':'');
  const duration=Number.isFinite(report.duration_ms)?(report.duration_ms/1000).toFixed(3)+'s':'unknown';
  $('srt-quality-summary').textContent=[`${report.source_units??'—'} source units`,`${report.source_characters??'—'} source characters`,`${report.missing_timing_units??'—'} units with missing timing`,`Timeline: ${duration}`,report.text_preserved?'Text preserved · 100% source coverage':'',report.continuous_timeline?'Continuous timeline':'',report.cue_count?`${report.cue_count} scenes · ${(report.shortest_ms/1000).toFixed(3)}–${(report.longest_ms/1000).toFixed(3)}s`:''].filter(Boolean).join(' · ');
  $('srt-quality-note').textContent=[report.duration_source,report.text_comparison,report.note].filter(Boolean).join(' · ');
  $('srt-quality-issues').replaceChildren(...(report.issues||[]).slice(0,200).map(issue=>{
   const p=document.createElement('p');p.textContent=`${issue.severity.toUpperCase()} · ${issue.code}: ${issue.message}${issue.text?' Source: '+issue.text:''}`;return p;
  }));
  if((report.issues||[]).length>200){const p=document.createElement('p');p.textContent=`Showing 200 of ${report.issues.length} findings. ${job?'The complete report is stored with the job.':'Queueing saves the complete source report.'}`;$('srt-quality-issues').append(p);}
  $('srt-quality-scenes').replaceChildren(...(report.scenes||[]).slice(0,1000).map(scene=>{
   const tr=document.createElement('tr');for(const text of [scene.scene,`${scene.first_unit}–${scene.last_unit}`,`${(scene.start_ms/1000).toFixed(3)} / ${(scene.end_ms/1000).toFixed(3)}`,(scene.duration_ms/1000).toFixed(3)+'s',scene.text]){const td=document.createElement('td');td.textContent=text;tr.append(td);}return tr;
  }));
  if((report.scenes||[]).length>1000)$('srt-quality-note').textContent+=' · Showing the first 1,000 scenes; quality.json contains every scene.';
  const approval=job&&report.stage==='output'&&report.status==='REVIEW'&&!report.approved;
  $('srt-approve').hidden=!approval;$('srt-approval-help').hidden=!approval;
 }
 async function showQuality(jid){const ticket=++qualityTicket;const report=await api('GET',`jobs/${jid}/quality`);if(ticket===qualityTicket)renderQuality(report,jid);}
 function durationValue(){const value=$('srt-duration').value.trim();if(!value)return null;const n=Number(value);if(!Number.isFinite(n)||n<=0||n>86400)throw Error('Enter a measured audio duration between 0 and 86,400 seconds.');return n;}
 async function checkSource(source_id,duration_seconds){
  if(!source_id)throw Error('Select transcript JSON first.');
  const ticket=++qualityTicket;const report=await api('POST','analyze',{source_id,duration_seconds});
  if(source_id!==$('srt-source').value||ticket!==qualityTicket)throw Error('The transcript selection changed. Check the selected source again.');
  if(!['READY','REVIEW','BLOCKED'].includes(report?.status))throw Error('Transcript checks are unavailable. Update the complete source and restart Studio and its backend.');
  renderQuality(report);return report;
 }
 $('srt-check').onclick=()=>action(async()=>{await checkSource($('srt-source').value,durationValue());say('Transcript checked locally. No ChatGPT request was sent.');});
 $('srt-approve').onclick=()=>action(async()=>{const jid=qualityJob;if(!jid)return;const report=await api('POST',`jobs/${jid}/approve`,{reviewed:true});renderQuality(report,jid);say('Reported exceptions accepted for this SRT.');void refresh();});
 function changedSource(){qualityTicket++;qualityJob='';$('srt-quality').hidden=true;$('srt-duration').value='';}
 $('srt-source').addEventListener('change',changedSource);
 $('srt-duration').addEventListener('input',()=>{qualityTicket++;qualityJob='';$('srt-quality').hidden=true;});
 function renderJobs(state){
   const queue=state.queue;
   $('srt-queue-status').textContent=queue?.message||'This backend does not report SRT queue diagnostics. Update the complete source and restart Studio and its backend.';
   $('srt-queue-details').textContent=queue?JSON.stringify(queue,null,2):'Queue diagnostics unavailable.';
   $('srt-jobs').replaceChildren(...state.jobs.map(j=>{
    const row=document.createElement('div');row.className='job';const p=document.createElement('p');p.textContent=`${j.title} · ${j.state} · Work / ${j.model}${j.cues?' · '+j.cues+' cues':''}`;row.append(p);
    if(j.state==='QUEUED'){
     const reason=document.createElement('p');reason.className='srt-wait-reason';
     reason.textContent=(j.queue_position?`Queue position ${j.queue_position} · `:'')+(j.wait_reason?.message||queue?.message||'Waiting for a ChatGPT worker. Restart the updated backend to see the exact waiting reason.');
     row.append(reason);
    }
    if(j.quality){const q=document.createElement('p');q.textContent=`Quality: ${j.quality.status}${j.quality.approved?' · Exceptions accepted':''}`;row.append(q);}
    if(j.error){const e=document.createElement('pre');e.textContent=j.error;row.append(e);}
    if(['QUEUED','RUNNING','NEEDS_REVIEW'].includes(j.state))row.append(button(j.state==='QUEUED'?'Cancel queued job':'Stop job',async()=>{
     say('Stopping SRT job…');await api('POST',`jobs/${j.id}/cancel`,{});prepared=null;
     say('Job stopped. Existing files are retained. You can create a new SRT job.');await refresh();
    }));
    if(j.state==='COMPLETED'){
     const assemble=button('Assemble video',async()=>window.openAssembly(j.id)),scenes=button('Import as Scenes',async()=>window.workflow?.importScenes(j.id));
     const locked=j.method==='source-boundaries-v1'&&j.quality?.status!=='PASSED'&&!j.quality?.approved;
     assemble.disabled=scenes.disabled=locked;assemble.title=scenes.title=locked?'Review and accept the SRT quality exceptions first.':'';
     row.append(assemble,button('Preview SRT',async()=>{$('srt-preview').textContent=(await api('GET',`jobs/${j.id}/preview`)).text;if(j.method==='source-boundaries-v1')await showQuality(j.id);}),scenes,button('Save SRT as…',async()=>{const r=await window.studio.srtSave(j.id);say(r.canceled?'Save cancelled.':'SRT saved: '+r.path);}));
    }
    if(j.method==='source-boundaries-v1')row.append(button('Quality report',()=>showQuality(j.id)));
    return window.studioTables?.jobRow(row,[j.title,j.cues||'—',j.state,j.model],j.id,j.state)||row;
   }));
 }
 function refreshPart(name,request,render){
  if(inFlight.has(name))return inFlight.get(name);
  const task=Promise.resolve().then(request).then(data=>{
   render(data);
   if(name!=='bridge'){loaded.add(name);delete sourceErrors[name];renderSources();}
  }).catch(error=>{
   const message=errorText(error);
   if(name==='bridge')$('srt-bridge').textContent='ChatGPT status unavailable. JSON selection remains available. '+message;
   else {sourceErrors[name]=(name==='srt'?'Imported JSON / SRT jobs: ':'WhisperX results: ')+message;renderSources();}
  }).finally(()=>inFlight.delete(name));
  inFlight.set(name,task);return task;
 }
 function refresh(){
  // Render each response independently; bridge health never gates source selection.
  return Promise.allSettled([
   refreshPart('srt',()=>api('GET','status'),state=>{
    if(!Array.isArray(state?.sources)||!Array.isArray(state?.jobs))throw Error('Unexpected SRT status response. Restart the updated backend.');
    importedSources=state.sources;
    for(const source of importedSources)recentImports.delete(source.id);
    renderJobs(state);
   }),
   refreshPart('whisperx',()=>(window.workflow?.api||window.studio.api)('GET','/api/whisperx/status'),wx=>{
    if(!Array.isArray(wx?.jobs))throw Error('Unexpected WhisperX status response. Restart the updated backend.');
    whisperxSources=wx.jobs.filter(j=>j.result_available===true||(j.result_available===undefined&&j.state==='COMPLETED')).map(j=>({id:j.id,title:'WhisperX: '+j.title}));
   }),
   refreshPart('bridge',()=>(window.workflow?.api||window.studio.api)('GET','/api/chatgpt/status'),renderBridge)
  ]);
 }
 $('srt-choose').onclick=async()=>{
  if(importing)return;importing=true;controls();say('Choose a transcript JSON file in the file dialog.');
  try{
   if(typeof window.studio?.srtImport!=='function')throw Error('srtImport is not a function');
   const ctx=window.workflow?.requireContext();
   const r=await window.studio.srtImport(ctx);window.workflow?.assertCurrent(ctx);
   if(r?.canceled){say('File selection cancelled. Your current JSON selection is unchanged.');return;}
   if(!r?.id)throw Error('The backend did not return an imported JSON source. Check the backend and try again.');
   recentImports.set(r.id,{id:r.id,title:r.title||'Imported transcript.json'});
   changedSource();
   selected=r.id;renderSources();
   say(`JSON selected: ${r.title||'Imported transcript.json'}. Review your prompt, then click Create SRT.`);
   void refresh();
  }catch(error){say(errorText(error));}finally{importing=false;controls();}
 };
 $('srt-refresh').onclick=()=>refresh();
 $('srt-queue-refresh').onclick=()=>refresh();
 $('srt-stop-blocking').onclick=()=>action(async()=>{
  if(!blockingJob)return;
  const result=await api('POST',`jobs/${blockingJob}/cancel`,{});
  blockingJob=null;prepared=null;$('srt-stop-blocking').hidden=true;
  say(result.state==='COMPLETED'?'The job already completed. Its SRT is saved.':'Job stopped. Existing files retained. Click Create SRT to start a new job.');
  await refresh();
 });
 $('srt-open-chatgpt').onclick=()=>action(prepareTab);
 $('srt-open-extension').onclick=()=>action(()=>window.studio.chatgptAction('extension'));
<<<<<<< HEAD
 $('srt-workers').onclick=()=>{document.querySelector('[data-page="projects"]').click();const panel=$('project-app-settings');panel.open=true;panel.scrollIntoView?.({block:'start'});};
=======
 $('srt-workers').onclick=()=>document.querySelector('[data-page="settings"]').click();
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
 $('srt-form').onsubmit=e=>{e.preventDefault();return action(async()=>{
  upgradeLegacyPrompt();
  const source_id=$('srt-source').value,prompt=$('srt-prompt').value,model=$('srt-model').value.trim();
  if(!source_id||!prompt.trim()||!model)throw Error('Select JSON and enter a prompt and model.');
  const duration_seconds=durationValue();
  const ready=await prepareTab();
  if(['running','queued'].includes(ready.state))return;
  if(source_id!==$('srt-source').value||duration_seconds!==durationValue())throw Error('Source selection changed. Click Create SRT again.');
  say('Work tab ready. Attaching the selected JSON…');
  say('Attaching prompt and JSON in the prepared Work tab…');
  await api('POST','jobs',{source_id,prompt,model,timeout:Number($('srt-timeout').value)*60,duration_seconds,prepared_tab_token:ready.token});
  prepared=null;
  say('Queued for the selected Work tab. Studio will paste your prompt, attach your original JSON, download the returned SRT file and save it to this video.');void refresh();
 });};
 // Navigation (including source handoffs) only loads saved data. Browser
 // preparation belongs to Create SRT or the explicit Open SRT window button.
 document.querySelector('[data-page="srt"]').addEventListener('click',()=>{upgradeLegacyPrompt();void refresh().catch(e=>say(e.message));});
 window.openSRT=source=>{if(source!==$('srt-source').value)changedSource();selected=source;document.querySelector('[data-page="srt"]').click();};
 setInterval(()=>{if(!document.querySelector('[data-view="srt"]').hidden&&!busy)refresh().catch(e=>say(e.message));},3000);
 document.addEventListener('workflow-changed',async()=>{prepared=null;changedSource();selected='';signature='';importedSources=[];whisperxSources=[];recentImports.clear();$('srt-jobs').replaceChildren();$('srt-preview').textContent='';renderSources();await Promise.allSettled([...inFlight.values()]);await refresh();});
})();
