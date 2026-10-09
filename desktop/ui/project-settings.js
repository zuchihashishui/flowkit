(() => {
 'use strict';
 const $=id=>document.getElementById(id),keys=['chatgpt_url','image_prompt_url','video_prompt_url','elevenlabs_url','google_flow_url'];
 const definitions=[
  ['tts','Text to Speech',[
   ['model','Model','text','Eleven v4',100],['expected_voice','Expected voice label (optional)','text','',200],
   ['max_chunk_characters','Maximum characters per chunk','number',3000,100,3000]
  ],'Choose the voice on ElevenLabs, or use a supported voice parameter in its saved URL. The optional label checks the selected voice; it does not select a voice.'],
  ['whisperx','WhisperX',[
   ['model','Speech model',['tiny','base','small','medium','large-v2','large-v3'],'large-v3'],
   ['device','Device',['cuda','cpu','auto'],'cuda'],['language','Language code (blank = detect)','text','',3],
   ['batch_size','Batch size','number',8,1,32],['video_duration_seconds','Video transcript boundary (seconds)','number',100,0,86400]
  ]],
  ['media','Images and videos',[
   ['orientation','Orientation',['HORIZONTAL','VERTICAL'],'HORIZONTAL'],['image_model','Flow image model ID (Pro: GEM_PIX_2; 2.1: BELUGA; Lite: HARBOR_SEAL)','text','GEM_PIX_2',100]
  ]],
  ['assembly','Video assembly',[
   ['size','Output size',['1080p','720p','vertical'],'1080p'],['fps','Frames per second',[24,30,60],30],
   ['fit','Image fit',['fit','crop'],'fit'],['subtitles','Subtitles',['off','burn','soft'],'off'],
   ['font','Subtitle font','text','Yu Gothic',80],['image_motion','Image motion',['none','zoom_in','zoom_out'],'none']
  ],'Image motion affects still images only. None keeps them still. Existing renders keep their saved settings.'],
  ['srt','SRT instructions',[
   ['instructions','Shared instructions (optional)','textarea','',50000]
  ],'Leave empty to use the built-in instructions. A video may override them. GPT image/video requests still send only the scene text.']
 ];
 const labels={cuda:'GPU (CUDA)',cpu:'CPU',auto:'Automatic',none:'None (still image)',zoom_in:'Slow zoom in',zoom_out:'Slow zoom out',fit:'Fit with padding',crop:'Fill and crop',burn:'Burn into video',soft:'Subtitle track',off:'Off',HORIZONTAL:'Landscape',VERTICAL:'Portrait',vertical:'1080 × 1920'};
 function node(tag,text){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;}
 function createEditor(host,prefix,partial=false){
  const controls=[],sections=[];let locked=false;
  for(const [section,title,fields,note] of definitions){
   const box=node('fieldset'),legend=node('legend',title),grid=node('div');grid.className='grid two';box.append(legend);
   if(note)box.append(node('p',note));
   for(const [key,label,type,defaultValue,min,max] of fields){
    const wrapper=node('div'),caption=node('label',label),id=prefix+'-'+section+'-'+key;
    const input=node(Array.isArray(type)?'select':type==='textarea'?'textarea':'input');input.id=id;caption.htmlFor=id;
    if(Array.isArray(type))for(const value of type){const option=node('option',labels[value]||String(value));option.value=value;input.append(option);}
    else if(type==='textarea'){input.rows=5;input.maxLength=min;}
    else if(type==='number'){input.type='number';input.min=min;input.max=max;input.step=key==='video_duration_seconds'?'any':'1';input.required=true;}
    else{input.type='text';input.maxLength=min;input.required=['model','font'].includes(key);}
    if(key==='language')input.pattern='([a-z]{2,3})?';
    let toggle;
    wrapper.append(caption);
    if(partial){
     const option=node('label');toggle=node('input');toggle.type='checkbox';toggle.id=id+'-override';
     option.append(toggle,document.createTextNode(' Override for this video'));wrapper.append(option);
     toggle.onchange=()=>{input.disabled=locked||!toggle.checked;};
    }
    wrapper.append(input);grid.append(wrapper);controls.push({section,key,input,toggle,defaultValue,numeric:type==='number'||key==='fps'});
   }
   box.append(grid);sections.push(box);
  }
  host.replaceChildren(...sections);
  return {
   load(value={},inherited={}){for(const c of controls){const own=value[c.section]||{},has=Object.hasOwn(own,c.key);c.input.value=has?own[c.key]:(inherited[c.section]?.[c.key]??c.defaultValue);if(c.toggle)c.toggle.checked=has;}this.lock(locked);},
   read(){const result={};for(const c of controls){if(c.toggle&&!c.toggle.checked)continue;const value=c.numeric?Number(c.input.value):c.input.value.trim();(result[c.section]??={})[c.key]=value;}return result;},
   lock(value){locked=value;for(const c of controls){if(c.toggle)c.toggle.disabled=value;c.input.disabled=value||!!(c.toggle&&!c.toggle.checked);}},
   reset(){this.load({},{});},
  };
 }
 window.productionSettingsEditor={create:createEditor};
 const form=$('project-settings-form');if(!form)return;
 let host=$('ps-production');if(!host){host=node('div');host.id='ps-production';form.append(host);}
 const editor=createEditor(host,'ps'),message=text=>{$('ps-message').textContent=text;};
 let owner='',revision=0,dirty=false,busy=false,ticket=0;
 function lock(value){for(const el of form.querySelectorAll('input,button,select,textarea'))el.disabled=value;editor.lock(value);}
 async function load(pid){
  const turn=++ticket;owner=pid;dirty=false;revision=0;lock(true);editor.reset();for(const k of keys)$('ps-'+k).value='';
  if(!pid){message('Select a project to edit its settings.');return;}
  try{
   const settings=await window.studio.api('GET','/api/projects/'+pid+'/settings');
   if(turn!==ticket)return;
   for(const k of keys)$('ps-'+k).value=settings[k];revision=settings.revision;editor.load(settings.production||{});
   message('Saved project settings · Revision '+revision);lock(false);
  }catch(e){if(turn===ticket){message(e.message);$('ps-reload').disabled=false;}}
 }
 form.oninput=()=>{dirty=true;message('Unsaved settings. Save before starting new jobs.');};
 form.onchange=form.oninput;
 form.onsubmit=async event=>{
  event.preventDefault();if(busy||!owner)return;
  const body={revision,production:editor.read()};for(const k of keys)body[k]=$('ps-'+k).value.trim();
  busy=true;lock(true);const pid=owner;
  try{
   const saved=await window.studio.api('PUT','/api/projects/'+pid+'/settings',body);
   revision=saved.revision;dirty=false;editor.load(saved.production||body.production);
   message('Saved for every video in this project. Video overrides and existing jobs are preserved.');
   document.dispatchEvent(new CustomEvent('project-settings-saved',{detail:{project_id:pid,settings:saved}}));
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
