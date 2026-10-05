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
 if(result.not_submitted)held.delete(r.worker.id);else held.set(r.worker.id,{requestId:id,worker:r.worker,jobId:r.jobId,state:result.ok?'AWAITING_SAVE':'NEEDS_REVIEW'});
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
 if(req.url==='/srt/cancel'){
  if(typeof p.jobId!=='string'||!/^[a-f0-9-]{36}$/.test(p.jobId))return json(res,400,{error:'Invalid SRT job ID'});
  const current=[...active.entries()].find(([,r])=>isSrt(r.worker)&&r.jobId===p.jobId);
  const reservation=held.get(SRT_WORKER_ID);
  if(!current&&reservation?.jobId!==p.jobId)return json(res,200,{ok:true,stopped:false});
  if(!capabilities.includes('srt-cancel-v1'))return json(res,409,{error:'Reload ChatGPT Bridge 1.10.1 to stop the running SRT job.'});
  const requestId=current?.[0]||reservation.requestId;
  try{
   await control('cancelSrt',{requestId,jobId:p.jobId},15000);
   if(active.has(requestId))finish(requestId,{ok:false,cancelled:true,error:'SRT job stopped by user'});
   if(held.get(SRT_WORKER_ID)?.requestId===requestId)held.delete(SRT_WORKER_ID);
   return json(res,200,{ok:true,stopped:true});
  }catch(error){return json(res,409,{error:error.message});}
 }
 if(req.url==='/srt/prepare'){
  if(!enabled)return json(res,409,{error:'Turn on the ChatGPT extension before opening SRT.'});
  if(accountPaused)return json(res,409,{error:'ChatGPT reported an account rate limit. Wait and resume after the limit clears.'});
  if([...active.values()].some(r=>isSrt(r.worker))||pool().some(w=>isSrt(w)&&!['IDLE','NEEDS_REVIEW'].includes(w.state)))return json(res,409,{error:'An SRT request is still running or saving. Wait for it to finish.'});
  if(!capabilities.includes('srt-prepare-v1'))return json(res,409,{error:'Reload ChatGPT Bridge 1.9.1 or later to open SRT immediately.'});
  if(typeof p.token!=='string'||!/^[a-f0-9-]{36}$/.test(p.token))return json(res,400,{error:'Invalid preparation token'});
  try{
   const result=await control('prepareSrt',{token:p.token,pageUrl:p.pageUrl},120000);
   // Clear only the inactive failed SRT reservation, after the new tab is ready.
   if(held.get(SRT_WORKER_ID)?.state==='NEEDS_REVIEW')held.delete(SRT_WORKER_ID);
   return json(res,200,result.data);
  }
  catch(e){return json(res,409,{error:e.message});}
 }
 if(req.url==='/workers/ensure'){
  if(p.workers===1&&(!capabilities.includes('work-prompt-zip-v1')||!capabilities.includes('verified-send-v1')))return json(res,409,{error:'Reload ChatGPT Bridge 1.12.1 for the single Work tab and prompt ZIP batches.'});
  if(!capabilities.includes('text-worker-recovery-v1')||!capabilities.includes('txt-prompt-attachment-v1')||!capabilities.includes('serialized-submission-v1'))return json(res,409,{error:'Reload ChatGPT Bridge 1.11.4 for coordinated text tab submission.'});
  if(!enabled)return json(res,409,{error:'Turn on the ChatGPT extension before creating prompts.'});
  if(accountPaused)return json(res,409,{error:'ChatGPT reported an account rate limit. Wait and resume after the limit clears.'});
  if(textCleanupActive||inspectionActive||extensionInspecting)return json(res,409,{error:'Text tab preparation or inspection is in progress. Try again when it finishes.'});
  const recover=pool().filter(w=>!isSrt(w)&&w.state==='NEEDS_REVIEW'&&![...active.values()].some(r=>r.worker.id===w.id));
  const reservations=new Map(recover.map(w=>[w.id,held.get(w.id)]));
  textCleanupActive=true;
  try{
   await control('ensureTextWorkers',{recoverWorkers:recover.map(w=>w.id),workerCount:p.workers===1?1:3},10000);
   for(const [id,reservation] of reservations)if(reservation&&held.get(id)===reservation&&reservation.state==='NEEDS_REVIEW')held.delete(id);
   return json(res,200,{ok:true});
  }catch(e){return json(res,409,{error:e.message});}finally{textCleanupActive=false;}
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
 if(p.downloadPromptZip===true&&(!p.textSessionId||p.composerMode!=='work'||p.temporary!==false||p.workers!==1||!capabilities.includes('work-prompt-zip-v1')||!capabilities.includes('verified-send-v1')))return json(res,400,{error:'Prompt ZIP batches require one Work worker and Bridge 1.12.1.',not_submitted:true});
 if(p.textSessionId!==undefined){
  if(typeof p.textSessionId!=='string'||!/^[a-f0-9-]{36}$/.test(p.textSessionId)||typeof p.promptTemplate!=='string'||!p.promptTemplate.trim()||p.promptTemplate.length>100000||(p.downloadPromptZip===true?(p.temporary!==false||p.composerMode!=='work'):(p.temporary!==true||p.composerMode!=='chat'))||p.freshTab||p.attachment)return json(res,400,{error:'Invalid text conversation session',not_submitted:true});
  if(!capabilities.includes('temporary-text-session-v1')||!capabilities.includes('txt-prompt-attachment-v1')||!capabilities.includes('serialized-submission-v1'))return json(res,400,{error:'Reload ChatGPT Bridge 1.11.4 for coordinated text tab submission.',not_submitted:true});
 }
 if(p.pageUrl!==undefined){
  try{const u=new URL(p.pageUrl);if(u.origin!=='https://chatgpt.com'||u.username||u.password||u.hash||!(u.pathname==='/'||/^\/g\/g-[A-Za-z0-9_-]+\/?$/.test(u.pathname)))throw Error();
   if(u.pathname.startsWith('/g/')&&(p.temporary!==false||p.attachment))throw Error();
  }catch{return json(res,400,{error:'Use a ChatGPT home or GPT URL; GPT requests require regular text-only chat.',not_submitted:true});}
  if(!capabilities.includes('project-urls-v1'))return json(res,400,{error:'Reload ChatGPT Bridge for project URLs.',not_submitted:true});
 }
 if(p.preparedTabToken!==undefined&&(!p.freshTab||typeof p.preparedTabToken!=='string'||!/^[a-f0-9-]{36}$/.test(p.preparedTabToken)||!capabilities.includes('srt-prepare-v1')))return json(res,400,{error:'Invalid or unsupported prepared SRT tab.',not_submitted:true});
 if(p.downloadSrt===true&&(!p.freshTab||!capabilities.includes('srt-download-v1')))return json(res,400,{error:'Reload ChatGPT Bridge 1.10.0 with Downloads permission.',not_submitted:true});
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
 const requestId=randomUUID(),timeout=Math.min((p.attachment||p.downloadPromptZip===true)?1800000:600000,Math.max(30000,Number(p.timeout)||180000));
 held.set(worker.id,{requestId,worker,jobId:p.srtJobId,state:'RUNNING'});
 const result=await new Promise(resolve=>{
  const timer=setTimeout(()=>fail(requestId,'Response deadline exceeded; review the worker tab.'),timeout+(p.attachment?1050000:660000));
  active.set(requestId,{resolve,timer,worker,jobId:p.srtJobId});
  res.on('close',()=>{if(!res.writableEnded)fail(requestId,'Client disconnected; submission may have completed.');});
  try{send({type:'chat',requestId,workerId:worker.id,messages:p.messages,model:p.model||'auto',timeout,temporary:p.temporary!==false,attachment:p.attachment,composerMode:p.composerMode,freshTab:p.freshTab===true,preparedTabToken:p.preparedTabToken,pageUrl:p.pageUrl,downloadSrt:p.downloadSrt===true,downloadPromptZip:p.downloadPromptZip===true,srtJobId:p.srtJobId,textSessionId:p.textSessionId,promptTemplate:p.promptTemplate});}catch(e){fail(requestId,e.message);}
 });
 if(result.not_submitted)return json(res,409,result);
 if(!result.ok)return json(res,502,result);
 json(res,200,{id:requestId,worker_id:worker.id,tab_id:result.tab_id,conversation_url:result.conversation_url,nativeDownload:result.nativeDownload,choices:[{message:{role:'assistant',content:result.content},finish_reason:'stop'}]});
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
   capabilities=Array.isArray(m.capabilities)?m.capabilities.filter(x=>['json-attachment-v1','fresh-srt-tab-v1','dedicated-srt-v1','worker-lifecycle-v1','project-urls-v1','srt-prepare-v1','srt-download-v1','srt-cancel-v1','temporary-text-session-v1','text-worker-recovery-v1','txt-prompt-attachment-v1','serialized-submission-v1','work-prompt-zip-v1','verified-send-v1'].includes(x)):[];
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
