const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const {JSDOM}=require('jsdom');
for(const mode of ['partial-only','thinking','tools','late-final','hidden-stop','resume-stream'])test(`strict completion: ${mode}`,async()=>{
 const dom=new JSDOM('<div role="group" aria-label="Composer mode"><button aria-pressed="true">Chat</button></div><textarea id="prompt-textarea"></textarea><button aria-label="Send" type="submit"></button><div data-turn-key="new" id="turn"></div>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,polls=0;const updates=[];
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f},sendMessage:async m=>updates.push(m)}};
 w.setTimeout=(f,ms)=>setImmediate(()=>{if(ms===1500){polls++;if(mode==='late-final'&&polls===7)d.querySelector('#answer').setAttribute('data-local-conversation-final-assistant','true');if(mode==='resume-stream'){if(polls===4)d.querySelector('#stop')?.remove();if(polls===6)d.body.insertAdjacentHTML('beforeend','<button id="stop" aria-label="Stop"></button>');if(polls===10){d.querySelector('#stop')?.remove();d.querySelector('#answer').textContent='Final answer';}}}f();});
 d.execCommand=(cmd,_,value)=>{if(cmd==='insertText')d.querySelector('textarea').value=value;};
 d.querySelector('[aria-label="Send"]').onclick=()=>{
  d.querySelector('#turn').innerHTML='<div id="answer" data-markdown-text-style="assistant-message">Draft answer</div>';
  if(!['partial-only','late-final'].includes(mode))d.querySelector('#answer').setAttribute('data-local-conversation-final-assistant','true');
  if(mode==='thinking')d.querySelector('#turn').insertAdjacentHTML('beforeend','<div role="status">Thinking</div>');
  if(mode==='tools')d.querySelector('#turn').insertAdjacentHTML('beforeend','<div role="status">Running tools</div>');
  if(mode==='hidden-stop')d.body.insertAdjacentHTML('beforeend','<button aria-label="Stop" hidden></button>');
  if(mode==='resume-stream')d.body.insertAdjacentHTML('beforeend','<button id="stop" aria-label="Stop"></button>');
 };
 w.eval(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8'));
 const r=await new Promise(resolve=>listener({type:'chat',requestId:'job-1',userMessage:'Prompt',newConversation:false,timeout:30000},{},resolve));
 const ok=['late-final','hidden-stop','resume-stream'].includes(mode);assert.equal(r.ok,ok,r.error);
 if(mode==='late-final')assert.ok(polls>=10);if(mode==='resume-stream'){assert.equal(r.content,'Final answer');assert.ok(polls>=14);}
 if(mode==='thinking')assert.ok(updates.some(u=>u.phase==='THINKING'));if(mode==='tools')assert.ok(updates.some(u=>u.phase==='USING_TOOLS'));
 assert.ok(updates.every(u=>u.requestId==='job-1'&&!('content' in u)));dom.window.close();
});
