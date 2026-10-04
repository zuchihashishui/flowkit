const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r));
const production={tts:{model:'Eleven v4',expected_voice:'Minato',max_chunk_characters:3000},whisperx:{model:'large-v3',device:'cuda',language:'ja',batch_size:8,video_duration_seconds:100},media:{orientation:'HORIZONTAL',image_model:''},assembly:{size:'1080p',fps:30,fit:'fit',subtitles:'burn',font:'Yu Gothic',image_motion:'none'},srt:{instructions:''}};
const urls={revision:0,chatgpt_url:'https://chatgpt.com/',image_prompt_url:'https://chatgpt.com/',video_prompt_url:'https://chatgpt.com/',elevenlabs_url:'https://elevenlabs.io/app/speech-synthesis/text-to-speech',google_flow_url:'https://flow.google.com/'};
const clone=value=>JSON.parse(JSON.stringify(value));
function merge(base,overrides){const out=clone(base);for(const [group,fields] of Object.entries(overrides))out[group]={...out[group],...fields};return out;}
function setup(custom){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id),calls=[],events=[],records={};
 let ctx={project_id:'p',video_id:''},project={...urls,production:clone(production)};
 // Keep this fixture usable while index.html and shared hooks are integrated.
 if(!$('video-settings')){const h=w.document.createElement('section');h.id='video-settings';w.document.body.append(h);}
 w.confirm=()=>false;w.workflow={context:()=>ctx};
 w.studio={api:async(method,route,body)=>{
  calls.push({method,route,body:body&&clone(body)});
  if(custom){const result=custom(method,route,body);if(result!==undefined)return result;}
  if(route.startsWith('/api/projects/')){if(method==='PUT')project={...clone(body),revision:body.revision+1};return clone(project);}
  const id=route.split('/')[3],record=records[id]||{revision:0,overrides:{}};
  if(method==='PUT')records[id]={revision:record.revision+1,overrides:clone(body.overrides)};
  const saved=records[id]||record;
  return {video_id:id,project_id:'p',project_revision:project.revision,...clone(saved),inherited:clone(project.production),effective:merge(project.production,saved.overrides)};
 }};
 w.document.addEventListener('production-settings-changed',e=>events.push(clone(e.detail)));
 for(const script of ['project-settings.js','video-settings.js'])w.eval(fs.readFileSync(path.join(__dirname,'../ui/'+script),'utf8'));
 const select=id=>{ctx={project_id:'p',video_id:id};w.document.dispatchEvent(new w.CustomEvent('workflow-changed',{detail:ctx}));};
 const change=(id,value)=>{const el=$(id);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 return {dom,w,$,calls,events,records,select,change,project:()=>project};
}
test('video inherits every project setting, saves only explicit fields, resets to inheritance',async()=>{
 const s=setup();try{
  s.select('v1');assert.throws(()=>s.w.videoSettings.assertSaved(),/load/);await tick();
  assert.equal(s.$('vs-tts-max_chunk_characters').value,'3000');assert.equal(s.$('vs-whisperx-device').value,'cuda');
  assert.equal(s.$('vs-tts-max_chunk_characters').disabled,true);assert.equal(s.$('vs-tts-max_chunk_characters-override').checked,false);
  s.change('vs-tts-max_chunk_characters-override',true);s.change('vs-tts-max_chunk_characters',1200);
  assert.equal(s.$('vs-tts-max_chunk_characters').disabled,false);assert.throws(()=>s.w.videoSettings.assertSaved(),/Save video/);
  assert.equal(s.w.videoSettings.canChangeVideo('v2'),false);assert.equal(s.w.videoSettings.canChangeProject('p2'),false);
  s.$('video-settings-form').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  assert.deepEqual(s.records.v1.overrides,{tts:{max_chunk_characters:1200}});
  assert.equal(s.w.videoSettings.effective().tts.expected_voice,'Minato');assert.equal(s.events.at(-1).production.tts.max_chunk_characters,1200);
  s.select('v2');await tick();assert.equal(s.$('vs-tts-max_chunk_characters').value,'3000');assert.equal(s.$('vs-tts-max_chunk_characters-override').checked,false);
  s.select('v1');await tick();assert.equal(s.$('vs-tts-max_chunk_characters').value,'1200');
  s.$('vs-reset').click();assert.equal(s.$('vs-tts-max_chunk_characters').value,'3000');assert.equal(s.$('vs-tts-max_chunk_characters-override').checked,false);
  s.$('video-settings-form').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();assert.deepEqual(s.records.v1.overrides,{});
 }finally{s.dom.window.close();}
});
test('late response never populates another video and failed settings keep generation blocked',async()=>{
 let previous,fail=true;
 const s=setup((method,route)=>{
  if(route==='/api/videos/old/settings')return new Promise(r=>previous=r);
  if(route==='/api/videos/current/settings'&&fail)return Promise.reject(Error('Backend unavailable'));
 });try{
  s.select('old');s.select('current');await tick();assert.match(s.$('vs-message').textContent,/unavailable/);assert.throws(()=>s.w.videoSettings.assertSaved(),/load/);
  fail=false;s.$('vs-reload').click();await tick();
  previous({project_id:'p',video_id:'old',revision:4,project_revision:4,overrides:{tts:{model:'Old model'}},inherited:production,effective:merge(production,{tts:{model:'Old model'}})});await tick();
  assert.equal(s.$('vs-tts-model').value,'Eleven v4');assert.equal(s.events.at(-1).video_id,'current');
 }finally{s.dom.window.close();}
});
test('project save updates inherited video fields and retains video overrides',async()=>{
 const s=setup();try{
  s.w.document.dispatchEvent(new s.w.CustomEvent('project-changed',{detail:{id:'p'}}));s.select('v1');await tick();
  s.change('vs-tts-max_chunk_characters-override',true);s.change('vs-tts-max_chunk_characters',1000);s.$('video-settings-form').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  s.change('ps-tts-max_chunk_characters',2500);s.change('ps-tts-expected_voice','New voice');s.change('ps-assembly-image_motion','zoom_out');
  s.$('project-settings-form').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();await tick();
  const latest=s.w.videoSettings.effective();assert.equal(latest.tts.max_chunk_characters,1000);assert.equal(latest.tts.expected_voice,'New voice');assert.equal(latest.assembly.image_motion,'zoom_out');
  const saved=s.calls.find(c=>c.method==='PUT'&&c.route.startsWith('/api/projects/')).body;assert.equal(saved.production.whisperx.device,'cuda');assert.equal(saved.production.assembly.image_motion,'zoom_out');
 }finally{s.dom.window.close();}
});
