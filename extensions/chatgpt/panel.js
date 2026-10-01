const $=id=>document.getElementById(id);
let state={}, working=false;
async function send(message){const result=await chrome.runtime.sendMessage(message);if(result.error)throw Error(result.error);return result;}
async function refresh(){
 state=await send({type:'status'});
 $('enabled').checked=state.enabled;$('power').textContent=state.enabled?'ON':'OFF';
 $('dot').classList.toggle('on',state.connected && state.enabled);
 $('connection').textContent=state.connected?'Connected':state.enabled?'Waiting for gateway':'Disabled';
 $('worker').textContent=state.busy?(state.enabled?'Generating':'Finishing, then OFF'):'Idle';
 $('completed').textContent=state.completed;
 $('selected').textContent=state.tabId?`Tab ${state.tabId} · ${state.tabTitle}`:'No tab selected';
 $('request').textContent=state.lastRequest || 'No request yet';
 $('notice').textContent=state.lastError || '';
 $('select').disabled=state.busy;$('reconnect').disabled=state.busy || !state.enabled;$('focus').disabled=!state.tabId;
 const previous=$('tabs').value;const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
 $('tabs').replaceChildren(...tabs.map(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=`${t.id} · ${t.title || 'ChatGPT'}`;return o;}));
 if(tabs.some(t=>String(t.id)===previous))$('tabs').value=previous;
 else if(state.tabId)$('tabs').value=String(state.tabId);
 $('activity').replaceChildren(...state.events.map(e=>{const li=document.createElement('li');li.textContent=`${new Date(e.time).toLocaleTimeString()} — ${e.message}`;return li;}));
}
function action(id,fn){$(id).addEventListener('click',async()=>{if(working)return;working=true;try{await fn();await refresh();}catch(e){$('notice').textContent=e.message;}finally{working=false;}});}
action('enabled',()=>send({type:'setEnabled',enabled:$('enabled').checked}));
action('refresh',()=>Promise.resolve());
action('reconnect',()=>send({type:'reconnect'}));
action('select',()=>send({type:'selectTab',tabId:Number($('tabs').value)}));
action('open',()=>chrome.tabs.create({url:'https://chatgpt.com/'}));
action('focus',async()=>{const t=await chrome.tabs.update(state.tabId,{active:true});await chrome.windows.update(t.windowId,{focused:true});});
action('clear',()=>send({type:'clearEvents'}));
// Resolve the window before clicking so open() keeps its user gesture.
let panelWindowId;
$('sidepanel').disabled=true;
if(chrome.windows?.getCurrent)chrome.windows.getCurrent().then(w=>{panelWindowId=w.id;$('sidepanel').disabled=false;}).catch(e=>$('notice').textContent=e.message);
$('sidepanel').addEventListener('click',()=>{
 if(panelWindowId===undefined)return;
 chrome.sidePanel.open({windowId:panelWindowId}).catch(e=>$('notice').textContent=e.message);
});
if(!document.body.classList.contains('popup'))$('sidepanel').hidden=true;
refresh().catch(e=>$('notice').textContent=e.message);
setInterval(()=>{if(!working)refresh().catch(e=>$('notice').textContent=e.message);},3000);
