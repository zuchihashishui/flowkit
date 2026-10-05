const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('SRT + TXT import, row filters, errors, retry and selection survive refresh',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id),calls=[],notices=[];
 const data={video:{id:'v1',project_id:'p1',title:'SRT scenes'},document:null,segments:[],warnings:[]};
 w.$=$;w.confirm=()=>true;w.setInterval=()=>0;w.notice=(message)=>notices.push(message);
 w.action=async fn=>{try{return await fn();}catch(error){notices.push(error.message);}};
 w.api=async(method,route,body)=>{
  calls.push({method,route,body});
  if(route.startsWith('/api/videos'))return [data.video];
  if(route==='/api/storyboard/videos/v1')return structuredClone(data);
  if(route.endsWith('/prompt-input')){
   data.document={id:'doc1',prompt_template:body.prompt_template,prompt_name:body.prompt_name,srt_name:body.srt_name};
   data.segments=Array.from({length:200},(_,i)=>({id:'s'+(i+1),ordinal:i+1,start_ms:i*4000,end_ms:(i+1)*4000,text:'日本語 '+(i+1)+'\nNext line',concepts:[],active_concept:null,ready:false,media_jobs:[]}));
   return structuredClone(data);
  }
  if(route.endsWith('/generate-concepts'))return {ids:body.segment_ids,skipped:[]};
  if(route.endsWith('/retry-failed')){for(const id of body.segment_ids)data.segments.find(s=>s.id===id).job={state:'QUEUED'};return {ids:body.segment_ids,skipped:[],resumed:[]};}
  throw Error('Unexpected route '+route);
 };
 w.element=(tag,text,cls)=>{const e=w.document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 w.button=(text,fn)=>{const e=w.element('button',text);e.onclick=fn;return e;};w.option=(value,label)=>{const e=w.element('option',label);e.value=value;return e;};
 w.studio={importScriptSource:async kind=>kind==='srt'?{name:'scenes.srt',text:'SRT source'}:{name:'prompt.txt',text:'Create one visual prompt.\nStyle instructions.'}};
 $('project-select').append(w.option('p1','Project'));$('project-select').value='p1';$('video-select').append(w.option('v1','Video'));$('video-select').value='v1';
 try{
  new vm.Script(fs.readFileSync(path.join(__dirname,'../ui/storyboard.js'),'utf8')).runInContext(dom.getInternalVMContext());await w.storyboard.open();
  await $('sb-choose-srt').onclick();await $('sb-choose-prompt').onclick();
  $('sb-inputs').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
  const input=calls.find(c=>c.route.endsWith('/prompt-input'));assert.equal(input.body.srt_name,'scenes.srt');assert.equal(input.body.prompt_name,'prompt.txt');
  assert.equal($('sb-rows').children.length,200);assert.equal(w.storyboard.count(),200);assert.match($('sb-summary').textContent,/Not started: 200/);
  await $('sb-create-concepts').onclick();assert.equal(calls.find(c=>c.route.endsWith('/generate-concepts')).body.segment_ids.length,200);
  data.segments[0].ready=true;data.segments[0].active_concept={id:'c1',version:1,image_prompt:'A saved image',video_prompt:''};data.segments[0].job={state:'COMPLETED'};
  data.segments[1].job={state:'FAILED',error:'Rate limit <script>unsafe()</script>'};data.segments[2].job={state:'RUNNING'};data.segments[3].job={state:'QUEUED'};
  await $('sb-refresh').onclick();assert.match($('sb-summary').textContent,/Completed: 1/);assert.match($('sb-summary').textContent,/Error \/ review: 1/);
  $('sb-filter').value='error';$('sb-filter').onchange();assert.equal($('sb-rows').children.length,1);assert.equal($('sb-rows').firstChild.dataset.rowId,'s2');assert.equal($('sb-rows').querySelector('script'),null);
  $('sb-select-visible').click();assert.equal(w.storyboard.count(),1);await $('sb-refresh').onclick();assert.equal(w.storyboard.count(),1);
  const retry=[...$('sb-rows').querySelectorAll('button')].find(b=>b.textContent==='Retry row');await retry.onclick();
  const call=calls.find(c=>c.route.endsWith('/retry-failed'));assert.deepEqual(Array.from(call.body.segment_ids),['s2']);assert.equal(data.segments[0].active_concept.image_prompt,'A saved image');
  $('sb-filter').value='all';$('sb-filter').onchange();$('sb-select-unfinished').click();assert.equal(w.storyboard.count(),196);
  $('sb-search').value='日本語 200';$('sb-search').oninput();assert.equal($('sb-rows').children.length,1);assert.match($('sb-rows').textContent,/日本語 200/);
  assert.ok(!notices.some(n=>/Unexpected|not defined/.test(n)),notices.join('\n'));
 }finally{dom.window.close();}
});
