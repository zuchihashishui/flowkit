const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
test('SRT UI selects JSON, preserves long prompt, sends Work options, previews and exports',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{url:'https://studio.test',runScripts:'outside-only'}),w=dom.window,d=w.document,$=id=>d.getElementById(id),calls=[];
 const sources=[];w.setInterval=()=>{};
 w.studio={api:async(method,url,body)=>{calls.push({method,url,body});if(url==='/api/srt/prepare')return {token:'11111111-1111-1111-1111-111111111111',tabId:100};
  if(url==='/api/whisperx/status')return {jobs:[{id:'wx',title:'Narration',result_available:true}]};
  if(url==='/api/srt/analyze')return {status:'READY',stage:'source',issues:[],duration_ms:10000};
  if(url==='/api/chatgpt/status')return {extensionConnected:true,enabled:true,capabilities:['json-attachment-v1','fresh-srt-tab-v1','dedicated-srt-v1'],workers:[1,2,3].map(i=>({id:"text-"+i,state:"RUNNING",progress:{phase:"TEXT_ONLY_PHASE"}})),availableSlots:0,availableSrtSlots:1};
  if(url.endsWith('/preview'))return {text:'1\n00:00:00,000 --> 00:00:03,000\n日本語'};
  return {sources,jobs:[{id:'done',title:'<script>bad</script>',state:'COMPLETED',model:'GPT-6 Astra',cues:1}]};
 },srtImport:async()=>{sources.push({id:'file',title:'My JSON'});return sources.at(-1);},srtSave:async id=>{calls.push({save:id});return {path:'test.srt'};}};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/srt.js'),'utf8'));
 await $('srt-refresh').onclick();assert.equal($('srt-source').options.length,2);
 assert.match($('srt-bridge').textContent,/SRT: Ready.*One request \/ one dedicated tab.*binds automatically/);
 assert.doesNotMatch($('srt-bridge').textContent,/TEXT_ONLY_PHASE|text-1/);
 await $('srt-choose').onclick();assert.equal($('srt-source').value,'file');
 $('srt-prompt').value='長い指示'.repeat(1000);$('srt-model').value='GPT-6 Astra :: High';
 await $('srt-form').onsubmit({preventDefault(){}});
 const submitted=calls.find(c=>c.url==='/api/srt/jobs');assert.equal(submitted.body.source_id,'file');assert.equal(submitted.body.timeout,1800);assert.equal(submitted.body.prompt,'長い指示'.repeat(1000));
 assert.match($('srt-message').textContent,/selected Work tab/);
 assert.equal($('srt-source').value,'file');assert.equal($('srt-jobs').querySelector('script'),null);
 await $('srt-jobs').querySelectorAll('button')[1].onclick();assert.match($('srt-preview').textContent,/日本語/);
 await [...$('srt-jobs').querySelectorAll('button')].find(b=>b.textContent==='Save SRT as…').onclick();assert.equal(calls.at(-1).save,'done');assert.match($('srt-message').textContent,/test.srt/);
 dom.window.close();
});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('JSON template is opt-in for a saved custom prompt, persists and explains timing limits',()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{url:'https://studio.test',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
 w.setInterval=()=>{};w.localStorage.setItem('srt-prompt','My existing audio instructions\n\nKeep this draft');
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/srt.js'),'utf8'));
 assert.equal($('srt-prompt').value,'My existing audio instructions\n\nKeep this draft');
 $('srt-use-template').onclick();
 assert.match($('srt-prompt').value,/attached transcript JSON/);
 assert.match($('srt-prompt').value,/do not duplicate parallel word lists/);
 assert.match($('srt-prompt').value,/duration is unavailable/);
 assert.match($('srt-prompt').value,/HH:MM:SS,mmm --> HH:MM:SS,mmm/);
 assert.equal(w.localStorage.getItem('srt-prompt'),$('srt-prompt').value);
 dom.window.close();
});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function sourceUI(responses={}){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{url:'https://studio.test',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
 w.setInterval=()=>{};
 w.studio={api:async(method,url)=>{
  if(responses[url])return responses[url]();
  if(url==='/api/srt/prepare')return {token:'11111111-1111-1111-1111-111111111111',tabId:100};
  if(url==='/api/srt/status')return {sources:[],jobs:[]};
  if(url==='/api/whisperx/status')return {jobs:[]};
  return {extensionConnected:false};
 },srtImport:async()=>({id:'picked',title:'日本語.json'})};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/srt.js'),'utf8'));
 return {dom,w,$};
}

test('pending bridge status does not hide sources or block the JSON picker; stale status keeps the newly imported selection',async()=>{
 const bridge=deferred(),status=deferred();let calls=0;
 const {dom,w,$}=sourceUI({
  '/api/chatgpt/status':()=>bridge.promise,
  '/api/srt/status':()=>++calls===1?{sources:[{id:'saved',title:'Saved.json'}],jobs:[]}:status.promise,
  '/api/whisperx/status':()=>({jobs:[{id:'wx',title:'Completed',result_available:true},{id:'running',state:'RUNNING'}]})
 });
 try{
  const initial=$('srt-refresh').onclick();await tick();
  assert.equal($('srt-source').options.length,3);
  assert.equal($('srt-choose').disabled,false);
  const refreshing=$('srt-refresh').onclick();await tick();
  assert.equal($('srt-choose').disabled,false);
  await $('srt-choose').onclick();
  assert.equal($('srt-source').value,'picked');assert.match($('srt-message').textContent,/日本語.json/);
  assert.equal($('srt-choose').disabled,false);assert.equal($('srt-start').disabled,false);
  status.resolve({sources:[{id:'saved',title:'Saved.json'}],jobs:[]});
  bridge.reject(Error('Gateway unavailable'));await Promise.all([initial,refreshing]);
  assert.equal($('srt-source').value,'picked');assert.equal($('srt-source').options.length,4);
  assert.match($('srt-bridge').textContent,/JSON selection remains available/);
 }finally{dom.window.close();}
});

test('failed or malformed source endpoints do not hide healthy lists and refresh recovers',async()=>{
 let fail=true;
 const {dom,w,$}=sourceUI({
  '/api/srt/status':()=>{if(fail)throw Error('Backend HTTP 404 on /api/srt/status');return {sources:[{id:'saved',title:'Imported.json'}],jobs:[]};},
  '/api/whisperx/status':()=>fail?{jobs:[{id:'legacy',title:'Legacy completed',state:'COMPLETED'},{id:'explicit-missing',state:'COMPLETED',result_available:false},{id:'pending',state:'RUNNING'}]}:{unexpected:true}
 });
 try{
  await $('srt-refresh').onclick();
  assert.equal($('srt-source').options.length,2);assert.equal($('srt-source').options[1].value,'legacy');
  assert.match($('srt-source-status').textContent,/missing from the running backend/);
  await $('srt-choose').onclick();assert.equal($('srt-source').value,'picked');
  await tick();fail=false;await $('srt-refresh').onclick();
  assert.equal($('srt-source').value,'picked');assert.equal($('srt-source').options.length,4);
  assert.match($('srt-source-status').textContent,/Unexpected WhisperX/);
  assert.doesNotMatch($('srt-source-status').textContent,/missing from the running backend/);
 }finally{dom.window.close();}
});

test('picker cancellation, import errors and stale preload keep selection and release controls',async()=>{
 const {dom,w,$}=sourceUI();
 try{
  await $('srt-choose').onclick();assert.equal($('srt-source').value,'picked');await tick();
  const choice=deferred();w.studio.srtImport=()=>choice.promise;
  const choosing=$('srt-choose').onclick();assert.equal($('srt-choose').disabled,true);
  choice.resolve({canceled:true});await choosing;
  assert.equal($('srt-source').value,'picked');assert.equal($('srt-start').disabled,false);
  assert.match($('srt-message').textContent,/cancelled/);
  w.studio.srtImport=async()=>{throw Error('The selected file must contain valid UTF-8 JSON.');};
  await $('srt-choose').onclick();assert.match($('srt-message').textContent,/valid UTF-8/);
  assert.equal($('srt-choose').disabled,false);assert.equal($('srt-source').value,'picked');
  delete w.studio.srtImport;await $('srt-choose').onclick();
  assert.match($('srt-message').textContent,/Restart Studio completely/);
  assert.equal($('srt-choose').disabled,false);
 }finally{dom.window.close();}
});

test('queued SRT explains why it is waiting, exposes recovery links and resumes its display without creating another job',async()=>{
 const calls=[];
 let queue={ready:false,code:'EXTENSION_UPDATE_REQUIRED',message:'Reload extensions/chatgpt for JSON attachments.',worker_running:true};
 let job={id:'waiting',title:'Narration.json',state:'QUEUED',model:'GPT-6 Astra',queue_position:1};
 const {dom,w,$}=sourceUI({'/api/srt/status':()=>({sources:[],jobs:[{...job,wait_reason:queue}],queue})});
 w.studio.chatgptAction=async action=>calls.push(action);
 w.document.querySelector('[data-page="settings"]').addEventListener('click',()=>calls.push('workers'));
 try{
  await $('srt-refresh').onclick();
  assert.match($('srt-queue-status').textContent,/Reload extensions\/chatgpt/);
  assert.match($('srt-jobs').querySelector('.srt-wait-reason').textContent,/Queue position 1.*JSON attachments/);
  assert.match($('srt-queue-details').textContent,/EXTENSION_UPDATE_REQUIRED/);
  await $('srt-open-extension').onclick();await $('srt-open-chatgpt').onclick();$('srt-workers').onclick();
  assert.deepEqual(calls,['extension','workers']);
  queue={ready:false,code:'SRT_BUSY',message:'Another SRT job is running.'};job={...job,state:'RUNNING'};
  await $('srt-queue-refresh').onclick();
  assert.match($('srt-jobs').textContent,/RUNNING/);
  assert.equal($('srt-jobs').querySelector('.srt-wait-reason'),null);
  assert.equal($('srt-choose').disabled,false);
 }finally{dom.window.close();}
});

test('transcript checks are optional and do not block sending the original JSON',async()=>{
 let checked=[],submitted=0,status='BLOCKED';
 const {dom,w,$}=sourceUI();
 const base=w.studio.api;
 w.studio.api=async(method,url,body)=>{
  if(url==='/api/srt/analyze'){checked.push(body);return {status,stage:'source',issues:[{severity:'error',code:'MISSING',message:'Source data is missing.'}]};}
  if(url==='/api/srt/jobs'){submitted++;return {id:'new'};}
  return base(method,url,body);
 };
 try{
  await $('srt-choose').onclick();$('srt-duration').value='50.123';
  await $('srt-form').onsubmit({preventDefault(){}});
  assert.equal(submitted,1);assert.equal(checked.length,0);
  await $('srt-check').onclick();assert.equal(checked[0].duration_seconds,50.123);
  assert.match($('srt-quality-issues').textContent,/Source data is missing/);

  status='READY';await $('srt-form').onsubmit({preventDefault(){}});assert.equal(submitted,2);
  $('srt-source').dispatchEvent(new w.Event('change'));
  assert.equal($('srt-duration').value,'');assert.equal($('srt-quality').hidden,true);
 }finally{dom.window.close();}
});

test('quality exceptions are visible and must be accepted before scene import or assembly',async()=>{
 let approved=false,calls=[];
 const report=()=>({stage:'output',status:'REVIEW',approved,source_units:10000,source_characters:10000,
  text_preserved:true,continuous_timeline:true,cue_count:200,shortest_ms:2500,longest_ms:18000,duration_ms:2000000,
  issues:[{severity:'warning',code:'SCENE_DURATION',message:'Scene 1 lasts 2.500s; outside the 3–15s target.'}],
  scenes:[{scene:1,first_unit:1,last_unit:10,start_ms:0,end_ms:2500,duration_ms:2500,text:'<script>日本語</script>'}]});
 const {dom,w,$}=sourceUI({
  '/api/srt/status':()=>({sources:[],jobs:[{id:'done',title:'Japanese',state:'COMPLETED',method:'source-boundaries-v1',quality:report()}]}),
  '/api/srt/jobs/done/quality':report,
  '/api/srt/jobs/done/approve':()=>{approved=true;calls.push('approved');return report();}
 });
 const find=text=>[...$('srt-jobs').querySelectorAll('button')].find(b=>b.textContent===text);
 try{
  await $('srt-refresh').onclick();assert.equal(find('Import as Scenes').disabled,true);assert.equal(find('Assemble video').disabled,true);
  await find('Quality report').onclick();
  assert.match($('srt-quality-summary').textContent,/100% source coverage/);
  assert.match($('srt-quality-summary').textContent,/200 scenes/);
  assert.match($('srt-quality-issues').textContent,/2.500s/);
  assert.equal($('srt-quality-scenes').querySelector('script'),null);
  assert.equal($('srt-approve').hidden,false);
  await $('srt-approve').onclick();await tick();await $('srt-refresh').onclick();
  assert.deepEqual(calls,['approved']);assert.equal(find('Import as Scenes').disabled,false);assert.equal(find('Assemble video').disabled,false);
  assert.equal($('srt-approve').hidden,true);assert.match($('srt-quality-status').textContent,/Exceptions accepted/);
 }finally{dom.window.close();}
});

test('source changes while preparing a tab cannot submit a stale source',async()=>{
 const pending=deferred();let submitted=0;
 const {dom,w,$}=sourceUI({'/api/srt/prepare':()=>pending.promise,'/api/srt/jobs':()=>{submitted++;return {id:'bad'};}});
 try{
  await $('srt-choose').onclick();
  const task=$('srt-form').onsubmit({preventDefault(){}});await tick();
  $('srt-duration').value='42';$('srt-duration').dispatchEvent(new w.Event('input'));
  pending.resolve({token:'ready-token'});await task;
  assert.equal(submitted,0);assert.equal($('srt-quality').hidden,true);
  assert.match($('srt-message').textContent,/selection changed/);
 }finally{dom.window.close();}
});

test('pending SRT opens inline stop control and never enqueues a duplicate',async()=>{
 let stopped=0,submitted=0;
 const {dom,w,$}=sourceUI({
  '/api/srt/prepare':()=>({state:'running',job_id:'old-job',message:'Existing job is running'}),
  '/api/srt/jobs/old-job/cancel':()=>{stopped++;return {state:'CANCELLED'};},
  '/api/srt/jobs':()=>{submitted++;return {};}
 });
 try{
  await $('srt-choose').onclick();
  await $('srt-form').onsubmit({preventDefault(){}});
  assert.equal(submitted,0);assert.equal($('srt-stop-blocking').hidden,false);
  await $('srt-stop-blocking').onclick();
  assert.equal(stopped,1);assert.equal($('srt-stop-blocking').hidden,true);
 }finally{dom.window.close();}
});
