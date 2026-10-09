'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  const button=(label,fn)=>{const b=node('button',label);b.type='button';b.onclick=fn;return b;};
  function fold(target,title,open=false){
    if(!target)return null;const d=node('details');d.className='workspace-fold';d.open=open;d.append(node('summary',title));target.before(d);d.append(target);return d;
  }
  function drawer(target,title){
    const d=node('section');d.className='record-drawer';d.hidden=true;d.setAttribute('role','region');d.setAttribute('aria-label',title);
    const bar=node('div');bar.className='toolbar';bar.append(node('h2',title),button('Close',()=>{d.hidden=true;opener?.focus({preventScroll:true});}));
    d.append(bar);target.before(d);d.append(target);let opener;
    return {element:d,open:()=>{opener=document.activeElement;d.hidden=false;d.scrollTop=0;d.querySelector('input,textarea,select')?.focus({preventScroll:true});}};
  }
  const projects=document.querySelector('[data-view=projects]');
  // Project list stays visible; creation and settings no longer consume the page.
  const projectSplit=$('project-form').parentElement;
  const createPopup=(form,title)=>window.studioPopups?.modal(form,title,{canClose:()=>!form.querySelector('button[type=submit]:disabled')});
  const projectCreate=createPopup($('project-form'),'New project');
  if(projectSplit?.classList.contains('split'))projectSplit.classList.remove('split');
  const newProject=button('New project',()=>projectCreate?.open());newProject.id='workspace-new-project';projects.querySelector('.toolbar')?.append(newProject);
  const projectSettings=drawer($('project-settings-form'),'Project settings');
  const editProject=$('edit-project')?.parentElement;if(editProject)projectSettings.element.insertBefore(editProject,$('project-settings-form'));
  const settingsButton=button('Project settings',()=>projectSettings.open());settingsButton.id='workspace-project-settings';
  projects.querySelector('.toolbar')?.append(settingsButton);
  const videoPanel=$('project-videos')?.closest('.panel');
  const videoCreate=createPopup($('create-video'),'New video');
  const videoEditor=drawer($('edit-video'),'Video settings');
  if($('video-settings'))videoEditor.element.append($('video-settings'));
  if($('apply-production-defaults'))videoEditor.element.append($('apply-production-defaults').parentElement);
  // Production overview is the single visible video list. Keep existing selector events.
  const dashboard=$('production-dashboard');
  if(dashboard&&videoPanel){
    const tools=node('div');tools.className='toolbar';
    tools.append($('video-select').closest('label'),$('refresh-videos'),button('New video',()=>videoCreate?.open()),button('Edit selected video',()=>videoEditor.open()));
    dashboard.before(tools,videoEditor.element);videoPanel.hidden=true;
  }
  const scenes=$('scenes')?.closest('.panel');fold(scenes,'Manual scene import / editing (advanced)');
  fold($('wf-resources')?.closest('.panel'),'Video sources & history');
  fold($('project-maintenance'),'Backup / maintenance');
  fold($('pd-recovery')?.closest('section'),'Recovery center');
  const instructions=$('sb-file-image')?.parentElement?.parentElement;
  if(instructions){
    const table=node('table');table.className='story-table instruction-table';
    const head=table.createTHead().insertRow();for(const text of ['Instructions','TXT file','Actions'])head.append(node('th',text));
    const body=table.createTBody();body.id='instruction-rows';
    for(const [key,label] of [['image','Image'],['video_4s','Video 4s'],['video_6s','Video 6s'],['video_8s','Video 8s'],['video_10s','Video 10s']]){
      const file=$('sb-file-'+key),upload=$('sb-upload-'+key),old=upload.parentElement,row=body.insertRow();
      row.append(node('td',label));const fileCell=node('td'),actions=node('td');fileCell.append(file);
      upload.hidden=true;actions.append(upload,button('Project settings',()=>window.projectInstructions?.open()));row.append(fileCell,actions);old.remove();
    }
    instructions.prepend(table);
  }
  $('sb-choose-prompt').hidden=true;
  fold($('sb-inputs'),'SRT source & shared project instructions');
  const generation=$('sb-provider')?.closest('.inline');fold(generation,'Generation settings · Chat / video rows / image batch size');
  const instructionEdit=$('sb-template')?.closest('details');let instructionDrawer;
  if(instructionEdit){instructionEdit.hidden=true;instructionEdit.classList.add('instruction-editor');instructionDrawer=drawer(instructionEdit,'Prompt instructions');document.querySelector('[data-view=storyboard]').append(instructionDrawer.element);instructionDrawer.element.append(button('Save instructions',()=>$('sb-save-options').click()));}
  fold($('sb-workers'),'ChatGPT worker details');
  const help=$('sb-select-all')?.closest('.toolbar')?.nextElementSibling;
  if(help?.tagName==='SMALL')fold(help,'How video and image batches run');
  $('sb-select-all')?.closest('.toolbar')?.classList.add('workspace-main-actions');
  const discard=button('Discard row / setting edits',()=>window.discardPromptOptions?.());
  $('sb-save-options')?.after(discard);
  // Keep long input forms available without pushing job tables off screen.
  for(const [id,title] of [['el-form','New narration & connection'],['wx-form','New transcription & environment'],['srt-form','New SRT & source preview']]){
    const form=$(id);if(form)fold(form.closest('.split')||form,title);
  }
  const assembly=document.querySelector('[data-view=assembly]>.split');fold(assembly,'Sources & render settings');
  for(const table of document.querySelectorAll('table')){
    const id=table.tBodies[0]?.id;
    if(id==='instruction-rows'||id==='sb-worker-rows')continue;
    window.studioTables.enhance(table,{search:!['sb-rows','scb-rows','all-jobs'].includes(id)});
  }
  document.addEventListener('click',event=>{
    const btn=event.target.closest('button');if(!btn)return;
    // Details nested in a collapsed source panel must be visible when opened from a row.
    if(/^(Preview SRT|Preview words|Quality report|View \/ edit)$/.test(btn.textContent.trim())){
      const target=btn.textContent.includes('words')?$('wx-result'):btn.textContent.includes('edit')?$('sb-template'):$('srt-preview');
      for(let p=target?.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;
    }
  });
  document.addEventListener('studio-record-created',e=>{(e.detail.kind==='project'?projectCreate:videoCreate)?.close(true);});
  document.addEventListener('studio-notice',e=>{for(const popup of [projectCreate,videoCreate])if(popup?.dialog.open){popup.feedback.textContent=e.detail.text;popup.feedback.classList.toggle('error',e.detail.error);}});
  window.workspaceUI={projectSettings:()=>projectSettings.open(),editVideo:()=>videoEditor.open()};
})();
