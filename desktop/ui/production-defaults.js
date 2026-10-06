(() => {
 'use strict';
 const $=id=>document.getElementById(id),key=c=>c?.project_id&&c?.video_id?`${c.project_id}/${c.video_id}`:'';
 const fields={
  'el-model':['tts','model'],'el-chunk-size':['tts','max_chunk_characters'],
  'wx-language':['whisperx','language'],'wx-model':['whisperx','model'],'wx-device':['whisperx','device'],
  'wx-batch':['whisperx','batch_size'],'wx-video-seconds':['whisperx','video_duration_seconds'],
  'srt-prompt':['srt','instructions']
 };
 const content=['el-title','el-text'],allowed=new Set([...Object.keys(fields),...content]),cache=new Map();
 // Capture HTML defaults before service pollers or a previous video's values can
 // become another video's baseline. SRT registers its immutable template below.
 const baseline=Object.fromEntries(Object.keys(fields).map(id=>[id,$(id)?.value||'']));
 let active='',edits={},effective={};
 function read(k){
  if(cache.has(k))return {...cache.get(k)};
  try{
   const value=JSON.parse(localStorage.getItem('production-form:'+k)||'{}');
   if(value&&typeof value==='object'&&!Array.isArray(value))return Object.fromEntries(Object.entries(value).filter(([id,text])=>allowed.has(id)&&typeof text==='string'));
  }catch{}
  return {};
 }
 function save(){
  if(!active)return;cache.set(active,{...edits});
  try{localStorage.setItem('production-form:'+active,JSON.stringify(edits));}catch{}
 }
 function setValue(id,value){
  const el=$(id);if(!el||value===undefined||value===null)return false;
  value=String(value);const changed=el.value!==value;
  if(el.tagName==='SELECT'&&![...el.options].some(o=>o.value===value)){
   const option=document.createElement('option');option.value=value;option.textContent=value||'Backend default';el.append(option);
  }
  el.value=value;return changed;
 }
 function resolved(id){
  if(Object.hasOwn(edits,id))return edits[id];
  if(content.includes(id))return '';
  const route=fields[id],value=effective[route[0]]?.[route[1]];
  return id==='srt-prompt'&&!value?baseline[id]:(value??baseline[id]);
 }
 function apply(ids=[...Object.keys(fields),...content]){
  if(typeof ids==='string')ids=[ids];let narrationChanged=false;
  for(const id of ids){if(!allowed.has(id))continue;const changed=setValue(id,resolved(id));if(changed&&['el-text','el-chunk-size'].includes(id))narrationChanged=true;}
  if($('el-character-count'))$('el-character-count').textContent=Array.from($('el-text')?.value||'').length.toLocaleString()+' characters';
  if(narrationChanged){
   if($('el-preview-summary'))$('el-preview-summary').textContent='Text or chunk size changed. Preview chunks to update the split.';
   $('el-chunk-preview')?.replaceChildren();
  }
 }
 function switchVideo(ctx){
  const next=key(ctx);if(next===active)return;
  save();active=next;edits=active?read(active):{};effective={};apply();
 }
 for(const id of allowed){
  const remember=()=>{if(active){edits[id]=$(id).value;save();}};
  $(id)?.addEventListener('input',remember);$(id)?.addEventListener('change',remember);
 }
 document.addEventListener('workflow-changed',event=>switchVideo(event.detail));
 document.addEventListener('production-settings-changed',event=>{
  if(key(event.detail)!==key(window.workflow?.context()))return;
  switchVideo(event.detail);effective=event.detail.production||event.detail.effective||{};apply();
 });
 window.productionDefaults={
  restore:apply,
  registerBaseline(id,value){if(!Object.hasOwn(fields,id))return;baseline[id]=String(value);apply(id);},
  reset(){
   const ctx=window.workflow?.requireContext?.()||window.workflow?.context();
   if(!key(ctx))throw Error('Select a project and video before applying production defaults.');
   window.projectSettings?.assertSaved();window.videoSettings?.assertSaved();
   if(key(ctx)!==active)switchVideo(ctx);
   for(const id of Object.keys(fields))delete edits[id];save();
   effective=window.videoSettings?.effective()||effective;apply();
   document.dispatchEvent(new CustomEvent('production-defaults-reset',{detail:{...ctx,production:effective}}));
  }
 };
 $('apply-production-defaults')?.addEventListener('click',()=>{
  try{window.productionDefaults.reset();$('notice').textContent='Video defaults applied to stage forms. Draft text and saved jobs are unchanged.';}
  catch(error){$('notice').textContent=error.message;}
 });
 function initialize(){switchVideo(window.workflow?.context());effective=window.videoSettings?.effective()||effective;apply();}
 initialize();
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});
})();
