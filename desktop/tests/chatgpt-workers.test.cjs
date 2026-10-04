const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
const tick=()=>new Promise(r=>setImmediate(r));
for(const composerMode of ['chat','work'])test(`extension ${composerMode} runs three bound tabs, waits for save ACK, and preserves uncertain tabs after disconnect`,async()=>{
 const saved={enabled:true,modelPreference:'GPT-6 Astra :: high',...(composerMode==='work'?{composerMode}:{}),workers:[1,2,3].map(i=>({id:'w'+i,tabId:i,state:'IDLE'}))};
 let listener,socket;const sent=[],navigated=[],pending=new Map(),chatPayloads=[];
 class WS{constructor(){this.readyState=1;socket=this;}send(data){sent.push(JSON.parse(data));}close(){this.readyState=3;this.onclose();}}
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async d=>Object.assign(saved,structuredClone(d))}},
 tabs:{get:async id=>({id,url:'https://chatgpt.com/',status:'complete'}),update:async(id)=>{navigated.push(id);},onRemoved:{addListener(){}},sendMessage:async(id,m)=>{
  if(m.type==='ping')return {ok:true};if(m.type==='probe')return {streaming:false};chatPayloads.push(m);return new Promise(resolve=>pending.set(id,resolve));}},
 runtime:{id:'ext',onMessage:{addListener:f=>listener=f},onStartup:{addListener(){}},onInstalled:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/background.js'),'utf8'),{chrome,WebSocket:WS,URL,console,setTimeout:fn=>setImmediate(fn),setInterval(){}});
 await tick();await tick();socket.onopen();
 const request=i=>socket.onmessage({data:JSON.stringify({type:'chat',workerId:'w'+i,requestId:'r'+i,messages:[{content:'prompt'+i}],model:composerMode==='work'?'extension':'auto',temporary:true})});
 for(let i=1;i<=3;i++)await request(i);
 for(let i=0;i<10&&pending.size<3;i++)await tick();
 assert.equal(pending.size,3);assert.deepEqual(navigated,[1,2,3]);assert.ok(chatPayloads.every(p=>p.temporary));
 assert.ok(chatPayloads.every(p=>p.composerMode===composerMode));
 const sendUI=(m,sender={id:'ext'})=>new Promise(resolve=>listener(m,sender,resolve));
 await sendUI({type:'jobProgress',requestId:'r1',phase:'THINKING',chars:123},{id:'ext',tab:{id:1},frameId:0});
 assert.equal((await sendUI({type:'status'})).workers[0].progress.phase,'THINKING');
 await sendUI({type:'jobProgress',requestId:'wrong',phase:'SENDING'},{id:'ext',tab:{id:1},frameId:0});
 await sendUI({type:'jobProgress',requestId:'r1',phase:'SENDING'},{id:'ext',tab:{id:3},frameId:0});
 assert.equal((await sendUI({type:'status'})).workers[0].progress.chars,123);
 assert.match((await sendUI({type:'preflight'})).error,/finish or review/);

 assert.ok(chatPayloads.every(p=>p.model===(composerMode==='work'?'GPT-6 Astra :: high':'auto')));
 const rejected=await new Promise(resolve=>listener({type:'setComposerMode',composerMode:composerMode==='chat'?'work':'chat'},{id:'ext'},resolve));
 assert.match(rejected.error,/Wait for active requests/);assert.equal(saved.composerMode,composerMode);
 pending.get(2)({ok:true,content:'second'});await tick();await tick();
 assert.equal(saved.workers[1].state,'AWAITING_SAVE');
 await request(2);assert.equal(sent.at(-1).ok,false); // no overwrite while waiting for disk
 await socket.onmessage({data:JSON.stringify({type:'commit',controlId:'c2',requestId:'r2',ok:true})});
 assert.equal(saved.workers[1].state,'IDLE');
 socket.close();await tick();
 assert.equal(saved.workers[0].state,'NEEDS_REVIEW');assert.equal(saved.workers[2].state,'NEEDS_REVIEW');
 pending.get(1)({ok:true,content:'late'});pending.get(3)({ok:true,content:'late'});await tick();await tick();
 assert.equal(saved.workers[0].state,'NEEDS_REVIEW');
 const status=await new Promise(resolve=>listener({type:'status'},{id:'ext'},resolve));assert.equal(status.busy,false);
});

test('Work + JSON and Chat Temporary stay isolated concurrently and when reusing the same tab',async()=>{
 const saved={enabled:true,composerMode:'work',modelPreference:'Saved extension model',workers:[1,2,3].map(i=>({id:'w'+i,tabId:i,state:'IDLE'}))};
 let listener,socket;const pending=new Map(),payloads=[],inspections=[];
 class WS{constructor(){this.readyState=1;socket=this;}send(){} }
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async d=>Object.assign(saved,structuredClone(d))}},
 tabs:{get:async id=>({id,url:'https://chatgpt.com/',status:'complete'}),update:async()=>{},onRemoved:{addListener(){}},sendMessage:async(id,m)=>{
  if(m.type==='ping')return {ok:true};
  if(m.type==='preflight'){inspections.push(m);return {ok:true,data:{passed:true}};}
  payloads.push({tabId:id,...m});return new Promise(resolve=>pending.set(m.requestId,resolve));}},
 runtime:{id:'ext',onMessage:{addListener:f=>listener=f},onStartup:{addListener(){}},onInstalled:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/background.js'),'utf8'),{chrome,WebSocket:WS,URL,console,clearTimeout,setTimeout:(fn,ms)=>ms>=5000?setTimeout(fn,ms):setImmediate(fn),setInterval(){}});
 await tick();await tick();socket.onopen();
 const send=m=>socket.onmessage({data:JSON.stringify(m)});
 const ui=m=>new Promise(resolve=>listener(m,{id:'ext'},resolve));
 await send({type:'inspect',controlId:'inspect-chat',kind:'preflight',composerMode:'chat',temporary:true});
 assert.ok(inspections.every(m=>m.composerMode==='chat'&&m.temporary));
 inspections.length=0;
 await ui({type:'preflight',temporary:false});
 assert.ok(inspections.every(m=>m.composerMode==='work'&&!m.temporary));
 const attachment={name:'transcript.json',base64:'e30='};
 await send({type:'chat',workerId:'w1',requestId:'srt',messages:[{content:'Make SRT'}],composerMode:'work',temporary:false,model:'GPT-6 Astra',attachment});
 await send({type:'chat',workerId:'w2',requestId:'text',messages:[{content:'Text'}],composerMode:'chat',temporary:true,model:'auto'});
 for(let i=0;i<20&&pending.size<2;i++)await tick();
 assert.equal(pending.size,2);
 const work=payloads.find(p=>p.requestId==='srt'),chat=payloads.find(p=>p.requestId==='text');
 assert.equal(work.tabId,1);assert.equal(work.composerMode,'work');assert.equal(work.temporary,false);assert.equal(work.model,'GPT-6 Astra');assert.deepEqual(JSON.parse(JSON.stringify(work.attachment)),attachment);
 assert.equal(chat.tabId,2);assert.equal(chat.composerMode,'chat');assert.equal(chat.temporary,true);assert.equal(chat.model,'auto');assert.equal(chat.attachment,undefined);
 assert.equal(saved.workers[0].requestOptions.composerMode,'work');assert.equal(saved.workers[1].requestOptions.composerMode,'chat');
 pending.get('srt')({ok:true,content:'SRT'});await tick();await tick();
 assert.equal(saved.workers[0].state,'AWAITING_SAVE');
 await send({type:'commit',controlId:'saved-srt',requestId:'srt',ok:true});
 assert.equal(saved.workers[0].state,'IDLE');assert.equal(saved.workers[0].requestOptions,null);
 await send({type:'chat',workerId:'w1',requestId:'text-after-work',messages:[{content:'Next text'}],composerMode:'chat',temporary:true,model:'Chat model'});
 for(let i=0;i<20&&!pending.has('text-after-work');i++)await tick();
 const next=payloads.at(-1);
 assert.equal(next.tabId,1);assert.equal(next.composerMode,'chat');assert.equal(next.temporary,true);assert.equal(next.model,'Chat model');assert.equal(next.attachment,undefined);
 assert.equal(saved.composerMode,'work');assert.equal(saved.modelPreference,'Saved extension model');
 for(const id of ['text','text-after-work']){pending.get(id)({ok:true,content:id});await tick();await tick();await send({type:'commit',controlId:'saved-'+id,requestId:id,ok:true});}
 assert.ok(saved.workers.every(w=>w.state==='IDLE'));
});
