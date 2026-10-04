(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const api=(method,route,body)=>(window.workflow?.api||window.studio.api)(method,'/api/srt/'+route,body);
 let busy=false, importing=false, selected='', signature='', qualityJob='', qualityTicket=0;
 let importedSources=[], whisperxSources=[];
 const recentImports=new Map(), inFlight=new Map(), sourceErrors={}, loaded=new Set();
 const say=text=>{$('srt-message').textContent=text;};
 const defaults=`Choose natural scene boundaries for the attached indexed transcript. Each scene will correspond to one image in the final video. Only JSON is attached, not audio.

Preserve the source language and every spoken word, without duplicating the transcript. Japanese / Chinese units may be characters, so group sentences and related clauses before choosing boundaries. Prefer one complete idea per scene, with 3–15 seconds including pauses. Merge short adjacent ideas when appropriate. Split long passages at natural clauses or real pauses; never cut a word or a tightly connected phrase solely to hit a target. Do not force equal scene lengths.

Use only source timing and positions marked can_start_scene. Return the boundary JSON requested by Studio, never rewritten transcript text, timestamps, an SRT block or a download link. Studio preserves the source text, fills the timeline continuously from zero and writes HH:MM:SS,mmm --> HH:MM:SS,mmm timestamps itself. If duration metadata is missing, the full audio tail cannot be verified; Studio will flag this. Long silence or unavailable timing may require duration exceptions; preserve the natural grouping instead of inventing timing.`;
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
    if(j.state==='QUEUED')row.append(button('Cancel queued job',async()=>{await api('POST',`jobs/${j.id}/cancel`,{});void refresh();}));
    if(j.state==='COMPLETED'){
     const assemble=button('Assemble video',async()=>window.openAssembly(j.id)),scenes=button('Import as Scenes',async()=>window.workflow?.importScenes(j.id));
     const locked=j.method==='source-boundaries-v1'&&j.quality?.status!=='PASSED'&&!j.quality?.approved;
     assemble.disabled=scenes.disabled=locked;assemble.title=scenes.title=locked?'Review and accept the SRT quality exceptions first.':'';
     row.append(assemble,button('Preview SRT',async()=>{$('srt-preview').textContent=(await api('GET',`jobs/${j.id}/preview`)).text;if(j.method==='source-boundaries-v1')await showQuality(j.id);}),scenes,button('Save SRT as…',async()=>{const r=await window.studio.srtSave(j.id);say(r.canceled?'Save cancelled.':'SRT saved: '+r.path);}));
    }
    if(j.method==='source-boundaries-v1')row.append(button('Quality report',()=>showQuality(j.id)));
    return row;
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
 $('srt-open-chatgpt').onclick=()=>action(()=>window.studio.chatgptAction('open'));
 $('srt-open-extension').onclick=()=>action(()=>window.studio.chatgptAction('extension'));
 $('srt-workers').onclick=()=>document.querySelector('[data-page="chatgpt"]').click();
 $('srt-form').onsubmit=e=>{e.preventDefault();return action(async()=>{
  const source_id=$('srt-source').value,prompt=$('srt-prompt').value,model=$('srt-model').value.trim();
  if(!source_id||!prompt.trim()||!model)throw Error('Select JSON and enter a prompt and model.');
  const duration_seconds=durationValue();
  const report=await checkSource(source_id,duration_seconds);
  if(report.status==='BLOCKED')throw Error('Transcript checks failed. See the quality report below before generating.');
  await api('POST','jobs',{source_id,prompt,model,timeout:Number($('srt-timeout').value)*60,duration_seconds});
  say('Queued. Studio will open and bind a new ChatGPT tab, select Work, paste your prompt, attach indexed JSON and build subtitles.srt from verified source boundaries.');void refresh();
 });};
 document.querySelector('[data-page="srt"]').addEventListener('click',()=>refresh().catch(e=>say(e.message)));
 window.openSRT=source=>{if(source!==$('srt-source').value)changedSource();selected=source;document.querySelector('[data-page="srt"]').click();};
 setInterval(()=>{if(!document.querySelector('[data-view="srt"]').hidden&&!busy)refresh().catch(e=>say(e.message));},3000);
 document.addEventListener('workflow-changed',async()=>{changedSource();selected='';signature='';importedSources=[];whisperxSources=[];recentImports.clear();$('srt-jobs').replaceChildren();$('srt-preview').textContent='';renderSources();await Promise.allSettled([...inFlight.values()]);await refresh();});
})();
