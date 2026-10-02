(() => {
 const $=id=>document.getElementById(id);
 $('chat-model-mode').onchange=()=>{$('chat-model-fields').hidden=$('chat-model-mode').value!=='custom';};
 $('chat-observed-model').onchange=()=>{if(!$('chat-observed-model').value)return;$('chat-model-mode').value='custom';$('chat-model-fields').hidden=false;$('chat-model').value=$('chat-observed-model').value;};
 $('chat-refresh-models').onclick=async()=>{
  $('chat-refresh-models').disabled=true;
  try{const c=await window.studio.api('POST','/api/chatgpt/models',{});$('chat-observed-model').replaceChildren(new Option('Select an observed model',''),...(c.models||[]).map(name=>new Option(name,name)));$('chat-model-catalog-status').textContent=`Tab ${c.tabId}: ${c.current?.model||'Unknown'} · ${c.current?.effort||'Default effort'}. ${c.note||''}`;}
  catch(e){$('chat-model-catalog-status').textContent=e.message;}finally{$('chat-refresh-models').disabled=false;}
 };
 window.chatModelSelection=()=>{
  const mode=$('chat-model-mode').value;
  if(mode!=='custom')return mode==='extension'?'extension':'auto';
  const name=$('chat-model').value.trim(),effort=$('chat-model-effort').value;
  if(!name)throw Error('Enter the exact model name shown in ChatGPT.');
  if(name.includes('::'))throw Error('Enter the model name only; choose reasoning effort separately.');
  const value=name+(effort?' :: '+effort:'');
  if(value.length>100)throw Error('Model selection is too long.');
  return value;
 };
})();
