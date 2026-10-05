const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
test('Desktop batch UI submits 200 prompts, shows worker states and safely renders results',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'fixtures/chatgpt-retired-ui.html'),'utf8'),{runScripts:'outside-only'});
 const w=dom.window,$=id=>w.document.getElementById(id),calls=[];
 const settings={workers:3,timeout_seconds:180,temporary:false,paused:false};
 const jobs=[{id:'a',batch_id:'batch-one',ordinal:1,prompt:'<script>bad</script>',state:'COMPLETED',answer:'A\nB'}];
 w.setInterval=()=>{};w.confirm=()=>true;
 w.studio={saveChatResults:async ids=>{calls.push(['export',ids]);return {canceled:false};},api:async(method,route,body)=>{
  calls.push([method,route,body]);if(route.endsWith('/preflight'))return {passed:true};if(route.endsWith('/status'))return {available:true,availableSlots:2,srtWorker:{id:'srt-worker',tabId:100,state:'RUNNING'},workers:[{id:'w1',tabId:1,state:'RUNNING',requestOptions:{composerMode:'chat',temporary:true,model:'auto',hasAttachment:false}}]};
  if(route.endsWith('/queue'))return {settings,jobs};if(route.endsWith('/config'))Object.assign(settings,body);return {};}};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/chatgpt-model.js'),'utf8'));
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/chatgpt-queue.js'),'utf8'));
 await $('chat-refresh').onclick();
 assert.equal($('chat-mode').value,'temporary');assert.equal($('chat-mode').disabled,true);
 await $('chat-save-config').onclick();assert.equal(settings.temporary,true);
 $('chat-model-mode').value='custom';$('chat-model').value='GPT-6 Astra';$('chat-model-effort').value='high';
 $('chat-batch').value=JSON.stringify(Array.from({length:200},(_,i)=>'Prompt '+i));await $('chat-enqueue').onclick();
 assert.equal(calls.find(c=>c[0]==='POST'&&c[1].endsWith('/queue'))[2].prompts.length,200);
 assert.equal(calls.find(c=>c[0]==='POST'&&c[1].endsWith('/queue'))[2].model,'GPT-6 Astra :: high');
 assert.match($('chat-pool-state').textContent,/RUNNING/);assert.doesNotMatch($('chat-pool-state').textContent,/srt-worker/);assert.equal($('chat-queue-rows').querySelector('script'),null);
 assert.match($('chat-pool-state').textContent,/Chat \/ Temporary ON \/ Current model \/ Text only/);
 $('chat-queue-rows').querySelector('button').click();assert.match($('chat-job-detail').textContent,/A\nB/);
 await $('chat-select-all').onclick();await $('chat-export').onclick();assert.equal(calls.at(-1)[0],'export');
 await $('chat-pause').onclick();assert.equal(settings.paused,true);
 dom.window.close();
});

test('failed automatic preflight preserves batch text and never enqueues prompts',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'fixtures/chatgpt-retired-ui.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id),calls=[];
 w.setInterval=()=>{};w.studio={api:async(method,route,body)=>{calls.push(route);return {passed:false,reports:[{error:'Input missing'}]};}};
 for(const file of ['chatgpt-model.js','chatgpt-queue.js'])w.eval(fs.readFileSync(path.join(__dirname,'../ui',file),'utf8'));
 $('chat-batch').value='Keep this prompt';await $('chat-enqueue').onclick();assert.deepEqual(calls,['/api/chatgpt/preflight']);assert.equal($('chat-batch').value,'Keep this prompt');assert.match($('chat-preflight-result').textContent,/Input missing/);dom.window.close();
});
