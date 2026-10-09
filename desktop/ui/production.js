'use strict';
(() => {
  const host = document.getElementById('production-dashboard');
  if (!host) return;
  host.innerHTML = `<section class="panel production-panel"><div class="toolbar"><div><h2>Production dashboard</h2><p>Every video keeps its own sources and results. Each stage starts only when you click.</p></div><div class="actions"><button type="button" id="pd-files">Open project folder</button><button type="button" id="pd-refresh">Refresh progress</button></div></div><p id="pd-message" role="status" aria-live="polite"></p><div class="table-wrap"><table class="story-table production-video-table"><thead><tr><th>Video</th><th>Audio</th><th>Word JSON</th><th>SRT</th><th>Image prompts</th><th>Video prompts</th><th>Images</th><th>Video clips</th><th>Render</th><th>Actions</th></tr></thead><tbody id="pd-videos"></tbody></table></div></section><section class="panel space"><div class="toolbar"><h2>Recovery center</h2><button type="button" id="pd-recovery-refresh">Refresh recovery</button></div><p id="pd-recovery-summary">Select a project to inspect saved work.</p><p class="muted">Saved results stay in their original video. Uncertain requests need inspection before retrying; reopening Studio does not resend them.</p><div id="pd-recovery" class="production-recovery"></div></section>`;
  const $ = id => document.getElementById(id);
  const request = (method, path, body) => window.studio.api(method, path, body);
  const node = (tag, text, cls) => { const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el; };
  const ctx = () => window.workflow?.context() || {project_id:$('project-select')?.value || '',video_id:$('video-select')?.value || ''};
  const pages={elevenlabs:'elevenlabs',whisperx:'whisperx',srt:'srt',image_prompts:'storyboard',video_prompts:'storyboard',images:'scene-board',videos:'scene-board',assembly:'assembly'};
  const names={elevenlabs:'Narration',whisperx:'Word JSON',srt:'SRT',image_prompts:'Image prompts',video_prompts:'Video prompts',images:'Images',videos:'Video clips',assembly:'Final video'};
  const states={ready:'Ready',completed:'Complete',running:'Running',queued:'Queued',needs_review:'Needs review',failed:'Failed',missing:'Not started',empty:'Not started',not_started:'Not started',pending:'Not started',partial:'Partially ready',cancelled:'Cancelled',interrupted:'Interrupted',processing:'Processing',waiting_commit:'Awaiting save',submission_uncertain:'Needs review'};
  let ticket=0,loading=false,overview=null,dialog=null,checking=false;
  function human(s) { return states[String(s).toLowerCase()] || String(s || 'Not started').replace(/_/g,' ').toLowerCase(); }
  function button(label,fn) { const b=node('button',label);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){$('pd-message').textContent=e.message;}finally{b.disabled=false;}};return b; }
  async function navigate(video, stage) {
    const before=ctx();
    if(!before.project_id)throw Error('Select a project first.');
    if(await window.selectProductionVideo?.(video,pages[stage] || stage)===false)return false;
    if(ctx().project_id!==before.project_id || ctx().video_id!==video)return false;
    if(['image_prompts','video_prompts'].includes(stage)){
      const picker=$('sb-prompt-kind');if(picker){picker.value=stage==='video_prompts'?'video':'image';picker.dispatchEvent(new Event('change'));}
    }
    return true;
  }
  async function openFiles(videoId=null) {
    const current=ctx();if(!current.project_id)throw Error('Select a project first.');
    $('pd-message').textContent='Organizing saved files…';
    const result=await window.studio.openVideoFiles(current.project_id,videoId);
    if(ctx().project_id!==current.project_id)return;
    $('pd-message').textContent=(result.directory||result.project_directory)+(result.warnings?.length?' · '+result.warnings.join(' · '):'');
  }
  function renderVideos(data) {
    $('pd-videos').replaceChildren();
    if(!data.videos?.length){$('pd-videos').append(node('p','Create a video above to start production.','muted'));return;}
    for(const video of data.videos){
      const card=node('tr');card.dataset.videoId=video.id;card.dataset.active=String(ctx().video_id===video.id);
      const title=node('td'),head=node('div');head.append(node('h3',video.title),node('small',`${video.scene_count || 0} scenes${ctx().video_id===video.id?' · Active video':''}`));
      const actions=node('div',undefined,'actions');actions.append(button('Open video folder',()=>openFiles(video.id)),button('Prompt to Media',()=>navigate(video.id,'scene-board')));
      if(video.next_stage)actions.append(button('Check next step',async()=>{
        if(await window.selectProductionVideo?.(video.id,'projects')===false)return;
        if(ctx().video_id===video.id)await check(video.next_stage);
      }));
      title.append(head);card.append(title);
      if(video.coverage)title.append(node('p',`Scene coverage · ${video.coverage.prompts || 0} / ${video.coverage.total || 0} prompts · ${video.coverage.visuals || 0} / ${video.coverage.total || 0} visuals saved (image or video)`,'muted'));
      if(video.next_stage_reason)title.append(node('p',video.next_stage_reason,'muted'));
      const grid=document.createDocumentFragment();
      for(const stageId of ['elevenlabs','whisperx','srt','image_prompts','video_prompts','images','videos','assembly']){
        const stage=(video.stages||[]).find(s=>s.id===stageId)||{id:stageId,status:'missing'};
        const item=button('',()=>navigate(video.id,stage.id));item.className='production-stage';item.dataset.status=String(stage.status || 'missing').toLowerCase();
        item.append(node('strong',stage.label || names[stage.id] || stage.id),node('span',human(stage.status)),node('small',`${stage.ready || 0} / ${stage.total || 0}${stage.optional?' · Optional':''}`));
        if(stage.total>0){const progress=node('progress');progress.max=stage.total;progress.value=Math.min(stage.total,stage.ready || 0);progress.setAttribute('aria-label',(stage.label||stage.id)+' completed');item.append(progress);}
        const issues=[];for(const [key,label] of [['running','running'],['queued','queued'],['failed','failed'],['needs_review','need review']])if(stage[key])issues.push(`${stage[key]} ${label}`);
        if(issues.length)item.append(node('small',issues.join(' · ')));
        if(stage.latest_job?.error)item.title=stage.latest_job.error;
        const cell=node('td');cell.append(item);grid.append(cell);
      }
      card.append(grid);
      for(const warning of video.warnings || [])title.append(node('p',warning,'production-warning'));
      actions.prepend(button(ctx().video_id===video.id?'Selected':'Select video',()=>navigate(video.id,'projects')),button('Edit',async()=>{if(await navigate(video.id,'projects'))window.workspaceUI?.editVideo();}));
      actions.append(button('Delete',async()=>{if(await window.deleteProductionVideo(video.id))await refresh();}));
      const actionCell=node('td');actionCell.className='table-actions';actionCell.append(actions);card.append(actionCell);
      $('pd-videos').append(card);
    }
  }
  function renderRecovery(data) {
    const counts=data.counts || {};
    $('pd-recovery-summary').textContent=['queued','running','needs_review','failed','resumable','download_recoverable'].map(k=>`${counts[k] || 0} ${k.replace(/_/g,' ')}`).join(' · ')+(data.retained_results?` · ${data.retained_results} completed results retained`:'');
    const target=$('pd-recovery');target.replaceChildren();
    const actionable=(data.jobs || []).filter(job=>job.action).sort((a,b)=>(Number(b.created)||0)-(Number(a.created)||0));
    if(actionable.length)$('pd-recovery-summary').textContent+=` · Showing latest ${Math.min(5,actionable.length)} of ${actionable.length} tasks`;
    target.setAttribute('tabindex','0');target.setAttribute('aria-label','Latest five tasks requiring attention');
    if(!actionable.length){target.append(node('p','No unfinished work needs attention in this project.','muted'));return;}
    const titles=new Map((overview?.videos || []).map(v=>[v.id,v.title]));
    for(const job of actionable.slice(0,5)){
      const row=node('article',undefined,'production-recovery-item');row.dataset.jobId=job.id;
      row.append(node('strong',`${job.title || job.kind} · ${human(job.state)}`),node('small',`${titles.get(job.video_id)||job.video_id||'Unassigned'} · ${names[job.stage]||job.stage||job.kind}`));
      if(job.message)row.append(node('p',job.message));
      if(job.error){const detail=node('details');detail.append(node('summary','Error details'),node('pre',job.error));row.append(detail);}
      if(job.video_id && job.stage)row.append(button(({inspect:'Inspect request',recover_download:'Open audio recovery',resume_render:'Open render recovery',resume_download:'Open download recovery',retry_local:'Open local processing',wait:'View running work',retry:'Review before retry'})[job.action] || 'Open stage',()=>openRecovery(job)));
      if(job.action==='inspect'&&['concept','srt'].includes(job.kind)&&['NEEDS_REVIEW','WAITING_COMMIT','SUBMISSION_UNCERTAIN'].includes(job.state))row.append(button('Open stage',()=>navigate(job.video_id,job.stage)));
      target.append(row);
    }
  }
  async function openRecovery(job){
    if(['image','video','voice'].includes(job.kind)){
      if(await navigate(job.video_id,'scene-board'))await window.focusProductionJob?.(job.id);
    }else if(job.action==='inspect'&&['concept','srt'].includes(job.kind)&&['NEEDS_REVIEW','WAITING_COMMIT','SUBMISSION_UNCERTAIN'].includes(job.state)){
      if(await navigate(job.video_id,'projects')){$('project-app-settings').open=true;$('cg-status')?.click();$('cg-history')?.click();$('cg-state')?.scrollIntoView?.({block:'center'});}
    }else await navigate(job.video_id,job.stage);
  }
  async function refresh() {
    const current=ctx(),version=++ticket;loading=true;
    if(!current.project_id){overview=null;$('pd-videos').replaceChildren();$('pd-recovery').replaceChildren();$('pd-message').textContent='Select a project to view all of its videos.';$('pd-recovery-summary').textContent='Select a project to inspect saved work.';loading=false;return;}
    $('pd-message').textContent='Loading saved progress…';
    const scope='?'+new URLSearchParams({project_id:current.project_id});
    const results=await Promise.allSettled([request('GET','/api/production/overview'+scope),request('GET','/api/production/recovery'+scope)]);
    if(version!==ticket || ctx().project_id!==current.project_id)return;
    loading=false;const errors=[];
    if(results[0].status==='fulfilled'){overview=results[0].value;renderVideos(overview);}else errors.push('Progress: '+results[0].reason.message);
    if(results[1].status==='fulfilled')renderRecovery(results[1].value);else {$('pd-recovery').replaceChildren();$('pd-recovery-summary').textContent='Recovery could not be loaded.';errors.push('Recovery: '+results[1].reason.message);}
    $('pd-message').textContent=errors.length?errors.join(' · '):`${overview?.videos?.length || 0} videos · Updated ${new Date().toLocaleTimeString()} · No stage runs automatically.`;
  }
  function closeReport() { dialog?.remove();dialog=null; }
  async function check(stage, options={}) {
    if(checking)throw Error('A production check is already running.');
    const current={...ctx()};if(!current.project_id || !current.video_id)throw Error('Select a project and video before checking a stage.');
    if(options.project_id && options.project_id!==current.project_id || options.video_id && options.video_id!==current.video_id)throw Error('The requested video is no longer active. Run the check again.');
    checking=true;
    try{
      const {silentOnSuccess,inlineFailure,...input}=options;
      const report=await request('POST','/api/production/preflight',{...input,...current,stage});
      if(current.project_id!==ctx().project_id || current.video_id!==ctx().video_id)throw Error('The active video changed. Run the check again for the selected video.');
      closeReport();
      if(inlineFailure&&report.blocked)throw Error((report.checks||[]).filter(item=>item.status==='fail').map(item=>item.message).join(' · ')||'Production check blocked generation. Check project settings and extension connection.');
      if(stage==='whisperx'){
        if(report.blocked)throw Error((report.checks||[]).filter(item=>item.status==='fail').map(item=>item.message).join(' · ')||'WhisperX is not ready. Run Check environment for details.');
        return true;
      }
      dialog=node('div',undefined,'production-modal');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Production preflight');
      const panel=node('section',undefined,'panel production-modal-panel'),header=node('div',undefined,'toolbar');header.append(node('h2',`${names[stage]||stage} · ${report.blocked?'Action required':'Ready to start'}`),button('Close',closeReport));panel.append(header);
      const checks=node('ul',undefined,'production-checks');for(const item of report.checks || []){const li=node('li');li.dataset.status=item.status;li.append(node('strong',({pass:'Ready',warn:'Note',fail:'Fix required'})[item.status]||item.status),node('span',item.message));checks.append(li);}panel.append(checks,node('p',report.blocked?'Resolve the items above before starting this stage.':'The check is complete. Continue from the selected stage when ready.','muted'));dialog.append(panel);document.body.append(dialog);
      dialog.querySelector('button')?.focus();
      if(!report.blocked && options.silentOnSuccess)closeReport();
      return !report.blocked;
    }finally{checking=false;}
  }
  $('pd-files').onclick=async()=>{$('pd-files').disabled=true;try{await openFiles();}catch(e){$('pd-message').textContent=e.message;}finally{$('pd-files').disabled=false;}};
  $('pd-refresh').onclick=()=>void refresh();$('pd-recovery-refresh').onclick=()=>void refresh();
  document.addEventListener('project-changed',()=>{++ticket;overview=null;$('pd-videos').replaceChildren();$('pd-recovery').replaceChildren();queueMicrotask(()=>void refresh());});
  document.addEventListener('workflow-changed',()=>{closeReport();if(overview)renderVideos(overview);});
  document.addEventListener('production-updated',()=>void refresh());
  document.querySelector('[data-page="projects"]')?.addEventListener('click',()=>void refresh());
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeReport();});
  setInterval(()=>{if(!loading && !document.querySelector('[data-view="projects"]')?.hidden && ctx().project_id)void refresh();},15000);
  window.production={refresh,check,navigate};
  void refresh();
})();
