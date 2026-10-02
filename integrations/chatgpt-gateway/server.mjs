// Flowkit multi-tab relay, adapted from Draivix/chatgpt-gateway (MIT).
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
const port=Number(process.env.CHATGPT_GATEWAY_PORT||18790);
let extension=null, workers=[], enabled=false, accountPaused=false,inspectionActive=false,extensionInspecting=false;
const active=new Map(), held=new Map(), controls=new Map();
const json=(res,status,body)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}};
const send=m=>{if(extension?.readyState!==1)throw Error('Extension disconnected');extension.send(JSON.stringify(m));};
function pool(){return workers.map(w=>({...w,state:held.get(w.id)?.state || w.state}));}
function finish(id,result){const r=active.get(id);if(!r)return;clearTimeout(r.timer);active.delete(id);
 if(result.not_submitted)held.delete(r.worker.id);else held.set(r.worker.id,{requestId:id,state:result.ok?'AWAITING_SAVE':'NEEDS_REVIEW'});
 if(result.code==='RATE_LIMIT')accountPaused=true;
 r.resolve({...result,request_id:id,worker_id:r.worker.id,tab_id:r.worker.tabId});}
function fail(id,error){finish(id,{ok:false,error,uncertain:true});try{send({type:'quarantine',requestId:id});}catch{}}
function control(type,body={},timeout=5000){return new Promise((resolve,reject)=>{
 const controlId=randomUUID(),timer=setTimeout(()=>{controls.delete(controlId);reject(Error('Extension control timed out'));},timeout);
 controls.set(controlId,{resolve:r=>{clearTimeout(timer);controls.delete(controlId);r.ok?resolve(r):reject(Error(r.error));}});
 try{send({type,controlId,...body});}catch(e){clearTimeout(timer);controls.delete(controlId);reject(e);}
});}
const server=createServer(async(req,res)=>{
 if(req.headers.origin)return json(res,403,{error:'Browser HTTP origins are not allowed'});
 if(req.method==='GET'&&req.url==='/health'){
  const ws=pool(),idle=enabled&&!accountPaused&&!inspectionActive&&!extensionInspecting?ws.filter(w=>w.state==='IDLE').length:0;
  return json(res,200,{service:'flowkit-chatgpt-gateway',protocol:2,extensionConnected:extension?.readyState===1,enabled,inspecting:inspectionActive||extensionInspecting,workers:ws,availableSlots:idle,busy:active.size>0,activeRequests:active.size,needsReview:accountPaused,reviewWorkers:ws.filter(w=>w.state==='NEEDS_REVIEW').length});
 }
 let p={};try{let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>256*1024)return json(res,413,{error:'Prompt too large'});}if(body)p=JSON.parse(body);}catch{return json(res,400,{error:'Invalid JSON'});}
 if(!p||typeof p!=='object'||Array.isArray(p))return json(res,400,{error:'Expected a JSON object'});
 if(req.method!=='POST')return json(res,404,{error:'Not found'});
 if(req.url==='/inspect'){
  if(!['discoverModels','preflight'].includes(p.kind))return json(res,400,{error:'Unknown inspection type'});
  if(inspectionActive||extensionInspecting||active.size||held.size)return json(res,409,{error:'Pause the queue and finish or review worker jobs before inspection'});
  inspectionActive=true;
  try{return json(res,200,(await control('inspect',{kind:p.kind,model:p.model||'auto',temporary:p.temporary!==false,workers:p.workers},20000)).data);}
  catch(e){return json(res,409,{error:e.message});}finally{inspectionActive=false;}
 }
 if(req.url==='/review/reset'){
  if(inspectionActive||extensionInspecting)return json(res,409,{error:'Inspection in progress'});
  if(active.size)return json(res,409,{error:'Requests still active'});
  try{await control('reviewReset');held.clear();accountPaused=false;return json(res,200,{ok:true});}catch(e){return json(res,409,{error:e.message});}
 }
 if(req.url==='/commit'){
  const pair=[...held].find(([,h])=>h.requestId===p.request_id);
  if(!pair)return json(res,409,{error:'Unknown request reservation'});
  const [workerId]=pair;
  try{await control('commit',{requestId:p.request_id,ok:p.ok===true});
   if(p.ok===true)held.delete(workerId);else held.set(workerId,{requestId:p.request_id,state:'NEEDS_REVIEW'});
   return json(res,200,{ok:true});
  }catch(e){return json(res,409,{error:e.message});}
 }
 if(req.url!=='/v1/chat/completions')return json(res,404,{error:'Not found'});
 if(p.stream)return json(res,400,{error:'Streaming not supported'});
 if(!Array.isArray(p.messages)||p.messages.length!==1||p.messages[0].role!=='user'||typeof p.messages[0].content!=='string'||!p.messages[0].content.trim())return json(res,400,{error:'Exactly one non-empty user message required'});
 if(extension?.readyState!==1)return json(res,503,{error:'Connect the ChatGPT extension first',not_submitted:true});
 const limit=Math.max(1,Math.min(3,Number(p.workers)||3));
 const worker=pool().slice(0,limit).find(w=>w.state==='IDLE');
 if(inspectionActive||extensionInspecting||!enabled||accountPaused||!worker)return json(res,409,{error:'No available worker or account paused',not_submitted:true});
 const requestId=randomUUID(),timeout=Math.min(600000,Math.max(30000,Number(p.timeout)||180000));
 held.set(worker.id,{requestId,state:'RUNNING'});
 const result=await new Promise(resolve=>{
  const timer=setTimeout(()=>fail(requestId,'Response deadline exceeded; review the worker tab.'),timeout+65000);
  active.set(requestId,{resolve,timer,worker});
  res.on('close',()=>{if(!res.writableEnded)fail(requestId,'Client disconnected; submission may have completed.');});
  try{send({type:'chat',requestId,workerId:worker.id,messages:p.messages,model:p.model||'auto',timeout,temporary:p.temporary!==false});}catch(e){fail(requestId,e.message);}
 });
 if(result.not_submitted)return json(res,409,result);
 if(!result.ok)return json(res,502,result);
 json(res,200,{id:requestId,worker_id:worker.id,tab_id:worker.tabId,conversation_url:result.conversation_url,choices:[{message:{role:'assistant',content:result.content},finish_reason:'stop'}]});
});
const wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
server.on('upgrade',(req,socket,head)=>{
 const origin=req.headers.origin||'';
 if(req.url!=='/ws'||(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)))return socket.destroy();
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
});
wss.on('connection',ws=>{
 if(extension?.readyState===1){ws.close(1008,'Only one extension connection allowed');return;}
 extension=ws;workers=[];enabled=false;
 ws.on('message',raw=>{
  let m;try{m=JSON.parse(raw);}catch{return;}
  if(m.type==='pool'&&m.protocol===2){
   const seen=new Set(),ids=new Set();workers=(Array.isArray(m.workers)?m.workers:[]).filter(w=>w&&typeof w.id==='string'&&Number.isInteger(w.tabId)&&!seen.has(w.tabId)&&!ids.has(w.id)&&seen.add(w.tabId)&&ids.add(w.id)).slice(0,3);enabled=m.enabled===true;extensionInspecting=m.inspecting===true;
  }else if(m.type==='response'&&active.get(m.requestId)?.worker.id===m.workerId)finish(m.requestId,m);
  else if(m.type==='controlResult')controls.get(m.controlId)?.resolve(m);
 });
 ws.on('close',()=>{if(extension!==ws)return;extension=null;enabled=false;extensionInspecting=false;for(const id of [...active.keys()])fail(id,'Extension disconnected; review worker tab.');for(const c of [...controls.values()])c.resolve({ok:false,error:'Extension disconnected'});});
});
server.listen(port,'127.0.0.1',()=>console.log(`Flowkit ChatGPT pool gateway on 127.0.0.1:${port}`));
