// Adapted from Draivix/chatgpt-gateway (MIT). Explicit tab binding, no replay.
let ws, busy=false, enabled=false, initialized=false;
let lastError='', lastRequest='', completed=0;
const events=[];
function record(message){events.unshift({time:new Date().toISOString(),message});events.splice(50);}
async function initialize(){
 const saved=await chrome.storage.local.get('enabled');
 enabled=saved.enabled!==false; initialized=true; connect();
}
function connect(){
 if(!initialized || !enabled || (ws && ws.readyState<2))return;
 ws=new WebSocket('ws://127.0.0.1:18790/ws');
 ws.onopen=()=>{lastError='';record('Gateway connected');};
 ws.onclose=()=>record('Gateway disconnected');
 ws.onmessage=async event=>{
  let m;try{m=JSON.parse(event.data);}catch{return;}
  if(m.type!=='chat')return;
  const peer=ws;
  const reply=r=>{if(peer.readyState===1)peer.send(JSON.stringify({type:'response',requestId:m.requestId,...r}));};
  if(!enabled){reply({ok:false,error:'Bridge is disabled'});return;}
  if(busy){reply({ok:false,error:'Tab is busy'});return;}
  busy=true;lastRequest=m.requestId;record('Request started: '+m.requestId);
  try{
   const {tabId}=await chrome.storage.local.get('tabId');
   if(!tabId)throw Error('Use the extension popup to select a ChatGPT tab');
   const tab=await chrome.tabs.get(tabId);
   if(!tab.url?.startsWith('https://chatgpt.com/'))throw Error('Selected tab must be on chatgpt.com');
   // Navigate BEFORE messaging content.js; an in-content reload loses the reply port.
   await chrome.tabs.update(tabId,{url:'https://chatgpt.com/'});
   let ready=false;
   for(let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,500));
    const t=await chrome.tabs.get(tabId);
    if(t.status==='complete' && new URL(t.url).pathname==='/'){
     try{const r=await chrome.tabs.sendMessage(tabId,{type:'ping'});if(r.ok){ready=true;break;}}catch{}
    }
   }
   if(!ready)throw Error('ChatGPT tab is not ready. Sign in and refresh it.');
   const result=await chrome.tabs.sendMessage(tabId,{type:'chat',userMessage:m.messages[0].content,model:m.model,timeout:m.timeout,newConversation:false,selectModel:true});
   if(!result?.ok)throw Error(result?.error || 'No response from tab');
   reply(result);completed++;record('Request completed: '+m.requestId);
  }catch(e){lastError=e.message;record('Request failed: '+e.message);reply({ok:false,error:e.message});}finally{busy=false;if(!enabled)ws?.close();}
 };
 const socket=ws;socket.onerror=()=>socket.close();
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 if(sender.id!==chrome.runtime.id || sender.tab)return false;
 (async()=>{
  if(m.type==='setEnabled'){
   enabled=!!m.enabled;await chrome.storage.local.set({enabled});
   record(enabled?'Bridge enabled':busy?'Bridge off: finishing current request':'Bridge disabled');
   if(enabled)connect();else if(!busy)ws?.close();
  }else if(m.type==='selectTab'){
   if(busy)throw Error('Wait for the current request before changing tabs.');
   const tab=await chrome.tabs.get(m.tabId);
   if(!tab.url?.startsWith('https://chatgpt.com/'))throw Error('Select a ChatGPT tab.');
   await chrome.storage.local.set({tabId:tab.id});record('Selected tab '+tab.id);
  }else if(m.type==='reconnect'){
   if(busy)throw Error('Wait for the current request before reconnecting.');
   if(!enabled)throw Error('Turn the bridge on first.');
   ws?.close();connect();
  }else if(m.type==='clearEvents'){events.length=0;}
  else if(m.type!=='status')throw Error('Unknown action');
  const {tabId}=await chrome.storage.local.get('tabId');
  let tab=null;try{if(tabId)tab=await chrome.tabs.get(tabId);}catch{}
  reply({enabled,connected:ws?.readyState===1,busy,tabId:tab?.id || null,
   tabTitle:tab?.title || '',lastError,lastRequest,completed,events});
 })().catch(e=>reply({error:e.message}));return true;
});
chrome.alarms.create('connect',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(()=>{if(initialized)connect();});
initialize();
// WebSocket activity keeps MV3 alive while waiting for a long answer.
setInterval(()=>{if(ws?.readyState===1)ws.send(JSON.stringify({type:'heartbeat'}));else connect();},20000);

// Let Chrome open this extension's own panel directly from its toolbar icon.
function configureSidePanel(){
 if(!chrome.sidePanel){record('Side panel unavailable. Use Chrome 116 or later.');return;}
 chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})
  .catch(e=>{lastError='Cannot configure ChatGPT side panel: '+e.message;record(lastError);});
}
configureSidePanel();
chrome.runtime.onInstalled.addListener(configureSidePanel);
