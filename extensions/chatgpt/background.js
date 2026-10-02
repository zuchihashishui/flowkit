// Fixed worker pool. One extension socket, up to three independent tabs.
let ws,enabled=true,composerMode='chat',modelPreference='auto',workers=[],initialized=false,configuring=false,lastError='',lastRequest='',completed=0;
const executing=new Set(),events=[];
const record=message=>{events.unshift({time:new Date().toISOString(),message});events.splice(50);};
const transmit=m=>{if(ws?.readyState===1)ws.send(JSON.stringify(m));};
let inspecting=false,lastInspection=null,modelCatalog=null;
function inspectMessage(tabId,message){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Tab inspection timed out; refresh the tab')),5000);chrome.tabs.sendMessage(tabId,message).then(r=>{clearTimeout(timer);resolve(r);},e=>{clearTimeout(timer);reject(e);});});}
const phases=new Set(['OPENING_TAB','SELECTING_MODE','ENABLING_TEMPORARY','SELECTING_MODEL','TYPING','SENDING','WAITING_RESPONSE','GENERATING','WORKING','THINKING','USING_TOOLS','VERIFYING_COMPLETION','WAITING_COMPLETION']);
async function inspectTabs(kind,options={}) {
 if(inspecting||configuring||executing.size||workers.some(w=>w.state!=='IDLE'))throw Error('Pause the queue and finish or review all worker jobs before checking tabs.');
 const limit=Math.max(1,Math.min(3,Number(options.workers)||3));
 if(!workers.length)throw Error('Assign worker tabs first.');
 inspecting=true;announce();
 const reports=[];
 try{
  const selected=kind==='discoverModels'?workers.slice(0,1):workers.slice(0,limit);
  for(const w of selected){
   try{
    const tab=await chrome.tabs.get(w.tabId);if(!tab.url?.startsWith('https://chatgpt.com/'))throw Error('Worker tab must be on ChatGPT');
    const model=options.model==='extension'?modelPreference:(options.model||'auto');
    const r=await inspectMessage(w.tabId,{type:kind,composerMode,model,temporary:options.temporary!==false});
    if(!r?.ok)throw Error(r?.error||'No response; refresh the ChatGPT tab');
    reports.push({workerId:w.id,tabId:w.tabId,...r.data});
   }catch(e){reports.push({workerId:w.id,tabId:w.tabId,passed:false,error:e.message});}
  }
  if(kind==='discoverModels'){
   if(reports[0].error)throw Error(reports[0].error);
   modelCatalog=reports[0];return modelCatalog;
  }
  lastInspection={passed:enabled&&reports.every(r=>r.passed),reports,enabled,checkedAt:Date.now(),note:'No prompts sent. Availability is checked on the current tabs; jobs verify settings again after navigation.'};
  return lastInspection;
 }finally{inspecting=false;announce();}
}
function announce(){transmit({type:'pool',protocol:2,enabled,workers,inspecting});}
async function persist(){await chrome.storage.local.set({workers,enabled,composerMode,modelPreference});announce();}
async function initialize(){const saved=await chrome.storage.local.get(['workers','enabled','tabId','composerMode','modelPreference']);enabled=saved.enabled!==false;composerMode=saved.composerMode==='work'?'work':'chat';modelPreference=typeof saved.modelPreference==='string'&&saved.modelPreference.length<=100?saved.modelPreference:'auto';
 workers=(saved.workers || (saved.tabId?[{id:'worker-1',tabId:saved.tabId,state:'IDLE'}]:[])).slice(0,3);
 for(const w of workers){if(w.state!=='IDLE')w.state='NEEDS_REVIEW';try{await chrome.tabs.get(w.tabId);}catch{w.state='NEEDS_REVIEW';w.error='Tab no longer exists';}}
 await persist();initialized=true;connect();}
function connect(){if(!initialized || (ws&&ws.readyState<2))return;
 const peer=ws=new WebSocket('ws://127.0.0.1:18790/ws');
 peer.onopen=()=>{record('Gateway connected');announce();};
 peer.onerror=()=>peer.close();
 peer.onclose=()=>{record('Gateway disconnected');for(const w of workers)if(w.state==='RUNNING'||w.state==='AWAITING_SAVE'){w.state='NEEDS_REVIEW';w.error='Connection lost; review before reuse';}persist().catch(()=>{});};
 peer.onmessage=async event=>{
  let m;try{m=JSON.parse(event.data);}catch{return;}
  if(m.type==='chat'){run(m,peer);return;}
  if(m.type==='inspect'){try{const data=await inspectTabs(m.kind,m);transmit({type:'controlResult',controlId:m.controlId,ok:true,data});}catch(e){transmit({type:'controlResult',controlId:m.controlId,ok:false,error:e.message});}return;}
  if(m.type==='quarantine'){const w=workers.find(w=>w.requestId===m.requestId);if(w){w.state='NEEDS_REVIEW';w.error='Gateway deadline or client disconnected';await persist();}return;}
  try{
   if(m.type==='commit'){
    const w=workers.find(w=>w.requestId===m.requestId);
    if(!w)throw Error('Request reservation missing');
    if(executing.has(w.id))throw Error('Worker still executing');
    if(m.ok&&w.state==='AWAITING_SAVE'){w.state='IDLE';w.requestId=null;w.error='';w.progress=null;completed++;record('Saved; '+w.id+' ready');}
    else{w.state='NEEDS_REVIEW';w.error='Result requires review';}
    await persist();
   }else if(m.type==='reviewReset'){
    if(executing.size)throw Error('A tab is still processing. Stop or wait before review reset.');
    for(const w of workers){const t=await chrome.tabs.get(w.tabId);if(!t.url?.startsWith('https://chatgpt.com/'))throw Error('Worker tab must be on ChatGPT');
     const r=await chrome.tabs.sendMessage(w.tabId,{type:'probe'});if(r.streaming)throw Error('Stop the active generation in '+w.id+' first.');}
    for(const w of workers){w.state='IDLE';w.requestId=null;w.error='';w.progress=null;}await persist();
   }else return;
   transmit({type:'controlResult',controlId:m.controlId,ok:true});
  }catch(e){transmit({type:'controlResult',controlId:m.controlId,ok:false,error:e.message});}
 };
}
async function run(m,peer){const w=workers.find(w=>w.id===m.workerId);
 const reply=r=>{if(peer.readyState===1)peer.send(JSON.stringify({type:'response',workerId:m.workerId,requestId:m.requestId,...r}));};
 if(inspecting||configuring||!enabled||!w||w.state!=='IDLE'){reply({ok:false,error:'Worker is unavailable',not_submitted:true});return;}
 const jobComposerMode=composerMode,jobModel=m.model==='extension'?modelPreference:m.model;
 w.state='RUNNING';w.progress={phase:'OPENING_TAB',updated:Date.now(),chars:0};w.requestId=m.requestId;w.started=Date.now();w.error='';executing.add(w.id);lastRequest=m.requestId;record(w.id+' started '+m.requestId);
 try{
  await persist();const tab=await chrome.tabs.get(w.tabId);
  if(!tab.url?.startsWith('https://chatgpt.com/'))throw Error('Worker tab must be on ChatGPT');
  await chrome.tabs.update(w.tabId,{url:'https://chatgpt.com/'});
  let ready=false;for(let i=0;i<60;i++){
   await new Promise(r=>setTimeout(r,500));const t=await chrome.tabs.get(w.tabId);
   if(t.status==='complete'&&new URL(t.url).pathname==='/')try{const p=await chrome.tabs.sendMessage(w.tabId,{type:'ping'});if(p.ok){ready=true;break;}}catch{}
  }
  if(!ready)throw Error('ChatGPT tab did not become ready');
  if(w.state!=='RUNNING')throw Error('Worker interrupted before submission');
  const result=await chrome.tabs.sendMessage(w.tabId,{type:'chat',requestId:m.requestId,userMessage:m.messages[0].content,model:jobModel,timeout:m.timeout,newConversation:false,selectModel:true,temporary:m.temporary,composerMode:jobComposerMode});
  if(!result?.ok){const e=Error(result?.error||'No response from tab');e.code=result?.code;throw e;}
  if(w.state!=='RUNNING')throw Error('Late response: worker already requires review');
  w.state='AWAITING_SAVE';w.progress={...w.progress,phase:'AWAITING_SAVE',updated:Date.now()};await persist();executing.delete(w.id);reply(result);record(w.id+' awaiting database confirmation');
 }catch(e){w.state='NEEDS_REVIEW';w.error=e.message;lastError=e.message;await persist();reply({ok:false,error:e.message,code:e.code});record(w.id+' failed: '+e.message);}
 finally{executing.delete(w.id);}
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 if(m.type==='jobProgress'&&sender.id===chrome.runtime.id&&sender.tab&&(sender.frameId===undefined||sender.frameId===0)){
  const w=workers.find(w=>w.tabId===sender.tab.id&&w.requestId===m.requestId&&w.state==='RUNNING');
  if(w&&phases.has(m.phase)){w.progress={phase:m.phase,updated:Date.now(),chars:Math.max(0,Math.min(2000000,Number(m.chars)||0)),lastChange:Number(m.lastChange)||null,completionEvidence:['final-assistant-marker','response-actions'].includes(m.completionEvidence)?m.completionEvidence:''};announce();}
  reply({ok:!!w});return false;
 }
 if(sender.id!==chrome.runtime.id||sender.tab)return false;
 (async()=>{
  if(inspecting&&m.type!=='status')throw Error('A tab inspection is in progress.');
  if(m.type==='discoverModels'||m.type==='preflight'){const data=await inspectTabs(m.type,m);reply({data});return;}
  if(m.type==='setEnabled'){enabled=!!m.enabled;await persist();record(enabled?'Bridge enabled':'Bridge paused; active work continues');}
  else if(m.type==='setComposerMode'){
   if(!['chat','work'].includes(m.composerMode))throw Error('Choose Chat or Work');
   if(executing.size)throw Error('Wait for active requests before changing composer mode');
   composerMode=m.composerMode;await persist();record('Composer mode: '+composerMode);
  }else if(m.type==='setModelPreference'){
   if(typeof m.model!=='string'||!m.model.trim()||m.model.length>100||m.model==='extension')throw Error('Enter a model name of up to 100 characters');
   if(executing.size)throw Error('Wait for active requests before changing the model preference');
   modelPreference=m.model.trim();await persist();record('Model preference: '+modelPreference);
  }else if(m.type==='configurePool'){
   if(configuring||executing.size||workers.some(w=>w.state==='RUNNING'||w.state==='AWAITING_SAVE'||(w.state==='NEEDS_REVIEW'&&!m.reviewed)))throw Error('Finish or review all worker jobs before configuring tabs');
   const ids=[...new Set(m.tabIds||[])];if(ids.length<1||ids.length>3||ids.some(id=>!Number.isInteger(id)))throw Error('Select 1–3 different ChatGPT tabs');
   configuring=true;
   try{for(const id of ids){const t=await chrome.tabs.get(id);if(!t.url?.startsWith('https://chatgpt.com/'))throw Error('Select ChatGPT tabs only');}
    workers=ids.map((id,i)=>({id:'worker-'+(i+1),tabId:id,state:'IDLE'}));await persist();}finally{configuring=false;}
  }else if(m.type==='reconnect'){
   if(executing.size)throw Error('Wait for active requests before reconnecting');ws?.close();connect();
  }else if(m.type==='clearEvents')events.length=0;
  else if(m.type!=='status')throw Error('Unknown action');
  reply({enabled,composerMode,modelPreference,connected:ws?.readyState===1,busy:executing.size>0||inspecting,inspecting,lastInspection,modelCatalog,workers,lastError,lastRequest,completed,events});
 })().catch(e=>reply({error:e.message}));return true;
});
chrome.tabs.onRemoved.addListener(id=>{const w=workers.find(w=>w.tabId===id);if(w){w.state='NEEDS_REVIEW';w.error='Worker tab closed';persist().catch(()=>{});}});
chrome.alarms.create('connect',{periodInMinutes:0.5});chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);initialize();
setInterval(()=>{if(ws?.readyState===1){transmit({type:'heartbeat'});announce();}else connect();},20000);
function configureSidePanel(){if(chrome.sidePanel)chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(e=>record(e.message));}
configureSidePanel();chrome.runtime.onInstalled.addListener(configureSidePanel);
