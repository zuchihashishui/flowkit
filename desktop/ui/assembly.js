(() => {
 'use strict';
 const $=id=>document.getElementById(id),api=(method,route,body)=>(window.workflow?.api||window.studio.api)(method,'/api/assembly/'+route,body);
 let busy=false,refreshing=false,assets=[],mapping={},lastRequest=null,ready=false,signature='',wantedSRT='',restored=false,mixedMediaVersion=0,productionVersion=0,imageMotionVersion=0;
 function readDraft(){
  let data={};
  try{
   data=JSON.parse(localStorage.getItem('assembly-draft:'+(window.workflow?.key()||'legacy'))||'{}');
   if(!data||typeof data!=='object'||Array.isArray(data))data={};
  }catch{data={};}
  if(data['visual-mode']&&!['images','mixed'].includes(data['visual-mode'])){
   data['visual-mode']=data.videos?.length?'mixed':'images';data.mapping={};
  }
  // Start the updated Merge form without subtitles, including old drafts and
  // inherited burn defaults. Subsequent explicit choices persist per video.
  if(data._subtitle_options_version!==1){
   data._settings_edited=[...new Set([...(data._settings_edited||Object.keys(data)),'subtitles'])];
   data.subtitles='off';data._subtitle_options_version=1;
  }
  if(data._clip_options_version!==1){
   data['clip-end']='slow';data._clip_options_version=1;
  }
  return data;
 }
 let draft=readDraft();
 let workspaceVersion=0,sourcesLoaded=false,sourcesEdited=!!draft._sources_edited,refreshTask=null,generation=0;
 let editedFields=new Set(draft._settings_edited||Object.keys(draft));
 const say=text=>{$('va-message').textContent=text;};
 const controls=['va-import-srt','va-import-audio','va-import-images','va-import-folder','va-preview','va-refresh','va-import-videos','va-import-video-folder','va-load-scenes','va-load-project','va-open-folder'];
 const ids=(kind='images')=>[...$('va-'+kind).selectedOptions].map(o=>o.value);
 const fields=['srt','audio','title','mode','size','fps','fit','subtitles','font','visual-mode','clip-end','image-motion'];
 const defaults={title:'Untitled video',mode:'number',size:'1080p',fps:'30',fit:'fit',subtitles:'off',font:'Yu Gothic','visual-mode':'images','clip-end':'slow','image-motion':'none'};
 const settingFields={size:'size',fps:'fps',fit:'fit',subtitles:'subtitles',font:'font',image_motion:'image-motion'};
 function applyDefaults(settings){
  if(!settings)return;
  for(const [key,name] of Object.entries(settingFields))if(settings[key]!=null&&!editedFields.has(name)){
   const value=String(settings[key]);draft[name]=value;$('va-'+name).value=value;
  }
 }
 function modeUI(){
  $('va-subtitle-font').hidden=$('va-subtitles').value!=='burn';
  $('va-video-options').hidden=$('va-visual-mode').value==='images';
  $('va-image-count').textContent=ids().length+' images selected';
  $('va-video-count').textContent=ids('videos').length+' clips selected';
 }
 function saveDraft(){try{const data={images:ids(),videos:ids('videos'),mapping,_subtitle_options_version:1,_clip_options_version:1,_sources_edited:sourcesEdited,_settings_edited:[...editedFields]};for(const name of fields)data[name]=$('va-'+name).value;localStorage.setItem('assembly-draft:'+ (window.workflow?.key()||'legacy'),JSON.stringify(data));}catch{}}
 function invalidate(){ready=false;lastRequest=null;$('va-render').disabled=true;$('va-plan-note').textContent='Inputs changed. Preview timeline before rendering.';saveDraft();}
 function editLock(value){for(const name of [...fields,'images','videos'])$('va-'+name).disabled=value;document.querySelectorAll('#va-scenes select').forEach(el=>el.disabled=value);}
 async function action(fn){if(busy)return;busy=true;editLock(true);for(const id of controls)$(id).disabled=true;$('va-render').disabled=true;try{await fn();}catch(e){say(e.message);}finally{busy=false;editLock(false);for(const id of controls)$(id).disabled=false;$('va-render').disabled=!ready;}}
 function option(value,label){const el=document.createElement('option');el.value=value;el.textContent=label;return el;}
 function fill(id,items,value){const el=$(id);el.replaceChildren(option('','Select a source'),...items.map(i=>option(i.value,i.title)));if(items.some(i=>i.value===value))el.value=value;}
 const time=s=>{const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${(s%60).toFixed(3).padStart(6,'0')}`;};
 function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>action(fn);return b;}
 function refresh(){
  if(!refreshTask)refreshTask=refreshOnce().finally(()=>{refreshTask=null;});
  return refreshTask;
 }
 async function refreshOnce(){
  refreshing=true;const ticket=generation;
  try{
   if(!restored){await window.videoSettings?.ready();applyDefaults(window.videoSettings?.effective()?.assembly);}
   const [state,srt,audio,wx]=await Promise.all([api('GET','status'),(window.workflow?.api||window.studio.api)('GET','/api/srt/status'),(window.workflow?.api||window.studio.api)('GET','/api/elevenlabs/jobs'),(window.workflow?.api||window.studio.api)('GET','/api/whisperx/status')]);
   if(ticket!==generation)return;
   workspaceVersion=state.workspace_version||0;
   $('va-output-directory').textContent=state.output_directory?'Output: '+state.output_directory+' · Each render uses its own folder.':'Select a project and video to see the output folder.';
   assets=state.assets;mixedMediaVersion=state.mixed_media_version||0;productionVersion=state.production_version||0;imageMotionVersion=state.image_motion_version||0;const shortcut=!!wantedSRT;
   $('va-tools').textContent=`FFmpeg: ${state.ffmpeg?'Ready':'Missing'} · FFprobe: ${state.ffprobe?'Ready':'Missing'}`;
   const srtOptions=[...assets.filter(a=>a.kind==='srt').map(a=>({value:'asset:'+a.id,title:a.title})),...srt.jobs.filter(j=>j.state==='COMPLETED').map(j=>({value:'job:'+j.id,title:'SRT job: '+j.title}))];
   const audioOptions=[...assets.filter(a=>a.kind==='audio').map(a=>({value:'asset:'+a.id,title:a.title})),...audio.jobs.filter(j=>j.merged_url).map(j=>({value:'job:'+j.id,title:'Narration: '+j.title})),...wx.imported_sources.map(a=>({value:'job:'+a.id,title:'Audio file: '+a.title}))];
   const images=assets.filter(a=>a.kind==='image').sort((a,b)=>a.title.localeCompare(b.title,undefined,{numeric:true}));
   const videos=assets.filter(a=>a.kind==='video').sort((a,b)=>a.title.localeCompare(b.title,undefined,{numeric:true}));
   const next=JSON.stringify([srtOptions,audioOptions,images.map(a=>[a.id,a.title]),videos.map(a=>[a.id,a.title])]);
   if(next!==signature){
    signature=next;
    const selected=restored?ids():(draft.images||[]),selectedVideos=restored?ids('videos'):(draft.videos||[]);
    fill('va-srt',srtOptions,wantedSRT||$('va-srt').value||draft.srt);
    fill('va-audio',audioOptions,$('va-audio').value||draft.audio);
    $('va-images').replaceChildren(...images.map(a=>{const o=option(a.id,a.title);o.selected=selected.includes(a.id);return o;}));
    $('va-videos').replaceChildren(...videos.map(a=>{const o=option(a.id,`${a.title} · ${Number(a.metadata?.duration||0).toFixed(2)}s`);o.selected=selectedVideos.includes(a.id);return o;}));
   }
   if(wantedSRT&&srtOptions.some(s=>s.value===wantedSRT)){$('va-srt').value=wantedSRT;wantedSRT='';invalidate();}
   if(!restored){for(const [name,value] of Object.entries(defaults))$('va-'+name).value=draft[name]??value;mapping=shortcut?{}:draft.mapping||{};restored=true;saveDraft();}
   modeUI();
   $('va-jobs').replaceChildren(...state.jobs.map(job=>{
    const row=document.createElement('div');row.className='job';const p=document.createElement('p');p.textContent=`${job.title} · ${job.state} · ${job.phase}${job.saved_scenes?' · '+job.saved_scenes+' saved scenes':''}`;row.append(p);
    const progress=document.createElement('progress');progress.max=100;progress.value=job.progress||0;progress.setAttribute('aria-label','Render progress');row.append(progress);
    if(job.error){const e=document.createElement('pre');e.textContent=job.error;row.append(e);}
    if(job.output_path){const output=document.createElement('p');output.textContent='Output: '+job.output_path;row.append(output);}
    if(['QUEUED','RUNNING'].includes(job.state))row.append(button('Cancel render',async()=>{await api('POST',`jobs/${job.id}/cancel`,{});await refresh();}));
    if(job.can_resume)row.append(button('Resume render',async()=>{await api('POST',`jobs/${job.id}/resume`,{});say('Resume queued. Saved scenes are verified before reuse.');await refresh();}));
    if(job.state==='COMPLETED')row.append(button('Preview video',async()=>{const r=await window.studio.assemblyMedia(job.id,'preview');$('va-video').src=r.url;$('va-video').hidden=false;$('va-video').load();say('Video ready to play below.');}),button('Save MP4 as…',async()=>{const r=await window.studio.assemblyMedia(job.id,'save');say(r.canceled?'Save cancelled.':'Video saved: '+r.path);}));
    return window.studioTables?.jobRow(row,[job.title,job.saved_scenes||0,job.state,job.phase],job.id,job.state)||row;
   }));
  }finally{refreshing=false;}
 }
 async function loadProject(){
  const ctx=window.workflow?.requireContext();
  if(!workspaceVersion)throw Error('Restart Studio with the updated backend to load project/video sources.');
  say('Loading audio, SRT and saved media for the selected video…');
  const result=await api('POST','project-sources',{visual_mode:editedFields.has('visual-mode')?$('va-visual-mode').value:'mixed'});
  window.workflow?.assertCurrent(ctx);
  await refresh();window.workflow?.assertCurrent(ctx);
  $('va-srt').value=result.srt_id?'asset:'+result.srt_id:'';
  $('va-audio').value=result.audio_id?'asset:'+result.audio_id:'';
  for(const kind of ['images','videos'])for(const o of $('va-'+kind).options)o.selected=result.assets.some(a=>a.id===o.value);
  if(!editedFields.has('visual-mode'))$('va-visual-mode').value=result.visual_mode;
  if(!editedFields.has('title'))$('va-title').value=result.title;
  mapping=result.mapping;sourcesLoaded=true;sourcesEdited=false;
  $('va-scenes').replaceChildren();$('va-plan-warnings').textContent='';
  invalidate();modeUI();
  say(`Loaded this video's sources: ${result.srt_id?'SRT ready':'SRT missing'} · ${result.audio_id?'Audio ready':'Audio missing'} · ${result.assets.length} media files. ${result.issues.join(' ')}`);
 }
 async function openPage(){
  await action(async()=>{
   const ticket=generation;
   await refresh();if(ticket!==generation)return;
   if(workspaceVersion&&window.workflow?.context().video_id&&(!sourcesLoaded||!sourcesEdited)){
    if(sourcesEdited&&$('va-srt').value&&$('va-audio').value&&(ids().length||ids('videos').length))sourcesLoaded=true;
    else await loadProject();
   }
  });
 }
 async function source(kind){
  const ctx=window.workflow?.requireContext();
  const value=$('va-'+kind).value;if(!value)throw Error('Choose '+kind.toUpperCase()+' first.');
  const [type,id]=value.split(':');if(type==='asset')return id;
  const imported=await api('POST','source',{kind,source_id:id});await refresh();window.workflow?.assertCurrent(ctx);$('va-'+kind).value='asset:'+imported.id;saveDraft();return imported.id;
 }
 async function showPlan(){
  const ctx=window.workflow?.requireContext();
  ready=false;$('va-render').disabled=true;
  const visualMode=$('va-visual-mode').value;
  if($('va-image-motion').value!=='none'&&imageMotionVersion<1)throw Error('Restart Studio with the updated backend to use still-image motion.');
  if(visualMode!=='images'&&mixedMediaVersion<1)throw Error('Restart Studio with the updated backend to use optional video clips.');
  if(!ids().length&&(visualMode==='images'||!ids('videos').length))throw Error('Choose and select images or video clips to use.');
  const srt_id=await source('srt');window.workflow?.assertCurrent(ctx);
  const audio_id=await source('audio');window.workflow?.assertCurrent(ctx);
  const body={srt_id,audio_id,image_ids:ids(),video_ids:visualMode==='images'?[]:ids('videos'),visual_mode:visualMode,clip_end:$('va-clip-end').value,mapping,mapping_mode:$('va-mode').value,title:$('va-title').value.trim()||'Untitled video',size:$('va-size').value,fps:Number($('va-fps').value),fit:$('va-fit').value,image_motion:$('va-image-motion').value,subtitles:$('va-subtitles').value,font:$('va-font').value.trim()||'Yu Gothic'};
  say('Checking selected files and scene timings…');
  const plan=await api('POST',productionVersion?'preflight':'preview',body);window.workflow?.assertCurrent(ctx);lastRequest=JSON.parse(JSON.stringify(body));ready=plan.missing.length===0&&!plan.blocked;
  $('va-plan-note').textContent=`${plan.scenes.length} visual segments · Audio ${time(plan.duration)} · Subtitles: ${{off:'Off',burn:'Burn into video',soft:'Selectable track'}[body.subtitles]} · Missing media: ${plan.missing.length}${plan.unused.length?' · Unused: '+plan.unused.join(', '):''}. ${plan.timeline_note}`;
  const warnings=[...(plan.warnings||[]),...(plan.checks||[]).filter(c=>c.scene==null).flatMap(c=>c.messages)];$('va-plan-warnings').textContent=warnings.slice(0,5).join(' ')+(warnings.length>5?` ${warnings.length-5} more short clips use the same setting.`:'');
  const visuals=assets.filter(a=>[...body.image_ids,...body.video_ids].includes(a.id));
  $('va-scenes').replaceChildren(...plan.scenes.map(cue=>{
   const key=cue.scene_key||String(cue.index),aid=cue.asset_id||cue.image_id,kind=cue.kind||(cue.image_id?'image':null);
   const choices=visuals.filter(a=>!cue.allowed_kind||cue.allowed_kind==='any'||a.kind===cue.allowed_kind);
   const row=document.createElement('tr');for(const text of [key,time(cue.start)+' → '+time(cue.end),cue.text,time(cue.visual_start??cue.image_start)+' → '+time(cue.visual_end??cue.image_end)]){const td=document.createElement('td');td.textContent=text;row.append(td);}
   const td=document.createElement('td'),select=document.createElement('select');select.setAttribute('aria-label','Media for scene '+key);select.append(option('','Choose '+(cue.allowed_kind==='video'?'video':cue.allowed_kind==='image'?'image':'image or video')),...choices.map(a=>option(a.id,`[${a.kind==='video'?'Video':'Image'}] ${a.title}`)));select.value=aid||'';
   select.onchange=()=>action(async()=>{mapping[key]=select.value||null;sourcesEdited=true;invalidate();await showPlan();});td.append(select);
   if(aid)td.append(button(kind==='video'?'Preview clip':'View image',async()=>{
    $('va-clip-preview').pause();$('va-clip-preview').hidden=true;$('va-image-preview').hidden=true;
    if(kind==='video'){const r=await window.studio.assemblyMedia(aid,'clip-preview');$('va-clip-preview').src=r.url;$('va-clip-preview').hidden=false;$('va-clip-preview').load();}
    else{$('va-image-preview').src=await window.studio.assemblyMedia(aid,'thumbnail');$('va-image-preview').hidden=false;}
    $('va-image-label').textContent='Scene '+key+' · '+(visuals.find(a=>a.id===aid)?.title||'')+(cue.image_motion&&cue.image_motion!=='none'?' · '+(cue.image_motion==='zoom_in'?'Slow zoom in':'Slow zoom out'):'')+(cue.clip_action?' · '+({slow:'Slow down to fit',freeze:'Hold last frame',loop:'Loop clip',trim:'Trim to scene'}[cue.clip_action]):'');
   }));
   row.append(td);
   const check=(plan.checks||[]).find(c=>c.scene===cue.index),health=document.createElement('td');
   health.textContent=check?`${check.status}${check.width?' · '+check.width+'×'+check.height:''}\n${check.messages.join(' ')}`:'File checks require the updated backend.';
   row.append(health);return row;
  }));
  saveDraft();say(ready?'Timeline ready. Review scene media and click Render MP4.':'Resolve missing media or file errors before rendering. You can change the file for each scene.');
 }
 async function importFiles(kind){
  say('Importing '+kind+'… Studio keeps a copy. Large folders may take a moment.');
  const ctx=window.workflow?.requireContext();
  const r=await window.studio.assemblyImport(kind,ctx);window.workflow?.assertCurrent(ctx);if(r.canceled){say('Selection cancelled.');return;}
  await refresh();window.workflow?.assertCurrent(ctx);sourcesEdited=true;
  if(kind.startsWith('images')||kind.startsWith('videos')){for(const o of $(kind.startsWith('videos')?'va-videos':'va-images').options)o.selected=r.assets.some(a=>a.id===o.value);mapping={};}
  else if(r.assets.length){$('va-'+kind).value='asset:'+r.assets[0].id;if(kind==='srt')mapping={};}
  invalidate();modeUI();
  say(`Imported ${r.assets.length} file(s). ${r.errors.length?'Errors: '+r.errors.join('\n'):'Preview timeline to continue.'}`);
 }
 for(const [id,kind] of [['va-import-srt','srt'],['va-import-audio','audio'],['va-import-images','images'],['va-import-folder','images-folder'],['va-import-videos','videos'],['va-import-video-folder','videos-folder']])$(id).onclick=()=>action(()=>importFiles(kind));
 for(const name of [...fields,'images','videos'])$('va-'+name).addEventListener(['title','font'].includes(name)?'input':'change',()=>{editedFields.add(name);if(['srt','audio','mode','images','videos','visual-mode'].includes(name))sourcesEdited=true;if(['srt','mode','images','videos','visual-mode'].includes(name))mapping={};invalidate();modeUI();});
 $('va-clip-preview').onerror=()=>say('This clip cannot be previewed by Electron. FFmpeg can still render supported imported formats.');
 $('va-load-scenes').onclick=()=>action(async()=>{
  if(!productionVersion)throw Error('Restart Studio with the updated backend to load scene media.');
  const ctx=window.workflow?.requireContext(),srt_id=await source('srt');window.workflow?.assertCurrent(ctx);
  say('Loading saved media for this project’s SRT scenes…');
  const r=await api('POST','scene-media',{srt_id,visual_mode:$('va-visual-mode').value});window.workflow?.assertCurrent(ctx);
  await refresh();window.workflow?.assertCurrent(ctx);sourcesEdited=true;
  for(const kind of ['images','videos'])for(const o of $('va-'+kind).options)o.selected=r.assets.some(a=>a.id===o.value);
  mapping=r.mapping;invalidate();modeUI();
  say(`Loaded ${r.assets.length} media files. Review the mapping with Check files & preview. ${r.issues.join(' ')}`);
 });
 $('va-preview').onclick=()=>action(showPlan);
 $('va-refresh').onclick=()=>action(refresh);
 $('va-load-project').onclick=()=>action(async()=>{await refresh();await loadProject();});
 $('va-open-folder').onclick=()=>action(async()=>{const ctx=window.workflow.requireContext();await window.studio.openVideoFiles(ctx.project_id,ctx.video_id);});
 $('va-render').onclick=()=>action(async()=>{if(!ready||!lastRequest)throw Error('Preview the timeline first.');await api('POST','jobs',lastRequest);ready=false;lastRequest=null;say('Render queued. Progress appears below; the MP4 is saved automatically when complete.');await refresh();});
 document.querySelector('[data-page="assembly"]').addEventListener('click',openPage);
 window.openAssembly=sourceId=>{wantedSRT='job:'+sourceId;mapping={};sourcesLoaded=true;sourcesEdited=true;document.querySelector('[data-page="assembly"]').click();};
 setInterval(()=>{if(!document.querySelector('[data-view="assembly"]').hidden&&!busy)refresh().catch(e=>say(e.message));},2500);
 document.addEventListener('workflow-changed',async()=>{
  const ticket=++generation;assets=[];mapping={};wantedSRT='';signature='';restored=false;ready=false;lastRequest=null;sourcesLoaded=false;workspaceVersion=0;draft=readDraft();sourcesEdited=!!draft._sources_edited;
  editedFields=new Set(draft._settings_edited||Object.keys(draft));
  for(const id of ['srt','audio','images','videos','scenes','jobs'])$('va-'+id).replaceChildren();
  for(const [name,value] of Object.entries(defaults))$('va-'+name).value=draft[name]??value;
  $('va-render').disabled=true;$('va-video').pause();$('va-video').removeAttribute('src');$('va-video').hidden=true;$('va-image-preview').hidden=true;$('va-clip-preview').pause();$('va-clip-preview').removeAttribute('src');$('va-clip-preview').hidden=true;$('va-plan-warnings').textContent='';$('va-plan-note').textContent='Load video sources and preview the timeline.';$('va-output-directory').textContent='Select a project and video to see the output folder.';say('');
  while(refreshing||busy)await new Promise(r=>setTimeout(r,20));
  if(ticket!==generation)return;
  if(!document.querySelector('[data-view="assembly"]').hidden)await openPage();
  else await refresh().catch(e=>say(e.message));
 });
 document.addEventListener('production-settings-changed',event=>{
  if(busy)return;
  const current=window.workflow?.context(),detail=event.detail||{};
  if(current&&(detail.project_id!==current.project_id||detail.video_id!==current.video_id))return;
  applyDefaults((detail.effective||detail.production)?.assembly);modeUI();if(restored)invalidate();
 });
 document.addEventListener('production-defaults-reset',event=>{
  if(busy)return;
  const current=window.workflow?.context(),detail=event.detail||{};
  if(current&&(detail.project_id!==current.project_id||detail.video_id!==current.video_id))return;
  for(const name of Object.values(settingFields))editedFields.delete(name);
  applyDefaults((detail.production||detail.effective)?.assembly);modeUI();invalidate();
 });
})();
