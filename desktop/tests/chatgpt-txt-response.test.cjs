const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const fixture=fs.readFileSync(process.env.FLOWKIT_TEMPORARY_DOM||path.join(__dirname,'fixtures/chatgpt-temporary-response.html'),'utf8');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
for(const scenario of ['complete','upload-remount','proof-lost','streaming','busy','no-toolbar','hidden-toolbar','code-copy-only','old-only','sibling-toolbar','upload-busy','upload-failed'])test('Temporary TXT attachment and response: '+scenario,async()=>{
 const dom=new JSDOM('<div role="group" aria-label="Composer mode"><button aria-pressed="true">Chat</button><button aria-pressed="false">Work</button></div><button aria-label="Temporary chat" aria-pressed="true"></button><form><textarea id="prompt-textarea"></textarea><input type="file" accept=".txt"><button aria-label="Send">Send</button></form><main></main>',{url:'https://chatgpt.com/?temporary-chat=true',runScripts:'outside-only'});
 const w=dom.window,d=w.document,main=d.querySelector('main');let handler,sent=0,uploads=0,bytes;
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
 Object.defineProperty(w.HTMLInputElement.prototype,'files',{get(){return this._files;},set(v){this._files=v;}});
 w.DataTransfer=class{constructor(){this.files=[];this.items={add:f=>this.files.push(f)};}};
 w.chrome={runtime:{onMessage:{addListener:f=>handler=f},sendMessage:async m=>{if(scenario==='proof-lost'&&m.type==='jobProgress'&&m.phase==='VERIFYING_COMPLETION')d.querySelector('[aria-label="Temporary chat"]').setAttribute('aria-pressed','false');return {ok:true};}}};
 w.setTimeout=f=>setImmediate(f);
 let editor=d.querySelector('textarea');d.execCommand=(cmd,_,value)=>{if(cmd==='insertText'){editor.value=value;d.querySelector('[aria-label="Send"]').disabled=false;}};
 const instructions='Read this TXT and return one prompt for each supplied sentence.\n日本語・Tiếng Việt.';
 d.querySelector('input').onchange=e=>{uploads++;const file=e.target.files[0];assert.equal(file.name,'prompt-instructions.txt');assert.equal(file.type,'text/plain');
  bytes=new Promise(resolve=>{const r=new w.FileReader();r.onload=()=>resolve(r.result);r.readAsText(file);});
  if(scenario==='upload-remount'){const next=d.createElement('textarea');next.id='prompt-textarea';editor.replaceWith(next);editor=next;d.querySelector('[aria-label="Send"]').disabled=true;}
  const chip=d.createElement('div');chip.dataset.testid='attachment-card';chip.textContent=file.name;
  if(scenario==='upload-busy')chip.setAttribute('aria-busy','true');if(scenario==='upload-failed')chip.append(' Upload failed');d.querySelector('form').append(chip);
 };
 if(['old-only','sibling-toolbar'].includes(scenario))main.innerHTML=fixture;
 d.querySelector('[aria-label="Send"]').onclick=e=>{e.preventDefault();sent++;assert.equal(editor.value,'SRT sentence '+sent);assert.equal(uploads,1);
  if(scenario==='old-only'){main.innerHTML=fixture;return;}
  const host=d.createElement('section');host.innerHTML=fixture;
  for(const el of host.querySelectorAll('[data-chatgpt-selection-message-id]'))el.setAttribute('data-chatgpt-selection-message-id','answer-'+sent);
  for(const el of host.querySelectorAll('[data-chatgpt-search-message-ids]'))el.setAttribute('data-chatgpt-search-message-ids','answer-'+sent);
  const unit=host.querySelector('[data-chatgpt-search-unit-key$=":assistant"]');
  if(['no-toolbar','code-copy-only','sibling-toolbar'].includes(scenario))host.querySelectorAll('button').forEach(e=>e.remove());
  if(scenario==='hidden-toolbar')host.querySelectorAll('button').forEach(e=>e.hidden=true);
  if(scenario==='code-copy-only')unit.querySelector('[data-markdown-text-style]').insertAdjacentHTML('beforeend','<pre><code>Still writing</code><button aria-label="Copy">Copy</button></pre>');
  if(scenario==='streaming')d.body.insertAdjacentHTML('beforeend','<button aria-label="Stop">Stop</button>');
  if(scenario==='busy')unit.insertAdjacentHTML('beforeend','<div aria-busy="true">Thinking</div>');
  main.append(host);d.querySelector('[data-testid="attachment-card"]')?.remove();
 };
 try{
  w.eval(source);
  const base={type:'chat',requestId:'one',textSessionId:'session',newConversation:false,composerMode:'chat',temporary:true,model:'auto',userMessage:'SRT sentence 1',timeout:10000};
  const call=msg=>new Promise(resolve=>handler(msg,{},resolve));
  const result=await call({...base,promptAttachment:{name:'prompt-instructions.txt',text:instructions}});
  assert.equal(await bytes,instructions);
  if(['complete','upload-remount','proof-lost'].includes(scenario)){
   assert.equal(result.ok,true,result.error);assert.match(result.content,/IMAGE TYPE/);assert.doesNotMatch(result.content,/ChatGPT said:|Read aloud|Regenerate response|VAI TRÒ/);
   if(scenario==='proof-lost'){assert.equal(result.textSessionProof,null);assert.equal(sent,1);return;}
   assert.ok(result.textSessionProof);
   const next=await call({...base,requestId:'two',userMessage:'SRT sentence 2',continueConversation:true,conversationUrl:w.location.href,textSessionProof:result.textSessionProof.proof});
   assert.equal(next.ok,true,next.error);assert.equal(sent,2);assert.equal(uploads,1);assert.equal(next.textSessionProof.proof,'two');
  }else{
   assert.equal(result.ok,false);assert.equal(sent,scenario.startsWith('upload-')?0:1);assert.match(result.error,scenario.startsWith('upload-')?/attachment|upload/i:/Timeout/);
  }
 }finally{dom.window.close();}
});
