'use strict';
(() => {
  const host=document.getElementById('scene-board');if(!host)return;
  host.innerHTML=`<section class="panel"><div class="toolbar"><div><h2>Prompt to Media</h2><p>Review narration, prompts and current media together. Successful results are preserved when retrying failed scenes.</p></div><button id="scb-show-downloads" type="button">Jobs &amp; downloads</button><button id="scb-open-files" type="button">Open video folder</button><button id="scb-collect" type="button">Collect saved images</button><button id="scb-refresh" type="button">Refresh scenes</button></div><div class="scene-board-controls"><label>Show<select id="scb-filter"><option value="all">All scenes</option><option value="failed">Failed scenes</option><option value="needs_review">Needs review</option><option value="missing_image_prompt">Missing image prompt</option><option value="missing_video_prompt">Missing video prompt</option><option value="missing_image">Missing image</option><option value="missing_video">Missing video clip</option><option value="ready">Image or video saved</option></select></label><label>Search narration or prompts<input id="scb-search" type="search" placeholder="Find a scene…" maxlength="500"></label><label>Retry target<select id="scb-target"><option value="image_prompt">Image prompt</option><option value="video_prompt">Video prompt</option><option value="image">Image generation</option><option value="video">Video generation</option></select></label></div><div class="scene-board-controls"><label>Image Model<select id="scb-model"><option value="GEM_PIX_2">Nano Banana Pro</option><option value="BELUGA">Nano Banana 2.1</option><option value="HARBOR_SEAL">Nano Banana 2 Lite</option></select></label><label>Aspect Ratio<select id="scb-ratio"><option value="HORIZONTAL">16:9 · Landscape</option><option value="VERTICAL">9:16 · Portrait</option></select></label><label class="check"><input id="scb-regenerate" type="checkbox">Regenerate completed selected scenes</label></div><p>Each row defaults to Image; choose Video for scenes that need a clip. Video requires a saved video prompt. Duration follows each SRT scene: up to 4s → 4s, up to 6s → 6s, up to 8s → 8s, up to 10s → 10s; longer scenes use 10s. Settings apply to new generation. Retry uses the original job settings and resumes saved remote results when available.</p><div class="actions space"><button id="scb-generate" type="button">Generate selected scenes</button><button id="scb-select-filtered" type="button">Select all filtered (up to 200)</button><button id="scb-select-failed" type="button">Select failed for target</button><button id="scb-clear" type="button">Clear selection</button><button id="scb-retry" type="button">Retry selected failed scenes</button><button id="scb-edit" type="button">Open SRT to Prompt</button></div><p id="scb-message" role="status" aria-live="polite">Choose a project and video in Project.</p><p id="scb-image-folder" class="scene-board-folder"></p><p id="scb-count" class="scene-board-count"></p><div id="scb-table-scroll" class="table-wrap" tabindex="0" role="region" aria-label="Prompt to Media scenes"><table class="story-table sb-table scene-board-table"><thead><tr><th><label class="scene-board-select-all"><input id="scb-select-all" type="checkbox"> Select all</label></th><th>Scene / time</th><th>Create</th><th>Narration</th><th>Image / video prompts</th><th>Next model / ratio</th><th>Current media</th><th>Activity / actions</th></tr></thead><tbody id="scb-rows"></tbody></table></div></section>`;
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
  const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
  const context=()=>window.workflow?.context()||{project_id:$('project-select')?.value||'',video_id:$('video-select')?.value||''};
  const scope=c=>`${c.project_id||''}/${c.video_id||''}`;
  const request=(method,path,body)=>window.studio.api(method,path,body);
  const terminal=new Set(['FAILED','NEEDS_REVIEW','INTERRUPTED','CANCELLED']),active=new Set(['QUEUED','SUBMITTING','RUNNING','DOWNLOADING']);
  let actionMessage='';
  function reportAction(message){actionMessage=message;$('scb-message').textContent=message;}
  let owner='',data=null,selected=new Set(),mediaTypes={},ticket=0,renderVersion=0,busy=false,polling=false,dialog=null;
  const urls=new Set(),thumbnailCache=new Map(),thumbnailLoads=new Map();let observer=null,previewQueue=[],previewActive=0,dialogUrl=null,cacheEpoch=0;
  function isCurrent(job,s){return job.current??job.concept_id===s.active_concept_id;}
  function currentJobs(s,kind){return(s.media_jobs||[]).filter(j=>j.kind===kind&&isCurrent(j,s));}
  function saved(s,kind){return currentJobs(s,kind).find(j=>j.state==='COMPLETED'&&j.files?.length);}
  function hasPrompt(s,kind){return Boolean(s.ready&&s.active_concept?.[kind+'_prompt']?.trim());}
  function failed(s,target){
    if(target.endsWith('_prompt'))return !hasPrompt(s,target.replace('_prompt',''))&&terminal.has(s.job?.state);
    const jobs=currentJobs(s,target);return hasPrompt(s,target)&&jobs.length&&!jobs.some(j=>active.has(j.state)||j.state==='COMPLETED')&&terminal.has(jobs[0].state);
  }
  function anyFailure(s){return (!s.ready||!hasPrompt(s,'image')||!hasPrompt(s,'video'))&&terminal.has(s.job?.state)||(s.media_jobs||[]).some(j=>isCurrent(j,s)&&terminal.has(j.state)&&!saved(s,j.kind));}
  function matches(s){
    const filter=$('scb-filter').value,query=$('scb-search').value.trim().toLocaleLowerCase();
    if(query&&![String(s.ordinal),s.text,s.active_concept?.image_prompt,s.active_concept?.video_prompt].some(t=>String(t||'').toLocaleLowerCase().includes(query)))return false;
    if(filter==='failed')return anyFailure(s);
    if(filter==='needs_review')return s.job?.state==='NEEDS_REVIEW'||(s.media_jobs||[]).some(j=>isCurrent(j,s)&&j.state==='NEEDS_REVIEW'&&!saved(s,j.kind));
    if(filter==='missing_image_prompt')return !hasPrompt(s,'image');if(filter==='missing_video_prompt')return !hasPrompt(s,'video');
    if(filter==='missing_image')return !saved(s,'image');if(filter==='missing_video')return !saved(s,'video');
    return filter==='ready'?Boolean(saved(s,'image')||saved(s,'video')):true;
  }
  function stateKey(){return 'flowkit.scene-board.v1/'+owner;}
  function persist(){if(!owner)return;try{localStorage.setItem(stateKey(),JSON.stringify({filter:$('scb-filter').value,search:$('scb-search').value,target:$('scb-target').value,image_model:$('scb-model').value,orientation:$('scb-ratio').value,media_types:mediaTypes,selected:[...selected].slice(0,200)}));}catch{}}
  function restore(){let stored={};try{stored=JSON.parse(localStorage.getItem(stateKey())||'{}');}catch{}for(const [id,key,fallback]of[['scb-filter','filter','all'],['scb-target','target','image_prompt']]){$(id).value=stored[key]||fallback;if(!$(id).value)$(id).value=fallback;}setImageSettings(stored);mediaTypes=stored.media_types&&typeof stored.media_types==='object'&&!Array.isArray(stored.media_types)?Object.fromEntries(Object.entries(stored.media_types).filter(([id,kind])=>typeof id==='string'&&kind==='video')):{};$('scb-regenerate').checked=false;$('scb-search').value=String(stored.search||'').slice(0,500);selected=new Set(Array.isArray(stored.selected)?stored.selected.filter(x=>typeof x==='string').slice(0,200):[]);}
  function setImageSettings(stored={}){
    const defaults=window.videoSettings?.effective()?.media||{};
    const savedModel=(stored.image_model??defaults.image_model)||'GEM_PIX_2';
    const model=['NARWHAL','NANO_BANANA_2'].includes(savedModel)?'GEM_PIX_2':savedModel;
  function setImageSettings(stored={}){
    const defaults=window.videoSettings?.effective()?.media||{};
    const model=stored.image_model??defaults.image_model??'';
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    if(![...$('scb-model').options].some(o=>o.value===model)){$('scb-model').append(new Option(model,model));}
    $('scb-model').value=model;
    $('scb-ratio').value=stored.orientation??defaults.orientation??'HORIZONTAL';
    if(!$('scb-ratio').value)$('scb-ratio').value='HORIZONTAL';
  }
  let modelsLoaded=false;
  async function loadModels(){
    if(modelsLoaded)return;
    const result=await request('GET','/api/models');
    const value=$('scb-model').value;
    for(const [name,key]of Object.entries(result.image_models||{})){
      if(key==='NARWHAL'||name==='NANO_BANANA_2')continue;
      const existing=[...$('scb-model').options].find(o=>o.value===key);
      const label=({GEM_PIX_2:'Nano Banana Pro',BELUGA:'Nano Banana 2.1',HARBOR_SEAL:'Nano Banana 2 Lite'})[key]||name;
      if(existing)existing.textContent=label;else $('scb-model').append(new Option(label,key));
    }
    $('scb-model').value=value;modelsLoaded=true;
  }
  function time(ms){const n=Math.max(0,Math.round(Number(ms)||0));return [Math.floor(n/3600000),Math.floor(n/60000)%60,Math.floor(n/1000)%60].map(x=>String(x).padStart(2,'0')).join(':')+'.'+String(n%1000).padStart(3,'0');}
  function revokePreviews(){observer?.disconnect();observer=null;previewQueue=[];++renderVersion;}
  function clearThumbnailCache(){++cacheEpoch;for(const url of urls)URL.revokeObjectURL(url);urls.clear();thumbnailCache.clear();thumbnailLoads.clear();}
  let previewTicket=0,previewOpener=null;
  function closePreview(restore=true){++previewTicket;dialog?.remove();dialog=null;if(dialogUrl){URL.revokeObjectURL(dialogUrl);dialogUrl=null;}if(restore){previewOpener?.focus?.({preventScroll:true});previewOpener=null;}}
  function actionButton(label,fn){const b=node('button',label);b.type='button';b.onclick=()=>run(fn,b);return b;}
  async function run(fn,control){if(busy)return;busy=true;host.querySelectorAll('[data-scene-kind]').forEach(el=>el.disabled=true);const own=owner;if(control)control.disabled=true;try{actionMessage='';await fn();}catch(e){console.error('[Prompt to Media]',e);if(owner===own){reportAction(e.message||String(e));$('scb-message').scrollIntoView?.({block:'center'});}}finally{busy=false;host.querySelectorAll('[data-scene-kind]').forEach(el=>el.disabled=false);if(control)control.disabled=false;}}
  let promptEditor=null;
  function closePromptEditor(force=false){
    if(!promptEditor)return true;
    promptEditor.close(force);
    return !promptEditor;
  }
  function openPromptEditor(scene,kind){
    if(!closePromptEditor())return;
    const ctx={...context()},own=scope(ctx),key=kind+'_prompt',original=scene.active_concept?.[key]||'';
    const form=node('form',undefined,'scene-prompt-form'),label=node('label',kind==='image'?'Image prompt':'Video prompt');
    const input=node('textarea');input.value=original;input.rows=18;input.maxLength=50000;input.required=true;
    input.setAttribute('aria-label',kind==='image'?'Image prompt':'Video prompt');input.spellcheck=false;label.append(input);
    const actions=node('div',undefined,'actions'),save=node('button','Save prompt'),cancel=node('button','Cancel');save.type='submit';cancel.type='button';actions.append(save,cancel);
    form.append(node('p',scene.text,'scene-prompt-narration'),label,actions);
    let saving=false;
    const popup=window.studioPopups.modal(form,`Scene ${String(scene.ordinal).padStart(3,'0')} · ${kind==='image'?'Image':'Video'} prompt`,{
      canClose:()=>!saving&&(input.value===original||confirm('Discard unsaved prompt changes?')),
      onClose:()=>{popup.dialog.remove();if(promptEditor===popup)promptEditor=null;}
    });
    promptEditor=popup;popup.dialog.classList.add('scene-prompt-popup');
    cancel.onclick=()=>popup.close();
    form.onsubmit=e=>{e.preventDefault();if(!input.value.trim()){popup.feedback.textContent='Enter a prompt before saving.';input.focus();return;}
      void run(async()=>{
        saving=true;input.disabled=true;popup.feedback.textContent='Saving prompt…';popup.feedback.classList.remove('error');
        try{
          if(scope(context())!==own)throw Error('The selected video changed. Reopen the prompt in the correct video.');
          const latest=await request('GET','/api/storyboard/videos/'+encodeURIComponent(ctx.video_id));
          const current=latest.segments?.find(s=>s.id===scene.id);
          if(scope(context())!==own||latest.video?.id!==ctx.video_id||latest.video?.project_id!==ctx.project_id)throw Error('The selected video changed. Reopen its prompt.');
          if(!current||current.active_concept_id!==scene.active_concept_id||current.revision!==scene.revision||current.text!==scene.text)throw Error('This scene changed while editing. Copy your edits and reopen the latest prompt.');
          const concept=current.active_concept||{};
          await request('POST','/api/storyboard/segments/'+encodeURIComponent(scene.id)+'/concepts',{
            title:concept.title||scene.text.slice(0,150)||'Scene prompt',description:concept.description||scene.text.slice(0,3000)||'Scene prompt',
            image_prompt:concept.image_prompt||'',video_prompt:concept.video_prompt||'',[key]:input.value.trim()
          });
          popup.close(true);
          if(scope(context())===own){reportAction(`Scene ${String(scene.ordinal).padStart(3,'0')} ${kind} prompt saved as a new version.`);await open();}
        }catch(error){popup.feedback.textContent=error.message||String(error);popup.feedback.classList.add('error');}
        finally{saving=false;input.disabled=false;}
      },save);
    };
    popup.open();
  }
  async function openPreview(s,job){
    if(!dialog)previewOpener=document.activeElement;
    const own=owner,turn=++previewTicket,result=await window.studio.preview(job.id,0);
    if(own!==owner||turn!==previewTicket)return;
    closePreview(false);dialogUrl=URL.createObjectURL(new Blob([result.bytes],{type:result.mime}));
    const panel=node('section',undefined,'media-popup-content');
    const media=node(job.kind==='video'?'video':'img');media.src=dialogUrl;if(job.kind==='video'){media.controls=true;media.preload='metadata';}else media.alt=`Scene ${s.ordinal}`;
    const available=filteredItems().map(scene=>({scene,job:saved(scene,job.kind)})).filter(item=>item.job),index=available.findIndex(item=>item.scene.id===s.id);
    const nav=node('div',undefined,'toolbar');
    for(const [label,step] of [['Previous scene',-1],['Next scene',1]]){const item=index>=0?available[index+step]:null,b=actionButton(label,async()=>{if(item)await openPreview(item.scene,item.job);});b.disabled=!item;nav.append(b);}
    nav.append(node('span',`${index>=0?index+1:'—'} / ${available.length} saved ${job.kind} scenes`));
    panel.append(nav,media,node('p',s.text));
    if(window.studioPopups){const popup=window.studioPopups.modal(panel,`Scene ${String(s.ordinal).padStart(3,'0')} · ${job.kind}`,{onClose:()=>closePreview()});dialog=popup.dialog;dialog.classList.add('media-popup');popup.open();}
    else{dialog=node('div',undefined,'production-modal');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Scene media preview');const head=node('div',undefined,'toolbar');head.append(node('h2',`Scene ${String(s.ordinal).padStart(3,'0')} · ${job.kind}`));const close=node('button','Close');close.type='button';close.onclick=()=>closePreview();head.append(close);panel.prepend(head);panel.classList.add('panel','production-modal-panel');dialog.append(panel);document.body.append(dialog);close.focus();}
  }
  async function loadThumbnail(entry){
    previewActive++;
    try{const key=entry.job.id+'/0';let url=thumbnailCache.get(key);if(url){thumbnailCache.delete(key);thumbnailCache.set(key,url);}
      if(!url){let pending=thumbnailLoads.get(key);if(!pending){const epoch=cacheEpoch;pending=(async()=>{const result=await window.studio.preview(entry.job.id,0);if(epoch!==cacheEpoch)throw Error('The active video changed.');if(!String(result.mime||'').startsWith('image/'))throw Error('The saved file is not an image.');const source=URL.createObjectURL(new Blob([result.bytes],{type:result.mime}));urls.add(source);thumbnailCache.set(key,source);while(thumbnailCache.size>50){const oldest=thumbnailCache.keys().next().value,oldUrl=thumbnailCache.get(oldest);thumbnailCache.delete(oldest);urls.delete(oldUrl);URL.revokeObjectURL(oldUrl);}return source;})();thumbnailLoads.set(key,pending);}try{url=await pending;}finally{if(thumbnailLoads.get(key)===pending)thumbnailLoads.delete(key);}}
      if(entry.version!==renderVersion||!entry.image.isConnected)return;
      entry.image.src=url;entry.image.hidden=false;entry.status.textContent='Saved image';
    }catch(e){if(entry.version===renderVersion&&entry.image.isConnected){entry.image.hidden=true;entry.status.textContent='Preview unavailable: '+e.message;}}
    finally{previewActive--;pumpPreviews();}
  }
  function pumpPreviews(){while(previewActive<3&&previewQueue.length){const item=previewQueue.shift();if(item.version===renderVersion)void loadThumbnail(item);}}
  function queueThumbnail(image,job,status){const entry={image,job,status,version:renderVersion};if(typeof IntersectionObserver==='function'){image._previewEntry=entry;observer.observe(image);}else{previewQueue.push(entry);pumpPreviews();}}
  function choose(s,checked){if(checked&&selected.size>=200&&!selected.has(s.id)){$('scb-message').textContent='Select at most 200 scenes for one action.';return false;}checked?selected.add(s.id):selected.delete(s.id);persist();return true;}
  function mediaType(s){return mediaTypes[s.id]==='video'?'video':'image';}
  function filteredItems(){return(data?.segments||[]).filter(matches);}
  function updateSelectAll(items){const box=$('scb-select-all');if(!box)return;const ids=items.map(s=>s.id),count=ids.filter(id=>selected.has(id)).length;box.disabled=!ids.length;box.checked=Boolean(ids.length&&count===ids.length);box.indeterminate=Boolean(count&&count<ids.length);box.title=ids.length>200?'Prompt to Media actions support 200 selected scenes at a time.':'Select or clear all matching scenes.';}
  function render(){
    const viewport=$('scb-table-scroll'),scrollTop=viewport.scrollTop,scrollLeft=viewport.scrollLeft;
    const focus=document.activeElement?.closest('#scb-rows [aria-label]')?.getAttribute('aria-label');
    revokePreviews();
    $('scb-image-folder').textContent=data?.image_output_directory?'Open video folder → images for numbered scene images (001, 002, 003…). Legacy image copies: '+data.image_output_directory:'';
    if(typeof IntersectionObserver==='function')observer=new IntersectionObserver(entries=>{for(const item of entries)if(item.isIntersecting){observer.unobserve(item.target);previewQueue.push(item.target._previewEntry);}pumpPreviews();},{root:viewport,rootMargin:'250px'});
    const items=filteredItems(),rows=$('scb-rows');rows.replaceChildren();
    updateSelectAll(items);
    $('scb-count').textContent=`${selected.size} selected · ${items.length} matching / ${data?.segments?.length||0} scenes${data?.video?.title?' · '+data.video.title:''}`;
    for(const s of items){
      const tr=node('tr');tr.dataset.segmentId=s.id;const pick=node('td'),box=node('input');box.type='checkbox';box.checked=selected.has(s.id);box.setAttribute('aria-label','Select scene '+s.ordinal);box.onchange=()=>{if(!choose(s,box.checked))box.checked=false;updateSelectAll(items);$('scb-count').textContent=`${selected.size} selected · ${items.length} matching / ${data.segments.length} scenes · ${data.video.title}`;};pick.append(box);
      const timing=node('td');timing.append(node('strong',String(s.ordinal).padStart(3,'0')),node('small',time(s.start_ms)),node('small',time(s.end_ms)),node('small',((s.end_ms-s.start_ms)/1000).toFixed(3)+' s'));
      const output=node('td'),kindPicker=node('select');kindPicker.setAttribute('aria-label','Create media for scene '+s.ordinal);kindPicker.dataset.sceneKind=s.id;
      kindPicker.append(new Option('Image','image'),new Option('Video','video'));kindPicker.value=mediaType(s);kindPicker.disabled=busy;
      const durationNote=node('small');durationNote.dataset.sceneDuration=s.id;
      const updateDuration=()=>{const ms=s.end_ms-s.start_ms,seconds=[4,6,8,10].find(d=>d*1000>=ms)||10;durationNote.hidden=kindPicker.value!=='video';durationNote.textContent=`Video: ${seconds}s`+(ms>10000?' · shorter than SRT':'');};
      kindPicker.onchange=()=>{if(kindPicker.value==='video')mediaTypes[s.id]='video';else delete mediaTypes[s.id];updateDuration();persist();render();};updateDuration();output.append(kindPicker,durationNote);
      const text=node('td');text.append(node('p',s.text));const prompts=node('td');
      for(const kind of ['image','video']){const container=kind===mediaType(s)?prompts:node('details');if(container!==prompts){container.append(node('summary',kind==='image'?'Other: image prompt':'Other: video prompt'));prompts.append(container);}const p=actionButton(s.active_concept?.[kind+'_prompt']||'Add '+kind+' prompt…',()=>openPromptEditor(s,kind));p.className='scene-board-prompt scene-prompt-open';p.setAttribute('aria-label','Edit '+kind+' prompt for scene '+s.ordinal);p.title='View full prompt and edit';if(!hasPrompt(s,kind)&&s.active_concept?.[kind+'_prompt'])p.prepend(node('strong','Outdated · '));container.append(p);}
      const text=node('td');text.append(node('p',s.text));const prompts=node('td');
      for(const kind of ['image','video']){prompts.append(node('strong',kind==='image'?'Image prompt':'Video prompt'));const p=node('p',s.active_concept?.[kind+'_prompt']||'No saved prompt.','scene-board-prompt');if(!hasPrompt(s,kind)&&s.active_concept?.[kind+'_prompt'])p.prepend(node('strong','Outdated · '));prompts.append(p);}
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
      const media=node('td');for(const kind of ['image','video']){
        const group=node('div',undefined,'scene-board-media'),job=saved(s,kind),pending=currentJobs(s,kind).find(j=>active.has(j.state));group.append(node('strong',kind==='image'?'Image':'Video clip'));
        if(job){const status=node('small',kind==='image'?'Loading preview…':'Saved clip');group.append(status);if(kind==='image'){const image=node('img',undefined,'scene-board-thumb');image.alt=`Scene ${s.ordinal} image preview`;image.width=180;image.height=105;image.setAttribute('tabindex','0');image.onclick=()=>run(()=>openPreview(s,job));image.onkeydown=e=>{if(e.key==='Enter')image.click();};group.append(image);setTimeout(()=>{if(image.isConnected)queueThumbnail(image,job,status);},0);}group.append(actionButton(kind==='image'?'View image':'Play clip',()=>openPreview(s,job)),actionButton('Export files',()=>window.sceneDownloads.export(job.id)));}
        else group.append(node('small',pending?pending.state.replace(/_/g,' ').toLowerCase():hasPrompt(s,kind)?'No current file':'Create a current prompt first'));
        const older=(s.media_jobs||[]).filter(j=>j.kind===kind&&!isCurrent(j,s)&&j.files?.length).length;if(older)group.append(node('small',`${older} older result(s) retained`));if(kind===mediaType(s))media.append(group);else{const other=node('details');other.append(node('summary',kind==='image'?'Other image result':'Other video result'),group);media.append(other);}
      }
      const activity=node('td');if(s.job){const status=node('small','Prompt · '+s.job.state);status.dataset.state=s.job.state;activity.append(status);}
      for(const job of (s.media_jobs||[]).filter(j=>isCurrent(j,s))){const status=node('small',job.kind+' · '+job.state);status.dataset.state=job.state;activity.append(status,actionButton('Job details',()=>window.sceneDownloads.focus(job.id)));}
      const errors=[s.job?.error,...(s.media_jobs||[]).filter(j=>isCurrent(j,s)).map(j=>j.error)].filter(Boolean);if(errors.length){const details=node('details');details.append(node('summary','Error details'),node('p',[...new Set(errors)].join('\n'),'scene-board-error'));activity.append(details);}
      activity.append(actionButton('Edit scene',async()=>{if(await window.selectProductionVideo?.(context().video_id,'storyboard')===false)return;await window.storyboard?.openSegment?.(s.id);}));
      const settings=node('td');settings.append(node('small',mediaType(s)==='image'?($('scb-model').selectedOptions[0]?.textContent||'Nano Banana Pro'):'Project video model'),node('small',$('scb-ratio').selectedOptions[0]?.textContent||'16:9'));
      tr.append(pick,timing,output,text,prompts,settings,media,activity);rows.append(tr);
    }
    if(!items.length){const tr=node('tr'),td=node('td',data?.segments?.length?'No scenes match this filter.':'Import SRT scenes in SRT to Prompt to begin.');td.colSpan=8;tr.append(td);rows.append(tr);}
    window.studioTables?.enhance(viewport.querySelector('table'),{search:false});window.studioTables?.refresh(viewport.querySelector('table'));
    if(focus)[...$('scb-rows').querySelectorAll('[aria-label]')].find(n=>n.getAttribute('aria-label')===focus)?.focus({preventScroll:true});
    viewport.scrollTop=scrollTop;viewport.scrollLeft=scrollLeft;
    persist();
  }
  async function open(){
    const ctx=context(),current=scope(ctx),version=++ticket;
    if(owner!==current){actionMessage='';persist();owner=current;data=null;$('scb-table-scroll').scrollTop=0;selected.clear();restore();closePreview();clearThumbnailCache();render();}
    if(!ctx.project_id||!ctx.video_id){$('scb-message').textContent='Select a project and video in Project.';return;}
    $('scb-message').textContent=actionMessage||'Loading scene status…';
    try{const result=await request('GET','/api/storyboard/videos/'+encodeURIComponent(ctx.video_id));if(version!==ticket||scope(context())!==current)return;
      if(result.video?.project_id!==ctx.project_id||result.video?.id!==ctx.video_id)throw Error('The scene source does not belong to the active video.');
      await loadModels();if(version!==ticket||scope(context())!==current)return;data=result;const valid=new Set(data.segments.map(s=>s.id));selected=new Set([...selected].filter(id=>valid.has(id)));render();$('scb-message').textContent=actionMessage||(data.warnings||[]).join(' · ')||'Current prompts and media are matched to each scene. Existing files remain saved.';
    }catch(e){if(version===ticket&&scope(context())===current)$('scb-message').textContent=e.message;}
  }
  function selectionItems(){if(owner!==scope(context())||!data?.document)throw Error('Load the active video and import its SRT scenes first.');const items=data.segments.filter(s=>selected.has(s.id));if(!items.length||items.length>200)throw Error('Select 1–200 scenes.');return items;}
  async function openVideoFiles(){
    const ctx={...context()};if(!ctx.project_id||!ctx.video_id)throw Error('Select a project and video first.');
    $('scb-message').textContent='Organizing saved files…';
    const result=await window.studio.openVideoFiles(ctx.project_id,ctx.video_id);
    if(scope(context())!==scope(ctx))return;
    $('scb-message').textContent=result.directory+(result.warnings?.length?' · '+result.warnings.join(' · '):'');
  }
  async function collectImages(){
    const ctx={...context()};
    if(owner!==scope(ctx)||!data?.document)throw Error('Load a video with SRT scenes first.');
    $('scb-message').textContent='Collecting saved images…';
    const result=await request('POST','/api/storyboard/videos/'+encodeURIComponent(ctx.video_id)+'/collect-images',{});
    if(scope(context())!==scope(ctx))return;
    $('scb-message').textContent=`${result.files?.length||0} images collected in ${result.directory}. `+(result.warnings||[]).join(' · ');
  }
  async function generateMedia(){
    reportAction('Checking selected scenes…');
    const items=selectionItems(),ctx={...context()},regenerate=$('scb-regenerate').checked;
    const missing=items.filter(s=>!hasPrompt(s,mediaType(s)));
    if(missing.length)throw Error('Every selected scene needs a current prompt for its chosen type. Missing: '+missing.map(s=>String(s.ordinal).padStart(3,'0')+' '+mediaType(s)+' prompt').join(', ')+'. Create it in SRT to Prompt first.');
    const eligible=items.filter(s=>!currentJobs(s,mediaType(s)).some(j=>active.has(j.state)||!regenerate&&j.state==='COMPLETED'));
    if(!eligible.length)throw Error('Selected scenes already have completed or active media. Existing results were kept.');
    const groups=['image','video'].map(kind=>({kind,segment_ids:eligible.filter(s=>mediaType(s)===kind).map(s=>s.id),image_model:kind==='image'?$('scb-model').value||null:null,orientation:$('scb-ratio').value,regenerate,
      ...(kind==='video'?{duration_mode:'srt'}:{})})).filter(g=>g.segment_ids.length);
    const summary=groups.map(g=>g.segment_ids.length+' '+(g.kind==='image'?'images':'videos')).join(' + ');
    if(!confirm(`Generate ${summary}? This may use credits.${regenerate?' Completed selected results will be regenerated; their original files remain saved.':' Existing completed results are kept.'} Active jobs are always skipped.`)){reportAction('Generation cancelled. No jobs submitted.');return;}
    window.projectSettings?.assertSaved();window.videoSettings?.assertSaved();
    if(typeof window.studio.openProjectPage!=='function')throw Error('Restart the updated Electron Studio to enable automatic Google Flow tab opening.');
    reportAction('Opening the Google Flow URL saved in Project…');
    await window.studio.openProjectPage(ctx.project_id,'google_flow_url');
    if(scope(context())!==scope(ctx))throw Error('The active video changed while opening Google Flow. No jobs submitted.');
    reportAction('Checking Google Flow and project settings…');
    for(const body of groups){
      if(window.production?.check&&!await window.production.check(body.kind==='image'?'images':'videos',{...ctx,segment_ids:body.segment_ids,silentOnSuccess:true,inlineFailure:true}))throw Error('Generation blocked by the production check. Review project settings and extension connection. No jobs submitted.');
      if(scope(context())!==scope(ctx))throw Error('The active video changed. Generate from its own Prompt to Media.');
    const summary=groups.map(g=>g.segment_ids.length+' '+(g.kind==='image'?'images':'videos')).join(' + ');
    if(!confirm(`Generate ${summary}? This may use credits.${regenerate?' Completed selected results will be regenerated; their original files remain saved.':' Existing completed results are kept.'} Active jobs are always skipped.`))return;
    for(const body of groups){
      if(window.production?.check&&!await window.production.check(body.kind==='image'?'images':'videos',{...ctx,segment_ids:body.segment_ids,silentOnSuccess:true}))return;
      if(scope(context())!==scope(ctx))throw Error('The active video changed. Generate from its own Scene Board.');
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
    }
    window.projectSettings?.assertSaved();window.videoSettings?.assertSaved();
    let queued=0,skipped=items.length-eligible.length,short=false;
    try{
      for(const body of groups){
        if(scope(context())!==scope(ctx))throw Error('The active video changed.');
        reportAction(`Submitting ${body.segment_ids.length} ${body.kind} scenes…`);
        const result=await request('POST','/api/storyboard/videos/'+encodeURIComponent(ctx.video_id)+'/generate-media',body);
        queued+=result.ids?.length||0;skipped+=result.skipped?.length||0;short ||= Boolean(result.durations?.some(d=>d.short));
      }
    }catch(e){throw Error(`${queued} media jobs confirmed queued before this error: ${e.message}. Check Jobs & downloads before trying again.`);}
    finally{document.dispatchEvent(new Event('production-updated'));if(scope(context())===scope(ctx))await open();}
    if(scope(context())!==scope(ctx))return;
    reportAction(`${queued} media jobs queued · ${skipped} scenes skipped.`+(short?' Some SRT scenes exceed the generated clip duration; adjust hold/loop during assembly.':''));
  }
  async function retry(){
    const target=$('scb-target').value,items=selectionItems().filter(s=>failed(s,target)),ctx={...context()};if(!items.length)throw Error('No selected failed scenes need retry for this target. Successful and active results are kept.');
    if(!confirm(`Retry ${items.length} failed scene(s) for ${target.replace('_',' ')}? Inspect uncertain requests and existing downloads first. New generation may use credits.`))return;
    const concept=target.endsWith('_prompt'),kind=concept?'concept':target,prompt_kind=concept?target.replace('_prompt',''):'both',body={segment_ids:items.map(s=>s.id),kind,reviewed:true,provider:'chatgpt-web',prompt_kind,model:null};
    if(window.production?.check && !await window.production.check(concept?prompt_kind+'_prompts':kind==='image'?'images':'videos',{...ctx,segment_ids:body.segment_ids,silentOnSuccess:true,inlineFailure:true}))throw Error('Generation blocked by the production check. Review project settings and extension connection. No jobs submitted.');
    if(scope(context())!==scope(ctx))throw Error('The active video changed. Retry from its own Prompt to Media.');
    window.projectSettings?.assertSaved();window.videoSettings?.assertSaved();
    const result=await request('POST','/api/storyboard/videos/'+encodeURIComponent(ctx.video_id)+'/retry-failed',body);
    if(scope(context())!==scope(ctx))return;
    await open();$('scb-message').textContent=`${result.ids?.length||0} retries queued · ${result.resumed?.length||0} saved remote results resumed · ${result.skipped?.length||0} scenes skipped. Successful results were kept.`;
    document.dispatchEvent(new Event('production-updated'));
  }
  $('scb-model').onchange=()=>{persist();render();};$('scb-ratio').onchange=()=>{persist();render();};$('scb-generate').onclick=()=>run(generateMedia,$('scb-generate'));
  $('scb-model').onchange=persist;$('scb-ratio').onchange=persist;$('scb-generate').onclick=()=>run(generateMedia,$('scb-generate'));
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
  $('scb-show-downloads').onclick=()=>window.sceneDownloads.open();
  $('scb-open-files').onclick=()=>run(openVideoFiles,$('scb-open-files'));
  $('scb-collect').onclick=()=>run(collectImages,$('scb-collect'));
  $('scb-refresh').onclick=()=>run(open);$('scb-filter').onchange=()=>{$('scb-table-scroll').scrollTop=0;render();};$('scb-search').oninput=()=>{$('scb-table-scroll').scrollTop=0;render();};$('scb-target').onchange=persist;
  $('scb-select-all').onchange=()=>{const items=filteredItems();if($('scb-select-all').checked){for(const s of items)if(!choose(s,true))break;}else{for(const s of items)selected.delete(s.id);persist();}render();};
  $('scb-select-filtered').onclick=()=>{const items=filteredItems();for(const s of items)if(!choose(s,true))break;render();};
  $('scb-select-failed').onclick=()=>{selected.clear();for(const s of(data?.segments||[]).filter(matches).filter(s=>failed(s,$('scb-target').value)).slice(0,200))selected.add(s.id);render();};
  $('scb-clear').onclick=()=>{selected.clear();render();};$('scb-retry').onclick=()=>run(retry,$('scb-retry'));$('scb-edit').onclick=()=>run(()=>window.selectProductionVideo?.(context().video_id,'storyboard'));
  document.addEventListener('workflow-changed',()=>{closePromptEditor(true);++ticket;persist();owner='';data=null;selected.clear();closePreview();revokePreviews();clearThumbnailCache();$('scb-rows').replaceChildren();$('scb-count').textContent='';$('scb-image-folder').textContent='';$('scb-message').textContent='Select Prompt to Media to load the active video.';if(!document.querySelector('[data-view="scene-board"]')?.hidden)void open();});
  document.addEventListener('media-jobs-updated',()=>{if(!busy&&!polling&&!document.querySelector('[data-view="scene-board"]')?.hidden)void open();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closePreview();});
  setInterval(async()=>{if(polling||busy||document.querySelector('[data-view="scene-board"]')?.hidden||!data?.segments.some(s=>active.has(s.job?.state)||s.media_jobs?.some(j=>active.has(j.state))))return;polling=true;try{await open();}finally{polling=false;}},5000);
  window.sceneBoard={open,selectSegments:async ids=>{const current=scope(context());await open();if(current!==scope(context()))return;const valid=new Set((data?.segments||[]).map(s=>s.id));selected=new Set(ids.filter(id=>valid.has(id)).slice(0,200));render();if(ids.length>200)$('scb-message').textContent='Selected the first 200 scenes; each action supports up to 200.';},canChangeVideo:()=>!busy&&closePromptEditor(),canChangeProject:()=>!busy&&closePromptEditor()};
})();
