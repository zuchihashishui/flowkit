'use strict';
(() => {
  const host=document.getElementById('scene-board');if(!host)return;
  host.innerHTML=`<section class="panel"><div class="toolbar"><div><h2>Scene Board</h2><p>Review narration, prompts and current media together. Successful results are preserved when retrying failed scenes.</p></div><button id="scb-collect" type="button">Collect saved images</button><button id="scb-refresh" type="button">Refresh scenes</button></div><div class="scene-board-controls"><label>Show<select id="scb-filter"><option value="all">All scenes</option><option value="failed">Failed scenes</option><option value="needs_review">Needs review</option><option value="missing_image_prompt">Missing image prompt</option><option value="missing_video_prompt">Missing video prompt</option><option value="missing_image">Missing image</option><option value="missing_video">Missing video clip</option><option value="ready">Image or video saved</option></select></label><label>Search narration or prompts<input id="scb-search" type="search" placeholder="Find a scene…" maxlength="500"></label><label>Retry target<select id="scb-target"><option value="image_prompt">Image prompt</option><option value="video_prompt">Video prompt</option><option value="image">Image generation</option><option value="video">Video generation</option></select></label></div><div class="scene-board-controls"><label>Image Model<select id="scb-model"><option value="">Backend default</option></select></label><label>Aspect Ratio<select id="scb-ratio"><option value="HORIZONTAL">16:9 · Landscape</option><option value="VERTICAL">9:16 · Portrait</option></select></label></div><p>Image settings apply to new generation. Retry uses the original job settings and resumes saved remote results when available.</p><div class="actions space"><button id="scb-generate" type="button">Generate selected images</button><button id="scb-select-filtered" type="button">Select filtered scenes (up to 200)</button><button id="scb-select-failed" type="button">Select failed for target</button><button id="scb-clear" type="button">Clear selection</button><button id="scb-retry" type="button">Retry selected failed scenes</button><button id="scb-edit" type="button">Open SRT to Prompt</button></div><p id="scb-message" role="status" aria-live="polite">Choose a project and video in Project.</p><p id="scb-image-folder" class="scene-board-folder"></p><p id="scb-count" class="scene-board-count"></p><div id="scb-table-scroll" class="table-wrap" tabindex="0" role="region" aria-label="Scene Board scenes"><table class="story-table sb-table scene-board-table"><thead><tr><th>Select</th><th>Scene / time</th><th>Narration</th><th>Image / video prompts</th><th>Current media</th><th>Activity / actions</th></tr></thead><tbody id="scb-rows"></tbody></table></div></section>`;
  const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
  const context=()=>window.workflow?.context()||{project_id:$('project-select')?.value||'',video_id:$('video-select')?.value||''};
  const scope=c=>`${c.project_id||''}/${c.video_id||''}`;
  const request=(method,path,body)=>window.studio.api(method,path,body);
  const terminal=new Set(['FAILED','NEEDS_REVIEW','INTERRUPTED','CANCELLED']),active=new Set(['QUEUED','SUBMITTING','RUNNING','DOWNLOADING']);
  let owner='',data=null,selected=new Set(),ticket=0,renderVersion=0,busy=false,polling=false,dialog=null;
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
  function persist(){if(!owner)return;try{localStorage.setItem(stateKey(),JSON.stringify({filter:$('scb-filter').value,search:$('scb-search').value,target:$('scb-target').value,image_model:$('scb-model').value,orientation:$('scb-ratio').value,selected:[...selected].slice(0,200)}));}catch{}}
  function restore(){let stored={};try{stored=JSON.parse(localStorage.getItem(stateKey())||'{}');}catch{}for(const [id,key,fallback]of[['scb-filter','filter','all'],['scb-target','target','image_prompt']]){$(id).value=stored[key]||fallback;if(!$(id).value)$(id).value=fallback;}setImageSettings(stored);$('scb-search').value=String(stored.search||'').slice(0,500);selected=new Set(Array.isArray(stored.selected)?stored.selected.filter(x=>typeof x==='string').slice(0,200):[]);}
  function setImageSettings(stored={}){
    const defaults=window.videoSettings?.effective()?.media||{};
    const model=stored.image_model??defaults.image_model??'';
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
      const existing=[...$('scb-model').options].find(o=>o.value===key);
      if(existing)existing.textContent=name;else $('scb-model').append(new Option(name,key));
    }
    $('scb-model').value=value;modelsLoaded=true;
  }
  function time(ms){const n=Math.max(0,Math.round(Number(ms)||0));return [Math.floor(n/3600000),Math.floor(n/60000)%60,Math.floor(n/1000)%60].map(x=>String(x).padStart(2,'0')).join(':')+'.'+String(n%1000).padStart(3,'0');}
  function revokePreviews(){observer?.disconnect();observer=null;previewQueue=[];++renderVersion;}
  function clearThumbnailCache(){++cacheEpoch;for(const url of urls)URL.revokeObjectURL(url);urls.clear();thumbnailCache.clear();thumbnailLoads.clear();}
  function closePreview(){dialog?.remove();dialog=null;if(dialogUrl){URL.revokeObjectURL(dialogUrl);dialogUrl=null;}}
  function actionButton(label,fn){const b=node('button',label);b.type='button';b.onclick=()=>run(fn,b);return b;}
  async function run(fn,control){if(busy)return;busy=true;const own=owner;if(control)control.disabled=true;try{await fn();}catch(e){if(owner===own)$('scb-message').textContent=e.message;}finally{busy=false;if(control)control.disabled=false;}}
  async function openPreview(s,job){
    const own=owner,version=renderVersion,result=await window.studio.preview(job.id,0);
    if(own!==owner||version!==renderVersion)return;
    closePreview();dialogUrl=URL.createObjectURL(new Blob([result.bytes],{type:result.mime}));
    dialog=node('div',undefined,'production-modal');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Scene media preview');
    const panel=node('section',undefined,'panel production-modal-panel'),head=node('div',undefined,'toolbar');head.append(node('h2',`Scene ${String(s.ordinal).padStart(3,'0')} · ${job.kind}`),actionButton('Close',async()=>closePreview()));
    const media=node(job.kind==='video'?'video':'img');media.src=dialogUrl;if(job.kind==='video'){media.controls=true;media.preload='metadata';}else media.alt=`Scene ${s.ordinal}`;
    panel.append(head,media,node('p',s.text));dialog.append(panel);document.body.append(dialog);dialog.querySelector('button')?.focus();
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
  function render(){
    const viewport=$('scb-table-scroll'),scrollTop=viewport.scrollTop,scrollLeft=viewport.scrollLeft;
    revokePreviews();
    $('scb-image-folder').textContent=data?.image_output_directory?'Scene images: '+data.image_output_directory+' · Named 001, 002, 003… (original image format). New images are collected automatically.':'';
    if(typeof IntersectionObserver==='function')observer=new IntersectionObserver(entries=>{for(const item of entries)if(item.isIntersecting){observer.unobserve(item.target);previewQueue.push(item.target._previewEntry);}pumpPreviews();},{root:viewport,rootMargin:'250px'});
    const items=(data?.segments||[]).filter(matches),rows=$('scb-rows');rows.replaceChildren();
    $('scb-count').textContent=`${selected.size} selected · ${items.length} matching / ${data?.segments?.length||0} scenes${data?.video?.title?' · '+data.video.title:''}`;
    for(const s of items){
      const tr=node('tr');tr.dataset.segmentId=s.id;const pick=node('td'),box=node('input');box.type='checkbox';box.checked=selected.has(s.id);box.setAttribute('aria-label','Select scene '+s.ordinal);box.onchange=()=>{if(!choose(s,box.checked))box.checked=false;$('scb-count').textContent=`${selected.size} selected · ${items.length} matching / ${data.segments.length} scenes · ${data.video.title}`;};pick.append(box);
      const timing=node('td');timing.append(node('strong',String(s.ordinal).padStart(3,'0')),node('small',time(s.start_ms)),node('small',time(s.end_ms)),node('small',((s.end_ms-s.start_ms)/1000).toFixed(3)+' s'));
      const text=node('td');text.append(node('p',s.text));const prompts=node('td');
      for(const kind of ['image','video']){prompts.append(node('strong',kind==='image'?'Image prompt':'Video prompt'));const p=node('p',s.active_concept?.[kind+'_prompt']||'No saved prompt.','scene-board-prompt');if(!hasPrompt(s,kind)&&s.active_concept?.[kind+'_prompt'])p.prepend(node('strong','Outdated · '));prompts.append(p);}
      const media=node('td');for(const kind of ['image','video']){
        const group=node('div',undefined,'scene-board-media'),job=saved(s,kind),pending=currentJobs(s,kind).find(j=>active.has(j.state));group.append(node('strong',kind==='image'?'Image':'Video clip'));
        if(job){const status=node('small',kind==='image'?'Loading preview…':'Saved clip');group.append(status);if(kind==='image'){const image=node('img',undefined,'scene-board-thumb');image.alt=`Scene ${s.ordinal} image preview`;image.width=180;image.height=105;image.setAttribute('tabindex','0');image.onclick=()=>run(()=>openPreview(s,job));image.onkeydown=e=>{if(e.key==='Enter')image.click();};group.append(image);setTimeout(()=>{if(image.isConnected)queueThumbnail(image,job,status);},0);}group.append(actionButton(kind==='image'?'View image':'Play clip',()=>openPreview(s,job)));}
        else group.append(node('small',pending?pending.state.replace(/_/g,' ').toLowerCase():hasPrompt(s,kind)?'No current file':'Create a current prompt first'));
        const older=(s.media_jobs||[]).filter(j=>j.kind===kind&&!isCurrent(j,s)&&j.files?.length).length;if(older)group.append(node('small',`${older} older result(s) retained`));media.append(group);
      }
      const activity=node('td');if(s.job){const status=node('small','Prompt · '+s.job.state);status.dataset.state=s.job.state;activity.append(status);}
      for(const job of (s.media_jobs||[]).filter(j=>isCurrent(j,s))){const status=node('small',job.kind+' · '+job.state);status.dataset.state=job.state;activity.append(status);}
      const errors=[s.job?.error,...(s.media_jobs||[]).filter(j=>isCurrent(j,s)).map(j=>j.error)].filter(Boolean);if(errors.length){const details=node('details');details.append(node('summary','Error details'),node('p',[...new Set(errors)].join('\n'),'scene-board-error'));activity.append(details);}
      activity.append(actionButton('Edit scene',async()=>{if(await window.selectProductionVideo?.(context().video_id,'storyboard')===false)return;await window.storyboard?.openSegment?.(s.id);}));
      tr.append(pick,timing,text,prompts,media,activity);rows.append(tr);
    }
    if(!items.length){const tr=node('tr'),td=node('td',data?.segments?.length?'No scenes match this filter.':'Import SRT scenes in SRT to Prompt to begin.');td.colSpan=6;tr.append(td);rows.append(tr);}
    viewport.scrollTop=scrollTop;viewport.scrollLeft=scrollLeft;
    persist();
  }
  async function open(){
    const ctx=context(),current=scope(ctx),version=++ticket;
    if(owner!==current){persist();owner=current;data=null;$('scb-table-scroll').scrollTop=0;selected.clear();restore();closePreview();clearThumbnailCache();render();}
    if(!ctx.project_id||!ctx.video_id){$('scb-message').textContent='Select a project and video in Project.';return;}
    $('scb-message').textContent='Loading scene status…';
    try{const result=await request('GET','/api/storyboard/videos/'+encodeURIComponent(ctx.video_id));if(version!==ticket||scope(context())!==current)return;
      if(result.video?.project_id!==ctx.project_id||result.video?.id!==ctx.video_id)throw Error('The scene source does not belong to the active video.');
      await loadModels();if(version!==ticket||scope(context())!==current)return;data=result;const valid=new Set(data.segments.map(s=>s.id));selected=new Set([...selected].filter(id=>valid.has(id)));render();$('scb-message').textContent=(data.warnings||[]).join(' · ')||'Current prompts and media are matched to each scene. Existing files remain saved.';
    }catch(e){if(version===ticket&&scope(context())===current)$('scb-message').textContent=e.message;}
  }
  function selectionItems(){if(owner!==scope(context())||!data?.document)throw Error('Load the active video and import its SRT scenes first.');const items=data.segments.filter(s=>selected.has(s.id));if(!items.length||items.length>200)throw Error('Select 1–200 scenes.');return items;}
  async function collectImages(){
    const ctx={...context()};
    if(owner!==scope(ctx)||!data?.document)throw Error('Load a video with SRT scenes first.');
    $('scb-message').textContent='Collecting saved images…';
    const result=await request('POST','/api/storyboard/videos/'+encodeURIComponent(ctx.video_id)+'/collect-images',{});
    if(scope(context())!==scope(ctx))return;
    $('scb-message').textContent=`${result.files?.length||0} images collected in ${result.directory}. `+(result.warnings||[]).join(' · ');
  }
  async function generateImages(){
    const items=selectionItems(),ctx={...context()};
    if(items.some(s=>!hasPrompt(s,'image')))throw Error('Every selected scene needs a current image prompt. Create it in SRT to Prompt first.');
    const eligible=items.filter(s=>!currentJobs(s,'image').some(j=>active.has(j.state)||j.state==='COMPLETED'));
    if(!eligible.length)throw Error('Selected scenes already have completed or active images. Existing results were kept.');
    const body={segment_ids:eligible.map(s=>s.id),kind:'image',image_model:$('scb-model').value||null,orientation:$('scb-ratio').value,regenerate:false};
    if(!confirm(`Generate images for ${eligible.length} selected scene(s)? This may use credits. Existing completed and active images will be kept.`))return;
    if(window.production?.check&&!await window.production.check('images',{...ctx,segment_ids:body.segment_ids,silentOnSuccess:true}))return;
    if(scope(context())!==scope(ctx))throw Error('The active video changed. Generate from its own Scene Board.');
    window.projectSettings?.assertSaved();window.videoSettings?.assertSaved();
    const result=await request('POST','/api/storyboard/videos/'+encodeURIComponent(ctx.video_id)+'/generate-media',body);
    if(scope(context())!==scope(ctx))return;
    await open();$('scb-message').textContent=`${result.ids?.length||0} images queued · ${(result.skipped?.length||0)+items.length-eligible.length} scenes skipped. Existing completed and active images were kept.`;
    document.dispatchEvent(new Event('production-updated'));
  }
  async function retry(){
    const target=$('scb-target').value,items=selectionItems().filter(s=>failed(s,target)),ctx={...context()};if(!items.length)throw Error('No selected failed scenes need retry for this target. Successful and active results are kept.');
    if(!confirm(`Retry ${items.length} failed scene(s) for ${target.replace('_',' ')}? Inspect uncertain requests and existing downloads first. New generation may use credits.`))return;
    const concept=target.endsWith('_prompt'),kind=concept?'concept':target,prompt_kind=concept?target.replace('_prompt',''):'both',body={segment_ids:items.map(s=>s.id),kind,reviewed:true,provider:'chatgpt-web',prompt_kind,model:null};
    if(window.production?.check && !await window.production.check(concept?prompt_kind+'_prompts':kind==='image'?'images':'videos',{...ctx,segment_ids:body.segment_ids,silentOnSuccess:true}))return;
    if(scope(context())!==scope(ctx))throw Error('The active video changed. Retry from its own Scene Board.');
    window.projectSettings?.assertSaved();window.videoSettings?.assertSaved();
    const result=await request('POST','/api/storyboard/videos/'+encodeURIComponent(ctx.video_id)+'/retry-failed',body);
    if(scope(context())!==scope(ctx))return;
    await open();$('scb-message').textContent=`${result.ids?.length||0} retries queued · ${result.resumed?.length||0} saved remote results resumed · ${result.skipped?.length||0} scenes skipped. Successful results were kept.`;
    document.dispatchEvent(new Event('production-updated'));
  }
  $('scb-model').onchange=persist;$('scb-ratio').onchange=persist;$('scb-generate').onclick=()=>run(generateImages,$('scb-generate'));
  $('scb-collect').onclick=()=>run(collectImages,$('scb-collect'));
  $('scb-refresh').onclick=()=>run(open);$('scb-filter').onchange=()=>{$('scb-table-scroll').scrollTop=0;render();};$('scb-search').oninput=()=>{$('scb-table-scroll').scrollTop=0;render();};$('scb-target').onchange=persist;
  $('scb-select-filtered').onclick=()=>{const items=(data?.segments||[]).filter(matches);for(const s of items)if(!choose(s,true))break;render();};
  $('scb-select-failed').onclick=()=>{selected.clear();for(const s of(data?.segments||[]).filter(matches).filter(s=>failed(s,$('scb-target').value)).slice(0,200))selected.add(s.id);render();};
  $('scb-clear').onclick=()=>{selected.clear();render();};$('scb-retry').onclick=()=>run(retry,$('scb-retry'));$('scb-edit').onclick=()=>run(()=>window.selectProductionVideo?.(context().video_id,'storyboard'));
  document.addEventListener('workflow-changed',()=>{++ticket;persist();owner='';data=null;selected.clear();closePreview();revokePreviews();clearThumbnailCache();$('scb-rows').replaceChildren();$('scb-count').textContent='';$('scb-image-folder').textContent='';$('scb-message').textContent='Select Scene Board to load the active video.';if(!document.querySelector('[data-view="scene-board"]')?.hidden)void open();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closePreview();});
  setInterval(async()=>{if(polling||busy||document.querySelector('[data-view="scene-board"]')?.hidden||!data?.segments.some(s=>active.has(s.job?.state)||s.media_jobs?.some(j=>active.has(j.state))))return;polling=true;try{await open();}finally{polling=false;}},5000);
  window.sceneBoard={open,canChangeVideo:()=>!busy,canChangeProject:()=>!busy};
})();
