const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const vm=require('node:vm');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('script/segments/concepts flow reaches database-backed image generation with selected IDs',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'});
 const w=dom.window,$=id=>w.document.getElementById(id),calls=[];
 const data={video:{id:'v1',project_id:'p1',title:'Narrated video'},document:null,segments:[],warnings:[]};
 const base='/api/storyboard/videos/v1';
 w.confirm=()=>true;w.setInterval=()=>0;
 w.studio={
  openProjectPage:async()=>{},
  settings:async()=>({output:'/output',extension:'/extension',autoExport:false}),
  importScriptSource:async kind=>kind==='script'?{name:'script.txt',text:'A complete narration script.'}:{name:'segments.json',text:'[{"start_ms":0,"end_ms":8400,"text":"First idea"},{"start_ms":8400,"end_ms":15200,"text":"Second idea"}]'},
  api:async(method,route,body)=>{
   calls.push({method,route,body});
  if(route.endsWith('/restart-text'))return {ok:true};
   if(route==='/health')return {version:'test',extension_connected:true};
   if(route==='/api/projects')return [{id:'p1',name:'Test project'}];
   if(route==='/api/workflow/project')return {project_id:'p1',video_id:'v1',title:'Narrated video',videos:[{id:'v1',title:'Narrated video'}],protocol:3};
   if(route.startsWith('/api/videos'))return [{id:'v1',title:'Narrated video'}];
   if(route.startsWith('/api/scenes'))return [];
   if(route==='/api/tts/templates')return [];
   if(route==='/api/materials')return [{id:'realistic',name:'Realistic'}];
   if(route==='/api/models')return {image_models:{}};
   if(route==='/api/desktop/jobs')return {jobs:[],paused:false};
   if(route===base){if(method==='PUT')data.document={id:'doc1',prompt_template:'Create one visual prompt.',...body};return structuredClone(data);}
   if(route===base+'/segments'){
    data.segments=JSON.parse(body.content).map((s,i)=>({...s,id:'s'+(i+1),ordinal:i+1,concepts:[],active_concept:null,ready:false,media_jobs:[]}));return structuredClone(data);
   }
   if(route===base+'/prompt-options'){data.document.prompt_options=structuredClone(body);return body;}
   if(route===base+'/generate-concepts'){
    for(const s of data.segments)if(body.segment_ids.includes(s.id))s.job={state:'QUEUED'};
    return {ids:['j1'],skipped:[]};
   }
   if(route===base+'/retry-failed')return {ids:[],resumed:['failed-image'],skipped:[]};
   if(route===base+'/generate-media')return {ids:['m1'],skipped:[]};
   throw Error('Unexpected request: '+method+' '+route);
  }
 };
 const change=async(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('change'));await tick();};
 const submit=async id=>{$(id).dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();};
 try{
  new vm.Script(fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8')).runInContext(dom.getInternalVMContext());
  new vm.Script(fs.readFileSync(path.join(__dirname,'../ui/storyboard.js'),'utf8')).runInContext(dom.getInternalVMContext());
  new vm.Script(fs.readFileSync(path.join(__dirname,'../ui/scene-board.js'),'utf8')).runInContext(dom.getInternalVMContext());
  await tick();await change('project-select','p1');
  w.document.querySelector('[data-page="storyboard"]').click();await tick();
  $('sb-import-script').click();await tick();assert.equal($('sb-script').value,'A complete narration script.');
  await submit('sb-document');assert.equal(data.document.script_text,'A complete narration script.');
  $('sb-import-segments').click();await tick();assert.equal($('sb-rows').children.length,2);
  assert.match($('sb-rows').textContent,/00:00:08.400/);
  const firstRow=$('sb-rows').firstElementChild;
  $('sb-select-none').click();assert.equal($('sb-rows').firstElementChild,firstRow);const check=$('sb-rows').querySelector('[data-segment-id="s2"]');check.checked=true;check.focus();check.dispatchEvent(new w.Event('change'));
  assert.equal($('sb-rows').querySelector('[data-segment-id="s2"]'),check);assert.equal(w.document.activeElement,check);assert.match($('sb-count').textContent,/1 of 2/);
  $('sb-create-concepts').click();await tick();
  const queued=calls.find(c=>c.route===base+'/generate-concepts');
  assert.deepEqual(JSON.parse(JSON.stringify(queued.body.segment_ids)),['s2']);
  assert.equal(queued.body.model,'GPT-5.6 Sol');assert.equal(data.document.prompt_options.chatgpt_model,'GPT-5.6 Sol');assert.equal($('sb-model').disabled,false);
  assert.equal(queued.body.provider,'chatgpt-web');assert.equal(queued.body.prompt_kind,'image');
  // A simulated AI result is used only to verify UI/API wiring, not live generation.
  const s=data.segments[1];s.ready=true;s.job.state='COMPLETED';s.active_concept_id='c2';s.active_concept={id:'c2',version:1,title:'Second concept',description:'A clear composition',image_prompt:'A visual illustration',video_prompt:'A slow camera move'};s.concepts=[s.active_concept];
  $('sb-refresh').click();await tick();
  $('sb-to-board').click();await tick();await tick();
  assert.equal($('scene-board').closest('[data-view]').hidden,false);
  assert.match($('scb-rows').textContent,/A visual illustration/);
  $('scb-generate').click();await tick();
  const media=calls.find(c=>c.route===base+'/generate-media');
  assert.deepEqual(Array.from(media.body.segment_ids),['s2']);assert.equal(media.body.kind,'image');
  assert.equal(calls.filter(c=>c.route==='/api/desktop/jobs'&&c.method==='POST').length,0);
  const picker=$('scb-rows').querySelector('[data-scene-kind="s2"]');picker.value='video';picker.dispatchEvent(new w.Event('change'));
  $('scb-generate').click();await tick();
  assert.equal(calls.filter(c=>c.route===base+'/generate-media').at(-1).body.duration_mode,'srt');
  s.media_jobs=[{id:'failed-image',kind:'image',concept_id:'c2',state:'FAILED',files:[]}];
  await w.sceneBoard.open();$('scb-target').value='image';$('scb-select-failed').click();$('scb-retry').click();await tick();
  const retry=calls.find(c=>c.route===base+'/retry-failed');
  assert.deepEqual(Array.from(retry.body.segment_ids),['s2']);assert.equal(retry.body.kind,'image');
  s.ready=false;await w.sceneBoard.open();const before=calls.filter(c=>c.route===base+'/generate-media').length;
  $('scb-generate').click();await tick();assert.match($('scb-message').textContent,/current prompt/);
  assert.equal(calls.filter(c=>c.route===base+'/generate-media').length,before);
 }finally{dom.window.close();}
});
