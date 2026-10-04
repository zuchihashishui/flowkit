const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');const tick=()=>new Promise(r=>setImmediate(r));
async function setup(){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only',url:'https://studio.test'}),w=dom.window,$=id=>w.document.getElementById(id),calls=[],opened=[];
 let scenesOverride=null;
 const videos={p1:[{id:'v1',title:'One',status:'DRAFT'},{id:'v2',title:'Two',status:'DRAFT'}],p2:[{id:'v3',title:'Other',status:'DRAFT'}]};
 w.confirm=()=>true;w.setInterval=()=>0;w.localStorage.setItem('active-project-id','p1');w.localStorage.setItem('active-video:p1','v1');
 w.studio={settings:async()=>({autoExport:false,output:'/output',extension:'/extension'}),api:async(method,route,body)=>{
  calls.push({method,route,body});
  if(route==='/health')return{version:'test',extension_connected:true};if(route==='/api/projects')return[{id:'p1',name:'First'},{id:'p2',name:'Second'}];
  if(route==='/api/workflow/project')return{protocol:3,videos:videos[body.project_id],video_id:videos[body.project_id].length===1?videos[body.project_id][0].id:null};
  if(route.startsWith('/api/scenes?')){if(scenesOverride){const result=scenesOverride(route);if(result!==undefined)return result;}return[];}
  if(route.startsWith('/api/workflow/resources'))return{resources:[]};if(route==='/api/tts/templates'||route==='/api/materials')return[];if(route==='/api/models')return{image_models:{}};
  if(route==='/api/desktop/jobs')return{paused:false,jobs:[{id:'media-v2',state:'FAILED',created:1,files:[],error:'download failed',can_resume:true,payload:{kind:'image',project_id:'p1',video_id:'v2',label:'Second video media',prompt:'Image two'}}]};
  if(route.startsWith('/api/production/overview'))return{videos:(videos[new URL('https://api.test'+route).searchParams.get('project_id')]||[]).map(v=>({...v,scene_count:0,stages:[]}))};
  if(route.startsWith('/api/production/recovery'))return{counts:{},jobs:[]};throw Error('Unexpected '+route);
 }};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/workflow.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8'));w.eval(fs.readFileSync(path.join(__dirname,'../ui/production.js'),'utf8'));
 for(const stage of ['elevenlabs','whisperx','srt','assembly'])w.document.querySelector(`[data-page="${stage}"]`).addEventListener('click',()=>opened.push({stage,...w.workflow.context()}));
 await tick();return{dom,w,$,calls,opened,override:fn=>{scenesOverride=fn;},change:async(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('change'));await tick();}};
}
test('dashboard navigation selects the owning video and triggers the stage refresh without generating',async()=>{
 const s=await setup();try{
  assert.equal(s.w.workflow.context().video_id,'v1');assert.equal(await s.w.selectProductionVideo('v2','elevenlabs'),true);
  assert.equal(s.$('video-select').value,'v2');assert.deepEqual(s.opened,[{stage:'elevenlabs',project_id:'p1',video_id:'v2'}]);assert.equal(s.w.document.querySelector('[data-page].active').dataset.page,'elevenlabs');
  assert(!s.calls.some(c=>c.method==='POST'&&c.route.endsWith('/jobs')));await assert.rejects(s.w.selectProductionVideo('v3','srt'),/does not belong/);
  await s.w.focusProductionJob('media-v2');assert.equal(s.$('job-search').value,'media-v2');assert.equal(s.w.document.querySelector('[data-page].active').dataset.page,'queue');assert.match(s.$('job-detail-text').textContent,/Second video media/);
 }finally{s.dom.window.close();}
});
test('inflight Scene Board retry prevents project/video selection, including dashboard navigation',async()=>{
 const s=await setup();try{
  s.w.sceneBoard={canChangeVideo:()=>false,canChangeProject:()=>false};assert.equal(await s.w.selectProductionVideo('v2','elevenlabs'),false);assert.equal(s.opened.length,0);assert.equal(s.w.workflow.context().video_id,'v1');
  await s.change('video-select','v2');assert.equal(s.$('video-select').value,'v1');await s.change('project-select','p2');assert.equal(s.$('project-select').value,'p1');assert.equal(s.w.workflow.context().project_id,'p1');assert.match(s.$('notice').textContent,/Scene Board action/);
  s.w.sceneBoard.canChangeVideo=()=>true;s.w.sceneBoard.canChangeProject=()=>true;assert.equal(await s.w.selectProductionVideo('v2','srt'),true);assert.equal(s.opened[0].stage,'srt');
 }finally{s.dom.window.close();}
});
test('a project switch during dashboard navigation discards the old navigation and loads the new dashboard',async()=>{
 const s=await setup();let resolveOld;try{
  s.override(route=>route.endsWith('v2')?new Promise(r=>resolveOld=r):undefined);const pending=s.w.selectProductionVideo('v2','assembly');await tick();await s.change('project-select','p2');resolveOld([]);assert.equal(await pending,false);assert.equal(s.opened.length,0);assert.equal(s.w.workflow.context().project_id,'p2');assert.equal(s.w.workflow.context().video_id,'v3');assert.match(s.$('pd-videos').textContent,/Other/);assert.doesNotMatch(s.$('pd-videos').textContent,/One/);
 }finally{s.dom.window.close();}
});
