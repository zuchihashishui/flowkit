const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const jobId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function setup(reply,backendReply){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'});
 const w=dom.window,$=id=>w.document.getElementById(id),calls=[];
 w.setInterval=()=>{};w.confirm=()=>true;
 w.URL.createObjectURL=()=> 'blob:audio-preview';w.URL.revokeObjectURL=()=>{};
 const job={id:jobId,title:'<script>unsafe</script>',model:'Eleven v4',state:'NEEDS_REVIEW',total_chunks:2,completed_chunks:1,characters:6000,created:100,chunks:[{index:1,state:'COMPLETED',characters:3000,text:'日本語の文章。',audio_url:'/api/elevenlabs/audio/'+jobId+'/1'},{index:2,state:'NEEDS_REVIEW',characters:3000,text:'続き。',error:'Unknown generation outcome'}]};
 w.studio={
  api:async(method,route,body)=>{calls.push([method,route,body]);if(reply)return reply(method,route,body,job);
   if(route.endsWith('/status'))return {connected:true,enabled:true,needsReview:true,settings:{paused:true},page:{voice:'Japanese narrator',creditsRemaining:241900,estimatedCost:null,credits:{balanceText:'241.9K credits free',cost:null}},progress:{phase:'AWAITING_SAVE',message:'Saving chunk'}};
   if(route.endsWith('/preview'))return {characters:Array.from(body.text).length,chunks:[{index:1,text:body.text,characters:Array.from(body.text).length}]};
   if(route.endsWith('/jobs'))return method==='GET'?{jobs:[job]}:job;
   if(route.endsWith('/'+jobId))return job;return {};
  },backendAction:async action=>{calls.push(['backend',action]);return backendReply ? backendReply(action) : {};},
  elevenlabsAction:async action=>calls.push(['action',action]),
  elevenlabsAudio:async(...args)=>{calls.push(['audio',...args]);return {bytes:new Uint8Array([1]),mime:'audio/mpeg',path:'export.mp3'};},
  elevenlabsExport:async id=>{calls.push(['export',id]);return {path:'output',count:1};}
 };
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/elevenlabs.js'),'utf8'));
 return {dom,w,$,calls,job};
}
test('ElevenLabs UI preserves Japanese script, previews backend chunks and submits Eleven v4',async()=>{
 const {dom,w,$,calls}=setup();
 const text='  日本語。\n次の文です。🎧\n';$('el-text').value=text;$('el-text').dispatchEvent(new w.Event('input'));
 assert.match($('el-character-count').textContent,new RegExp(String(Array.from(text).length)));
 await $('el-preview').onclick();assert.equal($('el-chunk-preview').querySelector('pre').textContent,text);
 $('el-title').value=' Narration ';await $('el-form').onsubmit({preventDefault(){}});
 const submit=calls.find(c=>c[0]==='POST'&&c[1]==='/api/elevenlabs/jobs');assert.deepEqual(JSON.parse(JSON.stringify(submit[2])),{text,title:'Narration',model:'Eleven v4',max_chunk_characters:3000});
 assert.equal($('el-voice').value,'Japanese narrator');assert.match($('el-credits').textContent,/241.9K credits free/);assert.match($('el-credits').textContent,/Cost not shown by page/);
 assert.equal($('el-job-rows').querySelector('script'),null);assert.equal($('el-stage-title').textContent,'Review required');assert.match($('el-technical').textContent,/AWAITING_SAVE/);assert.equal($('el-job-detail').hidden,false);
 dom.window.close();
});
test('audio actions use IDs; review and uncertain retry use inline confirmation without blocking native dialogs',async()=>{
 let needsReview=true;
 const {dom,w,$,calls}=setup(async(method,route,body,job)=>{
  if(route.endsWith('/status'))return {connected:true,enabled:true,busy:needsReview,state:needsReview?'NEEDS_REVIEW':'IDLE',needsReview,settings:{paused:true}};
  if(route.endsWith('/control')){needsReview=false;return {};}
  if(route.endsWith('/jobs'))return {jobs:[job]};
  if(route.endsWith('/retry'))return {queued:1,job};
  return job;
 });
 w.confirm=()=>{throw Error('A native confirmation dialog must not be opened');};
 await $('el-refresh').onclick();
 await $('el-job-rows').querySelector('button').onclick();await $('el-chunk-rows').querySelector('button').onclick();
 assert.deepEqual(calls.find(c=>c[0]==='audio'),['audio',jobId,1,'preview']);assert.equal($('el-audio').hidden,false);
 await $('el-export-all').onclick();assert.deepEqual(calls.at(-1),['export',jobId]);
 let retry=[...$('el-job-rows').querySelectorAll('button')].find(b=>b.textContent==='Retry remaining');
 assert.equal(retry.disabled,true);assert.equal($('el-review').disabled,true);
 $('el-review-confirm').checked=true;$('el-review-confirm').dispatchEvent(new w.Event('change'));
 await $('el-review').onclick();assert(calls.some(c=>c[1]==='/api/elevenlabs/control'&&c[2].action==='review'&&c[2].reviewed));
 assert.match($('el-control-message').textContent,/Worker released/);
 retry=[...$('el-job-rows').querySelectorAll('button')].find(b=>b.textContent==='Retry remaining');await retry.onclick();
 assert.equal($('el-retry-confirmation').hidden,false);assert.equal(calls.filter(c=>c[1]?.endsWith('/retry')).length,0);
 $('el-retry-confirm').checked=true;$('el-retry-confirm').dispatchEvent(new w.Event('change'));
 await $('el-retry-submit').onclick();assert.equal(calls.find(c=>c[1]?.endsWith('/retry'))[2].reviewed,true);
 assert.equal($('el-retry-confirmation').hidden,true);dom.window.close();
});
test('ElevenLabs preview failure prevents enqueue and preserves the script',async()=>{
 const {dom,$,calls}=setup(()=>{throw Error('Backend unavailable');});$('el-text').value='Keep this narration';
 await $('el-form').onsubmit({preventDefault(){}});assert.equal($('el-text').value,'Keep this narration');assert.match($('el-message').textContent,/Backend unavailable/);assert.equal(calls.length,1);assert.equal($('el-generate').disabled,false);dom.window.close();
});
test('ElevenLabs submit guard prevents a double-click from enqueueing twice',async()=>{
 let release,submitted=0;const wait=new Promise(resolve=>release=resolve);
 const {dom,$}=setup(async(method,route,body,job)=>{if(route.endsWith('/preview')){await wait;return {chunks:[]};}if(route.endsWith('/jobs')&&method==='POST'){submitted++;return job;}if(route.endsWith('/status'))return {};if(route.endsWith('/jobs'))return {jobs:[]};return job;});
 $('el-text').value='Narration';const first=$('el-form').onsubmit({preventDefault(){}});await $('el-form').onsubmit({preventDefault(){}});release();await first;assert.equal(submitted,1);dom.window.close();
});
test('Flow activity shows concurrency, runtime submit interval and safe stage labels',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window;
 w.setInterval=()=>{};w.studio={api:async()=>({active:3,max_concurrent:3,queued:10,completed:7,failed:1,generation_throttle:{min_interval_s:5,cooldown_active:true,cooldown_remaining_s:19.7},jobs:[{id:'1',label:'<img src=x>',kind:'image',state:'RUNNING',stage:'GENERATING_IMAGE'}]})};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/flow-progress.js'),'utf8'));w.document.querySelector('[data-page="queue"]').click();await new Promise(resolve=>setImmediate(resolve));
 assert.match(w.document.getElementById('flow-activity-summary').textContent,/3\/3 media slots/);assert.match(w.document.getElementById('flow-activity-summary').textContent,/Submit interval: 5s/);assert.match(w.document.getElementById('flow-activity-summary').textContent,/Cooldown: 20s/);assert.equal(w.document.getElementById('flow-activity-jobs').querySelector('img'),null);assert.match(w.document.getElementById('flow-activity-jobs').textContent,/GENERATING IMAGE/);dom.window.close();
});

test('ElevenLabs shows native download and save phases without stale activity after completion',async()=>{
 let status={connected:true,enabled:true,ready:false,busy:true,state:'RUNNING',active:{chunk_index:2},settings:{paused:false},page:{credits:{balanceText:'',balance:0,cost:null}},progress:{phase:'DOWNLOADING'}};
 const {dom,$}=setup(async(_method,route)=>route.endsWith('/status')?status:{jobs:[]});
 await $('el-refresh').onclick();
 assert.equal($('el-stage-title').textContent,'Downloading audio');assert.match($('el-credits').textContent,/Available credits: 0/);assert.equal($('el-steps').querySelector('[aria-current]').textContent,'Download');assert.equal($('el-probe').disabled,true);
 status={...status,state:'AWAITING_SAVE'};await $('el-refresh').onclick();assert.equal($('el-stage-title').textContent,'Saving audio to this job');
 status={...status,state:'IDLE',active:null,busy:false,ready:true};await $('el-refresh').onclick();
 assert.equal($('el-stage-title').textContent,'Ready for the next chunk');assert.equal($('el-steps').querySelector('[aria-current]'),null);assert.equal($('el-probe').disabled,false);dom.window.close();
});
test('review takes priority over pause and exposes safe next steps; missing credits are optional',async()=>{
 const {dom,$}=setup(async(_method,route)=>route.endsWith('/status')?{connected:true,enabled:true,state:'NEEDS_REVIEW',needsReview:true,settings:{paused:true},page:{},progress:{phase:'DOWNLOADING',message:'Old progress'}}:{jobs:[]});
 await $('el-refresh').onclick();assert.match($('el-connection').textContent,/Queue needs review/);assert.match($('el-credits').textContent,/Available credits: —/);
 assert.equal($('el-review-help').hidden,false);assert.equal($('el-resume').disabled,true);assert.equal($('el-review').disabled,true);assert.doesNotMatch($('el-progress').textContent,/Old progress/);dom.window.close();
});
test('job details show actual saved count and joined audio availability',async()=>{
 const {dom,$}=setup(async(_method,route,_body,job)=>route.endsWith('/status')?{connected:true,settings:{}}:route.endsWith('/jobs')?{jobs:[job]}:{...job,state:'COMPLETED',completed_chunks:2,merged_url:'/api/elevenlabs/audio/'+jobId+'/merged'});
 await $('el-refresh').onclick();await $('el-job-rows').querySelector('button').onclick();
 assert.equal($('el-saved-progress').value,2);assert.equal($('el-saved-progress').max,2);assert.match($('el-saved-count').textContent,/2 of 2 chunks saved · Joined audio available/);assert.equal($('el-save-merged').hidden,false);dom.window.close();
});


test('review lock does not say busy or disable the draft; polling preserves focus and typed text',async()=>{
 const {dom,w,$}=setup(async(_method,route)=>route.endsWith('/status')?{connected:true,enabled:true,busy:true,state:'NEEDS_REVIEW',settings:{paused:true,needs_review:true},page:{}}:{jobs:[]});
 w.document.querySelector('[data-view="elevenlabs"]').hidden=false;
 $('el-text').focus();$('el-text').value='日本語の新しい原稿';$('el-text').setSelectionRange(3,4);
 await $('el-refresh').onclick();await $('el-refresh').onclick();
 assert.match($('el-connection').textContent,/Worker locked for review/);assert.doesNotMatch($('el-connection').textContent,/Worker busy|Worker processing/);
 assert.equal($('el-text').disabled,false);assert.equal($('el-text').readOnly,false);
 assert.equal(w.document.activeElement,$('el-text'));assert.equal($('el-text').value,'日本語の新しい原稿');assert.equal($('el-text').selectionStart,3);
 dom.window.close();
});

test('review errors are displayed next to the release control and do not erase the draft',async()=>{
 const {dom,w,$}=setup(async(_method,route)=>{
  if(route.endsWith('/status'))return {needsReview:true,settings:{paused:true}};
  if(route.endsWith('/control'))throw Error('The tab is still generating. Finish or stop it first.');
  return {jobs:[]};
 });
 $('el-text').value='Keep this draft';await $('el-refresh').onclick();
 $('el-review-confirm').checked=true;$('el-review-confirm').dispatchEvent(new w.Event('change'));
 await $('el-review').onclick();
 assert.match($('el-control-message').textContent,/still generating/);assert.equal($('el-control-message').classList.contains('error'),true);
 assert.doesNotMatch($('el-message').textContent,/still generating/);assert.equal($('el-text').value,'Keep this draft');assert.equal($('el-review').disabled,false);
 dom.window.close();
});

test('enqueue uses the exact draft snapshot that was previewed even if the user continues typing',async()=>{
 let release;const wait=new Promise(resolve=>release=resolve);
 const {dom,$,calls}=setup(async(method,route,body,job)=>{
  if(route.endsWith('/preview')){await wait;return {chunks:[{text:body.text}],characters:body.text.length};}
  if(route.endsWith('/status'))return {settings:{}};
  if(route.endsWith('/jobs'))return method==='GET'?{jobs:[]}:job;
  return job;
 });
 $('el-text').value='First script';$('el-title').value='First title';$('el-chunk-size').value='1200';
 const pending=$('el-form').onsubmit({preventDefault(){}});
 $('el-text').value='Second draft';$('el-title').value='Second title';$('el-chunk-size').value='2000';release();await pending;
 const submitted=calls.find(c=>c[0]==='POST'&&c[1].endsWith('/jobs'));
 assert.equal(submitted[2].max_chunk_characters,1200);assert.equal(submitted[2].text,'First script');assert.equal(submitted[2].title,'First title');
 assert.equal($('el-text').value,'Second draft');assert.equal($('el-chunk-preview').children.length,0);
 dom.window.close();
});

test('download recovery calls only recovery API and reports partial errors in the jobs panel',async()=>{
 const {dom,$,calls}=setup(async(method,route,body,job)=>{
  if(route.endsWith('/status'))return {connected:true,processing:false,state:'IDLE',settings:{paused:true}};
  if(route.endsWith('/jobs'))return {jobs:[{...job,recoverable_downloads:1}]};
  if(route.endsWith('/recover'))return {recovered:1,errors:[{chunk_index:2,error:'File not found'}],job};
  return job;
 });
 await $('el-refresh').onclick();const recover=[...$('el-job-rows').querySelectorAll('button')].find(b=>b.textContent==='Recover downloaded audio');
 await recover.onclick();assert.equal(calls.filter(c=>c[0]==='POST').length,1);assert(calls.some(c=>c[1].endsWith('/recover')));
 assert.match($('el-jobs-message').textContent,/1 downloaded chunk\(s\) recovered/);assert.match($('el-jobs-message').textContent,/Chunk 2: File not found/);
 dom.window.close();
});

test('known pre-submit failure can retry without review or native dialogs, but never auto-resumes',async()=>{
 const {dom,w,$,calls}=setup(async(method,route,body,job)=>{
  if(route.endsWith('/status'))return {connected:true,processing:false,state:'IDLE',settings:{paused:true}};
  if(route.endsWith('/jobs'))return {jobs:[{...job,state:'FAILED',retry_requires_review:false}]};
  if(route.endsWith('/retry'))return {queued:1,job};return job;
 });
 w.confirm=()=>{throw Error('Native dialog');};await $('el-refresh').onclick();
 await [...$('el-job-rows').querySelectorAll('button')].find(b=>b.textContent==='Retry remaining').onclick();
 assert.equal(calls.find(c=>c[1].endsWith('/retry'))[2].reviewed,false);assert.equal(calls.filter(c=>c[1].endsWith('/control')).length,0);
 dom.window.close();
});

test('backend compatibility error is prominent and blocks mutations while keeping the draft editable',async()=>{
 const {dom,$}=setup(async(_method,route)=>route.endsWith('/status')?{connected:true,compatibilityError:'Old backend: stop it and restart Studio.',needsReview:true,settings:{paused:true}}:{jobs:[]});
 await $('el-refresh').onclick();assert.equal($('el-stage-title').textContent,'Backend update required');
 assert.equal($('el-activity-error').hidden,false);assert.match($('el-activity-error').textContent,/Old backend/);
 for(const id of ['el-generate','el-review','el-resume','el-probe'])assert.equal($(id).disabled,true,id);
 assert.equal($('el-text').disabled,false);assert.equal($('el-text').readOnly,false);dom.window.close();
});

test('backend recovery renders escaped diagnostics and never offers to restart an unverified process',async()=>{
 const diagnostics={compatible:false,studioApi:3,studioVersion:'0.7.17',pid:54321,root:'C:\\project\\<img src=x>\\flowkit',python:'C:\\Python\\python.exe',localRoot:'C:\\new-flowkit',missingFeatures:['elevenlabs_recover_downloads'],canRestart:false,restartReason:'This process is not owned by Flowkit Studio.'};
 const {dom,$,calls}=setup(async(_method,route)=>route.endsWith('/status')?{compatibilityError:'Backend update required.',backendDiagnostics:diagnostics,settings:{paused:false}}:{jobs:[{id:jobId,state:'QUEUED'}]});
 await $('el-refresh').onclick();
 assert.equal($('el-backend-help').hidden,false);assert.equal($('el-backend-restart').disabled,true);assert.equal($('el-backend-check').disabled,false);
 assert.match($('el-backend-details').textContent,/54321/);assert.match($('el-backend-details').textContent,/0.7.17/);assert.match($('el-backend-details').textContent,/elevenlabs_recover_downloads/);assert.match($('el-backend-details').textContent,/<img src=x>/);
 assert.equal($('el-backend-details').querySelector('img'),null);assert.match($('el-backend-reason').textContent,/not owned/);
 for(const id of ['el-generate','el-preview','el-pause','el-resume','el-probe'])assert.equal($(id).disabled,true,id);
 assert.equal($('el-job-rows').querySelector('[data-el-cancel]').disabled,true);
 await $('el-backend-restart').onclick();assert.equal(calls.filter(c=>c[0]==='backend').length,0);dom.window.close();
});

test('backend restart is explicit, preserves the draft, clears stale errors and never retries a chunk',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 let status={connected:true,compatibilityError:'Backend update required: older or incompatible backend.',backendDiagnostics:{compatible:false,canRestart:true,message:'Backend update required: older or incompatible backend.',root:'C:\\flowkit'},settings:{paused:true}};
 const {dom,w,$,calls}=setup(async(_method,route)=>route.endsWith('/status')?status:{jobs:[]},async action=>{
  assert.equal(action,'restart');await pending;status={connected:true,ready:true,settings:{paused:true},backendDiagnostics:{compatible:true,canRestart:false}};
  return {backendDiagnostics:status.backendDiagnostics,status};
 });
 await $('el-refresh').onclick();$('el-text').value='日本語の原稿。';$('el-text').focus();$('el-text').setSelectionRange(2,3);
 $('el-message').textContent='Error invoking remote method api: Backend update required: older or incompatible backend.';$('el-message').classList.add('error');
 const restarting=$('el-backend-restart').onclick();await $('el-backend-restart').onclick();
 assert.match($('el-backend-message').textContent,/Restarting the local backend/);assert.equal($('el-backend-restart').disabled,true);assert.equal($('el-text').disabled,false);
 release();await restarting;
 assert.equal(calls.filter(c=>c[0]==='backend').length,1);assert.equal(calls.filter(c=>c[0]==='POST').length,0);
 assert.equal($('el-backend-help').hidden,true);assert.equal($('el-message').textContent,'');assert.equal($('el-message').classList.contains('error'),false);
 assert.equal($('el-activity-error').hidden,true);assert.equal($('el-generate').disabled,false);assert.equal($('el-resume').disabled,false);
 assert.match($('el-control-message').textContent,/Local backend restarted and ready/);assert.equal($('el-text').value,'日本語の原稿。');assert.equal(w.document.activeElement,$('el-text'));assert.equal($('el-text').selectionStart,2);dom.window.close();
});

test('checking after a manual backend update removes the compatibility block without restarting or mutating jobs',async()=>{
 let status={compatibilityError:'Backend update required.',backendDiagnostics:{compatible:false,canRestart:false},settings:{paused:true}};
 const {dom,$,calls}=setup(async(_method,route)=>route.endsWith('/status')?status:{jobs:[]},async action=>{
  assert.equal(action,'status');status={ready:true,settings:{paused:true},backendDiagnostics:{compatible:true}};return status.backendDiagnostics;
 });
 await $('el-refresh').onclick();await $('el-backend-check').onclick();
 assert.equal($('el-backend-help').hidden,true);assert.equal($('el-generate').disabled,false);assert.match($('el-control-message').textContent,/Backend is compatible/);
 assert.deepEqual(calls.filter(c=>c[0]==='backend'),[['backend','status']]);assert.equal(calls.filter(c=>c[0]==='POST').length,0);dom.window.close();
});

test('restart refusal remains visible next to recovery controls and leaves the script untouched',async()=>{
 const {dom,$}=setup(async(_method,route)=>route.endsWith('/status')?{compatibilityError:'Backend update required.',backendDiagnostics:{compatible:false,canRestart:true},settings:{paused:true}}:{jobs:[]},async()=>{throw Error('The backend has active work. Wait for it to finish.');});
 await $('el-refresh').onclick();$('el-text').value='Keep this script';await $('el-backend-restart').onclick();
 assert.match($('el-backend-message').textContent,/active work/);assert.equal($('el-backend-message').classList.contains('error'),true);assert.equal($('el-backend-help').hidden,false);
 assert.equal($('el-backend-restart').disabled,false);assert.equal($('el-generate').disabled,true);assert.equal($('el-text').value,'Keep this script');dom.window.close();
});

test('a job refresh failure after successful backend recovery remains visible outside the hidden diagnostics panel',async()=>{
 let compatible=false;
 const {dom,$}=setup(async(_method,route)=>{
  if(route.endsWith('/status'))return {compatibilityError:compatible?'':'Backend update required.',backendDiagnostics:{compatible,canRestart:!compatible},settings:{paused:true}};
  if(compatible)throw Error('Could not refresh narration jobs.');return {jobs:[]};
 },async()=>{compatible=true;return {backendDiagnostics:{compatible:true}};});
 await $('el-refresh').onclick();await $('el-backend-restart').onclick();
 assert.equal($('el-backend-help').hidden,true);assert.match($('el-backend-message').textContent,/Could not refresh narration jobs/);
 assert.equal($('el-backend-message').closest('#el-backend-help'),null);assert.equal($('el-backend-message').classList.contains('error'),true);dom.window.close();
});

test('unchanged polling does not replace job buttons or collapse expanded chunk text',async()=>{
 const {dom,$}=setup();await $('el-refresh').onclick();const detailsButton=$('el-job-rows').querySelector('button');
 await detailsButton.onclick();const chunkDetails=$('el-chunk-rows').querySelector('details');chunkDetails.open=true;
 await $('el-refresh').onclick();assert.equal($('el-job-rows').querySelector('button'),detailsButton);
 assert.equal($('el-chunk-rows').querySelector('details'),chunkDetails);assert.equal(chunkDetails.open,true);dom.window.close();
});

test('releasing during an older status poll waits for a fresh poll before showing the released state',async()=>{
 let review=true,statusReads=0,releaseOldPoll;const oldPoll=new Promise(resolve=>releaseOldPoll=resolve);
 const {dom,w,$,calls}=setup(async(method,route)=>{
  if(route.endsWith('/status')){
   statusReads++;const snapshot={connected:true,needsReview:review,state:review?'NEEDS_REVIEW':'IDLE',settings:{paused:true}};
   if(statusReads===2)await oldPoll;
   return snapshot;
  }
  if(route.endsWith('/control')){review=false;return {};}
  return {jobs:[]};
 });
 await $('el-refresh').onclick();
 w.document.querySelector('[data-page="elevenlabs"]').click();
 $('el-review-confirm').checked=true;$('el-review-confirm').dispatchEvent(new w.Event('change'));
 const release=$('el-review').onclick();await new Promise(resolve=>setImmediate(resolve));
 assert(calls.some(c=>c[0]==='POST'&&c[1].endsWith('/control')));
 releaseOldPoll();await release;
 assert.equal(statusReads,3);assert.equal($('el-review-help').hidden,true);assert.equal($('el-resume').disabled,false);
 assert.match($('el-control-message').textContent,/Worker released/);dom.window.close();
});

test('automatic tab preparation is ready without a bound page and describes the full per-chunk workflow',async()=>{
 const status={connected:true,enabled:true,ready:true,autoPrepareTab:true,state:'IDLE',pageConnected:false,tabId:null,settings:{paused:false},progress:{phase:'SELECTING_MODEL',message:'Old page state'}};
 const {dom,$,calls}=setup(async(_method,route)=>route.endsWith('/status')?status:{jobs:[]});
 await $('el-refresh').onclick();
 assert.equal($('el-stage-title').textContent,'Ready to open a new tab');assert.match($('el-connection').textContent,/Ready to open a new tab/);
 assert.doesNotMatch($('el-connection').textContent,/Page not ready|use Bind tab/);assert.match($('el-progress').textContent,/No manual binding is needed/);
 assert.doesNotMatch($('el-progress').textContent,/Old page state/);assert.equal($('el-probe').disabled,true);assert.equal($('el-backend-check').disabled,false);
 assert.match($('el-tab-workflow').textContent,/Before each chunk: close all ElevenLabs Text to Speech tabs in this Chrome profile/);
 assert.match($('el-tab-workflow').textContent,/Other tabs stay open/);assert.match($('el-tab-workflow').textContent,/Sign in to ElevenLabs first/);
 await $('el-probe').onclick();assert.equal(calls.filter(c=>c[0]==='POST').length,0);
 status.tabId=17;status.pageConnected=true;await $('el-refresh').onclick();assert.equal($('el-probe').disabled,false);dom.window.close();
});

test('fresh-tab preparation phases remain in Prepare page and disable inspection until finished',async()=>{
 let status={connected:true,enabled:true,autoPrepareTab:true,ready:false,busy:true,processing:true,state:'RUNNING',active:{chunk_index:1},settings:{paused:false},progress:{}};
 const {dom,$}=setup(async(_method,route)=>route.endsWith('/status')?status:{jobs:[]});
 for(const [phase,title] of [['CLOSING_TABS','Closing previous Text to Speech tabs'],['OPENING_TAB','Opening a separate Text to Speech window'],['BINDING_TAB','Binding the new tab'],['WAITING_NEW_PAGE','Waiting for the new page']]){
  status.progress={phase};await $('el-refresh').onclick();assert.equal($('el-stage-title').textContent,title);
  assert.equal($('el-steps').querySelector('[aria-current]').textContent,'Prepare page');assert.equal($('el-probe').disabled,true);
 }
 dom.window.close();
});

test('automatic tab readiness never overrides review, pause or a disconnected extension',async()=>{
 let status={connected:true,enabled:true,autoPrepareTab:true,ready:true,state:'NEEDS_REVIEW',needsReview:true,settings:{paused:true}};
 const {dom,$,calls}=setup(async(_method,route)=>route.endsWith('/status')?status:{jobs:[]});
 await $('el-refresh').onclick();assert.equal($('el-stage-title').textContent,'Review required');assert.equal($('el-resume').disabled,true);assert.equal($('el-review').disabled,true);
 status={...status,state:'IDLE',needsReview:false};await $('el-refresh').onclick();assert.equal($('el-stage-title').textContent,'Queue paused');
 status={...status,connected:false,settings:{paused:false}};await $('el-refresh').onclick();assert.equal($('el-stage-title').textContent,'Extension disconnected');assert.doesNotMatch($('el-connection').textContent,/Ready to open a new tab/);
 assert.equal(calls.filter(c=>c[0]==='POST').length,0);dom.window.close();
});
