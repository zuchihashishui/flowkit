import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import net from 'node:net';

test('real HTTP/WS relay: serialization, disconnect pause, recovery, origin boundary',async()=>{
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,CHATGPT_GATEWAY_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let ws;
 try{
  await once(child.stdout,'data');
  const base=`http://127.0.0.1:${port}`;
  const send=()=>fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:'test'}]})});
  assert.equal((await send()).status,503);
  ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);await once(ws,'open');
  const incoming=once(ws,'message');const pending=send();const [raw]=await incoming;const msg=JSON.parse(raw);
  assert.equal((await send()).status,409);
  ws.send(JSON.stringify({type:'response',requestId:'wrong-id',ok:true,content:'wrong'}));
  ws.send(JSON.stringify({type:'response',requestId:msg.requestId,ok:true,content:'correct'}));
  const result=await (await pending).json();assert.equal(result.choices[0].message.content,'correct');
  const next=once(ws,'message');const lost=send();await next;ws.close();
  assert.equal((await lost).status,502);
  assert.equal((await (await fetch(base+'/health')).json()).needsReview,true);
  assert.equal((await fetch(base+'/review/reset',{method:'POST',headers:{Origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(base+'/review/reset',{method:'POST'})).status,200);
 }finally{ws?.terminate();child.kill();await once(child,'exit');}
});
