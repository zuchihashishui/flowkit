const $=id=>document.getElementById(id);
let state={},working=false,modelDirty=false;
async function send(message){const r=await chrome.runtime.sendMessage(message);if(r.error)throw Error(r.error);return r;}
async function refresh(){
 state=await send({type:'status'});$('enabled').checked=state.enabled;$('power').textContent=state.enabled?'ON':'OFF';
 $('dot').classList.toggle('on',state.connected&&state.enabled);$('connection').textContent=state.connected?'Connected': 'Waiting for gateway';
 $('worker').textContent=`${(state.workers||[]).filter(w=>w.state==='RUNNING').length} running / ${(state.workers||[]).length} tabs`;
 $('completed').textContent=state.completed;$('request').textContent=state.lastRequest||'No request yet';$('notice').textContent=state.lastError||'';
 if(!modelDirty){const parts=(state.modelPreference||'auto').split('::').map(s=>s.trim());$('model-mode').value=parts[0]==='auto'?'auto':'custom';$('model-name').value=parts[0]==='auto'?'':parts[0];$('model-effort').value=parts[1]||'';$('model-fields').hidden=$('model-mode').value!=='custom';}
 for(const id of ['model-mode','model-name','model-effort','save-model','refresh-models','observed-model','preflight'])$(id).disabled=state.busy;
 $('composer-mode').value=state.composerMode||'chat';$('composer-mode').disabled=state.busy;
 $('reconnect').disabled=state.busy;$('configure').disabled=state.busy;$('create-pool').disabled=state.busy;
 const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
 for(let i=1;i<=3;i++){
  const select=$('tab-'+i),old=select.value;
  select.replaceChildren(new Option('Not assigned',''),...tabs.map(t=>new Option(`${t.id} · ${t.title||'ChatGPT'}`,String(t.id))));
  select.value=tabs.some(t=>String(t.id)===old)?old:String(state.workers?.[i-1]?.tabId||'');select.disabled=state.busy;
 }
 $('pool').replaceChildren(...(state.workers||[]).map(w=>{const row=document.createElement('div');row.className='card';
  const text=document.createElement('div');text.textContent=`${w.id} · Tab ${w.tabId} · ${w.state}${w.state==='RUNNING'&&w.started?' · '+Math.round((Date.now()-w.started)/1000)+'s':''}${w.progress?' · '+w.progress.phase.replaceAll('_',' ')+' · '+(w.progress.chars||0)+' chars':''}${w.error?' · '+w.error:''}`;
  const button=document.createElement('button');button.textContent='Focus';button.onclick=async()=>{try{const t=await chrome.tabs.update(w.tabId,{active:true});await chrome.windows.update(t.windowId,{focused:true});}catch(e){$('notice').textContent=e.message;}};
  row.append(text,button);return row;}));
 $('activity').replaceChildren(...state.events.map(e=>{const li=document.createElement('li');li.textContent=`${new Date(e.time).toLocaleTimeString()} — ${e.message}`;return li;}));
}
function action(id,fn){$(id).onclick=async()=>{if(working)return;working=true;try{await fn();await refresh();}catch(e){$('notice').textContent=e.message;}finally{working=false;}};}
$('composer-mode').onchange=async()=>{if(working)return;working=true;try{await send({type:'setComposerMode',composerMode:$('composer-mode').value});await refresh();}catch(e){$('composer-mode').value=state.composerMode||'chat';$('notice').textContent=e.message;}finally{working=false;}};
for(const id of ['model-mode','model-name','model-effort'])$(id).addEventListener('input',()=>{modelDirty=true;$('model-fields').hidden=$('model-mode').value!=='custom';});
$('observed-model').onchange=()=>{if(!$('observed-model').value)return;modelDirty=true;$('model-mode').value='custom';$('model-fields').hidden=false;$('model-name').value=$('observed-model').value;};
action('refresh-models',async()=>{const r=await send({type:'discoverModels'});const c=r.data;$('observed-model').replaceChildren(new Option('Select an observed model',''),...(c.models||[]).map(name=>new Option(name,name)));$('model-catalog-status').textContent=`Tab ${c.tabId}: ${c.current?.model||'Unknown'} · ${c.current?.effort||'Default effort'}. ${c.note||''}`;});
action('preflight',async()=>{const r=await send({type:'preflight',model:'extension',temporary:$('check-temporary').checked});$('preflight-result').textContent=JSON.stringify(r.data,null,2);});
action('save-model',async()=>{let model='auto';if($('model-mode').value==='custom'){model=$('model-name').value.trim();if(!model)throw Error('Enter the exact model name shown in ChatGPT');if($('model-effort').value)model+=' :: '+$('model-effort').value;}await send({type:'setModelPreference',model});modelDirty=false;});
action('enabled',()=>send({type:'setEnabled',enabled:$('enabled').checked}));action('refresh',async()=>{});
action('reconnect',()=>send({type:'reconnect'}));action('clear',()=>send({type:'clearEvents'}));
action('configure',async()=>{
 const ids=[1,2,3].map(i=>$('tab-'+i).value).filter(Boolean).map(Number);
 const review=(state.workers||[]).some(w=>w.state==='NEEDS_REVIEW');
 if(review&&!confirm('Have you checked the uncertain worker tabs? Replacing a tab does not stop its old generation. Stop it before continuing.'))return;
 await send({type:'configurePool',tabIds:ids,reviewed:review});
});
action('create-pool',async()=>{
 if((state.workers||[]).some(w=>w.state!=='IDLE'))throw Error('Review the worker tabs in Studio first.');
 const ids=[];for(const w of state.workers||[]){try{const t=await chrome.tabs.get(w.tabId);if(t.url?.startsWith('https://chatgpt.com/'))ids.push(t.id);}catch{}}
 while(ids.length<3){const t=await chrome.tabs.create({url:'https://chatgpt.com/',active:false});ids.push(t.id);}
 await send({type:'configurePool',tabIds:ids});
});
// The toolbar icon opens the panel directly. Legacy popup supports an explicit button too.
let windowId;$('sidepanel').disabled=true;
if(chrome.windows?.getCurrent)chrome.windows.getCurrent().then(w=>{windowId=w.id;$('sidepanel').disabled=false;}).catch(()=>{});
$('sidepanel').onclick=()=>{if(windowId!==undefined)chrome.sidePanel.open({windowId}).catch(e=>$('notice').textContent=e.message);};
if(!document.body.classList.contains('popup'))$('sidepanel').hidden=true;
refresh().catch(e=>$('notice').textContent=e.message);
setInterval(()=>{if(!working)refresh().catch(e=>$('notice').textContent=e.message);},3000);
