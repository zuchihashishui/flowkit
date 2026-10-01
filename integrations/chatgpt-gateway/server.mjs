// Adapted from Draivix/chatgpt-gateway (MIT). One in-flight request, loopback only.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
const port = Number(process.env.CHATGPT_GATEWAY_PORT || 18790);
let extension = null, active = null, uncertain = false;
const json = (res, status, body) => {if (!res.destroyed) {res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(body));}};
function fail(message) {if(active){uncertain=true;active.finish({ok:false,error:message,uncertain:true});}}
const server = createServer(async(req,res)=>{
  if(req.headers.origin) return json(res,403,{error:'Browser HTTP origins are not allowed'});
  if(req.method==='GET' && req.url==='/health') return json(res,200,{service:'flowkit-chatgpt-gateway',protocol:1,extensionConnected:extension?.readyState===1,busy:!!active,needsReview:uncertain});
  if(req.method==='POST' && req.url==='/review/reset') {if(active)return json(res,409,{error:'Request still active'});uncertain=false;return json(res,200,{ok:true});}
  if(req.method!=='POST'||req.url!=='/v1/chat/completions')return json(res,404,{error:'Not found'});
  let body='';
  try {for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>128*1024)return json(res,413,{error:'Prompt too large'});}}
  catch{return;}
  let p;try{p=JSON.parse(body);}catch{return json(res,400,{error:'Invalid JSON'});}
  if(p.stream)return json(res,400,{error:'Streaming is not supported by this adapter'});
  if(!Array.isArray(p.messages)||p.messages.length!==1||p.messages[0].role!=='user'||typeof p.messages[0].content!=='string'||!p.messages[0].content.trim())return json(res,400,{error:'Exactly one non-empty user message required'});
  if(active||uncertain)return json(res,409,{error:'Gateway busy or needs review',uncertain});
  if(extension?.readyState!==1)return json(res,503,{error:'Connect the ChatGPT extension first'});
  const requestId=randomUUID(), peer=extension;
  const timeout=Math.min(600000,Math.max(10000,Number(p.timeout)||180000));
  const result=await new Promise(resolve=>{
    const timer=setTimeout(()=>fail('Timed out. Check ChatGPT before resuming.'),timeout+5000);
    active={requestId,peer,finish:r=>{clearTimeout(timer);active=null;resolve(r);}};
    res.on('close',()=>{if(!res.writableEnded && active?.requestId===requestId)fail('Client disconnected; submission may have completed.');});
    try{peer.send(JSON.stringify({type:'chat',requestId,messages:p.messages,model:p.model||'auto',timeout,newConversation:true}));}
    catch{fail('Extension send failed');}
  });
  if(!result.ok)return json(res,502,{...result,request_id:requestId});
  json(res,200,{id:requestId,conversation_url:result.conversation_url,choices:[{message:{role:'assistant',content:result.content},finish_reason:'stop'}]});
});
const wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
server.on('upgrade',(req,socket,head)=>{
  const origin=req.headers.origin||'';
  if(req.url!=='/ws'||(origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)))return socket.destroy();
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
});
wss.on('connection',ws=>{
  if(extension?.readyState===1){ws.close(1008,'Only one extension connection allowed');return;}
  extension=ws;
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw);}catch{return;}
    if(m.type==='response'&&active?.peer===ws&&m.requestId===active.requestId){
      if(!m.ok)uncertain=true;
      active.finish(m);
    }
  });
  ws.on('close',()=>{if(extension===ws){extension=null;fail('Extension disconnected. Check the conversation before resuming.');}});
});
server.listen(port,'127.0.0.1',()=>console.log(`Flowkit ChatGPT gateway listening on 127.0.0.1:${port}`));
