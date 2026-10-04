// Flowkit multi-tab relay, adapted from Draivix/chatgpt-gateway (MIT).
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
const port=Number(process.env.CHATGPT_GATEWAY_PORT||18790);
let capabilities=[], extension=null, workers=[], enabled=false, accountPaused=false,inspectionActive=false,extensionInspecting=false,textCleanupActive=false;
const active=new Map(), held=new Map(), controls=new Map();
const SRT_WORKER_ID='srt-worker';
const isSrt=w=>w.kind==='srt';
const json=(res,status,body)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}};
const send=m=>{if(extension?.readyState!==1)throw Error('Extension disconnected');extension.send(JSON.stringify(m));};
function pool(){
 // Include reservations whose new tab is still being created. A pool announcement
 // without that tab must not erase its dedicated reservation.
 const combined=new Map(workers.map(w=>[w.id,w]));
 for(const [id,h] of held)if(!combined.has(id)&&h.worker)combined.set(id,h.worker);
 return [...combined.values()].map(w=>({...w,state:held.get(w.id)?.state || w.state}));
}
function finish(id,result){const r=active.get(id);if(!r)return;clearTimeout(r.timer);active.delete(id);
 r.worker=workers.find(w=>w.id===r.worker.id)||r.worker;
 if(result.not_submitted)held.delete(r.worker.id);else held.set(r.worker.id,{requestId:id,worker:r.worker,state:result.ok?'AWAITING_SAVE':'NEEDS_REVIEW'});
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
  const ws=pool(),text=ws.filter(w=>!isSrt(w)),srtWorker=ws.find(isSrt)||null;
  const ready=enabled&&!accountPaused&&!inspectionActive&&!extensionInspecting;
  return json(res,200,{service:'flowkit-chatgpt-gateway',protocol:2,capabilities,extensionConnected:extension?.readyState===1,enabled,inspecting:inspectionActive||extensionInspecting,workers:text,srtWorker,availableSlots:ready?text.filter(w=>w.state==='IDLE').length:0,availableSrtSlots:ready&&capabilities.includes('dedicated-srt-v1')&&(!srtWorker||srtWorker.state==='IDLE')?1:0,busy:active.size>0,activeRequests:active.size,needsReview:accountPaused,reviewWorkers:ws.filter(w=>w.state==='NEEDS_REVIEW').length});
 }
 let p={};try{let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>24*1024*1024)return json(res,413,{error:'Request too large'});}if(body)p=JSON.parse(body);}catch{return json(res,400,{error:'Invalid JSON'});}
 if(!p||typeof p!=='object'||Array.isArray(p))return json(res,400,{error:'Expected a JSON object'});
 if(req.method!=='POST')return json(res,404,{error:'Not found'});
 if(req.url==='/inspect'){
  if(!['discoverModels','preflight'].includes(p.kind))return json(res,400,{error:'Unknown inspection type'});
  if(p.composerMode!==undefined&&!['chat','work'].includes(p.composerMode))return json(res,400,{error:'Invalid composer mode'});
  if(inspectionActive||extensionInspecting||[...active.values(),...held.values()].some(r=>!isSrt(r.worker)))return json(res,409,{error:'Pause the text queue and finish or review text worker jobs before inspection'});
  inspectionActive=true;
  try{return json(res,200,(await control('inspect',{kind:p.kind,model:p.model||'auto',composerMode:p.composerMode,temporary:p.temporary!==false,workers:p.workers},20000)).data);}
  catch(e){return json(res,409,{error:e.message});}finally{inspectionActive=false;}
 }
 if(req.url==='/review/reset'){
  if(inspectionActive||extensionInspecting)return json(res,409,{error:'Inspection in progress'});
  if(active.size)return json(res,409,{error:'Requests still active'});
  try{await control('reviewReset');held.clear();accountPaused=false;return json(res,200,{ok:true});}catch(e){return json(res,409,{error:e.message});}
 }
 if(req.url==='/workers/ensure'){
  if(!capabilities.includes('project-urls-v1'))return json(res,409,{error:'Reload ChatGPT Bridge for project URLs.'});
  try{await control('ensureTextWorkers');return json(res,200,{ok:true});}catch(e){return json(res,409,{error:e.message});}
 }
 if(req.url==='/workers/close'){
  if(!capabilities.includes('worker-lifecycle-v1'))return json(res,200,{ok:true,skipped:true});
  if(textCleanupActive||inspectionActive||extensionInspecting||[...active.values(),...held.values()].some(r=>!isSrt(r.worker)))return json(res,409,{error:'Text workers still busy or require review'});
  textCleanupActive=true;
  try{await control('closeIdleText',{},10000);return json(res,200,{ok:true});}
  catch(e){return json(res,409,{error:e.message});}finally{textCleanupActive=false;}
 }
 if(req.url==='/commit'){
  const pair=[...held].find(([,h])=>h.requestId===p.request_id);
  if(!pair)return json(res,409,{error:'Unknown request reservation'});
  const [workerId]=pair;
  try{await control('commit',{requestId:p.request_id,ok:p.ok===true});
   if(p.ok===true)held.delete(workerId);else held.set(workerId,{...pair[1],state:'NEEDS_REVIEW'});
   return json(res,200,{ok:true});
  }catch(e){return json(res,409,{error:e.message});}
 }
 if(req.url!=='/v1/chat/completions')return json(res,404,{error:'Not found'});
 if(p.pageUrl!==undefined){
  try{const u=new URL(p.pageUrl);if(u.origin!=='https://chatgpt.com'||u.username||u.password||u.hash||!(u.pathname==='/'||/^\/g\/g-[A-Za-z0-9_-]+\/?$/.test(u.pathname)))throw Error();
   if(u.pathname.startsWith('/g/')&&(p.temporary!==false||p.attachment))throw Error();
  }catch{return json(res,400,{error:'Use a ChatGPT home or GPT URL; GPT requests require regular text-only chat.',not_submitted:true});}
  if(!capabilities.includes('project-urls-v1'))return json(res,400,{error:'Reload ChatGPT Bridge for project URLs.',not_submitted:true});
 }
 if(p.stream)return json(res,400,{error:'Streaming not supported'});
 if(!Array.isArray(p.messages)||p.messages.length!==1||p.messages[0].role!=='user'||typeof p.messages[0].content!=='string'||!p.messages[0].content.trim())return json(res,400,{error:'Exactly one non-empty user message required'});
 if(p.composerMode!==undefined&&!['chat','work'].includes(p.composerMode))return json(res,400,{error:'Invalid composer mode',not_submitted:true});
 if(p.freshTab!==undefined&&typeof p.freshTab!=='boolean')return json(res,400,{error:'Invalid freshTab option',not_submitted:true});
 if(p.freshTab&&(!p.attachment||p.composerMode!=='work'||p.temporary!==false))return json(res,400,{error:'Fresh SRT tabs require JSON, Work and Temporary OFF',not_submitted:true});
 if(p.attachment!==undefined){
  const a=p.attachment;
  if(!a||typeof a.name!=='string'||!/^transcript-[a-f0-9-]{36}\.json$/.test(a.name)||typeof a.base64!=='string'||a.base64.length>Math.ceil(16*1024*1024/3)*4||!a.base64.length||(a.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(a.base64)))return json(res,400,{error:'Invalid JSON attachment',not_submitted:true});
  if(!capabilities.includes('json-attachment-v1'))return json(res,409,{error:'Reload the updated ChatGPT extension for JSON attachments.',not_submitted:true});
 }
 if(p.freshTab&&!capabilities.includes('fresh-srt-tab-v1'))return json(res,409,{error:'Restart the updated gateway and reload ChatGPT Bridge for automatic SRT tabs.',not_submitted:true});
 if(p.freshTab&&!capabilities.includes('dedicated-srt-v1'))return json(res,409,{error:'Reload ChatGPT Bridge 1.8.0 or later for the dedicated SRT worker.',not_submitted:true});
 if(extension?.readyState!==1)return json(res,503,{error:'Connect the ChatGPT extension first',not_submitted:true});
 const limit=p.freshTab?1:Math.max(1,Math.min(3,Number(p.workers)||3));
 const current=pool();
 const srt=current.find(isSrt);
 const worker=p.freshTab?(srt?.state==='IDLE'?srt:!srt?{id:SRT_WORKER_ID,kind:'srt',tabId:null,state:'IDLE'}:null):current.filter(w=>!isSrt(w)).slice(0,limit).find(w=>w.state==='IDLE');
 const running=[...active.values()].filter(r=>isSrt(r.worker)===!!p.freshTab).length;
 if((textCleanupActive&&!p.freshTab)||inspectionActive||extensionInspecting||!enabled||accountPaused||!worker||running>=limit)return json(res,409,{error:'No available worker or account paused',not_submitted:true});
 const requestId=randomUUID(),timeout=Math.min(p.attachment?1800000:600000,Math.max(30000,Number(p.timeout)||180000));
 held.set(worker.id,{requestId,worker,state:'RUNNING'});
 const result=await new Promise(resolve=>{
  const timer=setTimeout(()=>fail(requestId,'Response deadline exceeded; review the worker tab.'),timeout+(p.attachment?210000:65000));
  active.set(requestId,{resolve,timer,worker});
  res.on('close',()=>{if(!res.writableEnded)fail(requestId,'Client disconnected; submission may have completed.');});
  try{send({type:'chat',requestId,workerId:worker.id,messages:p.messages,model:p.model||'auto',timeout,temporary:p.temporary!==false,attachment:p.attachment,composerMode:p.composerMode,freshTab:p.freshTab===true,pageUrl:p.pageUrl});}catch(e){fail(requestId,e.message);}
 });
 if(result.not_submitted)return json(res,409,result);
 if(!result.ok)return json(res,502,result);
 json(res,200,{id:requestId,worker_id:worker.id,tab_id:result.tab_id,conversation_url:result.conversation_url,choices:[{message:{role:'assistant',content:result.content},finish_reason:'stop'}]});
});
const wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
server.on('upgrade',(req,socket,head)=>{
 const origin=req.headers.origin||'';
 if(req.url!=='/ws'||(origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)))return socket.destroy();
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
});
wss.on('connection',ws=>{
 if(extension?.readyState===1){ws.close(1008,'Only one extension connection allowed');return;}
 extension=ws;workers=[];enabled=false;capabilities=[];
 ws.on('message',raw=>{
  let m;try{m=JSON.parse(raw);}catch{return;}
  if(m.type==='pool'&&m.protocol===2){
   capabilities=Array.isArray(m.capabilities)?m.capabilities.filter(x=>['json-attachment-v1','fresh-srt-tab-v1','dedicated-srt-v1','worker-lifecycle-v1','project-urls-v1'].includes(x)):[];
   const seen=new Set(),ids=new Set();workers=(Array.isArray(m.workers)?m.workers:[]).filter(w=>{
    if(!w||typeof w.id!=='string'||w.id===SRT_WORKER_ID||w.kind==='srt'||(!Number.isInteger(w.tabId)&&w.tabId!==null)||ids.has(w.id))return false;
    if(w.tabId!==null&&seen.has(w.tabId))return false;
    ids.add(w.id);if(w.tabId!==null)seen.add(w.tabId);return true;
   }).slice(0,3).map(w=>({...w,kind:'text'}));
   const s=m.srtWorker;
   if(capabilities.includes('dedicated-srt-v1')&&s?.id===SRT_WORKER_ID&&(s.tabId===null||Number.isInteger(s.tabId)&&!seen.has(s.tabId)))workers.push({...s,kind:'srt'});
   enabled=m.enabled===true;extensionInspecting=m.inspecting===true;
  }else if(m.type==='response'&&active.get(m.requestId)?.worker.id===m.workerId)finish(m.requestId,m);
  else if(m.type==='controlResult')controls.get(m.controlId)?.resolve(m);
 });
 ws.on('close',()=>{if(extension!==ws)return;extension=null;enabled=false;extensionInspecting=false;for(const id of [...active.keys()])fail(id,'Extension disconnected; review worker tab.');for(const c of [...controls.values()])c.resolve({ok:false,error:'Extension disconnected'});});
});
server.listen(port,'127.0.0.1',()=>console.log(`Flowkit ChatGPT pool gateway on 127.0.0.1:${port}`));
