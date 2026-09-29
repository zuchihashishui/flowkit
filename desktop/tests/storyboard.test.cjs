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
  settings:async()=>({output:'/output',extension:'/extension',autoExport:false}),
  importScriptSource:async kind=>kind==='script'?{name:'script.txt',text:'A complete narration script.'}:{name:'segments.json',text:'[{"start_ms":0,"end_ms":8400,"text":"First idea"},{"start_ms":8400,"end_ms":15200,"text":"Second idea"}]'},
  api:async(method,route,body)=>{
   calls.push({method,route,body});
   if(route==='/health')return {version:'test',extension_connected:true};
   if(route==='/api/projects')return [{id:'p1',name:'Test project'}];
   if(route.startsWith('/api/videos'))return [{id:'v1',title:'Narrated video'}];
   if(route.startsWith('/api/scenes'))return [];
   if(route==='/api/tts/templates')return [];
   if(route==='/api/materials')return [{id:'realistic',name:'Realistic'}];
   if(route==='/api/models')return {image_models:{}};
   if(route==='/api/desktop/jobs')return {jobs:[],paused:false};
   if(route===base){if(method==='PUT')data.document={id:'doc1',...body};return structuredClone(data);}
   if(route===base+'/segments'){
    data.segments=JSON.parse(body.content).map((s,i)=>({...s,id:'s'+(i+1),ordinal:i+1,concepts:[],active_concept:null,ready:false,media_jobs:[]}));return structuredClone(data);
   }
   if(route===base+'/generate-concepts'){
    for(const s of data.segments)if(body.segment_ids.includes(s.id))s.job={state:'QUEUED'};
    return {ids:['j1'],skipped:[]};
   }
   if(route===base+'/generate-media')return {ids:['m1'],skipped:[]};
   throw Error('Unexpected request: '+method+' '+route);
  }
 };
 const change=async(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('change'));await tick();};
 const submit=async id=>{$(id).dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();};
 try{
  new vm.Script(fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8')).runInContext(dom.getInternalVMContext());
  new vm.Script(fs.readFileSync(path.join(__dirname,'../ui/storyboard.js'),'utf8')).runInContext(dom.getInternalVMContext());
  await tick();await change('project-select','p1');
  w.document.querySelector('[data-page="storyboard"]').click();await tick();
  $('sb-import-script').click();await tick();assert.equal($('sb-script').value,'A complete narration script.');
  await submit('sb-document');assert.equal(data.document.script_text,'A complete narration script.');
  $('sb-import-segments').click();await tick();assert.equal($('sb-rows').children.length,2);
  assert.match($('sb-rows').textContent,/00:00:08.400/);
  $('sb-select-none').click();const check=$('sb-rows').querySelector('[data-segment-id="s2"]');check.checked=true;check.dispatchEvent(new w.Event('change'));
  $('sb-create-concepts').click();await tick();
  const queued=calls.find(c=>c.route===base+'/generate-concepts');
  assert.deepEqual(JSON.parse(JSON.stringify(queued.body.segment_ids)),['s2']);
  assert.equal(queued.body.provider,'codex');
  // A simulated AI result is used only to verify UI/API wiring, not live generation.
  const s=data.segments[1];s.ready=true;s.job.state='COMPLETED';s.active_concept_id='c2';s.active_concept={id:'c2',version:1,title:'Second concept',description:'A clear composition',image_prompt:'A visual illustration',video_prompt:'A slow camera move'};s.concepts=[s.active_concept];
  $('sb-refresh').click();await tick();
  $('sb-to-images').click();assert.equal($('image-mode').value,'storyboard');assert.equal($('image-storyboard').hidden,false);
  assert.match($('image-storyboard-rows').textContent,/A visual illustration/);
  await submit('image-form');
  const media=calls.find(c=>c.route===base+'/generate-media');
  assert.deepEqual(JSON.parse(JSON.stringify(media.body.segment_ids)),['s2']);assert.equal(media.body.kind,'image');
  assert.equal(calls.filter(c=>c.route==='/api/desktop/jobs'&&c.method==='POST').length,0);
  assert.match($('notice').textContent,/1 media job/);
  // Stale concepts block media submission before any generation call.
  s.ready=false;$('sb-refresh').click();await tick();const before=calls.filter(c=>c.route===base+'/generate-media').length;
  await submit('image-form');assert.match($('notice').textContent,/current concepts/);
  assert.equal(calls.filter(c=>c.route===base+'/generate-media').length,before);
 }finally{dom.window.close();}
});
