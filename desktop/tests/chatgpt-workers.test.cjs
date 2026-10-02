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
