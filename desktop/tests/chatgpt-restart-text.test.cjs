const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(r=>setImmediate(r));
test('Start closes idle and running text tabs, stops generation, preserves SRT tab and clears setup lock',async()=>{
 const saved={enabled:true,workers:[{id:'worker-1',kind:'text',tabId:1,state:'IDLE',owned:true},{id:'worker-2',kind:'text',tabId:2,state:'IDLE',owned:true},{id:'srt-worker',kind:'srt',tabId:3,state:'IDLE',owned:true}]};
 const tabs=new Map([1,2,3].map(id=>[id,{id,url:'https://chatgpt.com/'}]));const stopped=[],removed=[],sent=[];let socket,runtimeMessage;
 class WS{constructor(){this.readyState=1;socket=this;}send(raw){sent.push(JSON.parse(raw));}}
 const event={addListener(){}};
 const chrome={storage:{local:{get:async()=>saved,set:async value=>Object.assign(saved,structuredClone(value))}},runtime:{id:"test",onMessage:{addListener(fn){runtimeMessage=fn;}},onStartup:event,onInstalled:event},alarms:{create(){},onAlarm:event},tabs:{onRemoved:event,get:async id=>{if(!tabs.has(id))throw Error('missing');return tabs.get(id);},query:async()=>[...tabs.values()],remove:async id=>{removed.push(id);tabs.delete(id);},sendMessage:async(id,m)=>{stopped.push([id,m.type]);return {ok:true};}}};
 const ctx=vm.createContext({chrome,WebSocket:WS,URL,console,setInterval(){},setTimeout(fn){return setImmediate(fn);},clearTimeout(){}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/background.js'),'utf8'),ctx);await tick();await tick();socket.onopen();
 vm.runInContext("workers.find(w=>w.id==='worker-2').state='RUNNING';workers.find(w=>w.id==='worker-2').requestId='old';executing.add('worker-2');",ctx);
 await vm.runInContext("acquireSetup('old')",ctx);
 await socket.onmessage({data:JSON.stringify({type:'restartText',controlId:'restart'})});
 assert.deepEqual(removed,[1,2]);assert.ok(tabs.has(3));assert.equal(saved.workers.length,1);assert.equal(saved.workers[0].id,'srt-worker');
 assert.equal(vm.runInContext('executing.size',ctx),0);assert.equal(vm.runInContext('setupOwner',ctx),null);
 assert.ok(sent.some(m=>m.controlId==='restart'&&m.ok));assert.deepEqual(stopped,[[1,'stopSrt'],[2,'stopSrt']]);
 await socket.onmessage({data:JSON.stringify({type:'closeIdleText',controlId:'cleanup'})});
 assert.equal(sent.filter(m=>m.type==='pool').at(-1).inspecting,false,'cleanup must announce the released configuration lock');
 await socket.onmessage({data:JSON.stringify({type:'restartText',controlId:'again'})});
 assert.ok(sent.some(m=>m.controlId==='again'&&m.ok));
 tabs.set(4,{id:4,url:'https://chatgpt.com/'});
 const configured=await new Promise(resolve=>runtimeMessage({type:'configurePool',tabIds:[4]},{id:'test'},resolve));
 assert.ok(!configured.error);assert.equal(sent.filter(m=>m.type==='pool').at(-1).inspecting,false);
});

for(const scenario of ['idle without request ID','idle with null request ID','running before idle','SRT owns setup'])test('Restart is safe when '+scenario,async()=>{
 const saved={enabled:true,workers:[{id:'worker-1',kind:'text',tabId:1,state:'IDLE',owned:true},{id:'worker-2',kind:'text',tabId:2,state:'IDLE',owned:true},{id:'srt-worker',kind:'srt',tabId:3,state:'IDLE',owned:true}]};
 if(scenario==='idle with null request ID')saved.workers[0].requestId=null;
 const tabs=new Map([1,2,3].map(id=>[id,{id,url:'https://chatgpt.com/'}])),sent=[],removed=[];let socket;
 class WS{constructor(){this.readyState=1;socket=this;}send(raw){sent.push(JSON.parse(raw));}}
 const event={addListener(){}};
 const chrome={storage:{local:{get:async()=>saved,set:async value=>Object.assign(saved,structuredClone(value))}},runtime:{onMessage:event,onStartup:event,onInstalled:event},alarms:{create(){},onAlarm:event},tabs:{onRemoved:event,get:async id=>{if(!tabs.has(id))throw Error('missing');return tabs.get(id);},query:async()=>[...tabs.values()],remove:async id=>{removed.push(id);tabs.delete(id);},sendMessage:async()=>({ok:true})}};
 const ctx=vm.createContext({chrome,WebSocket:WS,URL,console,setInterval(){},setTimeout:fn=>setImmediate(fn),clearTimeout(){}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/background.js'),'utf8'),ctx);await tick();await tick();socket.onopen();
 if(scenario==='running before idle'){
  vm.runInContext("workers[0].state='RUNNING';workers[0].requestId='active-text';executing.add(workers[0].id);",ctx);
  await vm.runInContext("acquireSetup('active-text')",ctx);
 }
 if(scenario==='SRT owns setup')await vm.runInContext("acquireSetup('active-srt')",ctx);
 await socket.onmessage({data:JSON.stringify({type:'restartText',controlId:'start'})});
 const result=sent.find(m=>m.controlId==='start');assert.equal(result?.ok,true,result?.error);
 assert.deepEqual(removed,[1,2]);assert.ok(tabs.has(3));assert.equal(saved.workers.length,1);
 assert.equal(vm.runInContext('setupOwner?.requestId ?? null',ctx),scenario==='SRT owns setup'?'active-srt':null);
 assert.equal(vm.runInContext('configuring',ctx),false);
 await socket.onmessage({data:JSON.stringify({type:'restartText',controlId:'again'})});
 assert.equal(sent.find(m=>m.controlId==='again')?.ok,true);
});
