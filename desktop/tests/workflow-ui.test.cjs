const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const flush=async()=>{for(let i=0;i<10;i++)await tick();await new Promise(r=>setTimeout(r,30));};
const ctx=video_id=>({project_id:'project-'+video_id,video_id});

test('blocked preflight never submits a paid job; successful checks freeze the original video',async()=>{
 const s=await studio(),{w,calls}=s;
 try{
  const checks=[];
  w.production={check:async(stage,body)=>{checks.push({stage,body});return false;}};
  await assert.rejects(w.workflow.api('POST','/api/elevenlabs/jobs',{text:'Narration'}),/Preflight blocked/);
  assert.equal(checks[0].stage,'elevenlabs');assert.equal(checks[0].body.video_id,'a');
  assert(!calls.some(c=>c.method==='POST'&&c.route==='/api/elevenlabs/jobs'));
  let release;
  w.production.check=()=>new Promise(resolve=>{release=resolve;});
  const pending=w.workflow.api('POST','/api/whisperx/jobs',{source_id:'el-a'});
  const rejected=assert.rejects(pending,/active project or video changed/i);
  await tick();await s.select('b');release(true);await rejected;
  assert(!calls.some(c=>c.method==='POST'&&c.route==='/api/whisperx/jobs'));
  w.production.check=async(stage,body)=>{checks.push({stage,body});return true;};
  await w.workflow.api('POST','/api/whisperx/jobs',{source_id:'el-b',device:'cpu'});
  assert.equal(checks.at(-1).body.device,'cpu');
  const submitted=calls.find(c=>c.method==='POST'&&c.route==='/api/whisperx/jobs');
  assert.equal(submitted.body.video_id,'b');assert.equal(submitted.body.source_id,'el-b');
 }finally{s.dom.window.close();}
});

async function studio(sameProject=false){
 const context=id=>sameProject?{project_id:'shared-project',video_id:id}:ctx(id);
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only',url:'https://studio.test'});
 const w=dom.window,$=id=>w.document.getElementById(id),calls=[];
 w.setInterval=()=>0;w.confirm=()=>true;w.HTMLMediaElement.prototype.pause=()=>{};
 for(const id of ['a','b']){const option=w.document.createElement('option');option.value=id;option.textContent='Video '+id;$('video-select').append(option);}
 let override;
 const options={model:'large-v3',device:'cuda',language:'ja',batch_size:8,auto:false};
 w.studio={settings:async()=>({}),api:async(method,route,body)=>{
  calls.push({method,route,body});
  const replacement=override?.(method,route,body);if(replacement!==undefined)return replacement;
  const url=new URL(route,'http://local'),pathname=url.pathname,v=url.searchParams.get('video_id')||'unassigned';
  if(pathname==='/api/workflow/resources')return {resources:v==='unassigned'?[]:[
   {id:'el-'+v,title:'Narration '+v,resource_kind:'elevenlabs',state:'COMPLETED',result_available:true,created:1,...context(v),sources:[]},
   {id:'wx-'+v,title:'Transcript '+v,resource_kind:'whisperx',state:'COMPLETED',created:2,...context(v),sources:[{kind:'elevenlabs',id:'el-'+v}]},
   {id:'srt-'+v,title:'Subtitles '+v,resource_kind:'srt',state:'COMPLETED',created:3,...context(v),sources:[]}
  ]};
  if(method==='GET'&&pathname==='/api/elevenlabs/jobs')return {jobs:[{id:'el-'+v,title:'Narration '+v,state:'COMPLETED',merged_url:'/audio',created:1}],settings:{}};
  if(pathname==='/api/elevenlabs/status')return {connected:true,enabled:true,ready:true,autoPrepareTab:true,settings:{}};
  if(pathname==='/api/elevenlabs/preview')return {characters:body.text.length,chunks:[{text:body.text,characters:body.text.length,index:1}]};
  if(pathname==='/api/whisperx/status')return {transcript_split_version:1,settings:options,imported_sources:[],jobs:[{id:'wx-'+v,title:'Transcript '+v,state:'COMPLETED',phase:'COMPLETED',options,result_available:true}]};
  if(pathname==='/api/srt/status')return {sources:[{id:'json-'+v,title:'Imported JSON '+v}],jobs:[{id:'srt-'+v,title:'Subtitles '+v,state:'COMPLETED',model:'Astra'}],queue:{message:'Ready'}};
  if(pathname==='/api/assembly/status')return {assets:[],jobs:[],ffmpeg:true,ffprobe:true};
  if(pathname==='/api/srt/prepare')return {token:'11111111-1111-1111-1111-111111111111'};
  if(pathname==='/api/chatgpt/status')return {extensionConnected:false};
  if(method==='POST')return {id:'queued'};
  throw Error('Unexpected request '+method+' '+route);
 }};
 for(const name of ['workflow','elevenlabs','whisperx','srt','assembly'])w.eval(fs.readFileSync(path.join(__dirname,'../ui/'+name+'.js'),'utf8'));
 const select=async id=>{$('video-select').value=id;w.workflow.set(context(id));await flush();};
 await select('a');
 return {dom,w,$,calls,select,setReply:fn=>{override=fn;}};
}

test('all stage lists follow the active video; handoffs select sources without generating',async()=>{
 const s=await studio(),{w,$,calls}=s;
 try{
  assert($('active-video-name'));assert.equal($('video-select').hidden,false);
  assert.match($('wx-source').textContent,/Narration a/);assert.match($('srt-source').textContent,/Transcript a/);
  assert.match($('va-srt').textContent,/Subtitles a/);assert.match($('el-job-rows').textContent,/Narration a/);
  const button=label=>[...$('wf-resources').querySelectorAll('button')].find(b=>b.textContent===label);
  await button('Use for WhisperX').onclick();await flush();assert.equal($('wx-source').value,'el-a');
  await button('Use for SRT').onclick();await flush();assert.equal($('srt-source').value,'wx-a');
  await button('Use for Video Assembly').onclick();await flush();assert.equal($('va-srt').value,'job:srt-a');
  assert(!calls.some(c=>c.method==='POST'&&c.route!=='/api/srt/prepare'));
  $('srt-preview').textContent='Old subtitles';$('wx-result').hidden=false;
  await s.select('b');
  for(const id of ['wx-source','srt-source','va-srt','va-audio','el-job-rows'])assert.doesNotMatch($(id).textContent,/Narration a|Transcript a|Subtitles a|Imported JSON a/);
  assert.equal($('srt-preview').textContent,'');assert.equal($('wx-result').hidden,true);
  assert.equal($('va-render').disabled,true);assert.equal(w.workflow.context().project_id,'project-b');
  $('wx-source').value='el-b';await $('wx-form').onsubmit({preventDefault(){}});
  const job=calls.find(c=>c.method==='POST'&&c.route==='/api/whisperx/jobs');
  assert.equal(job.body.source_id,'el-b');assert.equal(job.body.video_id,'b');assert.equal(job.body.project_id,'project-b');
 }finally{s.dom.window.close();}
});

test('changing video during preview cannot enqueue the prior script into the new video',async()=>{
 const s=await studio(),{$,calls}=s;let release;
 try{
  s.setReply((method,route)=>route==='/api/elevenlabs/preview'?new Promise(resolve=>{release=resolve;}):undefined);
  $('el-text').value='日本語の長い台本';
  const pending=$('el-form').onsubmit({preventDefault(){}});await tick();
  assert(release);await s.select('b');
  release({characters:10,chunks:[{index:1,text:'日本語の長い台本',characters:10}]});await pending;
  assert(!calls.some(c=>c.method==='POST'&&c.route==='/api/elevenlabs/jobs'));
  assert.match($('el-message').textContent,/project or video changed/i);
  assert.equal($('el-text').value,'日本語の長い台本');
 }finally{s.dom.window.close();}
});

test('a late status response cannot restore old sources after a video switch',async()=>{
 const s=await studio(),{w,$}=s;let release;
 try{
  s.setReply((method,route)=>route==='/api/whisperx/status?project_id=project-a&video_id=a'?new Promise(resolve=>{release=resolve;}):undefined);
  const old=w.workflow.api('GET','/api/whisperx/status');
  const rejected=assert.rejects(old,/Active project or video changed/);
  await s.select('b');release({jobs:[{id:'stale'}]});await rejected;
  assert.doesNotMatch($('srt-source').textContent,/Transcript a|stale/);
  assert.match($('srt-source').textContent,/Transcript b/);
 }finally{s.dom.window.close();}
});

test('assignment requires a concrete preview and confirmation; selecting video alone does not assign',async()=>{
 const s=await studio(),{w,$,calls}=s;
 try{
  const legacy={id:'legacy',resource_kind:'audio',title:'Existing voice',state:'IMPORTED',created:1,sources:[],project_id:null,video_id:null};
  s.setReply((method,route)=>route.endsWith('unassigned=true')?{resources:[legacy]}:route.endsWith('/assignment-preview')?{resources:[legacy]}:undefined);
  $('wf-view').value='unassigned';await w.workflow.refresh();
  const button=$('wf-resources').querySelector('button');
  assert(!calls.some(c=>c.route.endsWith('/assign')));
  w.confirm=message=>{assert.match(message,/Existing voice/);return false;};await button.onclick();
  assert(!calls.some(c=>c.route.endsWith('/assign')));
  w.confirm=()=>true;await button.onclick();await flush();
  const assign=calls.find(c=>c.route.endsWith('/assign'));
  assert.deepEqual(JSON.parse(JSON.stringify(assign.body)),{...ctx('a'),kind:'audio',id:'legacy'});
  assert(!calls.some(c=>c.method==='POST'&&c.route.endsWith('/jobs')));
 }finally{s.dom.window.close();}
});


test('assembly production actions carry the selected project ownership',async()=>{
 const s=await studio(),{w,calls}=s;
 try{
  for(const route of ['/api/assembly/preflight','/api/assembly/scene-media','/api/assembly/jobs/12345678-1234-1234-1234-123456789abc/resume']){
   await w.workflow.api('POST',route,{srt_id:'fixture'});
   const call=calls.find(c=>c.route===route);
   assert.equal(call.body.project_id,'project-a');assert.equal(call.body.video_id,'a');
  }
 }finally{s.dom.window.close();}
});


test('two videos in the same project have separate stage lists and reject late responses',async()=>{
 const s=await studio(true),{w,$,calls}=s;let release;
 try{
  assert.equal(w.workflow.context().project_id,'shared-project');
  $('va-title').value='First draft';$('va-title').dispatchEvent(new w.Event('input'));
  s.setReply((method,route)=>route==='/api/whisperx/status?project_id=shared-project&video_id=a'?new Promise(resolve=>{release=resolve;}):undefined);
  const pending=w.workflow.api('GET','/api/whisperx/status');const rejected=assert.rejects(pending,/project or video changed/i);
  await s.select('b');release({jobs:[{id:'old-a'}]});await rejected;
  assert.equal(w.workflow.context().project_id,'shared-project');assert.equal(w.workflow.context().video_id,'b');
  for(const id of ['wx-source','srt-source','va-srt','va-audio','el-job-rows'])assert.doesNotMatch($(id).textContent,/Narration a|Transcript a|Subtitles a/);
  assert.match($('wx-source').textContent,/Narration b/);
  assert.equal($('va-title').value,'Untitled video');
  $('wx-source').value='el-b';await $('wx-form').onsubmit({preventDefault(){}});
  const request=calls.find(c=>c.method==='POST'&&c.route==='/api/whisperx/jobs');
  assert.equal(request.body.video_id,'b');assert.equal(request.body.project_id,'shared-project');
  s.setReply(()=>undefined);await s.select('a');assert.equal($('va-title').value,'First draft');
 }finally{s.dom.window.close();}
});


test('Create SRT skips the global review checklist and keeps project/video ownership; ChatGPT menu is removed',async()=>{
 const s=await studio(),{w,calls}=s;
 try{
  w.production={check:async()=>{throw Error('Historical ChatGPT request needs review');}};
  await w.workflow.api('POST','/api/srt/jobs',{source_id:'json-a',prompt:'Convert this',prepared_tab_token:'prepared'});
  const job=calls.find(c=>c.method==='POST'&&c.route==='/api/srt/jobs');
  assert.equal(job.body.video_id,'a');assert.equal(job.body.project_id,'project-a');
  assert.equal(job.body.prepared_tab_token,'prepared');
  assert.equal(w.document.querySelector('[data-page="chatgpt"]'),null);
  assert.equal(w.document.querySelector('[data-view="chatgpt"]'),null);
  assert.equal(w.document.querySelector('script[src="chatgpt-queue.js"]'),null);
 }finally{s.dom.window.close();}
});
