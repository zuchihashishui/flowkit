(() => {
 const el=id=>document.getElementById(id);
 let pending=false, answer='';
 function lock(value){pending=value;for(const id of ['chat-send','chat-clear','chat-prompt','chat-model'])el(id).disabled=value;}
 el('chat-form').onsubmit=async event=>{
  event.preventDefault();if(pending)return;
  const prompt=el('chat-prompt').value;
  if(!prompt.trim()){el('chat-status').textContent='Enter a prompt first.';return;}
  lock(true);answer='';el('chat-copy').disabled=true;
  el('chat-response').textContent='Waiting for ChatGPT…';
  el('chat-status').textContent='Sending… Keep the dedicated ChatGPT tab open. This can take a few minutes.';
  const started=Date.now();
  try{
   const result=await window.studio.api('POST','/api/chatgpt/message',{prompt,model:el('chat-model').value.trim() || 'auto'});
   if(typeof result.response!=='string' || !result.response.trim())throw Error('ChatGPT returned an empty answer. Check Request History in Settings.');
   answer=result.response;el('chat-response').textContent=answer;el('chat-copy').disabled=false;
   el('chat-status').textContent=`Completed in ${Math.round((Date.now()-started)/1000)} seconds. Saved to Request History.`;
  }catch(error){el('chat-response').textContent='No completed answer received.';el('chat-status').textContent=error.message;}
  finally{lock(false);}
 };
 el('chat-clear').onclick=()=>{if(pending)return;el('chat-prompt').value='';answer='';el('chat-response').textContent='Your answer will appear here.';el('chat-status').textContent='Ready.';el('chat-copy').disabled=true;el('chat-prompt').focus();};
 el('chat-copy').onclick=async()=>{try{await navigator.clipboard.writeText(answer);el('chat-status').textContent='Response copied.';}catch{el('chat-status').textContent='Could not access clipboard. Select the response text and copy it manually.';}};
 el('chat-open').onclick=async()=>{try{await window.studio.chatgptAction('open');}catch(e){el('chat-status').textContent=e.message;}};
})();
