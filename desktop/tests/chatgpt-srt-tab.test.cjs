const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(r=>setImmediate(r));
const until=async condition=>{for(let i=0;i<40&&!condition();i++)await tick();assert.ok(condition(),'Expected asynchronous transition');};
const attachment={name:'transcript-11111111-1111-1111-1111-111111111111.json',base64:'e30='};
async function bridge(initial=[],create){
 const saved={enabled:true,composerMode:'chat',workers:structuredClone(initial)};
 const tabs=new Map(initial.filter(w=>w.tabId!==null).map(w=>[w.tabId,{id:w.tabId,url:'https://chatgpt.com/c/old',status:'complete'}]));
 tabs.set(9,{id:9,url:'https://example.com/',status:'complete'});
 let socket,listener,nextId=100,removed;const replies=[],created=[],updated=[],messages=[],pending=new Map();
 class WS{constructor(){socket=this;this.readyState=1;}send(s){replies.push(JSON.parse(s));}close(){this.readyState=3;this.onclose();}}
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async d=>Object.assign(saved,structuredClone(d))}},
  tabs:{get:async id=>{if(!tabs.has(id))throw Error('Missing tab');return tabs.get(id);},
   query:async()=>[...tabs.values()],remove:async id=>{tabs.delete(id);removed(id);},
   create:async options=>{created.push(options);if(create)await create();const t={id:nextId++,url:options.url,status:'complete'};tabs.set(t.id,t);return t;},
   update:async(id,options)=>{updated.push({id,...options});Object.assign(tabs.get(id),options);return tabs.get(id);},
   onRemoved:{addListener:f=>removed=f},sendMessage:async(id,m)=>{
    if(m.type==='ping')return {ok:true};if(m.type==='probe')return {streaming:false};if(m.type==='preflight')return {ok:true,data:{passed:true}};
    messages.push({id,...m});return new Promise(resolve=>pending.set(m.requestId,resolve));}},
  runtime:{id:'ext',onMessage:{addListener:f=>listener=f},onStartup:{addListener(){}},onInstalled:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}}};
 chrome.windows={create:async options=>{assert.equal(options.type,'normal');const tab=await chrome.tabs.create({url:options.url,active:options.focused});return {id:tab.id,tabs:[tab]};}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/background.js'),'utf8'),{chrome,WebSocket:WS,URL,console,setTimeout:(f,ms)=>ms===500?setImmediate(f):setTimeout(f,ms),clearTimeout,setInterval(){}});
 await tick();await tick();socket.onopen();
 const send=m=>socket.onmessage({data:JSON.stringify(m)});
 const request=(id,workerId='srt-worker',extra={})=>send({type:'chat',requestId:id,workerId,messages:[{content:'Prompt '+id}],attachment,model:'GPT-6 Astra',composerMode:'work',temporary:false,freshTab:true,...extra});
 const complete=async id=>{pending.get(id)({ok:true,content:'Saved answer'});await until(()=>saved.workers.some(w=>w.requestId===id&&w.state==='AWAITING_SAVE'));};
 return {saved,tabs,replies,created,updated,messages,pending,request,complete,send,socket,
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
 assert.equal(b.tabs.has(100),false,'Saved SRT tab closes');assert.equal(b.updated.length,0,'Never navigates the old tab for SRT');
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
 assert.equal(b.created.length,1);assert.deepEqual(b.updated.map(x=>x.id),[1,2,3]);
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
 assert.equal(b.saved.workers.length,3);assert.equal(b.created.length,0);
 const image='https://chatgpt.com/g/g-image-project',video='https://chatgpt.com/g/g-video-project';
 const opts=url=>({freshTab:false,attachment:undefined,composerMode:'chat',temporary:false,model:'auto',pageUrl:url});
 for(let i=1;i<=3;i++)await b.request('gpt-'+i,'worker-'+i,opts(image));
 await until(()=>b.messages.length===3);
 assert.equal(b.created.length,3);assert.ok(b.created.every(t=>t.url===image));
 assert.ok(b.messages.every(m=>m.customGPT&&m.pageUrl===image&&!m.attachment&&m.temporary===false));
 for(let i=1;i<=3;i++){await b.complete('gpt-'+i);await b.send({type:'commit',requestId:'gpt-'+i,controlId:'c'+i,ok:true});}
 await b.request('next-project','worker-1',opts(video));await until(()=>b.messages.length===4);
 assert.equal(b.created.length,3);assert.equal(b.updated.at(-1).url,video);assert.equal(b.messages.at(-1).pageUrl,video);
 assert.equal(b.messages[0].id,b.messages[3].id);await b.complete('next-project');
});
test('invalid project destinations are rejected before opening a tab or typing',async()=>{
 const b=await bridge();await b.send({type:'ensureTextWorkers',controlId:'prepare'});
 for(const pageUrl of ['https://example.com/','https://chatgpt.com/c/old']){
  await b.request('bad','worker-1',{freshTab:false,attachment:undefined,temporary:false,pageUrl});
  assert.equal(b.replies.at(-1).not_submitted,true);
 }
 assert.equal(b.created.length,0);assert.equal(b.messages.length,0);
});
