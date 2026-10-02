import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import net from 'node:net';
async function setup(){
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,CHATGPT_GATEWAY_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 await once(child.stdout,'data');const base=`http://127.0.0.1:${port}`;
 const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);await once(ws,'open');
 const workers=[1,2,3].map(i=>({id:'w'+i,tabId:i,state:'IDLE'}));
 const announce=()=>ws.send(JSON.stringify({type:'pool',protocol:2,enabled:true,workers}));announce();
 const post=(route,body)=>fetch(base+route,{method:'POST',body:JSON.stringify(body)});
 const request=(prompt='test')=>post('/v1/chat/completions',{messages:[{role:'user',content:prompt}]});
 const health=async()=>await (await fetch(base+'/health')).json();
 for(let i=0;i<20 && (await health()).workers.length!==3;i++)await new Promise(r=>setTimeout(r,10));
 return {ws,workers,announce,request,post,health,base,close:async()=>{ws.terminate();child.kill();await once(child,'exit');}};
}
test('3 reservations, out-of-order ID matching, save ACK before reuse, isolated error and disconnect',async()=>{
 const s=await setup();const messages=[];
 s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat')messages.push(m);
  if(m.type==='commit'||m.type==='reviewReset')s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));});
 try{
  const pending=[s.request('a'),s.request('b'),s.request('c')];
  while(messages.length<3)await new Promise(r=>setTimeout(r,5));
  assert.equal(new Set(messages.map(m=>m.workerId)).size,3);assert.equal((await s.request('d')).status,409);
  s.ws.send(JSON.stringify({type:'response',workerId:messages[0].workerId,requestId:'wrong',ok:true,content:'wrong'}));
  for(const m of [...messages].reverse())s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:m.messages[0].content}));
  const results=await Promise.all(pending.map(async p=>await (await p).json()));
  assert.deepEqual(results.map(r=>r.choices[0].message.content),['a','b','c']);
  assert.equal((await s.request('blocked-before-save')).status,409);
  await s.post('/commit',{request_id:results[0].id,ok:true});
  const failed=s.request('fail');while(messages.length<4)await new Promise(r=>setTimeout(r,5));
  const last=messages[3];s.ws.send(JSON.stringify({type:'response',workerId:last.workerId,requestId:last.requestId,ok:false,error:'Temporary Chat not verified'}));
  assert.equal((await failed).status,502);assert.equal((await s.health()).reviewWorkers,1);
  await s.post('/commit',{request_id:results[1].id,ok:true});assert.equal((await s.health()).availableSlots,1);
  const lost=s.request('disconnect');while(messages.length<5)await new Promise(r=>setTimeout(r,5));s.ws.close();assert.equal((await lost).status,502);
  assert.equal((await fetch(s.base+'/review/reset',{method:'POST',headers:{Origin:'https://example.com'}})).status,403);
 }finally{await s.close();}
});
test('150 queued requests circulate through exactly 3 workers and commit every result',async()=>{
 const s=await setup();let active=0,peak=0,acks=0;const seen=new Set();
 s.ws.on('message',raw=>{const m=JSON.parse(raw);
  if(m.type==='chat'){
   active++;peak=Math.max(peak,active);seen.add(m.workerId);
   setTimeout(()=>s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'answer:'+m.messages[0].content})),m.workerId==='w1'?15:3);
  }else if(m.type==='commit'){
   active--;acks++;s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));
  }
 });
 try{
  let cursor=0;const results=new Map();
  await Promise.all([1,2,3].map(async()=>{while(cursor<150){const i=cursor++;const r=await (await s.request(String(i))).json();assert.equal(r.choices[0].message.content,'answer:'+i);results.set(i,r);assert.equal((await s.post('/commit',{request_id:r.id,ok:true})).status,200);}}));
  assert.equal(results.size,150);assert.equal(seen.size,3);assert.equal(peak,3);assert.equal(acks,150);
 }finally{await s.close();}
});
test('inspection locks dispatch, relays reports and preserves worker progress',async()=>{
 const s=await setup();let inspection;
 s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='inspect')inspection=m;});
 try{
  const pending=s.post('/inspect',{kind:'preflight',model:'GPT-6 Astra :: high',workers:2,temporary:true});
  for(let i=0;i<100&&!inspection;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(inspection.model,'GPT-6 Astra :: high');assert.equal((await s.health()).availableSlots,0);
  const blocked=await s.request('must not send');assert.equal(blocked.status,409);assert.equal((await blocked.json()).not_submitted,true);
  s.ws.send(JSON.stringify({type:'controlResult',controlId:inspection.controlId,ok:true,data:{passed:true,reports:[{workerId:'w1',passed:true}]}}));
  assert.equal((await (await pending).json()).passed,true);assert.equal((await s.health()).availableSlots,3);
  s.workers[0].progress={phase:'THINKING',chars:25};s.announce();
  for(let i=0;i<30&&!(await s.health()).workers[0].progress;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal((await s.health()).workers[0].progress.phase,'THINKING');
 }finally{await s.close();}
});
test('inspection race rejection before submission releases gateway reservation',async()=>{
 const s=await setup();s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat')s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:false,not_submitted:true,error:'Inspection in progress'}));});
 try{const r=await s.request();assert.equal(r.status,409);assert.equal((await r.json()).not_submitted,true);const h=await s.health();assert.equal(h.availableSlots,3);assert.equal(h.reviewWorkers,0);}finally{await s.close();}
});
