const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
for(const mode of ['pressed','heading','unchanged','missing','lost','rate-limit'])test(`Temporary Chat verification: ${mode}`,async()=>{
 const dom=new JSDOM('<textarea id="prompt-textarea"></textarea><button type="submit" aria-label="Send">Send</button>'+(mode==='missing'?'':'<div data-app-shell-header-obstacle="true"><button type="button" aria-label="Temporary chat"><svg></svg></button></div>'),{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,sent=0,typed=0;
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f}}};w.setTimeout=fn=>setImmediate(fn);
 const toggle=d.querySelector('[aria-label="Temporary chat"]');
 if(toggle)toggle.onclick=()=>{if(mode==='unchanged')return;if(mode==='heading'){const h=d.createElement('h1');h.textContent='Temporary Chat';d.body.append(h);}else toggle.setAttribute('aria-pressed','true');};
 d.execCommand=(cmd,_,value)=>{if(cmd==='insertText'){typed++;d.querySelector('textarea').value=value;if(mode==='lost')toggle.setAttribute('aria-pressed','false');}};
 d.querySelector('[aria-label="Send"]').onclick=()=>{sent++;const el=d.createElement('div');if(mode==='rate-limit'){el.setAttribute('role','alert');el.textContent='You have reached your message limit';}else{el.dataset.markdownTextStyle='assistant-message';el.dataset.localConversationFinalAssistant='true';el.textContent='Temporary answer';}d.body.append(el);};
 w.document.body.insertAdjacentHTML('afterbegin','<div role="group" aria-label="Composer mode"><button aria-pressed="true">Chat</button><button aria-pressed="false">Work</button></div>');
 w.eval(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8'));
 const r=await new Promise(resolve=>listener({type:'chat',userMessage:'Test',newConversation:false,temporary:true,timeout:10000},{},resolve));
 if(['pressed','heading'].includes(mode)){assert.equal(r.ok,true);assert.equal(sent,1);assert.equal(r.content,'Temporary answer');}
 else if(mode==='rate-limit'){assert.equal(r.code,'RATE_LIMIT');assert.equal(r.ok,false);}
 else{assert.equal(r.ok,false);assert.equal(sent,0);assert.match(r.error,/Temporary Chat/);if(mode!=='lost')assert.equal(typed,0);}
 dom.window.close();
});

for(const mode of ['pressed','switch','exit','missing-exit','disabled-exit','stuck','reactivated'])test(`Work regular request leaves Temporary Chat before selecting Work: ${mode}`,async()=>{
 const dom=new JSDOM('<textarea id="prompt-textarea"></textarea><button type="submit" aria-label="Send">Send</button>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,sent=0,typed=0,exited=0;
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f}}};w.setTimeout=fn=>setImmediate(fn);
 const toggle=d.createElement(mode==='switch'?'div':'button');
 toggle.setAttribute('aria-label',mode==='exit'?'Exit temporary chat':'Temporary chat');
 if(mode==='switch'){toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked','true');}else toggle.setAttribute('aria-pressed','true');
 if(mode==='missing-exit'){const h=d.createElement('h1');h.textContent='Temporary Chat';d.body.append(h);}else d.body.append(toggle);
 if(mode==='disabled-exit')toggle.disabled=true;
 toggle.onclick=()=>{
  exited++;
  if(mode==='stuck')return;
  toggle.setAttribute('aria-label','Temporary chat');toggle.setAttribute('aria-pressed','false');toggle.setAttribute('aria-checked','false');
  d.body.insertAdjacentHTML('afterbegin','<div role="group" aria-label="Composer mode"><button aria-pressed="true">Chat</button><button aria-pressed="false">Work</button></div>');
  const [chat,work]=d.querySelectorAll('[role="group"] button');
  work.onclick=()=>{work.setAttribute('aria-pressed','true');chat.setAttribute('aria-pressed','false');};
 };
 d.execCommand=(cmd,_,value)=>{if(cmd==='insertText'){
  typed++;assert.equal(exited,1);assert.equal(d.querySelectorAll('[role="group"] button')[1].getAttribute('aria-pressed'),'true');
  d.querySelector('textarea').value=value;if(mode==='reactivated')toggle.setAttribute('aria-pressed','true');
 }};
 d.querySelector('[aria-label="Send"]').onclick=()=>{sent++;d.body.insertAdjacentHTML('beforeend','<div data-local-conversation-final-assistant="true" data-markdown-text-style="assistant-message">Work answer</div>');};
 w.eval(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8'));
 const r=await new Promise(resolve=>listener({type:'chat',userMessage:'Work prompt',composerMode:'work',temporary:false,newConversation:false,timeout:10000},{},resolve));
 const ok=['pressed','switch','exit'].includes(mode);
 assert.equal(r.ok,ok,r.error);assert.equal(sent,ok?1:0);
 if(!ok){assert.match(r.error,/Temporary Chat/);assert.equal(typed,mode==='reactivated'?1:0);}
 dom.window.close();
});

for(const change of ['none','temporary-off','same-url-new-chat','reload'])test(`Temporary TXT conversation continuity: ${change}`,async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
 const markup='<div role="group" aria-label="Composer mode"><button aria-pressed="false">Chat</button><button aria-pressed="true">Work</button></div><button aria-label="Temporary chat" aria-pressed="false"></button><textarea id="prompt-textarea"></textarea><button type="submit" aria-label="Send">Send</button>';
 const dom=new JSDOM(markup,{url:'https://chatgpt.com/?temporary-chat=true',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,sent=0,toggleClicks=0;const typed=[];
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f}}};w.setTimeout=fn=>setImmediate(fn);
 const [chat,work]=d.querySelectorAll('[role="group"] button'),toggle=d.querySelector('[aria-label="Temporary chat"]');
 chat.onclick=()=>{chat.setAttribute('aria-pressed','true');work.setAttribute('aria-pressed','false');};
 toggle.onclick=()=>{toggleClicks++;assert.equal(chat.getAttribute('aria-pressed'),'true');toggle.setAttribute('aria-pressed','true');};
 d.execCommand=(cmd,_,value)=>{if(cmd==='insertText'){typed.push(value);d.querySelector('textarea').value=value;}};
 d.querySelector('[aria-label="Send"]').onclick=()=>{sent++;d.body.insertAdjacentHTML('beforeend',`<div data-message-author-role="assistant" data-message-id="a${sent}" data-local-conversation-final-assistant="true">Prompt ${sent}</div>`);};
 w.eval(source);
 const message={type:'chat',requestId:'first',textSessionId:'session-1',userMessage:'TXT instructions\n\nFirst SRT row',composerMode:'chat',temporary:true,newConversation:false,timeout:10000};
 const call=m=>new Promise(resolve=>listener(m,{},resolve));
 const first=await call(message);assert.equal(first.ok,true,first.error);assert.equal(toggleClicks,1);assert.equal(first.textSessionProof.proof,'first');
 let state=await call({type:'ping'});assert.equal(state.textSessionProof.id,'session-1');
 if(change==='temporary-off')toggle.setAttribute('aria-pressed','false');
 if(change==='same-url-new-chat'){d.querySelector('[data-message-author-role]').remove();d.body.insertAdjacentHTML('beforeend','<div data-message-author-role="assistant" data-message-id="new">Unrelated reply</div>');}
 if(change==='reload')w.eval(source); // Fresh script with identical DOM/URL has no memory.
 state=await call({type:'ping'});assert.equal(!!state.textSessionProof,change==='none');
 const next=await call({...message,requestId:'second',userMessage:'Second SRT row',continueConversation:true,conversationUrl:w.location.href,textSessionProof:'first'});
 assert.equal(next.ok,change==='none',next.error);assert.equal(sent,change==='none'?2:1);
 if(change==='none'){assert.deepEqual(typed,['TXT instructions\n\nFirst SRT row','Second SRT row']);assert.equal(toggleClicks,1);assert.equal(next.textSessionProof.proof,'second');assert.equal(chat.getAttribute('aria-pressed'),'true');}
 else assert.match(next.error,/Temporary conversation memory/);
 dom.window.close();
});
