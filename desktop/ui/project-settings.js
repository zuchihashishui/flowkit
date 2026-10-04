(() => {
 'use strict';
 const $=id=>document.getElementById(id),keys=['chatgpt_url','image_prompt_url','video_prompt_url','elevenlabs_url','google_flow_url'];
 let owner='',revision=0,dirty=false,busy=false,ticket=0;
 const message=text=>{$('ps-message').textContent=text;};
 function lock(value){for(const el of $('project-settings-form').querySelectorAll('input,button'))el.disabled=value;}
 async function load(pid){
  const turn=++ticket;owner=pid;dirty=false;revision=0;lock(true);for(const k of keys)$('ps-'+k).value='';
  if(!pid){message('Select a project to edit its settings.');return;}
  try{
   const settings=await window.studio.api('GET','/api/projects/'+pid+'/settings');
   if(turn!==ticket)return;
   for(const k of keys)$('ps-'+k).value=settings[k];revision=settings.revision;
   message('Saved project settings · Revision '+revision);lock(false);
  }catch(e){if(turn===ticket){message(e.message);$('ps-reload').disabled=false;}}
 }
 $('project-settings-form').oninput=()=>{dirty=true;message('Unsaved settings. Save before starting new jobs.');};
 $('project-settings-form').onsubmit=async event=>{
  event.preventDefault();if(busy||!owner)return;
  busy=true;lock(true);const pid=owner;
  try{
   const body={revision};for(const k of keys)body[k]=$('ps-'+k).value.trim();
   const saved=await window.studio.api('PUT','/api/projects/'+pid+'/settings',body);
   revision=saved.revision;dirty=false;message('Saved for every video in this project. Existing jobs keep their previous URLs.');
  }catch(e){message(e.message);}finally{busy=false;lock(false);}
 };
 $('ps-reload').onclick=()=>{if(!dirty||confirm('Discard unsaved project settings?'))void load(owner);};
 document.querySelectorAll('[data-project-page]').forEach(b=>b.onclick=async()=>{
  if(dirty){message('Save project settings before opening this page.');return;}
  try{await window.studio.openProjectPage(owner,b.dataset.projectPage);}catch(e){message(e.message);}
 });
 window.projectSettings={assertSaved:()=>{if(busy||dirty)throw Error('Save project settings in Project before starting new jobs.');},canChangeProject:pid=>{
  if(owner===pid)return true;
  if(busy){message('Wait for settings to finish saving.');return false;}
  return !dirty||confirm('Discard unsaved project settings?');
 }};
 document.addEventListener('project-changed',e=>void load(e.detail.id));
 void load($('project-select').value);
})();
