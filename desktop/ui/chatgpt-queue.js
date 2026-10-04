(() => {
 const $=id=>document.getElementById(id),api=(method,route,body)=>window.studio.api(method,'/api/chatgpt/'+route,body);
 let jobs=[],config={},busy=false;const selected=new Set();
 const show=message=>$('chat-pool-state').textContent=message;
 const requestOptions=w=>{const o=w.requestOptions;return o?` · ${o.composerMode==='work'?'Work':'Chat'} / Temporary ${o.temporary?'ON':'OFF'} / ${o.model==='auto'?'Current model':o.model} / ${o.hasAttachment?'Text + JSON':'Text only'}`:'';};
 async function refresh(loadConfig=false){
  const [s,q]=await Promise.all([api('GET','status'),api('GET','queue')]);jobs=q.jobs;config=q.settings;
  if(loadConfig){$('chat-workers').value=config.workers;$('chat-timeout').value=config.timeout_seconds;$('chat-mode').value='temporary';}
  show(`Gateway: ${s.available?'Ready':'Unavailable'} | Queue: ${config.paused?'Paused':s.needsReview?'Account review required':'Running'} | Free text slots: ${s.availableSlots||0}\n`+(s.workers||[]).map(w=>`${w.id} · ${Number.isInteger(w.tabId)?'Tab '+w.tabId:'Window opens on next job'} · ${w.state}${requestOptions(w)}${w.state==='RUNNING'&&w.started?' · '+Math.round((Date.now()-w.started)/1000)+'s':''}${w.progress?' · '+w.progress.phase.replaceAll('_',' ')+' · '+(w.progress.chars||0)+' chars'+(w.progress.lastChange?' · last change '+Math.max(0,Math.round((Date.now()-w.progress.lastChange)/1000))+'s ago':''):''}${w.error?' · '+w.error:''}`).join('\n')+(s.error?'\n'+s.error:''));
  const counts={};jobs.forEach(j=>counts[j.state]=(counts[j.state]||0)+1);$('chat-queue-summary').textContent=Object.entries(counts).map(([k,v])=>`${k}: ${v}`).join(' · ')||'No queued prompts';
  $('chat-queue-rows').replaceChildren(...jobs.map(j=>{
   const row=document.createElement('tr'),cell=()=>{const td=document.createElement('td');row.append(td);return td;};
   const check=document.createElement('input');check.type='checkbox';check.checked=selected.has(j.id);check.onchange=()=>check.checked?selected.add(j.id):selected.delete(j.id);cell().append(check);
   cell().textContent=`${j.batch_id.slice(0,8)} / ${j.ordinal}`;cell().textContent=j.prompt.slice(0,160);cell().textContent=j.state;
   const view=document.createElement('button');view.textContent='View';view.onclick=()=>{$('chat-job-detail').textContent=`Job: ${j.id}\n${j.state}\n\nPROMPT\n${j.prompt}\n\nRESPONSE\n${j.answer||''}\n\n${j.error||''}`;};cell().append(view);return row;
  }));
 }
 function bind(id,fn){$(id).onclick=async()=>{if(busy)return;busy=true;$(id).disabled=true;try{await fn();}catch(e){show(e.message);}finally{busy=false;$(id).disabled=false;}};}
 function ids(){const values=[...selected];if(!values.length)throw Error('Select jobs first');if(values.length>200)throw Error('Select at most 200 jobs');return values;}
 async function checkTabs(){
  $('chat-preflight-result').textContent='Checking tabs without sending a prompt…';
  try{const r=await api('POST','preflight',{model:window.chatModelSelection()});$('chat-preflight-result').textContent=JSON.stringify(r,null,2);if(!r.passed)throw Error('Preflight failed. Review the report before submitting the batch.');return r;}
  catch(e){$('chat-preflight-result').textContent+='\n'+e.message;throw e;}
 }
 bind('chat-preflight',checkTabs);
 bind('chat-refresh',()=>refresh(true));
 bind('chat-save-config',async()=>{await api('POST','config',{workers:Number($('chat-workers').value),timeout_seconds:Number($('chat-timeout').value),temporary:true,paused:!!config.paused});await refresh(true);});
 for(const [id,paused] of [['chat-pause',true],['chat-resume',false]])bind(id,async()=>{const q=await api('GET','queue');await api('POST','config',{...q.settings,paused});await refresh();});
 bind('chat-review',async()=>{if(!confirm('Check every uncertain worker tab and stop any active generation first. Release reviewed workers? Uncertain jobs will not be resent.'))return;await api('POST','resume',{});await refresh();});
 bind('chat-enqueue',async()=>{
  const text=$('chat-batch').value.trim();let prompts;
  if(text.startsWith('[')){prompts=JSON.parse(text);if(!Array.isArray(prompts)||prompts.some(p=>typeof p!=='string'))throw Error('Use a JSON array of strings');}
  else prompts=text.split(/^\s*---\s*$/m).map(p=>p.trim()).filter(Boolean);
  if(!prompts.length||prompts.length>200)throw Error('Enter 1–200 prompts');
  if($('chat-preflight-required').checked)await checkTabs();
  await api('POST','queue',{prompts,model:window.chatModelSelection()});$('chat-batch').value='';await refresh();
 });
 bind('chat-select-all',async()=>{if(selected.size)selected.clear();else jobs.slice(0,200).forEach(j=>selected.add(j.id));await refresh();});
 bind('chat-cancel',async()=>{await api('POST','cancel',{ids:ids()});selected.clear();await refresh();});
 bind('chat-retry',async()=>{const chosen=ids();if(!confirm('Retry creates new jobs. Review uncertain chats first to avoid duplicate generation. Continue?'))return;await api('POST','retry',{ids:chosen});selected.clear();await refresh();});
 bind('chat-export',async()=>{const result=await window.studio.saveChatResults(ids());show(result.canceled?'Export cancelled.':'Results exported.');});
 document.querySelector('[data-page="chatgpt"]').addEventListener('click',()=>refresh(true).catch(e=>show(e.message)));
 setInterval(()=>{if(!busy&&!document.querySelector('[data-view="chatgpt"]').hidden)refresh().catch(e=>show(e.message));},3000);
})();
