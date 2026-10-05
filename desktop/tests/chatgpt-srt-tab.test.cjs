const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(r=>setImmediate(r));
const until=async condition=>{for(let i=0;i<40&&!condition();i++)await tick();assert.ok(condition(),'Expected asynchronous transition');};
const attachment={name:'transcript-11111111-1111-1111-1111-111111111111.json',base64:'e30='};
async function bridge(initial=[],create,downloadMock,manualSubmission=false){
 const saved={enabled:true,composerMode:'chat',workers:structuredClone(initial)};
 const tabs=new Map(initial.filter(w=>w.tabId!==null).map(w=>[w.tabId,{id:w.tabId,url:'https://chatgpt.com/c/old',status:'complete'}]));
 tabs.set(9,{id:9,url:'https://example.com/',status:'complete'});
 let socket,listener,nextId=100,removed;const replies=[],created=[],updated=[],messages=[],pending=new Map(),proofs=new Map(),focused=[];
 class WS{constructor(){socket=this;this.readyState=1;}send(s){replies.push(JSON.parse(s));}close(){this.readyState=3;this.onclose();}}
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async d=>Object.assign(saved,structuredClone(d))}},
  tabs:{get:async id=>{if(!tabs.has(id))throw Error('Missing tab');return tabs.get(id);},
   query:async()=>[...tabs.values()],remove:async id=>{tabs.delete(id);removed(id);},
   create:async options=>{created.push(options);if(create)await create();const t={id:nextId++,url:options.url,status:'complete'};tabs.set(t.id,t);return t;},
   update:async(id,options)=>{updated.push({id,...options});if(options.url)proofs.delete(id);Object.assign(tabs.get(id),options);return tabs.get(id);},
   onRemoved:{addListener:f=>removed=f},sendMessage:async(id,m)=>{
    if(m.type==='stopSrt')return {ok:true};
    if(m.type==='clickSrtDownload')return downloadMock.click(m);
    if(m.type==='prepareSrt')return {ok:true};if(m.type==='ping')return {ok:true,submissionAck:true,textSessionProof:proofs.get(id)};if(m.type==='probe')return {streaming:false};if(m.type==='preflight')return {ok:true,data:{passed:true}};
    messages.push({id,...m});if(!manualSubmission)setImmediate(()=>listener({type:'requestSubmitted',requestId:m.requestId},{id:'ext',frameId:0,tab:{id}},()=>{}));return new Promise(resolve=>pending.set(m.requestId,resolve));}},
  runtime:{id:'ext',onMessage:{addListener:f=>listener=f},onStartup:{addListener(){}},onInstalled:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}}};
 chrome.downloads=downloadMock?.api;
 chrome.windows={update:async(id)=>{focused.push(id);},create:async options=>{assert.equal(options.type,'normal');const tab=await chrome.tabs.create({url:options.url,active:options.focused});return {id:tab.id,tabs:[tab]};}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/background.js'),'utf8'),{chrome,crypto:require('node:crypto').webcrypto,WebSocket:WS,URL,console,setTimeout:(f,ms)=>ms===500?setImmediate(f):setTimeout(f,ms),clearTimeout,setInterval(){}});
 await tick();await tick();socket.onopen();
 const send=m=>socket.onmessage({data:JSON.stringify(m)});
 const request=(id,workerId='srt-worker',extra={})=>send({type:'chat',requestId:id,workerId,messages:[{content:'Prompt '+id}],attachment,model:'GPT-6 Astra',composerMode:'work',temporary:false,freshTab:true,...extra});
 const complete=async id=>{pending.get(id)({ok:true,content:'Saved answer'});await until(()=>saved.workers.some(w=>w.requestId===id&&w.state==='AWAITING_SAVE'));};
 return {saved,tabs,replies,created,updated,messages,pending,proofs,focused,request,complete,send,socket,
  page:(m,tabId)=>new Promise(resolve=>listener(m,{id:'ext',frameId:0,tab:{id:tabId}},resolve)),
  ui:m=>new Promise(resolve=>listener(m,{id:'ext'},resolve)),remove:id=>{tabs.delete(id);removed(id);}};
}

test('SRT opens and binds a fresh Work tab without assignments, then each next SRT gets another new tab',async()=>{
 const b=await bridge();await b.request('srt-1');await until(()=>b.messages.length===1);
 assert.equal(b.created.length,1);assert.equal(b.created[0].url,'https://chatgpt.com/');assert.equal(b.created[0].active,true);
 assert.equal(b.saved.workers.length,1);assert.equal(b.saved.workers[0].tabId,100);
 assert.equal(b.messages[0].id,100);assert.equal(b.messages[0].composerMode,'work');assert.equal(b.messages[0].temporary,false);assert.equal(b.messages[0].model,'GPT-6 Astra');
 assert.deepEqual(JSON.parse(JSON.stringify(b.messages[0].attachment)),attachment);assert.equal(b.messages[0].userMessage,'Prompt srt-1');
 await b.complete('srt-1');await b.request('too-early');assert.equal(b.replies.at(-1).not_submitted,true);assert.equal(b.created.length,1);
 await b.send({type:'commit',requestId:'srt-1',controlId:'c1',ok:true});
 await b.request('srt-2');await until(()=>b.messages.length===2);
 assert.equal(b.created.length,2);assert.equal(b.saved.workers[0].tabId,101);assert.equal(b.messages[1].id,101);
 assert.equal(b.tabs.has(100),false,'Saved SRT tab closes');assert.equal(b.updated.filter(x=>x.url).length,0,'Never navigates the old tab for SRT');
 await b.complete('srt-2');await b.send({type:'commit',requestId:'srt-2',controlId:'c2',ok:true});
 await b.request('text','srt-worker',{freshTab:false,attachment:undefined,composerMode:'chat',temporary:true,model:'auto'});
 assert.equal(b.replies.at(-1).not_submitted,true);assert.equal(b.messages.length,2);
 assert.equal(b.saved.workers[0].kind,'srt');assert.equal((await b.ui({type:'status'})).workers.length,0);
 assert.equal((await b.ui({type:'status'})).srtWorker.tabId,null);
 assert.equal(b.tabs.has(101),false);assert.ok(b.tabs.has(9));
});

test('one SRT and three text workers run concurrently without changing text bindings',async()=>{
 const b=await bridge([1,2,3].map(i=>({id:'worker-'+i,tabId:i,state:'IDLE'})));
 for(let i=1;i<=3;i++)await b.request('text-'+i,'worker-'+i,{freshTab:false,attachment:undefined,composerMode:'chat',temporary:true});
 await until(()=>b.messages.length===3);await b.request('srt');await until(()=>b.messages.length===4);
 const status=await b.ui({type:'status'});
 assert.deepEqual(Array.from(status.workers,w=>w.tabId),[1,2,3]);assert.equal(status.srtWorker.tabId,100);
 assert.equal(b.created.length,1);assert.deepEqual(b.updated.filter(x=>x.url).map(x=>x.id),[1,2,3]);
 for(const id of ['text-1','text-2','text-3','srt'])await b.complete(id);
});

test('creating one SRT tab reserves only its slot; text configuration and preflight remain available',async()=>{
 let release;const waiting=new Promise(r=>release=r);const b=await bridge([{id:'worker-1',tabId:1,state:'IDLE'}],()=>waiting);
 await b.request('srt');await until(()=>b.created.length===1);
 await b.request('second-srt');assert.equal(b.replies.at(-1).not_submitted,true);assert.equal(b.created.length,1);
 assert.equal((await b.ui({type:'configurePool',tabIds:[1]})).error,undefined);
 assert.equal((await b.ui({type:'preflight'})).data.passed,true);
 const state=await b.ui({type:'status'});assert.equal(state.busy,true);assert.equal(state.textBusy,false);assert.equal(state.srtWorker.tabId,null);
 release();await until(()=>b.messages.length===1);assert.equal(b.saved.workers.length,2);await b.complete('srt');
});

test('failed tab creation is held for review, not retried, and the unbound slot can be released',async()=>{
 const b=await bridge([],()=>{throw Error('Chrome cannot create a tab');});
 await b.request('failed');await until(()=>b.replies.some(m=>m.type==='response'));
 assert.equal(b.created.length,1);assert.equal(b.messages.length,0);assert.equal(b.saved.workers[0].state,'NEEDS_REVIEW');assert.equal(b.saved.workers[0].tabId,null);
 await b.request('retry');assert.equal(b.created.length,1);
 await b.send({type:'reviewReset',controlId:'reset'});assert.equal(b.replies.at(-1).ok,true);assert.equal(b.saved.workers.length,0);
});

test('disconnect during new tab creation never types or submits after the late tab opens',async()=>{
 let release;const wait=new Promise(r=>release=r);const b=await bridge([],()=>wait);
 await b.request('lost');await until(()=>b.created.length===1);b.socket.close();await tick();
 release();await until(()=>b.tabs.has(100));await tick();await tick();
 assert.equal(b.saved.workers[0].state,'NEEDS_REVIEW');assert.equal(b.saved.workers[0].tabId,100);assert.equal(b.messages.length,0);
});

test('an unbound SRT reservation survives extension restart and can be reviewed without a tab',async()=>{
 const b=await bridge([{id:'srt-worker',tabId:null,state:'RUNNING',requestId:'old'}]);
 assert.equal(b.saved.workers[0].state,'NEEDS_REVIEW');await b.request('new');assert.equal(b.created.length,0);
 await b.send({type:'reviewReset',controlId:'reset'});assert.equal(b.saved.workers.length,0);
 await b.request('after-review');await until(()=>b.messages.length===1);await b.complete('after-review');
});

test('migration preserves a legacy shared SRT reservation separately from the text pool',async()=>{
 const b=await bridge([{id:'worker-1',tabId:1,state:'RUNNING',requestId:'old',requestOptions:{freshTab:true}},
  {id:'worker-2',tabId:2,state:'IDLE'},{id:'worker-3',tabId:3,state:'IDLE'}]);
 const s=await b.ui({type:'status'});assert.equal(s.srtWorker.id,'srt-worker');assert.equal(s.srtWorker.state,'NEEDS_REVIEW');assert.equal(s.srtWorker.requestId,'old');
 assert.deepEqual(Array.from(s.workers,w=>w.tabId),[2,3]);
 await b.ui({type:'configurePool',tabIds:[2,3]});
 const next=await b.ui({type:'status'});assert.equal(next.srtWorker.requestId,'old');assert.equal(next.workers[0].id,'worker-1');
 await b.request('new');assert.equal(b.created.length,0);
});

test('text pool closes after saved results, retains virtual slots and reopens on the next batch',async()=>{
 const b=await bridge([1,2,3].map(i=>({id:'worker-'+i,tabId:i,state:'IDLE',owned:true})));
 const ask=i=>b.request('text-'+i,'worker-'+i,{freshTab:false,attachment:undefined,composerMode:'chat',temporary:true});
 for(let i=1;i<=3;i++)await ask(i);await until(()=>b.messages.length===3);
 await b.send({type:'closeIdleText',controlId:'early'});assert.equal(b.replies.at(-1).ok,false);assert.ok(b.tabs.has(1));
 for(let i=1;i<=3;i++)await b.complete('text-'+i);
 for(let i=1;i<=2;i++)await b.send({type:'commit',requestId:'text-'+i,controlId:'c'+i,ok:true});
 await b.send({type:'closeIdleText',controlId:'held'});assert.equal(b.replies.at(-1).ok,false);
 await b.send({type:'commit',requestId:'text-3',controlId:'c3',ok:true});
 await b.send({type:'closeIdleText',controlId:'done'});assert.equal(b.replies.at(-1).ok,true);
 assert.ok(b.saved.workers.every(w=>w.state==='IDLE'&&w.tabId===null));assert.equal(b.tabs.size,1);assert.ok(b.tabs.has(9));
 await b.request('next','worker-1',{freshTab:false,attachment:undefined,composerMode:'chat',temporary:true});await until(()=>b.messages.length===4);
 assert.equal(b.messages[3].id,100);assert.equal(b.created.length,1);await b.complete('next');
});
test('cleanup retains review workers, manually assigned tabs and navigated worker tabs',async()=>{
 const b=await bridge([{id:'worker-1',tabId:1,state:'IDLE',owned:true},{id:'worker-2',tabId:2,state:'IDLE'}]);
 b.tabs.get(1).url='https://example.org/';
 await b.send({type:'closeIdleText',controlId:'safe'});assert.ok(b.tabs.has(1));assert.ok(b.tabs.has(2));
 const review=await bridge([{id:'worker-1',tabId:1,state:'NEEDS_REVIEW',owned:true}]);
 await review.send({type:'closeIdleText',controlId:'review'});assert.equal(review.replies.at(-1).ok,false);assert.ok(review.tabs.has(1));
});
test('closed managed text slots remain ready after extension restart',async()=>{
 const b=await bridge([{id:'worker-1',tabId:null,state:'IDLE',owned:true}]);
 assert.equal(b.saved.workers[0].state,'IDLE');
 await b.request('reopened','worker-1',{freshTab:false,attachment:undefined,composerMode:'chat',temporary:true});await until(()=>b.messages.length===1);await b.complete('reopened');
});

test('project GPT jobs allocate three windows once and reuse each tab with the request URL',async()=>{
 const b=await bridge();await b.send({type:'ensureTextWorkers',controlId:'prepare'});
 assert.equal(b.saved.workers.length,3);assert.equal(b.created.length,3);
 const image='https://chatgpt.com/g/g-image-project',video='https://chatgpt.com/g/g-video-project';
 const opts=url=>({freshTab:false,attachment:undefined,composerMode:'chat',temporary:false,model:'auto',pageUrl:url});
 for(let i=1;i<=3;i++)await b.request('gpt-'+i,'worker-'+i,opts(image));
 await until(()=>b.messages.length===3);
 assert.equal(b.created.length,3);assert.ok(b.created.every(t=>t.url==='https://chatgpt.com/'));assert.ok(b.updated.filter(t=>t.url).every(t=>t.url===image));
 assert.ok(b.messages.every(m=>m.customGPT&&m.pageUrl===image&&!m.attachment&&m.temporary===false));
 for(let i=1;i<=3;i++){await b.complete('gpt-'+i);await b.send({type:'commit',requestId:'gpt-'+i,controlId:'c'+i,ok:true});}
 await b.request('next-project','worker-1',opts(video));await until(()=>b.messages.length===4);
 assert.equal(b.created.length,3);assert.equal(b.updated.filter(t=>t.url).at(-1).url,video);assert.equal(b.messages.at(-1).pageUrl,video);
 assert.equal(b.messages[0].id,b.messages[3].id);await b.complete('next-project');
});
test('invalid project destinations are rejected before opening a tab or typing',async()=>{
 const b=await bridge();await b.send({type:'ensureTextWorkers',controlId:'prepare'});
 for(const pageUrl of ['https://example.com/','https://chatgpt.com/c/old']){
  await b.request('bad','worker-1',{freshTab:false,attachment:undefined,temporary:false,pageUrl});
  assert.equal(b.replies.at(-1).not_submitted,true);
 }
 assert.equal(b.created.length,3);assert.equal(b.updated.length,0);assert.equal(b.messages.length,0);
});


test('opening SRT prepares a focused Work window without sending; the job reuses exactly that tab',async()=>{
 const b=await bridge(),token='11111111-1111-1111-1111-111111111111';
 await b.send({type:'prepareSrt',controlId:'prepare',token,pageUrl:'https://chatgpt.com/'});
 assert.equal(b.created.length,1);assert.equal(b.created[0].active,true);
 assert.equal(b.messages.length,0);assert.equal(b.saved.workers[0].preparedToken,token);
 assert.equal(b.replies.at(-1).data.tabId,100);
 await b.send({type:'prepareSrt',controlId:'refocus',token,pageUrl:'https://chatgpt.com/'});
 assert.equal(b.created.length,1);
 await b.request('srt-prepared','srt-worker',{preparedTabToken:token});await until(()=>b.messages.length===1);
 assert.equal(b.created.length,1);assert.equal(b.messages[0].id,100);
 assert.equal(b.messages[0].composerMode,'work');assert.deepEqual(JSON.parse(JSON.stringify(b.messages[0].attachment)),attachment);
 assert.equal(b.saved.workers[0].preparedToken,null);
 await b.send({type:'prepareSrt',controlId:'busy',token,pageUrl:'https://chatgpt.com/'});
 assert.equal(b.replies.at(-1).ok,false);assert.equal(b.created.length,1);
 await b.complete('srt-prepared');
});

test('stale prepared tab tokens cannot send a prompt or create an extra window',async()=>{
 const b=await bridge();
 await b.request('stale','srt-worker',{preparedTabToken:'11111111-1111-1111-1111-111111111111'});
 assert.equal(b.replies.at(-1).not_submitted,true);assert.equal(b.messages.length,0);assert.equal(b.created.length,0);
});

test('prepare replaces an inactive failed SRT binding, preserves its old tab and other workers',async()=>{
 const b=await bridge([{id:'srt-worker',kind:'srt',tabId:20,state:'NEEDS_REVIEW',requestId:'old'},
 {id:'worker-1',tabId:21,state:'IDLE'}]);
 await b.send({type:'prepareSrt',controlId:'prepare',token:'new-token',pageUrl:'https://chatgpt.com/'});
 assert.equal(b.replies.at(-1).ok,true);assert.equal(b.created.length,1);
 assert.equal(b.tabs.has(20),true);
 assert.equal(b.saved.workers.find(w=>w.id==='srt-worker').tabId,100);
 assert.equal(b.saved.workers.find(w=>w.id==='worker-1').tabId,21);
 assert.equal(b.messages.length,0);
});
test('quarantined SRT still executing cannot be replaced',async()=>{
 const b=await bridge();await b.request('active');await until(()=>b.messages.length===1);
 await b.send({type:'quarantine',requestId:'active'});
 await b.send({type:'prepareSrt',controlId:'prepare',token:'new-token'});
 assert.equal(b.replies.at(-1).ok,false);assert.equal(b.created.length,1);
 b.pending.get('active')({ok:true,content:'Old answer'});
 await until(()=>b.replies.some(r=>r.type==='response'&&r.requestId==='active'));
});

for(const interrupted of [false,true])test('SRT browser download '+(interrupted?'failure retains tab':'completes before save and close'),async()=>{
 let listener,suggested,removed=false,clicked=0;
 const mock={api:{
  onDeterminingFilename:{addListener:f=>listener=f,removeListener:f=>{assert.equal(f,listener);removed=true;}},
  search:async()=>[{state:interrupted?'interrupted':'complete',exists:true,filename:'C:/Users/Test/Downloads/'+suggested.filename}]
 },click:async()=>{
  clicked++;
  listener({id:55,startTime:new Date().toISOString(),referrer:'https://chatgpt.com/',filename:'transcript(5)_scenes.srt'},s=>suggested=s);
  return {ok:true};
 }};
 const b=await bridge([],null,mock);await b.request('download');await until(()=>b.messages.length===1);
 const wrong=await b.page({type:'downloadSrt',requestId:'download'},9);assert.equal(wrong.ok,false);assert.equal(clicked,0);
 const r=await b.page({type:'downloadSrt',requestId:'download'},100);
 assert.equal(r.ok,!interrupted);assert.equal(clicked,1);assert.equal(removed,true);assert.equal(b.tabs.has(100),true);
 if(!interrupted){assert.match(r.nativeDownload.path,/flowkit-chatgpt\/.*\/subtitles.srt/);assert.ok(r.nativeDownload.token);}
 await b.complete('download');
 if(!interrupted){await b.send({type:'commit',requestId:'download',controlId:'ack',ok:true});assert.equal(b.tabs.has(100),false);}
});

test('Stop job closes only its SRT tab; late response cannot change a new worker',async()=>{
 const b=await bridge([{id:'worker-1',kind:'text',tabId:21,state:'IDLE'}]);
 await b.request('old','srt-worker',{srtJobId:'old-job'});await until(()=>b.messages.length===1);
 await b.send({type:'cancelSrt',requestId:'old',jobId:'different-job',controlId:'wrong'});assert.equal(b.replies.at(-1).ok,false);
 await b.send({type:'cancelSrt',requestId:'old',jobId:'old-job',controlId:'stop'});
 assert.equal(b.replies.at(-1).ok,true);assert.equal(b.tabs.has(100),false);assert.equal(b.tabs.has(21),true);
 await b.request('new','srt-worker',{srtJobId:'new-job'});await until(()=>b.messages.length===2);
 b.pending.get('old')({ok:true,content:'Late old answer'});
 await until(()=>b.replies.some(r=>r.type==='response'&&r.requestId==='old'));
 assert.equal(b.saved.workers.find(w=>w.kind==='srt').requestId,'new');
 assert.equal(b.saved.workers.find(w=>w.kind==='srt').state,'RUNNING');
 await b.complete('new');
});

test('200 SRT rows reuse three Temporary conversations and send TXT only once in each tab',async()=>{
 const b=await bridge();await b.send({type:'ensureTextWorkers',controlId:'prepare'});
 assert.equal(b.created.length,3);
 await b.send({type:'ensureTextWorkers',controlId:'again'});assert.equal(b.created.length,3);
 const options={freshTab:false,attachment:undefined,composerMode:'chat',temporary:true,model:'auto',pageUrl:'https://chatgpt.com/',textSessionId:'11111111-1111-1111-1111-111111111111',promptTemplate:'Create one visual prompt.\n日本語の指示。'};
 const finish=async(id,tabId)=>{
  const tab=b.tabs.get(tabId);tab.url='https://chatgpt.com/?temporary-chat=true';
  const sent=b.messages.find(m=>m.requestId===id);
  const proof={id:sent.textSessionId,proof:id,url:tab.url};b.proofs.set(tabId,proof);
  b.pending.get(id)({ok:true,content:'Answer '+id,conversation_url:tab.url,textSessionProof:proof});
  await until(()=>b.saved.workers.some(w=>w.requestId===id&&w.state==='AWAITING_SAVE'));
  await b.send({type:'commit',requestId:id,controlId:'save-'+id,ok:true});
 };
 for(let start=0;start<200;start+=3){
  const size=Math.min(3,200-start);
  for(let offset=0;offset<size;offset++)await b.request('row-'+(start+offset),'worker-'+(offset+1),options);
  await until(()=>b.messages.length===start+size);
  for(let offset=size-1;offset>=0;offset--){const m=b.messages[start+offset];await finish(m.requestId,m.id);}
 }
 assert.equal(b.messages.length,200);assert.equal(b.created.length,3);assert.equal(b.updated.filter(x=>x.url).length,3,'No navigation after the first row per tab');
 const seen=new Set();for(const m of b.messages){const first=!seen.has(m.id);seen.add(m.id);assert.equal(m.userMessage,'Prompt '+m.requestId);assert.equal(m.promptAttachment?.text,first?options.promptTemplate:undefined);assert.equal(m.promptAttachment?.name,first?'prompt-instructions.txt':undefined);assert.equal(m.continueConversation,!first);assert.equal(m.temporary,true);assert.equal(m.composerMode,'chat');}
 assert.equal(seen.size,3);assert.ok(b.saved.workers.every(w=>w.state==='IDLE'));
 // Reloading may keep the SAME URL while erasing Temporary conversation memory.
 const first=b.saved.workers[0];b.proofs.delete(first.tabId);
 await b.request('navigated',first.id,options);await until(()=>b.messages.length===201);
 assert.equal(b.messages.at(-1).continueConversation,false);assert.equal(b.messages.at(-1).promptAttachment.text,options.promptTemplate);await finish('navigated',first.tabId);
 // A different run or prompt always starts with the new instructions.
 await b.request('next-batch',first.id,{...options,textSessionId:'22222222-2222-2222-2222-222222222222',promptTemplate:'New video instructions'});await until(()=>b.messages.length===202);
 assert.equal(b.messages.at(-1).userMessage,'Prompt next-batch');assert.equal(b.messages.at(-1).promptAttachment.text,'New video instructions');await finish('next-batch',first.tabId);
});

test('three Temporary Chat sessions and the single regular Work/SRT tab stay isolated',async()=>{
 const b=await bridge();await b.send({type:'ensureTextWorkers',controlId:'prepare'});
 const options={freshTab:false,attachment:undefined,composerMode:'chat',temporary:true,model:'auto',pageUrl:'https://chatgpt.com/',textSessionId:'11111111-1111-1111-1111-111111111111',promptTemplate:'Image instructions'};
 for(let i=1;i<=3;i++)await b.request('temporary-'+i,'worker-'+i,options);
 await b.request('srt','srt-worker');await until(()=>b.messages.length===4);
 const text=b.messages.filter(m=>m.textSessionId),srt=b.messages.find(m=>m.requestId==='srt');
 assert.equal(text.length,3);assert.ok(text.every(m=>m.composerMode==='chat'&&m.temporary===true&&!m.attachment&&m.promptAttachment?.text==='Image instructions'));
 assert.equal(srt.composerMode,'work');assert.equal(srt.temporary,false);assert.ok(srt.attachment);assert.ok(!text.some(m=>m.id===srt.id));
 for(const m of text){const tab=b.tabs.get(m.id);tab.url='https://chatgpt.com/?temporary-chat=true';const proof={id:options.textSessionId,proof:m.requestId,url:tab.url};b.proofs.set(m.id,proof);b.pending.get(m.requestId)({ok:true,content:'Image prompt',conversation_url:tab.url,textSessionProof:proof});}
 await until(()=>b.saved.workers.filter(w=>w.kind==='text').every(w=>w.state==='AWAITING_SAVE'));
 await b.complete('srt');
 for(const m of b.messages)await b.send({type:'commit',requestId:m.requestId,controlId:'save-'+m.requestId,ok:true});
 assert.equal(b.saved.workers.filter(w=>w.kind==='text').length,3);assert.equal(b.saved.workers.find(w=>w.kind==='srt').tabId,null);
 // Wrong mode is refused instead of falling back to regular Chat.
 const before=b.messages.length;await b.request('wrong','worker-1',{...options,temporary:false});
 assert.equal(b.replies.at(-1).not_submitted,true);assert.equal(b.messages.length,before);
});

test('text preparation replaces inactive failed bindings while preserving old tabs and SRT',async()=>{
 const initial=[1,2,3].map(i=>({id:'worker-'+i,kind:'text',tabId:i,state:'NEEDS_REVIEW',requestId:'old-'+i}));
 initial.push({id:'srt-worker',kind:'srt',tabId:4,state:'NEEDS_REVIEW',requestId:'old-srt'});
 const b=await bridge(initial);await b.send({type:'ensureTextWorkers',controlId:'recover'});
 assert.equal(b.replies.at(-1).ok,true);assert.equal(b.created.length,3);
 for(let i=1;i<=4;i++)assert.ok(b.tabs.has(i),'Old tab retained');
 assert.equal(b.messages.length,0,'No old request replayed');
 const text=b.saved.workers.filter(w=>w.kind==='text');assert.ok(text.every(w=>w.state==='IDLE'&&w.tabId>=100&&!w.requestId&&!w.textSession));
 assert.equal(b.saved.workers.find(w=>w.kind==='srt').requestId,'old-srt');
 await b.send({type:'ensureTextWorkers',controlId:'again'});assert.equal(b.created.length,3);
});

test('text preparation preserves running and awaiting-save requests and refuses quarantine while executing',async()=>{
 const b=await bridge([1,2,3].map(i=>({id:'worker-'+i,tabId:i,state:'IDLE'})));
 const options={freshTab:false,attachment:undefined,composerMode:'chat',temporary:true};
 await b.request('running','worker-1',options);await until(()=>b.messages.length===1);
 await b.request('saving','worker-2',options);await until(()=>b.messages.length===2);await b.complete('saving');
 await b.send({type:'ensureTextWorkers',controlId:'prepare'});
 assert.equal(b.created.length,0);assert.equal(b.saved.workers[0].state,'RUNNING');assert.equal(b.saved.workers[1].state,'AWAITING_SAVE');
 await b.send({type:'quarantine',requestId:'running'});
 await b.send({type:'ensureTextWorkers',controlId:'blocked'});assert.equal(b.replies.at(-1).ok,false);assert.equal(b.created.length,0);
 b.pending.get('running')({ok:false,error:'Stopped'});await until(()=>b.replies.some(r=>r.type==='response'&&r.requestId==='running'));
 await b.send({type:'ensureTextWorkers',controlId:'after-stop'});assert.equal(b.replies.at(-1).ok,true);assert.equal(b.created.length,1);
 assert.ok(b.tabs.has(1));assert.equal(b.saved.workers[1].state,'AWAITING_SAVE');
});

test('three tabs serialize focus/upload/send but generate responses concurrently',async()=>{
 const b=await bridge([],null,null,true);await b.send({type:'ensureTextWorkers',controlId:'ensure'});
 const options={freshTab:false,attachment:undefined,composerMode:'chat',temporary:true,textSessionId:'session',promptTemplate:'Instructions'};
 for(let i=1;i<=3;i++)await b.request('row'+i,'worker-'+i,options);
 await until(()=>b.messages.length===1);for(let i=0;i<10;i++)await tick();
 assert.equal(b.messages.length,1,'Next window must not steal focus during upload');assert.equal(b.focused.length,1);
 const first=b.messages[0];assert.equal((await b.page({type:'requestSubmitted',requestId:'row1'},999)).ok,false);
 assert.equal(b.messages.length,1,'Unrelated tabs cannot unlock setup');
 await b.page({type:'requestSubmitted',requestId:'row1'},first.id);await until(()=>b.messages.length===2);
 assert.ok(b.pending.has('row1'),'The first response is still generating');
 await b.page({type:'requestSubmitted',requestId:'row2'},b.messages[1].id);await until(()=>b.messages.length===3);
 await b.page({type:'requestSubmitted',requestId:'row3'},b.messages[2].id);
 assert.equal(b.focused.length,3);assert.equal(b.pending.size,3);
 // Losing continuation proof must not discard already completed content.
 for(const m of b.messages){b.pending.get(m.requestId)({ok:true,content:'Completed '+m.requestId,conversation_url:b.tabs.get(m.id).url});}
 await until(()=>b.saved.workers.every(w=>w.state==='AWAITING_SAVE'));
 assert.equal(b.replies.filter(r=>r.type==='response'&&r.ok).length,3);
 for(const m of b.messages)await b.send({type:'commit',requestId:m.requestId,controlId:'save-'+m.requestId,ok:true});
 await b.request('next','worker-1',options);await until(()=>b.messages.length===4);
 assert.equal(b.messages[3].continueConversation,false);assert.equal(b.messages[3].promptAttachment.text,'Instructions');
 b.pending.get('next')({ok:false,error:'Upload failed',phase:'ATTACHING_FILE',submitted:false});
 await until(()=>b.replies.some(r=>r.type==='response'&&r.requestId==='next'));
 assert.equal(b.replies.find(r=>r.type==='response'&&r.requestId==='next').phase,'ATTACHING_FILE');
});
