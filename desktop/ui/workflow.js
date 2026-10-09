(() => {
 'use strict';
 let current={project_id:'',video_id:''},generation=0,loading=0;
 const $=id=>document.getElementById(id),key=c=>`${c.project_id||''}/${c.video_id||''}`;
 const raw=(method,route,body)=>window.studio.api(method,route,body);
 const listings=new Set(['/api/elevenlabs/jobs','/api/whisperx/status','/api/srt/status','/api/assembly/status']);
<<<<<<< HEAD
 const scopedWrites=new Set(['/api/elevenlabs/jobs','/api/whisperx/jobs','/api/srt/jobs','/api/srt/prepare','/api/srt/analyze','/api/assembly/source','/api/assembly/project-sources','/api/assembly/preview','/api/assembly/preflight','/api/assembly/scene-media','/api/assembly/jobs']);
=======
 const scopedWrites=new Set(['/api/elevenlabs/jobs','/api/whisperx/jobs','/api/srt/jobs','/api/srt/prepare','/api/srt/analyze','/api/assembly/source','/api/assembly/preview','/api/assembly/preflight','/api/assembly/scene-media','/api/assembly/jobs']);
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
 function requireContext(){if(!current.project_id||!current.video_id)throw Error('Select a project and video in Project and wait for them to load.');return {...current};}
 function assertCurrent(ctx){if(key(ctx)!==key(current))throw Error('The active project or video changed. Your result remains saved with its original video.');}
 async function api(method,route,body){
  const ctx={...current},ticket=generation;
  const stage=method==='POST'?({'/api/elevenlabs/jobs':'elevenlabs','/api/whisperx/jobs':'whisperx','/api/srt/jobs':'srt','/api/assembly/jobs':'assembly'})[route]:null;
  if(stage||method==='POST'&&/^\/api\/whisperx\/jobs\/[a-f0-9-]{36}\/retry$/.test(route)){
   window.projectSettings?.assertSaved();window.videoSettings?.assertSaved();
   if(stage&&stage!=='srt'&&window.production){
    const options=stage==='assembly'?{plan:body}:body;
    if(!await window.production.check(stage,{...options,...requireContext(),silentOnSuccess:true}))throw Error('Preflight blocked this request. Resolve the listed checks before starting.');
    assertCurrent(ctx);
   }
  }
  if(method==='GET'&&listings.has(route))route+='?'+new URLSearchParams(ctx.project_id&&ctx.video_id?ctx:{unassigned:'true'});
  if(method==='POST'&&(scopedWrites.has(route)||/^\/api\/whisperx\/jobs\/[a-f0-9-]{36}\/retry$/.test(route)||/^\/api\/assembly\/jobs\/[a-f0-9-]{36}\/resume$/.test(route)))body={...body,...requireContext()};
  const result=await raw(method,route,body);
  if(ticket!==generation)throw Error('Active project or video changed; refreshing its sources.');
  return result;
 }
 function set(ctx){
  if(key(ctx)===key(current))return;
  current={project_id:ctx.project_id||'',video_id:ctx.video_id||''};generation++;
  document.dispatchEvent(new CustomEvent('workflow-changed',{detail:{...current}}));
  void refresh();
 }
 function button(label,fn){const b=document.createElement('button');b.textContent=label;b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){$('wf-message').textContent=e.message;}finally{b.disabled=false;}};return b;}
 async function refresh(){
  const ticket=++loading,ctx={...current},unassigned=$('wf-view').value==='unassigned';
  if(!unassigned&&!ctx.video_id){$('wf-resources').replaceChildren();$('wf-message').textContent='Choose a project and video above, or browse Unassigned to link existing files.';return;}
  try{
   const result=await raw('GET','/api/workflow/resources?'+new URLSearchParams(unassigned?{unassigned:'true'}:ctx));
   if(ticket!==loading||key(ctx)!==key(current))return;
   $('wf-message').textContent=`${result.resources.length} source / job versions · ${unassigned?'Unassigned':'Active video'} · Each stage starts only when you click.`;
   const lookup=new Map(result.resources.map(r=>[r.resource_kind+'/'+r.id,r]));
   $('wf-resources').replaceChildren(...result.resources.map(r=>{
    const row=document.createElement('div');row.className='item';const title=document.createElement('strong');title.textContent=`${r.title} · ${r.resource_kind} · ${r.state}`;
    const info=document.createElement('small');info.textContent=new Date(r.created*1000).toLocaleString()+' · '+r.id;
    const sources=document.createElement('p');sources.textContent=r.sources.length?'Inputs: '+r.sources.map(p=>(lookup.get(p.kind+'/'+p.id)?.title||p.kind)+' ['+p.id+']').join(' · '):'Original source';
    if(r.scenes)sources.textContent+=` · Imported into ${r.scenes.scene_count} scenes`;
    row.append(title,info,sources);
    if(!r.video_id){row.append(button('Assign source chain to active video',async()=>{
     const target=requireContext(),body={...target,kind:r.resource_kind,id:r.id};
     const plan=await raw('POST','/api/workflow/assignment-preview',body);assertCurrent(target);
     if(!confirm(`Assign these ${plan.resources.length} linked source/job versions to the active video?\n\n`+plan.resources.map(i=>i.resource_kind+' · '+i.title).join('\n')))return;
     await raw('POST','/api/workflow/assign',body);assertCurrent(target);document.dispatchEvent(new CustomEvent('workflow-changed',{detail:target}));await refresh();
    }));}
    else if(r.video_id===ctx.video_id){
     if(r.resource_kind==='elevenlabs'&&r.result_available||r.resource_kind==='audio')row.append(button('Use for WhisperX',()=>window.openWhisperX(r.id)));
     if(r.resource_kind==='whisperx'&&r.state==='COMPLETED'||r.resource_kind==='json')row.append(button('Use for SRT',()=>window.openSRT(r.id)));
     if(r.resource_kind==='srt'&&r.state==='COMPLETED')row.append(button('Import as Scenes',()=>importScenes(r.id)),button('Use for Video Assembly',()=>window.openAssembly(r.id)));
    }
    return row;
   }));
  }catch(e){if(ticket===loading)$('wf-message').textContent=e.message;}
 }
 async function importScenes(id){
  if(window.storyboard?.canImportSource&&!window.storyboard.canImportSource())return;
  const ctx=requireContext();await raw('POST','/api/workflow/import-scenes',{...ctx,kind:'srt',id});assertCurrent(ctx);
  document.querySelector('[data-page="storyboard"]').click();await window.storyboard?.open();
  await refresh();
 }
 window.workflow={api,set,requireContext,assertCurrent,refresh,importScenes,context:()=>({...current}),key:()=>key(current)};
 $('wf-refresh').onclick=refresh;$('wf-view').onchange=refresh;
 document.querySelector('[data-page="projects"]').addEventListener('click',refresh);
})();
