const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
function setup(){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'});
 const w=dom.window,$=id=>w.document.getElementById(id),calls=[],imports=[];w.setInterval=()=>{};
 const options={model:'large-v3',language:'',device:'auto',batch_size:8,auto:false,video_duration_seconds:100};
 w.studio={api:async(method,url,body)=>{calls.push({method,url,body});
  if(url==='/api/elevenlabs/jobs')return {jobs:[{id:'source',title:'Merged voice',merged_url:'/merged'},{id:'unfinished',title:'Pending'}]};
  if(url.endsWith('/status'))return {transcript_split_version:1,settings:options,imported_sources:imports,jobs:[{id:'wx1',title:'<script>bad</script>',state:'COMPLETED',phase:'COMPLETED',options,result_available:true,split_available:true,transcript_split:{video_duration_seconds:100,video_words:500,image_words:9500,warnings:[]}}]};
  if(url.includes('/preview'))return {filename:url.endsWith('/image')?'transcript_image.json':'transcript.json',language:'ja',word_count:2,segment_count:1,words:[{word:'日',start:0,end:0.2},{word:'?'}],metadata:{warnings:['One untimed word']}};
  return {ok:true};},whisperxImport:async()=>{const source={id:'imported',title:'My audio.mp3'};imports.push(source);return source;},whisperxSave:async (id,variant)=>{calls.push({save:id,variant});return {path:'transcript.json'};}};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/data-table.js'),'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname,'../ui/whisperx.js'),'utf8'));
 return {dom,w,$,calls};
}
test('WhisperX UI uses merged sources, sends options, preserves draft and previews native timestamps',async()=>{
 const {dom,w,$,calls}=setup();
 await $('wx-refresh').onclick();
 assert.equal($('wx-source').options.length,2);assert.equal($('wx-jobs').querySelector('script'),null);
 $('wx-source').value='source';$('wx-language').value='ja';$('wx-device').value='cuda';
 await $('wx-form').onsubmit({preventDefault(){}});
 const request=calls.find(c=>c.url==='/api/whisperx/jobs');
 assert.deepEqual(JSON.parse(JSON.stringify(request.body)),{source_id:'source',model:'large-v3',device:'cuda',language:'ja',batch_size:8,video_duration_seconds:100});
 assert.equal($('wx-language').value,'ja');
 $('wx-auto').checked=true;await $('wx-settings').onclick();assert.equal(calls.find(c=>c.url.endsWith('/settings')).body.auto,false);
 await $('wx-jobs').querySelectorAll('button')[1].onclick();assert.match($('wx-words').textContent,/0.2/);assert.match($('wx-summary').textContent,/One untimed/);
 await $('wx-jobs').querySelectorAll('button')[2].onclick();assert.equal(calls.at(-1).save,'wx1');
 dom.window.close();
});

test('split duration is editable, retained during polling, saved and sent with jobs; all variants export',async()=>{
 const {dom,w,$,calls}=setup();
 try{
  await $('wx-refresh').onclick();assert.equal($('wx-video-seconds').value,'100');
  $('wx-video-seconds').value='75.5';$('wx-source').value='source';await $('wx-refresh').onclick();
  assert.equal($('wx-video-seconds').value,'75.5');
  await $('wx-form').onsubmit({preventDefault(){}});
  assert.equal(calls.find(c=>c.url==='/api/whisperx/jobs').body.video_duration_seconds,75.5);
  await $('wx-settings').onclick();assert.equal(calls.find(c=>c.url.endsWith('/settings')).body.video_duration_seconds,75.5);
  const find=label=>[...$('wx-jobs').querySelectorAll('button')].find(b=>b.textContent===label);
  assert.match($('wx-jobs').textContent,/3 JSON files saved.*500 word units.*9,500 word units/);
  await find('Save transcript_video.json').onclick();assert.equal(calls.at(-1).variant,'video');
  await find('Save transcript_image.json').onclick();assert.equal(calls.at(-1).variant,'image');
  await find('Preview words').onclick();$('wx-preview-file').value='image';await $('wx-preview-file').onchange();
  assert.equal(calls.at(-1).url,'/api/whisperx/jobs/wx1/preview/image');assert.match($('wx-summary').textContent,/transcript_image.json/);
  const jobCalls=calls.filter(c=>c.url==='/api/whisperx/jobs').length;
  await find('Split saved JSON').onclick();assert.equal(calls.find(c=>c.url?.endsWith('/split')).body.video_duration_seconds,75.5);
  assert.equal(calls.filter(c=>c.url==='/api/whisperx/jobs').length,jobCalls);
  assert.match($('wx-message').textContent,/Original transcript.json is unchanged.*not rerun/);
  $('wx-video-seconds').value='-1';await $('wx-form').onsubmit({preventDefault(){}});
  assert.match($('wx-message').textContent,/0 to 86,400 seconds/);
  assert.equal(calls.filter(c=>c.url==='/api/whisperx/jobs').length,jobCalls);
 }finally{dom.window.close();}
});

test('old backend cannot silently ignore the requested three-file output',async()=>{
 const {dom,w,$,calls}=setup(),base=w.studio.api;
 w.studio.api=async(...args)=>{const result=await base(...args);delete result.transcript_split_version;return result;};
 try{
  await $('wx-refresh').onclick();$('wx-source').value='source';await $('wx-form').onsubmit({preventDefault(){}});
  assert.match($('wx-message').textContent,/restart Studio\/backend/);
  assert.equal(calls.some(c=>c.url==='/api/whisperx/jobs'),false);
 }finally{dom.window.close();}
});


test('Choose audio adds and selects a file; polling preserves it and cancel keeps the selection',async()=>{
 const {dom,w,$,calls}=setup();
 await $('wx-refresh').onclick();
 await $('wx-choose').onclick();
 assert.equal($('wx-source').value,'imported');
 assert.match($('wx-message').textContent,/My audio.mp3/);
 await $('wx-refresh').onclick();
 assert.equal($('wx-source').value,'imported');
 await $('wx-form').onsubmit({preventDefault(){}});
 assert.equal(calls.find(c=>c.url==='/api/whisperx/jobs').body.source_id,'imported');
 w.studio.whisperxImport=async()=>({canceled:true});
 await $('wx-choose').onclick();
 assert.equal($('wx-source').value,'imported');
 assert.match($('wx-message').textContent,/cancelled/);
 dom.window.close();
});

test('WhisperX displays measured stage progress, Japanese character counts, elapsed time and unknown loading progress',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id),timers=[];
 w.setInterval=fn=>timers.push(fn);
 const options={model:'large-v3',language:'ja',device:'cuda',batch_size:8,auto:false};
 let job={id:'running',title:'Long Japanese narration',state:'RUNNING',phase:'ALIGNING',options,elapsed_seconds:125,progress:{phase_percent:50,segments_done:40,segments_total:80,units_done:5000,units_total:10000,unit:'characters',audio_seconds:1800,audio_done_seconds:900,updated_at:Date.now()/1000-35}};
 w.studio={api:async(method,url)=>url==='/api/elevenlabs/jobs'?{jobs:[]}:{settings:options,jobs:[job],imported_sources:[]}};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/whisperx.js'),'utf8'));
 await $('wx-refresh').onclick();
 assert.equal($('wx-activity').hidden,false);assert.equal($('wx-stage-progress').value,50);
 assert.equal($('wx-stage-percent').textContent,'Current stage · 50.0%');
 assert.equal($('wx-unit-label').textContent,'Source characters processed');assert.equal($('wx-unit-count').textContent,'5,000 / 10,000');
 assert.equal($('wx-audio-position').textContent,'00:15:00');assert.equal($('wx-duration').textContent,'00:30:00');assert.equal($('wx-elapsed').textContent,'00:02:05');
 assert.match($('wx-last-update').textContent,/may still be running/);
 $('wx-batch').value='16';job.progress.phase_percent=75;job.progress.units_done=7500;
 await $('wx-refresh').onclick();assert.equal($('wx-stage-progress').value,75);assert.equal($('wx-batch').value,'16');
 job={...job,phase:'LOADING_ALIGNMENT_MODEL',progress:{message:'Loading model…'}};
 await $('wx-refresh').onclick();assert.equal($('wx-stage-progress').hasAttribute('value'),false);assert.doesNotMatch($('wx-stage-percent').textContent,/%/);
 job={...job,state:'COMPLETED',phase:'COMPLETED',progress:{output_words:9990},elapsed_seconds:140};
 await $('wx-refresh').onclick();assert.equal($('wx-stage-progress').value,100);assert.equal($('wx-unit-label').textContent,'Output word units');assert.equal($('wx-elapsed').textContent,'00:02:20');
 job={...job,state:'FAILED',phase:'FAILED',error:'Alignment model could not load'};
 await $('wx-refresh').onclick();assert.equal($('wx-stage-progress').hidden,true);assert.match($('wx-activity-message').textContent,/could not load/);
 dom.window.close();
});

test('retry is offered only for recoverable local transcription failures and uses the saved job ID',async()=>{
 const {dom,w,$,calls}=setup(),original=w.studio.api;
 let retried=false;
 w.studio.api=async(method,url,body)=>{
  if(url==='/api/whisperx/jobs/failed-job/retry'){
   calls.push({method,url,body});retried=true;return {id:'new-job',previous_id:'failed-job',retried:true};
  }
  const data=await original(method,url,body);
  if(url==='/api/whisperx/status')data.jobs=[
   {id:'failed-job',title:'Interrupted narration',state:retried?'QUEUED':'INTERRUPTED',phase:retried?'QUEUED':'INTERRUPTED',options:{model:'large-v3',device:'cuda'},can_retry:!retried},
   {id:'missing-source',title:'Missing audio',state:'FAILED',phase:'FAILED',options:{model:'large-v3',device:'cuda'},can_retry:false}
  ];
  return data;
 };
 try{
  await $('wx-refresh').onclick();
  const retries=[...$('wx-jobs').querySelectorAll('button')].filter(b=>b.textContent==='Retry job');
  assert.equal(retries.length,1);await retries[0].onclick();
  assert.equal(calls.filter(c=>c.url==='/api/whisperx/jobs/failed-job/retry').length,1);
  assert.match($('wx-message').textContent,/queued again with its saved source and settings/);
  assert.equal([...$('wx-jobs').querySelectorAll('button')].filter(b=>b.textContent==='Retry job').length,0);
 }finally{dom.window.close();}
});

test('WhisperX displays preflight status before the start request returns',async()=>{
 const {dom,w,$}=setup();
 try{
  await $('wx-refresh').onclick();$('wx-source').value='source';
  let release;const original=w.studio.api;
  w.studio.api=(method,url,body)=>url==='/api/whisperx/jobs'?new Promise(resolve=>release=resolve):original(method,url,body);
  const pending=$('wx-form').onsubmit({preventDefault(){}});
  assert.match($('wx-message').textContent,/Checking WhisperX environment/);
  assert.equal($('wx-message').closest('#wx-form'),null);
  assert.equal($('wx-start').disabled,true);
  release({id:'new'});await pending;assert.match($('wx-message').textContent,/queued/);
 }finally{dom.window.close();}
});

test('live log and queue errors remain visible when narration listing fails',async()=>{
 const {dom,w,$}=setup();
 try{
  const original=w.studio.api;
  w.studio.api=async(method,url,body)=>{
   if(url==='/api/elevenlabs/jobs')throw Error('Narration unavailable');
   const result=await original(method,url,body);
   if(url.endsWith('/status')){result.jobs[0].state='RUNNING';result.jobs[0].phase='STARTING';result.worker={running:true,error:'Output directory unavailable'};result.activity_log={job_id:'wx1',text:'Loading Torch…\rDownloading model 12%'};}
   return result;
  };
  await $('wx-refresh').onclick();
  assert.equal($('wx-activity').hidden,false);assert.match($('wx-live-log').textContent,/Downloading model 12%/);
  assert.match($('wx-worker-status').textContent,/Output directory unavailable/);
 }finally{dom.window.close();}
});
