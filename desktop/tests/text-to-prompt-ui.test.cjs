const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('SRT + TXT import, row filters, errors, retry and selection survive refresh',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id),calls=[],notices=[];
 const data={video:{id:'v1',project_id:'p1',title:'SRT scenes'},document:null,segments:[],warnings:[]};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/data-table.js'),'utf8'));
 w.$=$;w.confirm=()=>true;w.setInterval=()=>0;w.notice=(message)=>notices.push(message);
 w.action=async fn=>{try{return await fn();}catch(error){notices.push(error.message);}};
 w.api=async(method,route,body)=>{
  calls.push({method,route,body});
  if(route.endsWith('/saved-srt'))return {name:'saved.srt',text:'Saved SRT',source_kind:'srt',source_id:'source1'};
  if(route.endsWith('/restart-text'))return {ok:true};
  if(route==='/api/chatgpt/status')return {available:true,extensionConnected:true,workers:[{id:'worker-1',tabId:101,state:'RUNNING',progress:{phase:'ATTACHING_FILE'}},{id:'worker-2',tabId:102,state:'RUNNING',progress:{phase:'WAITING_SETUP'}},{id:'worker-3',tabId:103,state:'NEEDS_REVIEW',error:'Upload failed <script>unsafe()</script>'}]};
  if(route.startsWith('/api/videos'))return [data.video];
  if(route==='/api/storyboard/videos/v1')return structuredClone(data);
  if(route.endsWith('/prompt-options')){data.document.prompt_options=structuredClone(body);return body;}
  if(route.endsWith('/prompt-input')){
   data.document={id:'doc1',prompt_template:body.prompt_template,prompt_name:body.prompt_name,srt_name:body.srt_name};
   data.segments=Array.from({length:200},(_,i)=>({id:'s'+(i+1),ordinal:i+1,start_ms:i*4000,end_ms:(i+1)*4000,text:'日本語 '+(i+1)+'\nNext line',concepts:[],active_concept:null,ready:false,media_jobs:[]}));
   return structuredClone(data);
  }
  if(route.endsWith('/generate-concepts'))return {ids:body.segment_ids,skipped:[],batch_count:Math.ceil(body.segment_ids.length/body.batch_size),batch_size:body.batch_size};
  if(route.endsWith('/retry-failed')){for(const id of body.segment_ids)data.segments.find(s=>s.id===id).job={state:'QUEUED'};return {ids:body.segment_ids,skipped:[],resumed:[]};}
  throw Error('Unexpected route '+route);
 };
 w.element=(tag,text,cls)=>{const e=w.document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 w.button=(text,fn)=>{const e=w.element('button',text);e.onclick=fn;return e;};w.option=(value,label)=>{const e=w.element('option',label);e.value=value;return e;};
 w.studio={importScriptSource:async kind=>kind==='srt'?{name:'scenes.srt',text:'SRT source'}:{name:'prompt.txt',text:'Create one visual prompt.\nStyle instructions.'}};
 $('project-select').append(w.option('p1','Project'));$('project-select').value='p1';$('video-select').append(w.option('v1','Video'));$('video-select').value='v1';
 try{
  new vm.Script(fs.readFileSync(path.join(__dirname,'../ui/storyboard.js'),'utf8')).runInContext(dom.getInternalVMContext());await w.storyboard.open();
  assert.equal($('sb-srt-file').textContent,'saved.srt · Auto-loaded');
  assert.equal($('sb-provider').querySelector('option[value="chatgpt-web"]'),null);
  await $('sb-choose-srt').onclick();await $('sb-choose-prompt').onclick();
  $('sb-inputs').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
  const input=calls.find(c=>c.route.endsWith('/prompt-input'));assert.equal(input.body.srt_name,'scenes.srt');assert.equal(input.body.prompt_name,'prompt.txt');
  assert.equal($('sb-rows').children.length,200);assert.equal(w.storyboard.count(),200);assert.match($('sb-summary').textContent,/Not started: 200/);
  $('sb-batch-size').value='10';$('sb-batch-size').onchange();
  await $('sb-create-concepts').onclick();assert.equal(calls.find(c=>c.route.endsWith('/generate-concepts')).body.segment_ids.length,200);
  assert.ok(notices.some(n=>/200 row\(s\) queued in 20 batch/.test(n)));
  assert.match($('sb-start-status').textContent,/200 rows queued/);
  assert.equal(calls.some(c=>c.route.endsWith('/restart-text')),false);assert.equal(calls.find(c=>c.route.endsWith('/generate-concepts')).body.fresh_start,true);
  const originalApi=w.api,originalError=w.console.error;w.console.error=()=>{};
  w.api=async(method,route,body)=>{if(route.endsWith('/generate-concepts'))throw Error('ChatGPT extension disconnected');return originalApi(method,route,body);};
  await $('sb-create-concepts').onclick();assert.match($('sb-start-status').textContent,/Start failed: ChatGPT extension disconnected/);
  w.api=originalApi;w.console.error=originalError;
  data.segments[0].ready=true;data.segments[0].active_concept={id:'c1',version:1,image_prompt:'A saved image',video_prompt:''};data.segments[0].job={state:'COMPLETED'};
  data.segments[1].job={state:'FAILED',error:'Rate limit <script>unsafe()</script>'};data.segments[2].job={state:'RUNNING'};data.segments[3].job={state:'QUEUED'};
  for(const i of [1,2,3])data.segments[i].job.text_batch_id='batch-1';
  data.prompt_outputs=[{kind:'image',directory:'/output/text_prompts/run-1'},{kind:'video',directory:'/output/text_prompts/video-run'}];
  await $('sb-refresh').onclick();assert.equal($('sb-video-row-count').value,'15');$('sb-video-row-count').value='0';$('sb-video-row-count').onchange();await $('sb-save-options').onclick();assert.match($('sb-summary').textContent,/Completed: 1/);assert.match($('sb-summary').textContent,/Error \/ review: 1/);
  assert.equal($('sb-output-folders').hidden,false);assert.equal($('sb-output-folders').textContent,'TXT folder: /output/text_prompts/run-1');
  $('sb-prompt-kind').value='video';$('sb-prompt-kind').onchange();assert.equal($('sb-output-folders').textContent,'TXT folder: /output/text_prompts/video-run');
  $('sb-prompt-kind').value='image';$('sb-prompt-kind').onchange();
  assert.equal($('sb-worker-rows').children.length,3);assert.match($('sb-worker-rows').textContent,/Uploading prompt TXT/);assert.match($('sb-worker-rows').textContent,/Waiting for another tab/);assert.match($('sb-worker-rows').textContent,/Upload failed/);assert.equal($('sb-worker-rows').querySelector('script'),null);
  $('sb-filter').value='error';$('sb-filter').onchange();assert.equal($('sb-rows').children.length,1);assert.equal($('sb-rows').firstChild.dataset.rowId,'s2');assert.equal($('sb-rows').querySelector('script'),null);
  assert.match($('sb-rows').textContent,/Batch: 002, 003, 004/);
  $('sb-select-visible').click();assert.equal(w.storyboard.count(),1);await $('sb-refresh').onclick();assert.equal(w.storyboard.count(),1);
  const retry=[...$('sb-rows').querySelectorAll('button')].find(b=>b.textContent==='Retry row');await retry.onclick();
  const call=calls.find(c=>c.route.endsWith('/retry-failed'));assert.deepEqual(Array.from(call.body.segment_ids),['s2']);assert.equal(data.segments[0].active_concept.image_prompt,'A saved image');
  $('sb-filter').value='all';$('sb-filter').onchange();$('sb-select-unfinished').click();assert.equal(w.storyboard.count(),196);
  $('sb-search').value='日本語 200';$('sb-search').oninput();assert.equal($('sb-rows').children.length,1);assert.match($('sb-rows').textContent,/日本語 200/);
  for(const type of ['video_4s','video_6s','video_8s','video_10s']){
   await $('sb-upload-'+type).onclick();
  }
  const picker=$('sb-rows').querySelector('[data-instruction-row="s200"]');picker.value='video';picker.onchange();
  $('sb-provider').value='chatgpt-web-chat';$('sb-provider').onchange();$('sb-batch-size').value='7';$('sb-batch-size').onchange();
  await $('sb-save-options').onclick();
  const saved=calls.filter(c=>c.route.endsWith('/prompt-options')).at(-1).body;
  assert.equal(saved.composer_mode,'chat');assert.equal(saved.batch_size,7);assert.equal(saved.row_instructions.s200,'video');assert.equal(Object.keys(saved.templates).length,5);
  assert.equal(saved.templates.video_10s.text,'Create one visual prompt.\nStyle instructions.');
  await $('sb-create-concepts').onclick();const mixed=calls.filter(c=>c.route.endsWith('/generate-concepts')).at(-1).body;
  assert.equal(mixed.provider,'chatgpt-web');assert.equal(mixed.composer_mode,'chat');assert.equal(mixed.batch_size,7);assert.equal(mixed.use_row_instructions,true);
  assert.ok(!notices.some(n=>/Unexpected|not defined/.test(n)),notices.join('\n'));
 }finally{dom.window.close();}
});

test('ChatGPT prompt start and explicit retry reach preparation despite historical preflight errors; media and CLI keep checks',async()=>{
 const calls=[],checks=[];let saved=0;
 const window={studio:{api:async(...args)=>{calls.push(args);return {ok:true};}},projectSettings:{assertSaved:()=>saved++},videoSettings:{assertSaved:()=>saved++},workflow:{context:()=>({project_id:'p',video_id:'v'}),assertCurrent(){}},production:{check:async stage=>{checks.push(stage);return false;}}};
 const source=fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8').split('const ACTIVE =')[0];
 const context=vm.createContext({window,document:{getElementById(){}},});
 vm.runInContext(source+';globalThis.submit=api;',context);
 for(const route of ['generate-concepts','retry-failed'])await context.submit('POST','/api/storyboard/videos/v/'+route,{provider:'chatgpt-web',kind:'concept',prompt_kind:'image'});
 assert.equal(calls.length,2);assert.equal(checks.length,0);assert.equal(saved,4);
 await assert.rejects(context.submit('POST','/api/storyboard/videos/v/generate-media',{kind:'image'}),/Preflight blocked/);
 await assert.rejects(context.submit('POST','/api/storyboard/videos/v/generate-concepts',{provider:'codex'}),/Preflight blocked/);
 assert.equal(calls.length,2);assert.deepEqual(checks,['images','image_prompts']);
});

test('folder instructions load before SRT, preserve edits, resume folder loading and isolate videos',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id),notices=[];
 let context={project_id:'p',video_id:'v'},saved={},doc=null;
 const disk=Object.fromEntries(['image','video_4s','video_6s','video_8s','video_10s'].map(k=>[k,{name:'prompt_instructions_'+k+'.txt',text:'Folder '+k,source:'folder'}]));
 w.$=$;w.confirm=()=>true;w.setInterval=()=>0;w.notice=m=>notices.push(m);w.action=async fn=>{try{return await fn();}catch(e){notices.push(e.message);}};
 w.workflow={context:()=>context};
 w.element=(tag,text,cls)=>{const e=w.document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 w.button=(text,fn)=>{const e=w.element('button',text);e.onclick=fn;return e;};w.option=(value,label)=>{const e=w.element('option',label);e.value=value;return e;};
 w.api=async(method,route,body)=>{
  if(route==='/api/chatgpt/status')return {workers:[]};
  if(route.endsWith('/prompt-options')){saved=structuredClone(body);return body;}
  if(route==='/api/storyboard/videos/v2')return {video:{id:'v2'},document:null,segments:[],warnings:[],prompt_options:{templates:{}}};
  assert.equal(route,'/api/storyboard/videos/v');
  const templates=structuredClone(saved.templates||{});
  for(const [k,file] of Object.entries(disk))if(!templates[k]||templates[k].source==='folder')templates[k]=structuredClone(file);
  const options={...saved,templates},info={directory:'C:/output/projects/project/video/prompts',warnings:[]};
  return {video:{id:'v'},document:doc?{...doc,prompt_options:options,prompt_instruction_files:info}:null,prompt_options:options,prompt_instruction_files:info,segments:[],warnings:[]};
 };
 $('project-select').append(w.option('p','Project'));$('project-select').value='p';$('video-select').append(w.option('v','Video'),w.option('v2','Video 2'));$('video-select').value='v';
 try{
  w.eval(fs.readFileSync(path.join(__dirname,'../ui/storyboard.js'),'utf8'));await w.storyboard.open();
  for(const k of Object.keys(disk))assert.match($('sb-file-'+k).textContent,/Auto-loaded/);
  assert.match($('sb-instructions-folder').textContent,/video\/prompts/);
  doc={id:'d',script_text:'SRT'};await w.storyboard.open();w.promptInstructionEditor('video_4s');
  $('sb-template').value='My manual edit';$('sb-template').oninput();disk.video_4s.text='Updated disk';
  await w.storyboard.open();assert.equal($('sb-template').value,'My manual edit');
  await $('sb-save-options').onclick();assert.equal(saved.templates.video_4s.source,'manual');assert.equal(saved.templates.video_4s.text,'My manual edit');
  await w.storyboard.open();assert.equal($('sb-template').value,'My manual edit');
  await w.usePromptInstructionFolder('video_4s');w.promptInstructionEditor('video_4s');assert.equal($('sb-template').value,'Updated disk');
  assert.equal(saved.templates.video_4s.source,'folder');
  disk.video_4s.text='Next disk revision';await w.storyboard.open();assert.equal($('sb-template').value,'Next disk revision');
  context={project_id:'p',video_id:'v2'};$('video-select').value='v2';await w.storyboard.open();
  assert.equal($('sb-file-video_4s').textContent,'No TXT loaded');assert.equal($('sb-template').value,'');
  assert.deepEqual(notices.filter(m=>!/saved for this video/.test(m)),[]);
 }finally{w.close();}
});

for(const kind of ['image','video'])test('chosen row prompt opens full '+kind+' editor and saves only that field',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id),writes=[];
 const concept={id:'c1',version:1,title:'Scene',description:'Description',image_prompt:'Image 日本語\n'.repeat(300),video_prompt:'Video 日本語\n'.repeat(300)};
 const data={video:{id:'v1',project_id:'p1',title:'Video'},document:{id:'d1',prompt_options:{templates:{},video_row_count:0,row_instructions:{}}},segments:[{id:'s1',ordinal:1,start_ms:0,end_ms:4000,text:'Narration',revision:1,active_concept_id:'c1',active_concept:concept,concepts:[concept],ready:true,media_jobs:[]}],warnings:[]};
 w.$=$;w.confirm=()=>true;w.setInterval=()=>0;w.notice=()=>{};w.action=async fn=>fn();
 w.element=(tag,text,cls)=>{const n=w.document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 w.button=(text,fn)=>{const n=w.element('button',text);n.onclick=fn;return n;};w.option=(value,label)=>{const n=w.element('option',label);n.value=value;return n;};
 w.api=async(method,route,body)=>{if(method==='POST'){writes.push({route,body:structuredClone(body)});return{id:'c2'};}if(route==='/api/chatgpt/status')return{};if(route.startsWith('/api/videos?'))return[data.video];return structuredClone(data);};
 $('project-select').append(w.option('p1','Project'));$('project-select').value='p1';$('video-select').append(w.option('v1','Video'));$('video-select').value='v1';
 try{
  for(const file of ['popups.js','data-table.js','storyboard.js'])w.eval(fs.readFileSync(path.join(__dirname,'../ui/'+file),'utf8'));
  await w.storyboard.open();
  const picker=$('sb-rows').querySelector('[data-instruction-row]');picker.value=kind;picker.onchange();
  const scroll=$('sb-rows').closest('.table-wrap');scroll.scrollTop=240;
  $('sb-rows').querySelector('[aria-label="Edit '+kind+' prompt for scene 1"]').click();
  const popup=w.document.querySelector('.scene-prompt-popup[open]'),input=popup.querySelector('textarea');assert.equal(input.value,concept[kind+'_prompt']);assert.equal(input.readOnly,false);
  input.value='Edited '+kind+'\n日本語';await w.storyboard.open();assert.equal(input.value,'Edited '+kind+'\n日本語');
  popup.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));for(let i=0;i<10&&popup.isConnected;i++)await tick();
  assert.equal(writes.length,1);assert.equal(writes[0].route,'/api/storyboard/segments/s1/concepts');assert.equal(writes[0].body[kind+'_prompt'],'Edited '+kind+'\n日本語');
  const other=kind==='image'?'video':'image';assert.equal(writes[0].body[other+'_prompt'],concept[other+'_prompt']);assert.equal(scroll.scrollTop,240);assert.equal(popup.isConnected,false);
  assert.equal($('sb-rows').querySelector('[data-instruction-row]').value,kind,'unsaved type choice retained');
 }finally{dom.window.close();}
});
