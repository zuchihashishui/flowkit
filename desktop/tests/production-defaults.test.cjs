const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const clone=value=>JSON.parse(JSON.stringify(value));
const defaults={tts:{model:'Eleven v4',max_chunk_characters:3000},whisperx:{model:'large-v3',device:'cuda',language:'ja',batch_size:8,video_duration_seconds:100},media:{orientation:'HORIZONTAL',image_model:'flow-custom-a'},srt:{instructions:'Project A SRT instructions'},assembly:{image_motion:'none'}};
function setup({scripts=[],storage={}}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only',url:'https://studio.test'}),w=dom.window,$=id=>w.document.getElementById(id),calls=[],resets=[];
 let ctx={project_id:'',video_id:''},current=null;
 const records={};w.setInterval=()=>0;w.confirm=()=>true;
 for(const [key,value] of Object.entries(storage))w.localStorage.setItem(key,value);
 const api=async(method,url,body)=>{
  calls.push({method,url,body:body&&clone(body)});
  if(url.startsWith('/api/videos/')){
   const id=url.split('/')[3],record=records[id]||{revision:1,overrides:{media:{orientation:'VERTICAL'}}};
   if(method==='PUT')records[id]={revision:body.revision+1,overrides:clone(body.overrides)};
   return {project_id:ctx.project_id,video_id:id,...clone(records[id]||record)};
  }
  if(url==='/api/elevenlabs/jobs')return {jobs:[]};
  if(url==='/api/whisperx/status')return {transcript_split_version:1,settings:{...defaults.whisperx,device:'cpu',language:'en',model:'tiny'},jobs:[],imported_sources:[]};
  if(url==='/api/srt/status')return {sources:[],jobs:[]};
  if(url==='/api/chatgpt/status')return {extensionConnected:false};
  return {ok:true};
 };
 w.workflow={context:()=>({...ctx}),key:()=>ctx.project_id+'/'+ctx.video_id,requireContext:()=>{if(!ctx.video_id)throw Error('Select a video');return {...ctx};},assertCurrent:value=>{if(value.video_id!==ctx.video_id||value.project_id!==ctx.project_id)throw Error('Video changed');},api};
 w.videoSettings={effective:()=>current,assertSaved:()=>{if(!current)throw Error('Settings loading');},ready:async()=>{},reload:async()=>{calls.push({reload:true});}};
 w.projectSettings={assertSaved:()=>{}};w.studio={api};
 w.document.addEventListener('production-defaults-reset',e=>resets.push(clone(e.detail)));
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/production-defaults.js'),'utf8'));
 for(const script of scripts)w.eval(fs.readFileSync(path.join(__dirname,'../ui/'+script),'utf8'));
 const select=(project_id,video_id,effective=defaults)=>{
  ctx={project_id,video_id};current=null;w.document.dispatchEvent(new w.CustomEvent('workflow-changed',{detail:{...ctx}}));
  if(effective){current=clone(effective);w.document.dispatchEvent(new w.CustomEvent('production-settings-changed',{detail:{...ctx,production:current}}));}
 };
 const edit=(id,value)=>{const input=$(id);input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));};
 return {dom,w,$,calls,resets,records,select,edit,settings:value=>{current=clone(value);w.document.dispatchEvent(new w.CustomEvent('production-settings-changed',{detail:{...ctx,production:current}}));}};
}

test('form drafts isolate every video and project, retain explicit edits when inherited defaults change',async()=>{
 const s=setup();try{
  s.select('p1','v1');assert.equal(s.$('el-chunk-size').value,'3000');assert.equal(s.$('wx-language').value,'ja');
  s.edit('el-text','日本語の原稿');s.edit('el-title','Topic one');s.edit('el-chunk-size','1200');s.edit('srt-prompt','My video SRT prompt');
  s.select('p1','v2',{...defaults,tts:{model:'Eleven v3',max_chunk_characters:2200},srt:{instructions:'Video two instructions'}});
  assert.equal(s.$('el-text').value,'');assert.equal(s.$('el-chunk-size').value,'2200');assert.equal(s.$('srt-prompt').value,'Video two instructions');
  s.edit('el-text','Video two narration');
  s.select('p1','v1');assert.equal(s.$('el-text').value,'日本語の原稿');assert.equal(s.$('el-title').value,'Topic one');assert.equal(s.$('el-chunk-size').value,'1200');assert.equal(s.$('srt-prompt').value,'My video SRT prompt');
  s.settings({...defaults,tts:{model:'Different model',max_chunk_characters:2500},whisperx:{...defaults.whisperx,language:'en'}});
  assert.equal(s.$('el-chunk-size').value,'1200');assert.equal(s.$('el-model').value,'Different model');assert.equal(s.$('wx-language').value,'en');
  s.select('p2','v1',{...defaults,tts:{model:'Another project',max_chunk_characters:1800}});
  assert.equal(s.$('el-text').value,'');assert.equal(s.$('el-chunk-size').value,'1800');
  s.select('p1','v2');assert.equal(s.$('el-text').value,'Video two narration');
 }finally{s.dom.window.close();}
});

test('reset restores video defaults while preserving narration and invalidating stale preview',()=>{
 const s=setup();try{
  s.select('p1','v1');s.edit('el-text','Keep this narration');s.edit('el-title','Keep title');s.edit('el-chunk-size','1200');s.edit('wx-language','en');s.edit('srt-prompt','Changed instructions');
  s.$('el-chunk-preview').textContent='Old chunks';s.w.productionDefaults.reset();
  assert.equal(s.$('el-chunk-size').value,'3000');assert.equal(s.$('wx-language').value,'ja');assert.equal(s.$('srt-prompt').value,'Project A SRT instructions');
  assert.equal(s.$('el-text').value,'Keep this narration');assert.equal(s.$('el-title').value,'Keep title');assert.equal(s.$('el-chunk-preview').textContent,'');
  assert.equal(s.resets.length,1);assert.equal(s.resets[0].video_id,'v1');
  const draft=JSON.parse(s.w.localStorage.getItem('production-form:p1/v1'));assert.deepEqual(draft,{'el-text':'Keep this narration','el-title':'Keep title'});
 }finally{s.dom.window.close();}
});

test('SRT builtin template stays independent from the old global draft and per-video prompts survive reload',async()=>{
 const s=setup({scripts:['srt.js'],storage:{'srt-prompt':'OLD GLOBAL INSTRUCTIONS','production-form:p1/v1':JSON.stringify({'srt-prompt':'Saved video one'})}});const builtin=s.$('srt-prompt').value;try{
  s.select('p1','v1');assert.equal(s.$('srt-prompt').value,'Saved video one');
  s.select('p2','v2',{...defaults,srt:{instructions:''}});assert.equal(s.$('srt-prompt').value,builtin);assert.doesNotMatch(s.$('srt-prompt').value,/OLD GLOBAL/);
  s.edit('srt-prompt','New video two');assert.equal(s.w.localStorage.getItem('srt-prompt'),'OLD GLOBAL INSTRUCTIONS');
  s.select('p1','v1');assert.equal(s.$('srt-prompt').value,'Saved video one');
  s.select('p2','v2',{...defaults,srt:{instructions:''}});assert.equal(s.$('srt-prompt').value,'New video two');
  s.$('srt-use-template').click();assert.equal(s.$('srt-prompt').value,builtin);
  assert.equal(JSON.parse(s.w.localStorage.getItem('production-form:p2/v2'))['srt-prompt'],builtin);
  await tick();
 }finally{s.dom.window.close();}
});

test('WhisperX first poll cannot overwrite scoped defaults or edited drafts; save writes only selected video',async()=>{
 const s=setup({scripts:['whisperx.js']});try{
  s.select('p','v');s.edit('wx-model','medium');s.edit('wx-batch','4');await tick();await s.$('wx-refresh').onclick();
  assert.equal(s.$('wx-device').value,'cuda');assert.equal(s.$('wx-language').value,'ja');assert.equal(s.$('wx-model').value,'medium');assert.equal(s.$('wx-batch').value,'4');
  await s.$('wx-settings').onclick();
  const saved=s.calls.find(c=>c.method==='PUT');assert.equal(saved.url,'/api/videos/v/settings');assert.equal(saved.body.revision,1);
  assert.deepEqual(saved.body.overrides,{media:{orientation:'VERTICAL'},whisperx:{model:'medium',device:'cuda',language:'ja',batch_size:4,video_duration_seconds:100}});
  assert.equal(s.calls.some(c=>c.url==='/api/whisperx/settings'),false);assert.match(s.$('wx-message').textContent,/saved for this video/);
 }finally{s.dom.window.close();}
});

test('stale settings events and corrupt stored drafts cannot replace current video settings',()=>{
 const s=setup({storage:{'production-form:p/v':JSON.stringify(['wrong shape'])}});try{
  s.select('p','v');s.w.document.dispatchEvent(new s.w.CustomEvent('production-settings-changed',{detail:{project_id:'old',video_id:'video',production:{tts:{model:'Wrong project'}}}}));
  assert.equal(s.$('el-model').value,'Eleven v4');
  s.select('p','pending',null);assert.throws(()=>s.w.productionDefaults.reset(),/loading/);
 }finally{s.dom.window.close();}
});
