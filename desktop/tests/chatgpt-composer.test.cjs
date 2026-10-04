const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
const group=active=>`<div role="group" aria-label="Composer mode"><button type="button" aria-pressed="${active==='chat'}">Chat</button><button type="button" aria-pressed="${active==='work'}"><span>Work</span></button></div>`;
for(const scenario of ['default-chat','work','already-chat','rerender','delayed','missing','disabled','aria-disabled','unchanged','invalid','work-temporary-missing','temporary-resets-mode']){
 test(`composer selection: ${scenario}`,async()=>{
  const initial=scenario==='default-chat'?'work':'chat';
  const dom=new JSDOM((scenario==='missing'||scenario==='delayed'?'':group(initial))+'<textarea id="prompt-textarea"></textarea><button type="submit" aria-label="Send">Send</button>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
  const w=dom.window,d=w.document;let listener,typed=0,sent=0,clicks=0,sleeps=0;
  const desired=['default-chat','already-chat'].includes(scenario)?'chat':'work';
  Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
  w.chrome={runtime:{onMessage:{addListener:f=>listener=f}}};
  function bind(){for(const b of d.querySelectorAll('[role="group"] button')){
   if(scenario==='disabled')b.disabled=true;
   if(scenario==='aria-disabled')b.setAttribute('aria-disabled','true');
   b.onclick=()=>{clicks++;if(scenario==='unchanged')return;
    if(scenario==='rerender'){b.closest('[role="group"]').outerHTML=group(desired);return;}
    for(const sibling of d.querySelectorAll('[role="group"] button'))sibling.setAttribute('aria-pressed',String(sibling===b));
   };
  }}bind();
  w.setTimeout=fn=>setImmediate(()=>{sleeps++;if(scenario==='delayed'&&sleeps===2){d.body.insertAdjacentHTML('afterbegin',group('chat'));bind();}fn();});
  d.execCommand=(cmd,_,value)=>{if(cmd==='insertText'){
   assert.equal([...d.querySelectorAll('[role="group"] button')].find(b=>b.textContent.toLowerCase()===desired).getAttribute('aria-pressed'),'true');
   typed++;d.querySelector('textarea').value=value;
  }};
  d.querySelector('[aria-label="Send"]').onclick=()=>{sent++;d.body.insertAdjacentHTML('beforeend','<div data-local-conversation-final-assistant="true" data-markdown-text-style="assistant-message">Answer</div>');};
  if(scenario==='temporary-resets-mode'){const t=d.createElement('button');t.setAttribute('aria-label','Temporary chat');t.onclick=()=>{t.setAttribute('aria-pressed','true');d.querySelector('[role="group"]').outerHTML=group('chat');};d.body.append(t);}
  w.eval(source);
  const message={type:'chat',userMessage:'Prompt',newConversation:false,timeout:10000,temporary:['work-temporary-missing','temporary-resets-mode'].includes(scenario)};
  if(scenario!=='default-chat')message.composerMode=scenario==='invalid'?'unknown':desired;
  const result=await new Promise(resolve=>listener(message,{},resolve));
  const failure=['missing','disabled','aria-disabled','unchanged','invalid','work-temporary-missing','temporary-resets-mode'].includes(scenario);
  assert.equal(result.ok,!failure,result.error);
  assert.equal(sent,failure?0:1);assert.equal(typed,failure?0:1);
  if(scenario==='already-chat')assert.equal(clicks,0);
  if(scenario==='default-chat'||scenario==='work'||scenario==='rerender')assert.equal(clicks,1);
  if(failure)assert.match(result.error,/composer mode|Temporary Chat/);
  dom.window.close();
 });
}

test('custom GPT sends plain scene text without requiring Chat/Work or model controls',async()=>{
 const pageUrl='https://chatgpt.com/g/g-project-image';
 const dom=new JSDOM('<textarea id="prompt-textarea"></textarea><button type="submit" aria-label="Send">Send</button>',{url:pageUrl,runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,sent=0;
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return d.body;}});
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f}}};w.setTimeout=fn=>setImmediate(fn);
 d.execCommand=(cmd,_,value)=>{if(cmd==='insertText')d.querySelector('textarea').value=value;};
 d.querySelector('button').onclick=()=>{sent++;d.body.insertAdjacentHTML('beforeend','<div data-local-conversation-final-assistant="true" data-markdown-text-style="assistant-message">One image prompt</div>');};
 w.eval(source);
 const text='日本語。\nA scene paragraph.';
 const result=await new Promise(resolve=>listener({type:'chat',userMessage:text,newConversation:false,timeout:10000,temporary:false,composerMode:'chat',customGPT:true,pageUrl,model:'auto'},{},resolve));
 assert.equal(result.ok,true,result.error);assert.equal(sent,1);assert.equal(d.querySelector('textarea').value,text);
 dom.window.close();
});
