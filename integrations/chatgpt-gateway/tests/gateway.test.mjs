import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import net from 'node:net';
async function setup(initial=[1,2,3].map(i=>({id:'w'+i,tabId:i,state:'IDLE'})),capabilities=[]){
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,CHATGPT_GATEWAY_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 await once(child.stdout,'data');const base=`http://127.0.0.1:${port}`;
 const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);await once(ws,'open');
 const workers=initial,dedicated={worker:null};
 const announce=()=>ws.send(JSON.stringify({type:'pool',protocol:2,enabled:true,workers,srtWorker:dedicated.worker,capabilities}));announce();
 const post=(route,body)=>fetch(base+route,{method:'POST',body:JSON.stringify(body)});
 const request=(prompt='test')=>post('/v1/chat/completions',{messages:[{role:'user',content:prompt}]});
 const health=async()=>await (await fetch(base+'/health')).json();
 for(let i=0;i<20;i++){const h=await health();if(h.enabled&&h.workers.length===workers.length&&capabilities.every(c=>h.capabilities.includes(c)))break;await new Promise(r=>setTimeout(r,10));}
 return {ws,workers,dedicated,announce,request,post,health,base,close:async()=>{ws.terminate();child.kill();await once(child,'exit');}};
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

const srtPayload={messages:[{role:'user',content:'Make SRT'}],attachment:{name:'transcript-11111111-1111-1111-1111-111111111111.json',base64:'e30='},composerMode:'work',temporary:false,model:'GPT-6 Astra',freshTab:true};
const srtCapabilities=['json-attachment-v1','fresh-srt-tab-v1','dedicated-srt-v1'];
const waitFor=async condition=>{for(let i=0;i<100;i++){if(await condition())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Expected gateway transition');};
test('fresh SRT works without assigned tabs, reserves before create and returns the new tab ID after save',async()=>{
 const s=await setup([],srtCapabilities),messages=[];
 s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat')messages.push(m);
  if(m.type==='commit'){
   s.dedicated.worker.state='IDLE';s.announce();s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));
  }
 });
 try{
  assert.equal((await s.health()).workers.length,0);
  const pending=s.post('/v1/chat/completions',{...srtPayload,workers:1});await waitFor(()=>messages.length===1);
  const m=messages[0];assert.equal(m.freshTab,true);assert.equal(m.composerMode,'work');assert.equal(m.temporary,false);
  assert.equal((await s.health()).srtWorker.state,'RUNNING');assert.equal((await s.health()).srtWorker.tabId,null);
  s.announce(); // A stale empty-pool heartbeat cannot erase the reservation.
  assert.equal((await s.post('/v1/chat/completions',{...srtPayload,workers:1})).status,409);
  s.dedicated.worker={id:m.workerId,kind:'srt',tabId:123,state:'RUNNING'};s.announce();
  s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'SRT'}));
  const response=await pending;assert.equal(response.status,200);const result=await response.json();assert.equal(result.tab_id,123);
  assert.equal((await s.post('/v1/chat/completions',{...srtPayload,workers:1})).status,409);
  assert.equal((await s.post('/commit',{request_id:result.id,ok:true})).status,200);
  assert.equal((await s.request('text cannot take the SRT tab')).status,409);
  const next=s.post('/v1/chat/completions',{...srtPayload,workers:1});await waitFor(()=>messages.length===2);
  assert.equal(messages[1].freshTab,true);assert.equal(messages[1].workerId,m.workerId);
  s.dedicated.worker.tabId=124;s.dedicated.worker.state='RUNNING';s.announce();
  s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:messages[1].requestId,ok:true,content:'Next SRT'}));
  assert.equal((await (await next).json()).tab_id,124);
 }finally{await s.close();}
});

test('one pending SRT tab creation reserves its slot across stale heartbeats; known non-submission releases it',async()=>{
 const s=await setup([],srtCapabilities),messages=[];
 s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat')messages.push(m);});
 try{
  const pending=s.post('/v1/chat/completions',srtPayload);await waitFor(()=>messages.length===1);
  assert.equal((await s.health()).availableSrtSlots,0);assert.equal((await s.health()).workers.length,0);
  s.announce();assert.equal((await s.post('/v1/chat/completions',srtPayload)).status,409);
  for(const m of messages)s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:false,not_submitted:true,error:'Pool changed before tab creation'}));
  assert.equal((await pending).status,409);
  assert.equal((await s.health()).srtWorker,null);assert.equal((await s.health()).availableSrtSlots,1);assert.equal((await s.health()).activeRequests,0);
 }finally{await s.close();}
});

for(const capabilities of [['json-attachment-v1'],['json-attachment-v1','fresh-srt-tab-v1']])test('dedicated fresh-tab support is required; unavailable support never falls back to text tabs: '+capabilities.join(','),async()=>{
 const s=await setup(undefined,capabilities);let sent=0;
 s.ws.on('message',raw=>{if(JSON.parse(raw).type==='chat')sent++;});
 try{
  const r=await s.post('/v1/chat/completions',srtPayload);assert.equal(r.status,409);assert.equal((await r.json()).not_submitted,true);assert.equal(sent,0);
  const invalid=await s.post('/v1/chat/completions',{...srtPayload,composerMode:'chat'});assert.equal(invalid.status,400);
 }finally{await s.close();}
});

test('unbound failed SRT tab remains visible for review and can be released',async()=>{
 const s=await setup([],srtCapabilities);
 s.ws.on('message',raw=>{const m=JSON.parse(raw);
  if(m.type==='chat'){
   s.dedicated.worker={id:m.workerId,kind:'srt',tabId:null,state:'NEEDS_REVIEW',progress:{phase:'CREATING_TAB'}};s.announce();
   s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:false,error:'Chrome could not open the tab'}));
  }else if(m.type==='reviewReset'){
   s.dedicated.worker=null;s.announce();s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));
  }
 });
 try{
  assert.equal((await s.post('/v1/chat/completions',{...srtPayload,workers:1})).status,502);
  const h=await s.health();assert.equal(h.reviewWorkers,1);assert.equal(h.srtWorker.tabId,null);assert.equal(h.srtWorker.progress.phase,'CREATING_TAB');
  assert.equal((await s.post('/v1/chat/completions',{...srtPayload,workers:1})).status,409);
  assert.equal((await s.post('/review/reset',{})).status,200);assert.equal((await s.health()).workers.length,0);
 }finally{await s.close();}
});
test('200 text requests circulate through exactly 3 workers while one independent SRT request remains active',async()=>{
 const s=await setup(undefined,srtCapabilities);let active=0,peak=0,acks=0,srtMessage,srtSends=0;const seen=new Set();
 s.ws.on('message',raw=>{const m=JSON.parse(raw);
  if(m.type==='chat'){
   if(m.freshTab){srtMessage=m;srtSends++;return;}
   assert.notEqual(m.workerId,'srt-worker');
   active++;peak=Math.max(peak,active);seen.add(m.workerId);
   setTimeout(()=>s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'answer:'+m.messages[0].content})),m.workerId==='w1'?15:3);
  }else if(m.type==='commit'){
   if(m.requestId!==srtMessage?.requestId){active--;acks++;}s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));
  }else if(m.type==='inspect'){
   s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true,data:{passed:true}}));
  }
 });
 try{
  const srt=s.post('/v1/chat/completions',srtPayload);await waitFor(()=>!!srtMessage);
  assert.equal((await s.health()).availableSlots,3);assert.equal((await s.health()).availableSrtSlots,0);
  assert.equal((await s.post('/inspect',{kind:'preflight'})).status,200);
  assert.equal((await s.post('/v1/chat/completions',srtPayload)).status,409);
  let cursor=0;const results=new Map();
  await Promise.all([1,2,3].map(async()=>{while(cursor<200){const i=cursor++;const r=await (await s.request(String(i))).json();assert.equal(r.choices[0].message.content,'answer:'+i);results.set(i,r);assert.equal((await s.post('/commit',{request_id:r.id,ok:true})).status,200);}}));
  assert.equal(results.size,200);assert.equal(seen.size,3);assert.equal(peak,3);assert.equal(acks,200);assert.equal(srtSends,1);
  assert.equal((await s.health()).activeRequests,1);
  s.ws.send(JSON.stringify({type:'response',workerId:srtMessage.workerId,requestId:srtMessage.requestId,ok:true,content:'SRT'}));
  const result=await (await srt).json();assert.equal(result.choices[0].message.content,'SRT');
  assert.equal((await s.post('/commit',{request_id:result.id,ok:true})).status,200);assert.equal((await s.health()).availableSrtSlots,1);
 }finally{await s.close();}
});
test('inspection locks dispatch, relays reports and preserves worker progress',async()=>{
 const s=await setup();let inspection;
 s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='inspect')inspection=m;});
 try{
  const pending=s.post('/inspect',{kind:'preflight',model:'GPT-6 Astra :: high',workers:2,composerMode:'chat',temporary:true});
  for(let i=0;i<100&&!inspection;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(inspection.model,'GPT-6 Astra :: high');assert.equal(inspection.composerMode,'chat');assert.equal((await s.health()).availableSlots,0);
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

test('JSON attachments require capable extension and relay exact Work/model/timeout options',async()=>{
 const s=await setup();
 try{
  const attachment={name:'transcript-11111111-1111-1111-1111-111111111111.json',base64:Buffer.from('{"segments":[]}').toString('base64')};
  const payload={messages:[{role:'user',content:'Make SRT'}],attachment,composerMode:'work',model:'GPT-6 Astra :: High',timeout:1800000,temporary:false};
  const unsupported=await s.post('/v1/chat/completions',payload);assert.equal(unsupported.status,409);assert.equal((await unsupported.json()).not_submitted,true);
  s.ws.send(JSON.stringify({type:'pool',protocol:2,enabled:true,capabilities:['json-attachment-v1'],workers:s.workers}));
  for(let i=0;i<20&&!(await s.health()).capabilities.includes('json-attachment-v1');i++)await new Promise(r=>setTimeout(r,10));
  const received=[];
  s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat'){
   received.push(m);
   if(m.messages[0].content==='Make SRT'){
    assert.deepEqual(m.attachment,attachment);assert.equal(m.composerMode,'work');assert.equal(m.model,payload.model);assert.equal(m.timeout,1800000);assert.equal(m.temporary,false);
   }else{
    assert.equal(m.attachment,undefined);assert.equal(m.composerMode,'chat');assert.equal(m.model,'auto');assert.equal(m.temporary,true);
   }
   s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'Completed content'}));
  }else if(m.type==='commit')s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));});
  const srt=await s.post('/v1/chat/completions',payload);assert.equal(srt.status,200);
  assert.equal((await s.post('/commit',{request_id:(await srt.json()).id,ok:true})).status,200);
  const text=await s.post('/v1/chat/completions',{messages:[{role:'user',content:'Plain text'}],composerMode:'chat',temporary:true,model:'auto'});
  assert.equal(text.status,200);assert.equal(received[0].workerId,received[1].workerId);
  assert.equal((await s.post('/v1/chat/completions',{...payload,attachment:{...attachment,name:'../../bad.json'}})).status,400);
 }finally{await s.close();}
});

test('cleanup waits for save ACK, blocks new text reservations and preserves closed reusable slots',async()=>{
 const s=await setup([{id:'w1',tabId:1,state:'IDLE'}],['worker-lifecycle-v1']);const messages=[];let cleanup;
 s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat')messages.push(m);
  if(m.type==='commit')s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));
  if(m.type==='closeIdleText')cleanup=m;
 });
 try{
  const pending=s.request();await waitFor(()=>messages.length===1);
  assert.equal((await s.post('/workers/close',{})).status,409);
  const m=messages[0];s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'saved'}));
  const result=await (await pending).json();assert.equal((await s.post('/workers/close',{})).status,409);
  assert.equal((await s.post('/commit',{request_id:result.id,ok:true})).status,200);
  const closing=s.post('/workers/close',{});await waitFor(()=>!!cleanup);
  assert.equal((await s.request('during cleanup')).status,409);
  s.workers[0].tabId=null;s.announce();s.ws.send(JSON.stringify({type:'controlResult',controlId:cleanup.controlId,ok:true}));
  assert.equal((await closing).status,200);assert.equal((await s.health()).availableSlots,1);
  const next=s.request('next batch');await waitFor(()=>messages.length===2);assert.equal(messages[1].workerId,'w1');
  s.ws.send(JSON.stringify({type:'response',workerId:'w1',requestId:messages[1].requestId,ok:true,content:'next'}));assert.equal((await next).status,200);
 }finally{await s.close();}
});

test('project GPT routing verifies capability, ensures workers and forwards one text message',async()=>{
 const s=await setup(undefined,['project-urls-v1','temporary-text-session-v1','txt-prompt-attachment-v1','serialized-submission-v1','text-worker-recovery-v1']);const received=[];
 s.ws.on('message',raw=>{const m=JSON.parse(raw);received.push(m);
  if(m.type==='chat')s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'A visual prompt'}));
  else if(m.controlId)s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));
 });
 try{
  assert.equal((await s.post('/workers/ensure',{})).status,200);assert.equal(received[0].type,'ensureTextWorkers');
  const payload={messages:[{role:'user',content:'Exactly one scene'}],pageUrl:'https://chatgpt.com/g/g-channel-images',temporary:false,composerMode:'chat'};
  const r=await s.post('/v1/chat/completions',payload);assert.equal(r.status,200);
  const sent=received.find(m=>m.type==='chat');assert.equal(sent.pageUrl,payload.pageUrl);assert.deepEqual(sent.messages,payload.messages);
  const answer=await r.json();await s.post('/commit',{request_id:answer.id,ok:true});
  for(const changes of [{temporary:true},{pageUrl:'https://example.com/'},{pageUrl:'https://chatgpt.com/c/old'}]){
   const bad=await s.post('/v1/chat/completions',{...payload,...changes});assert.equal(bad.status,400);assert.equal((await bad.json()).not_submitted,true);
  }
  assert.equal(received.filter(m=>m.type==='chat').length,1);
 }finally{await s.close();}
 const old=await setup();try{assert.equal((await old.post('/workers/ensure',{})).status,409);}finally{await old.close();}
});

test('SRT preparation relays control and the prepared token reaches its dedicated request',async()=>{
 const s=await setup([], [...srtCapabilities,'srt-prepare-v1']);
 const token='11111111-1111-1111-1111-111111111111',messages=[];
 s.ws.on('message',raw=>{
  const m=JSON.parse(raw);messages.push(m);
  if(m.type==='prepareSrt')s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true,data:{token:m.token,tabId:123,windowId:456,composerMode:'work'}}));
  if(m.type==='chat')s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'boundaries'}));
 });
 try{
  const ready=await s.post('/srt/prepare',{token,pageUrl:'https://chatgpt.com/'});
  const readyBody=await ready.json();assert.equal(ready.status,200,JSON.stringify(readyBody));assert.equal(readyBody.tabId,123);
  assert.equal(messages.filter(m=>m.type==='chat').length,0);
  assert.equal((await s.post('/v1/chat/completions',{...srtPayload,preparedTabToken:token})).status,200);
  assert.equal(messages.find(m=>m.type==='chat').preparedTabToken,token);
  assert.equal((await s.post('/srt/prepare',{token,pageUrl:'https://chatgpt.com/'})).status,409);
 }finally{await s.close();}
});

test('new SRT preparation releases a failed reservation after preparation succeeds',async()=>{
 const s=await setup([], [...srtCapabilities,'srt-prepare-v1']);
 let failPrepare=true;
 s.ws.on('message',raw=>{
  const m=JSON.parse(raw);
  if(m.type==='chat')s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:false,error:'Old request failed'}));
  if(m.type==='prepareSrt')s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:!failPrepare,error:'Page loading',data:{token:m.token,tabId:123}}));
 });
 try{
  assert.equal((await s.post('/v1/chat/completions',srtPayload)).status,502);
  const body={token:'11111111-1111-1111-1111-111111111111',pageUrl:'https://chatgpt.com/'};
  assert.equal((await s.post('/srt/prepare',body)).status,409);
  assert.equal((await s.health()).srtWorker.state,'NEEDS_REVIEW');
  failPrepare=false;
  assert.equal((await s.post('/srt/prepare',body)).status,200);
  assert.equal((await s.health()).availableSrtSlots,1);
 }finally{await s.close();}
});

test('file SRT transport forwards download metadata and holds worker until backend save acknowledgment',async()=>{
 const s=await setup([], [...srtCapabilities,'srt-download-v1']);
 const nativeDownload={path:'C:/Downloads/flowkit-chatgpt/11111111-1111-1111-1111-111111111111/subtitles.srt',token:'11111111-1111-1111-1111-111111111111'};
 s.ws.on('message',raw=>{
  const m=JSON.parse(raw);
  if(m.type==='chat'){assert.equal(m.downloadSrt,true);s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'247 scenes. Audio tail unverified.',nativeDownload}));}
  if(m.type==='commit')s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));
 });
 try{
  const response=await s.post('/v1/chat/completions',{...srtPayload,downloadSrt:true});
  assert.equal(response.status,200);const body=await response.json();
  assert.deepEqual(body.nativeDownload,nativeDownload);
  assert.equal((await s.health()).srtWorker.state,'AWAITING_SAVE');
  assert.equal((await s.post('/commit',{request_id:body.id,ok:true})).status,200);
 }finally{await s.close();}
 const old=await setup([],srtCapabilities);
 try{const r=await old.post('/v1/chat/completions',{...srtPayload,downloadSrt:true});assert.equal(r.status,400);assert.equal((await r.json()).not_submitted,true);}
 finally{await old.close();}
});

test('cancel SRT targets its job ID, finishes active HTTP request and releases only its reservation',async()=>{
 const s=await setup([], [...srtCapabilities,'srt-cancel-v1']);
 const job='11111111-1111-1111-1111-111111111111',messages=[];
 s.ws.on('message',raw=>{
  const m=JSON.parse(raw);messages.push(m);
  if(m.type==='cancelSrt')s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));
 });
 try{
  const pending=s.post('/v1/chat/completions',{...srtPayload,srtJobId:job});
  await waitFor(()=>messages.some(m=>m.type==='chat'));
  const wrong=await s.post('/srt/cancel',{jobId:'22222222-2222-2222-2222-222222222222'});
  assert.equal((await wrong.json()).stopped,false);assert.equal(messages.filter(m=>m.type==='cancelSrt').length,0);
  const stopped=await s.post('/srt/cancel',{jobId:job});assert.equal(stopped.status,200);
  assert.equal((await pending).status,502);
  assert.equal(messages.find(m=>m.type==='cancelSrt').jobId,job);
  assert.equal((await s.health()).activeRequests,0);
  assert.equal((await s.health()).availableSrtSlots,1);
 }finally{await s.close();}
});

test('TXT session metadata is validated and forwarded separately from SRT text',async()=>{
 const s=await setup(undefined,['project-urls-v1','temporary-text-session-v1','txt-prompt-attachment-v1','serialized-submission-v1']),messages=[];
 s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat'){messages.push(m);s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'Scene prompt'}));}else if(m.controlId)s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));});
 const payload={messages:[{role:'user',content:'日本語のSRT行'}],pageUrl:'https://chatgpt.com/',temporary:true,composerMode:'chat',textSessionId:'11111111-1111-1111-1111-111111111111',promptTemplate:'My image instructions'};
 try{
  for(const invalid of [{temporary:false},{pageUrl:'https://chatgpt.com/g/g-custom'},{promptTemplate:''},{textSessionId:'bad'},{composerMode:'work'}])assert.equal((await s.post('/v1/chat/completions',{...payload,...invalid})).status,400);
  assert.equal(messages.length,0);
  const result=await s.post('/v1/chat/completions',payload);assert.equal(result.status,200);
  assert.equal(messages[0].promptTemplate,payload.promptTemplate);assert.equal(messages[0].textSessionId,payload.textSessionId);assert.deepEqual(messages[0].messages,payload.messages);
 }finally{await s.close();}
 const old=await setup(undefined,['project-urls-v1']);try{const r=await old.post('/v1/chat/completions',payload);assert.equal(r.status,400);assert.equal((await r.json()).not_submitted,true);}finally{await old.close();}
});

test('text preparation releases only failed reservations after recovery ACK and retains pending saves',async()=>{
 const s=await setup(undefined,['text-worker-recovery-v1','txt-prompt-attachment-v1','serialized-submission-v1']),messages=[];let failPrepare=true;
 s.ws.on('message',raw=>{const m=JSON.parse(raw);messages.push(m);
  if(m.type==='chat')s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:m.messages[0].content==='saved',content:'answer',error:'Old failure'}));
  if(m.type==='ensureTextWorkers'){
   if(!failPrepare){for(const id of m.recoverWorkers){const w=s.workers.find(w=>w.id===id);w.tabId+=100;w.state='IDLE';}s.announce();}
   s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:!failPrepare,error:'Cannot open tab'}));
  }
 });
 try{
  assert.equal((await s.request('failed')).status,502);assert.equal((await s.request('saved')).status,200);
  assert.equal((await s.post('/workers/ensure',{})).status,409);assert.equal((await s.health()).reviewWorkers,1);
  failPrepare=false;assert.equal((await s.post('/workers/ensure',{})).status,200);
  const state=await s.health();assert.equal(state.reviewWorkers,0);assert.equal(state.workers.filter(w=>w.state==='AWAITING_SAVE').length,1);
  assert.deepEqual(messages.filter(m=>m.type==='ensureTextWorkers').at(-1).recoverWorkers,['w1']);assert.equal(messages.filter(m=>m.type==='chat').length,2);
 }finally{await s.close();}
});

test('text preparation does not clear an account rate limit',async()=>{
 const s=await setup(undefined,['text-worker-recovery-v1','txt-prompt-attachment-v1','serialized-submission-v1']);let controls=0;
 s.ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='chat')s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:false,error:'Limit',code:'RATE_LIMIT'}));else controls++;});
 try{await s.request();assert.equal((await s.post('/workers/ensure',{})).status,409);assert.equal((await s.health()).needsReview,true);assert.equal(controls,0);}finally{await s.close();}
});

test('Work ZIP batches use one reserved worker and preserve download metadata until save ACK',async()=>{
 const caps=['project-urls-v1','temporary-text-session-v1','txt-prompt-attachment-v1','serialized-submission-v1','text-worker-recovery-v1','work-prompt-zip-v1'];
 const s=await setup([{id:'w1',tabId:1,state:'IDLE'}],caps),messages=[];
 s.ws.on('message',raw=>{const m=JSON.parse(raw);messages.push(m);
  if(m.type==='chat')s.ws.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,ok:true,content:'image_prompts.zip',nativeDownload:{path:'/downloads/prompts.zip',token:'token'}}));
  else if(m.controlId)s.ws.send(JSON.stringify({type:'controlResult',controlId:m.controlId,ok:true}));
 });
 const payload={messages:[{role:'user',content:'001 First\n\n002 Second'}],workers:1,pageUrl:'https://chatgpt.com/',temporary:false,composerMode:'work',downloadPromptZip:true,textSessionId:'11111111-1111-1111-1111-111111111111',promptTemplate:'Create ZIP',timeout:1800000};
 try{
  assert.equal((await s.post('/workers/ensure',{workers:1})).status,200);assert.equal(messages[0].workerCount,1);
  for(const wrong of [{workers:3},{composerMode:'chat'},{temporary:true}])assert.equal((await s.post('/v1/chat/completions',{...payload,...wrong})).status,400);
  const result=await (await s.post('/v1/chat/completions',payload)).json();assert.equal(result.nativeDownload.token,'token');assert.equal(messages.find(m=>m.type==='chat').downloadPromptZip,true);
  assert.equal(messages.find(m=>m.type==='chat').timeout,1800000);
  assert.equal((await s.post('/v1/chat/completions',payload)).status,409);
  await s.post('/commit',{request_id:result.id,ok:true});assert.equal((await s.health()).availableSlots,1);
 }finally{await s.close();}
});
