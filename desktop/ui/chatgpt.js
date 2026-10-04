(() => {
 const el=id=>document.getElementById(id);
 async function showStatus(){
  const info=await window.studio.api('GET','/api/chatgpt/status');
  const error=await window.studio.chatgptAction('startup-error');
  el('cg-state').textContent=`Gateway: ${info.available?'Ready':'Unavailable'}\nExtension: ${info.extensionConnected?'Connected (tab/sign-in not verified)':'Disconnected'}\nQueue: ${info.needsReview?'Account paused — review required':info.settings?.paused?'Paused':`${info.availableSlots||0} free worker slots`}\nWorkers needing review: ${info.reviewWorkers||0}${error?'\n'+error:''}${info.error?'\n'+info.error:''}`;
 }
 function bind(id,fn){el(id).onclick=async()=>{el(id).disabled=true;try{await fn();}catch(e){el('cg-state').textContent=e.message;}finally{el(id).disabled=false;}};}
 for(const [id,cmd] of [['cg-extension','extension'],['cg-logs','logs']])bind(id,()=>window.studio.chatgptAction(cmd));
 bind('cg-open',()=>{const pid=window.workflow?.context?.().project_id;return pid?window.studio.openProjectPage(pid,'chatgpt_url'):window.studio.chatgptAction('open');});
 bind('cg-status',showStatus);
 bind('cg-test',async()=>{el('cg-state').textContent='Waiting for ChatGPT…';const r=await window.studio.api('POST','/api/chatgpt/test',{});await showStatus();el('cg-state').textContent+='\nTest response: '+r.response;});
 bind('cg-resume',async()=>{if(!confirm('Have you checked the ChatGPT tab and stopped any unfinished generation? Queued jobs will continue; uncertain jobs will not be resent.'))return;await window.studio.api('POST','/api/chatgpt/resume',{});await showStatus();});
 bind('cg-history',async()=>{const r=await window.studio.api('GET','/api/chatgpt/history');el('cg-history-output').textContent=JSON.stringify(r.requests,null,2);});
})();
