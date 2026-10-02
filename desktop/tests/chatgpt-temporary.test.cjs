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
