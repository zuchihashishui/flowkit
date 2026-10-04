(() => {
 'use strict';
 const host=document.getElementById('video-settings');
 if(!host||!window.productionSettingsEditor)return;
 const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
 const heading=node('h2','Video production settings'),intro=node('p','Settings inherit from this project unless you enable an override. Changes apply to new jobs only.'),form=node('form'),fields=node('div'),actions=node('div'),save=node('button','Save video settings'),reset=node('button','Use project defaults'),reload=node('button','Reload'),message=node('p');
 form.id='video-settings-form';fields.id='vs-fields';save.id='vs-save';save.type='submit';reset.id='vs-reset';reset.type='button';reload.id='vs-reload';reload.type='button';message.id='vs-message';actions.className='actions';message.className='hint';
 actions.append(save,reset,reload);form.append(fields,actions,message);host.replaceChildren(heading,intro,form);
 const editor=window.productionSettingsEditor.create(fields,'vs',true);
 let owner={project_id:'',video_id:''},current=null,dirty=false,busy=false,ticket=0,readyPromise=Promise.resolve();
 const key=ctx=>`${ctx.project_id||''}/${ctx.video_id||''}`;
 const say=text=>{message.textContent=text;};
 function lock(value){editor.lock(value);for(const b of [save,reset,reload])b.disabled=value;}
 function emit(){if(current)document.dispatchEvent(new CustomEvent('production-settings-changed',{detail:{...owner,production:current.effective,effective:current.effective,revision:current.revision,project_revision:current.project_revision}}));}
 async function load(ctx){
  if(key(ctx)===key(owner)&&(busy||dirty))return;
  const turn=++ticket;owner={project_id:ctx.project_id||'',video_id:ctx.video_id||''};current=null;dirty=false;lock(true);editor.reset();
  if(!owner.video_id){say('Select a video to view its inherited settings.');return;}
  say('Loading production settings…');
  try{
   const result=await window.studio.api('GET','/api/videos/'+owner.video_id+'/settings');
   if(turn!==ticket)return;
   if(result.project_id!==owner.project_id)throw Error('This video belongs to another project. Select it again.');
   current=result;editor.load(result.overrides,result.inherited);lock(false);say(`Project revision ${result.project_revision} · Video revision ${result.revision}. Unchecked fields inherit project defaults.`);emit();
  }catch(e){if(turn===ticket){say(e.message);reload.disabled=false;}}
 }
 function startLoad(ctx){readyPromise=load(ctx);return readyPromise;}
 function canChange(ctx){
  if(key(ctx)===key(owner))return true;
  if(busy){say('Wait for video settings to finish saving.');return false;}
  return !dirty||confirm('Discard unsaved video settings?');
 }
 form.oninput=form.onchange=()=>{dirty=true;say('Unsaved video overrides. Save before starting new jobs.');};
 form.onsubmit=async event=>{
  event.preventDefault();if(busy||!current)return;
  const ctx={...owner},turn=ticket,body={revision:current.revision,overrides:editor.read()};busy=true;lock(true);
  try{
   const result=await window.studio.api('PUT','/api/videos/'+ctx.video_id+'/settings',body);
   if(turn!==ticket)return;
   current=result;dirty=false;editor.load(result.overrides,result.inherited);say('Saved. New jobs use these values; existing jobs keep their previous settings.');emit();
  }catch(e){if(turn===ticket)say(e.message);}finally{busy=false;if(turn===ticket)lock(false);}
 };
 reset.onclick=()=>{if(!current)return;editor.load({},current.inherited);dirty=true;say('All fields now inherit project defaults. Save to apply.');};
 reload.onclick=()=>{if(dirty&&!confirm('Discard unsaved video settings?'))return;dirty=false;void startLoad(owner);};
 window.videoSettings={
  assertSaved(){if(busy||dirty)throw Error('Save video production settings in Project before starting new jobs.');if(owner.video_id&&!current)throw Error('Wait for video production settings to load, or click Reload in Project.');},
  canChangeVideo:id=>canChange({...owner,video_id:id}),canChangeProject:pid=>pid===owner.project_id||canChange({project_id:pid,video_id:''}),
  effective:()=>current?JSON.parse(JSON.stringify(current.effective)):null,
  ready:()=>readyPromise,reload:()=>startLoad(owner)
 };
 document.addEventListener('workflow-changed',e=>void startLoad(e.detail));
 document.addEventListener('project-settings-saved',e=>{
  if(e.detail.project_id!==owner.project_id||!owner.video_id)return;
  if(dirty||busy){say('Project defaults changed. Save or reload your video overrides before continuing.');return;}
  void startLoad(owner);
 });
 void startLoad(window.workflow?.context?.()||owner);
})();
