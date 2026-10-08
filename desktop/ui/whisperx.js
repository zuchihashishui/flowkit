(() => {
 'use strict';
 const $ = id => document.getElementById(id);
 const api = (method, route, body) => (window.workflow?.api||window.studio.api)(method, '/api/whisperx/' + route, body);
 let loaded = false, refreshing = false, running = false, wantedSource = '', signature = '';
 let activityJob=null, activityReceivedAt=0, splitSupported=false, previewJob='';
 const phases={QUEUED:'Queued',STARTING:'Starting worker',LOADING_MODEL:'Loading speech model',READING_AUDIO:'Reading audio',TRANSCRIBING:'Transcribing speech',LOADING_ALIGNMENT_MODEL:'Loading alignment model',ALIGNING:'Aligning timestamps',WRITING_JSON:'Saving JSON',VERIFYING_JSON:'Verifying JSON',SPLITTING_JSON:'Splitting video / image JSON',COMPLETED:'Completed',FAILED:'Failed',CANCELLED:'Cancelled',INTERRUPTED:'Interrupted'};
 const duration=value=>{const s=Math.max(0,Math.floor(Number(value)||0));return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(n=>String(n).padStart(2,'0')).join(':');};
 const count=value=>Number(value).toLocaleString('en-US');
 function activityClock(){
  if(!activityJob)return;
  const active=activityJob.state==='RUNNING',p=activityJob.progress||{},now=Date.now()/1000;
  $('wx-elapsed').textContent=duration((activityJob.elapsed_seconds||0)+(active?now-activityReceivedAt:0));
  const age=p.updated_at?Math.max(0,now-p.updated_at):null;
  $('wx-last-update').textContent=active?(age===null?'Waiting for the worker…':`${duration(age)} since the last worker update${age>30?' · The current batch, model load or download may still be running.':''}`):activityJob.state==='QUEUED'?'Waiting for a free transcription worker.':'Worker stopped.';
 }
 function showActivity(jobs){
  activityJob=jobs.find(j=>j.state==='RUNNING')||jobs.find(j=>j.state==='QUEUED')||jobs[0]||null;activityReceivedAt=Date.now()/1000;
  $('wx-activity').hidden=!activityJob;if(!activityJob)return;
  const j=activityJob,p=j.progress||{},active=j.state==='RUNNING',percent=j.state==='COMPLETED'?100:typeof p.phase_percent==='number'&&Number.isFinite(p.phase_percent)?Math.min(100,Math.max(0,p.phase_percent)):null;
  $('wx-activity-title').textContent=j.title;
  $('wx-activity-phase').textContent=phases[j.phase]||j.phase;
  $('wx-activity-message').textContent=j.error||p.message||(j.state==='QUEUED'?'Waiting to start.':'');
  $('wx-stage-percent').textContent=j.state==='COMPLETED'?'Completed · 100%':active?(percent===null?'Current stage · waiting for measurable progress':`Current stage · ${percent.toFixed(1)}%`):phases[j.state]||j.state;
  $('wx-stage-progress').hidden=!active&&j.state!=='COMPLETED';
  if(percent===null)$('wx-stage-progress').removeAttribute('value');else $('wx-stage-progress').value=percent;
  $('wx-duration').textContent=p.audio_seconds!==undefined?duration(p.audio_seconds):'Not available yet';
  $('wx-audio-position').textContent=p.audio_done_seconds!==undefined?duration(p.audio_done_seconds):'Not available in this stage';
  $('wx-segment-count').textContent=p.segments_done!==undefined?count(p.segments_done)+(p.segments_total!==undefined?' / '+count(p.segments_total):' completed'):(p.output_segments!==undefined?count(p.output_segments)+' output segments':'Not available in this stage');
  $('wx-unit-label').textContent=p.units_done===undefined&&p.output_words!==undefined?'Output word units':p.unit==='characters'?'Source characters processed':'Source words processed';
  $('wx-unit-count').textContent=p.units_done!==undefined?count(p.units_done)+(p.units_total!==undefined?' / '+count(p.units_total):' processed'):(p.output_words!==undefined?count(p.output_words)+' output word units':'Available during alignment');
  const order=['STARTING','LOADING_MODEL','READING_AUDIO','TRANSCRIBING','LOADING_ALIGNMENT_MODEL','ALIGNING','WRITING_JSON','VERIFYING_JSON','SPLITTING_JSON','COMPLETED'];
  document.querySelectorAll('#wx-steps [data-phase]').forEach(el=>{const index=order.indexOf(el.dataset.phase),current=order.indexOf(j.phase);el.classList.toggle('current',active&&index===current);el.classList.toggle('done',j.state==='COMPLETED'||current>index);});
  activityClock();
 }
 const say = text => { $('wx-message').textContent = text; };
 function videoSeconds(){
  const text=$('wx-video-seconds').value.trim(),value=Number(text);
  if(!text||!Number.isFinite(value)||value<0||value>86400)throw Error('Video duration must be from 0 to 86,400 seconds.');
  return value;
 }
 function options() {
  const batch_size = Number($('wx-batch').value);
  if (!Number.isInteger(batch_size) || batch_size < 1 || batch_size > 32) throw Error('Batch size must be a whole number from 1 to 32.');
  return {model:$('wx-model').value, language:$('wx-language').value, device:$('wx-device').value, batch_size,video_duration_seconds:videoSeconds()};
 }
 async function action(fn) {
  if(running)return;
  running=true;
  for(const id of ['wx-start','wx-settings','wx-check','wx-choose'])$(id).disabled=true;
  try {await fn();}catch(e){say(e.message || String(e));}
  finally{running=false;for(const id of ['wx-start','wx-settings','wx-check','wx-choose'])$(id).disabled=false;}
 }
 function button(label, fn) {
  const el=document.createElement('button');el.type='button';el.textContent=label;
  el.onclick=()=>action(fn);return el;
 }
 async function preview(jid,variant='full'){
  const result=await api('GET',`jobs/${jid}/preview${variant==='full'?'':'/'+variant}`);
  previewJob=jid;$('wx-result').hidden=false;$('wx-preview-file').value=variant;
  const split=result.metadata?.transcript_split;
  $('wx-summary').textContent=`${result.filename||'transcript.json'} · Language: ${result.language} · ${result.segment_count} segments · ${result.word_count} word units. ${split?'Split: '+split.video_duration_seconds+'s · Original audio timestamps. ':''}${[...(result.metadata?.warnings||[]),...(split?.warnings||[])].join(' ')}`;
  $('wx-words').textContent=JSON.stringify(result.words,null,2);
 }
 $('wx-preview-file').onchange=()=>action(()=>preview(previewJob,$('wx-preview-file').value));
 async function refresh() {
  if(refreshing)return;
  refreshing=true;
  try {
   const [state,audio]=await Promise.all([api('GET','status'),(window.workflow?.api||window.studio.api)('GET','/api/elevenlabs/jobs').catch(error=>({jobs:[],sourceError:error.message}))]);
   splitSupported=state.transcript_split_version===1;
   const selected=wantedSource || $('wx-source').value;
   const sources=[...(audio.jobs || []).filter(j=>j.merged_url), ...(state.imported_sources || []).map(j=>({...j,title:'File: '+j.title}))];
   const nextSignature=JSON.stringify(sources.map(j=>[j.id,j.title]));
   if(nextSignature!==signature){
    signature=nextSignature;$('wx-source').replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Select merged narration or audio file';$('wx-source').append(placeholder);
    for(const source of sources){const el=document.createElement('option');el.value=source.id;el.textContent=`${source.title} · ${source.id}`;$('wx-source').append(el);}
   }
   if(sources.some(j=>j.id===selected)){$('wx-source').value=selected;wantedSource='';}
   if(!loaded){
    if(window.productionDefaults)window.productionDefaults.restore(['wx-language','wx-model','wx-device','wx-batch','wx-video-seconds']);
    else {
     const s=window.videoSettings?.effective()?.whisperx||state.settings;for(const name of ['language','model','device'])$('wx-'+name).value=s[name];
     $('wx-batch').value=s.batch_size;$('wx-video-seconds').value=s.video_duration_seconds??100;
    }
    $('wx-auto').checked=false;loaded=true;
   }
   showActivity(state.jobs);
   $('wx-worker-status').textContent=state.worker?.error?'Queue error: '+state.worker.error:state.worker?.running===false?'WhisperX queue worker is not running. Restart Studio/backend.':state.active_id&&activityJob?.state==='QUEUED'&&state.active_id!==activityJob.id?'Waiting: another video is using the transcription worker.':audio.sourceError?'Audio source list unavailable: '+audio.sourceError:'';
   const log=$('wx-live-log'),atEnd=log.scrollHeight-log.scrollTop-log.clientHeight<40;
   log.textContent=state.activity_log?.job_id===activityJob?.id?state.activity_log?.text||'Waiting for worker output.':'Waiting for worker output.';
   if(atEnd)log.scrollTop=log.scrollHeight;
   $('wx-jobs').replaceChildren(...state.jobs.map(job=>{
    const row=document.createElement('div');row.className='job';
    const text=document.createElement('p');text.textContent=`${job.title} · ${job.state} · ${job.phase} · ${job.options.model} / ${job.options.device}`;
    row.append(text);
    if(job.elapsed_seconds){const detail=document.createElement('small');detail.textContent='Elapsed: '+duration(job.elapsed_seconds)+(job.progress?.output_words!==undefined?' · '+count(job.progress.output_words)+' output word units':'');row.append(detail);}
    if(job.error){const err=document.createElement('pre');err.textContent=job.error;row.append(err);}
    if(['QUEUED','RUNNING'].includes(job.state))row.append(button('Cancel transcription',async()=>{await api('POST',`jobs/${job.id}/cancel`,{});await refresh();}));
    if(job.can_retry&&['FAILED','INTERRUPTED'].includes(job.state))row.append(button('Retry job',async()=>{await api('POST',`jobs/${job.id}/retry`,{});say('Transcription queued again with its saved source and settings.');await refresh();}));
    if(job.result_available){
     row.append(button('Create SRT',async()=>window.openSRT(job.id)),button('Preview words',()=>preview(job.id)),button('Save transcript.json',async()=>{const r=await window.studio.whisperxSave(job.id,'full');say(r.canceled?'Save cancelled.':'JSON saved: '+r.path);}));
     if(job.split_available){
      const detail=document.createElement('p'),split=job.transcript_split;
      detail.textContent=`3 JSON files saved · Split at ${split.video_duration_seconds}s · Video: ${count(split.video_words)} word units · Image: ${count(split.image_words)} word units${split.warnings?.length?' · '+split.warnings.join(' '):''}`;row.append(detail);
      for(const variant of ['video','image'])row.append(button(`Save transcript_${variant}.json`,async()=>{const r=await window.studio.whisperxSave(job.id,variant);say(r.canceled?'Save cancelled.':'JSON saved: '+r.path);}));
     }
     if(splitSupported)row.append(button('Split saved JSON',async()=>{
      const video_duration_seconds=videoSeconds();
      await api('POST',`jobs/${job.id}/split`,{video_duration_seconds});
      say(`Video / image JSON updated at ${video_duration_seconds}s. Original transcript.json is unchanged. WhisperX was not rerun.`);
      if(previewJob===job.id)await preview(job.id,$('wx-preview-file').value);
      await refresh();
     }));
    }
    return window.studioTables?.jobRow(row,[job.title,job.options.model+' / '+job.options.device,job.state,job.phase],job.id,job.state)||row;
   }));
  }finally{refreshing=false;}
 }
 $('wx-form').onsubmit=e=>{e.preventDefault();return action(async()=>{
  if(!$('wx-source').value)throw Error('Select a merged narration or choose an audio file first.');
  if(!splitSupported)throw Error('Update the complete source and restart Studio/backend to save all three transcript files.');
  say('Checking WhisperX environment and selected audio before starting…');
  await api('POST','jobs',{source_id:$('wx-source').value,...options()});
  say('Transcription queued. Studio will save the original, video and image JSON files. Follow the job stages below.');await refresh();
 });};
 $('wx-settings').onclick=()=>action(async()=>{
  if(window.productionDefaults&&window.workflow){
   const ctx=window.workflow.requireContext();window.projectSettings?.assertSaved();window.videoSettings?.assertSaved();
   const values=options(),path='/api/videos/'+ctx.video_id+'/settings';
   const current=await window.studio.api('GET',path);window.workflow.assertCurrent(ctx);
   if(current.project_id!==ctx.project_id)throw Error('This video belongs to another project. Select it again.');
   await window.studio.api('PUT',path,{revision:current.revision,overrides:{...current.overrides,whisperx:{...current.overrides?.whisperx,...values}}});
   window.workflow.assertCurrent(ctx);await window.videoSettings?.reload();
   say('WhisperX defaults saved for this video. Other videos and existing jobs are unchanged.');
  }else {await api('POST','settings',{...options(),auto:false});say('Settings saved. Stages stay manual. Click Create word JSON when ready.');}
 });
 $('wx-check').onclick=()=>action(async()=>{
  say('Checking Python, Torch and WhisperX imports (up to 90 seconds)…');
  $('wx-environment').textContent='Checking imports (up to 90 seconds)…';
  try {const r=await api('POST','check',{});$('wx-environment').textContent=JSON.stringify(r,null,2);say(r.ok?'WhisperX environment check passed.':r.error||'WhisperX environment check failed. See environment details.');}
  catch(e){$('wx-environment').textContent=e.message;throw e;}
 });
 $('wx-choose').onclick=()=>action(async()=>{
  say('Choose an audio file. Studio will keep a copy for transcription.');
  const ctx=window.workflow?.requireContext();
  const source=await window.studio.whisperxImport(ctx);window.workflow?.assertCurrent(ctx);
  if(source.canceled){say('File selection cancelled.');return;}
  wantedSource=source.id;
  await refresh();
  say(`Selected ${source.title}. Click Create word JSON to start.`);
 });
 $('wx-refresh').onclick=()=>action(refresh);
 document.querySelector('[data-page="whisperx"]').addEventListener('click',()=>refresh().catch(e=>say(e.message)));
 window.openWhisperX=async source=>{wantedSource=source;document.querySelector('[data-page="whisperx"]').click();await refresh();};
 setInterval(()=>{if(!document.querySelector('[data-view="whisperx"]').hidden)refresh().catch(e=>say(e.message));},3000);
 setInterval(()=>{if(!document.querySelector('[data-view="whisperx"]').hidden)activityClock();},1000);
 document.addEventListener('workflow-changed',async()=>{previewJob='';wantedSource='';signature='';$('wx-source').replaceChildren();$('wx-jobs').replaceChildren();$('wx-result').hidden=true;while(refreshing)await new Promise(r=>setTimeout(r,20));await refresh().catch(e=>say(e.message));});
})();
