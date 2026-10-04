(() => {
 'use strict';
 const host=document.getElementById('project-maintenance');if(!host)return;
 const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
 const title=node('h2','Project templates & backups');
 const copyForm=node('form'),copyLabel=node('label','Name of copied project'),copyName=node('input'),copyButton=node('button','Duplicate project settings');
 copyName.id='maintenance-copy-name';copyName.maxLength=200;copyName.required=true;copyLabel.htmlFor=copyName.id;copyButton.type='submit';copyButton.id='maintenance-copy';
 copyForm.append(copyLabel,copyName,copyButton,node('small','Copies saved project settings into a new project. Videos, scenes and jobs are not copied. The Google Flow destination is shared until changed.'));
 const backupHeading=node('h3','Studio backup'),mediaLabel=node('label'),includeMedia=node('input');includeMedia.type='checkbox';includeMedia.id='maintenance-media';
 mediaLabel.append(includeMedia,document.createTextNode(' Include generated and imported media (larger backup)'));
 const explanation=node('p','Backs up all projects, videos, settings and job history. Finish or cancel queued and active work first. A database-only backup excludes audio, transcript files, images and rendered videos.');
 const controls=node('div'),create=node('button','Create backup'),refresh=node('button','Refresh backups'),restore=node('button','Restore backup to new folder');
 create.id='maintenance-create';refresh.id='maintenance-refresh';restore.id='maintenance-restore';controls.className='inline';controls.append(create,refresh,restore);
 const message=node('p'),list=node('div'),instructions=node('pre');message.id='maintenance-message';message.setAttribute('role','status');list.id='maintenance-backups';instructions.id='maintenance-instructions';instructions.hidden=true;instructions.style.whiteSpace='pre-wrap';
 host.replaceChildren(title,copyForm,backupHeading,explanation,mediaLabel,controls,message,list,instructions);
 let busy=false,polling=false,disposed=false,backupBusy=false;
 const project=()=>window.workflow?.context()?.project_id||document.getElementById('project-select')?.value||'';
 function locked(value){busy=value;create.disabled=value||backupBusy;restore.disabled=value;includeMedia.disabled=value||backupBusy;copyButton.disabled=value||backupBusy||!project();copyName.disabled=value||backupBusy||!project();}
 const say=text=>{message.textContent=text;};
 function projectChanged(event){if(!busy)copyName.value=(event?.detail?.name||document.getElementById('project-select')?.selectedOptions?.[0]?.textContent||'Project')+' copy';locked(busy);}
 async function load(){
  if(polling||disposed)return;
  polling=true;
  try{
   const data=await window.studio.api('GET','/api/maintenance/backups');
   if(disposed)return;
   list.replaceChildren();
   for(const item of data.backups||[]){
    const row=node('div'),name=node('strong',item.filename),state=node('small',item.state+(item.bytes?' · '+(item.bytes/1024/1024).toFixed(1)+' MiB':''));row.className='item';row.append(name,state);
    if(item.error)row.append(node('p',item.error));
    if(item.state==='COMPLETED'){
     const save=node('button','Save ZIP');save.dataset.backupId=item.id;
     save.onclick=async()=>{save.disabled=true;try{const result=await window.studio.maintenanceSaveBackup(item.id);if(!result.canceled)say('Backup saved: '+result.path);}catch(error){say(error.message);}finally{save.disabled=false;}};row.append(save);
    }
    list.append(row);
   }
   if(!data.backups?.length)list.append(node('p','No backups yet.'));
   backupBusy=!!data.busy;locked(busy);
  }catch(error){say(error.message);}finally{polling=false;}
 }
 copyForm.onsubmit=async event=>{
  event.preventDefault();if(busy||!copyForm.reportValidity())return;
  const pid=project();if(!pid){say('Select a project first.');return;}
  try{
   window.projectSettings?.assertSaved();locked(true);
   const result=await window.studio.api('POST','/api/maintenance/duplicate-project',{project_id:pid,name:copyName.value.trim()});
   if(typeof window.refreshStudioProjects==='function')await window.refreshStudioProjects();
   say(`Created “${result.project.name}”. Select it from the project list. ${result.message||''}`);
  }catch(error){say(error.message);}finally{locked(false);}
 };
 create.onclick=async()=>{
  if(busy)return;locked(true);say('Preparing Studio backup…');
  try{await window.studio.api('POST','/api/maintenance/backups',{include_media:includeMedia.checked});backupBusy=true;say('Backup started. It will appear below when ready.');await load();}
  catch(error){say(error.message);}finally{locked(false);}
 };
 refresh.onclick=()=>void load();
 restore.onclick=async()=>{
  if(busy)return;locked(true);instructions.hidden=true;say('Choose a backup ZIP and its new parent folder. Large backups may take several minutes to verify and restore.');
  try{
   const result=await window.studio.maintenanceRestore();
   if(result.canceled){say('Restore cancelled.');return;}
   say('Restored to '+result.directory+'. Current Studio data remains unchanged.'+(result.missing_media_paths?' Some media references are missing; use a media-inclusive backup to transfer those files.':'')+(result.note?' '+result.note:''));
   instructions.textContent=result.instructions;instructions.hidden=false;
  }catch(error){say(error.message);}finally{locked(false);}
 };
 document.addEventListener('project-changed',projectChanged);
 document.addEventListener('workflow-changed',()=>locked(busy));
 const timer=setInterval(()=>{if(!document.hidden)void load();},5000);
 window.addEventListener('beforeunload',()=>{disposed=true;clearInterval(timer);});
 locked(false);void load();
})();
