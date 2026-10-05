const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(process.env.FLOWKIT_SEND_CONTENT||path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
const cases=['ready','hidden-spinner','split-name','other-send','remount','delayed-send','upload-busy','upload-error','missing-card','disabled-send','no-ack','user-ack'];
for(const kind of ['TXT','JSON'])for(const scenario of cases)test(`Work ${kind} upload and Send: ${scenario}`,async()=>{
 const dom=new JSDOM('<div role="group" aria-label="Composer mode"><button aria-pressed="true">Work</button></div><div data-type="unified-composer"><form><div class="ProseMirror" contenteditable="true" role="textbox" data-composer-markdown aria-label="Work with ChatGPT"></div><input type="file"><button type="button" aria-label="Send">Send</button></form></div><main></main>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document,scope=d.querySelector('[data-type]'),button=d.querySelector('[aria-label="Send"]');
 let handler,clicks=0,wrongClicks=0,uploads=0,edits=0,waits=0;const progress=[],notifications=[];
 const text='001 通帳にはまとまったお金が残っている。\n\n002 家の修理代を払う。\n\n003 解約すると損が出る。';
 const name=kind==='TXT'?'prompt-instructions.txt':'transcript-11111111-1111-1111-1111-111111111111.json';
 const editor=()=>d.querySelector('[contenteditable]');
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
 Object.defineProperty(w.HTMLInputElement.prototype,'files',{get(){return this._files;},set(v){this._files=v;}});
 w.DataTransfer=class{constructor(){this.files=[];this.items={add:f=>this.files.push(f)};}};w.TextDecoder=TextDecoder;
 w.setTimeout=(f,ms)=>setImmediate(()=>{if(uploads&&ms===300&&scenario==='delayed-send'&&++waits===3)button.disabled=false;f();});
 d.execCommand=(_,__,value)=>{edits++;editor().replaceChildren(...value.split('\n').map(line=>{const p=d.createElement('p');p.textContent=line;return p;}));if(scenario==='remount')button.disabled=false;return true;};
 d.querySelector('input').onchange=e=>{
  uploads++;assert.equal(e.target.files[0].name,name);assert.equal(e.target.files[0].type,kind==='TXT'?'text/plain':'application/json');
  if(scenario==='remount'){editor().replaceWith(editor().cloneNode(false));button.disabled=true;}
  if(['delayed-send','disabled-send'].includes(scenario))button.disabled=true;
  if(scenario==='missing-card')return;
  const card=d.createElement('div');card.dataset.testid='attachment-card';card.textContent=name;
  if(scenario==='split-name'){card.replaceChildren();for(const part of [name.slice(0,name.lastIndexOf('.')),' ',name.slice(name.lastIndexOf('.'))]){const span=d.createElement('span');span.textContent=part;card.append(span);}}
  if(scenario==='hidden-spinner')card.insertAdjacentHTML('beforeend','<span hidden role="progressbar"></span><span class="animate-spin" style="display:none"></span>');
  if(scenario==='upload-busy')card.insertAdjacentHTML('beforeend','<span role="progressbar"></span>');
  if(scenario==='upload-error')card.append(' Upload failed');
  scope.prepend(card);
 };
 const answer=()=>d.querySelector('main').insertAdjacentHTML('beforeend','<div data-markdown-text-style="assistant-message" data-message-id="new-answer" data-local-conversation-final-assistant="true">Done</div>');
 button.onclick=()=>{
  clicks++;assert.equal(uploads,1);assert.match(editor().textContent,/001 .*002 .*003 /);
  if(scenario==='no-ack')return;
  if(scenario==='user-ack'){
   const user=d.createElement('div');user.dataset.userMessageBubble='true';user.dataset.messageId='new-user';user.innerHTML=editor().innerHTML;d.querySelector('main').append(user);
  }else answer();
 };
 if(scenario==='other-send'){const decoy=d.createElement('button');decoy.type='submit';decoy.setAttribute('aria-label','Send');decoy.onclick=()=>wrongClicks++;d.body.prepend(decoy);}
 w.chrome={runtime:{onMessage:{addListener:f=>handler=f},sendMessage:async m=>{
  notifications.push(m.type);if(m.type==='jobProgress')progress.push(m);
  if(m.type==='requestSubmitted'&&scenario==='user-ack')answer();return {ok:true};
 }}};
 try{
  w.eval(source);
  const upload=kind==='TXT'?{textSessionId:'run',promptAttachment:{name,text:'Instructions'},downloadPromptZip:true}:{attachment:{name,base64:Buffer.from('{"words":[]}').toString('base64')}};
  const result=await new Promise(resolve=>handler({type:'chat',requestId:'send-test',newConversation:false,composerMode:'work',temporary:false,model:'auto',userMessage:text,timeout:10000,...upload},{},resolve));
  const blocked=['upload-busy','upload-error','missing-card','disabled-send'].includes(scenario);
  assert.equal(clicks,blocked?0:1,result.error);assert.equal(wrongClicks,0);assert.equal(uploads,1);
  if(blocked){assert.equal(result.ok,false);assert.equal(result.submitted,false);assert.equal(notifications.includes('requestSubmitted'),false);assert.match(result.error,/upload|attachment|disabled/i);}
  else if(scenario==='no-ack'){assert.equal(result.ok,false);assert.equal(result.submitted,true);assert.equal(result.phase,'VERIFYING_SUBMISSION');assert.match(result.error,/15 seconds/);assert.equal(notifications.includes('requestSubmitted'),false);}
  else {assert.equal(notifications.filter(t=>t==='requestSubmitted').length,1,result.error);assert.ok(progress.some(p=>p.phase==='VERIFYING_SUBMISSION'));if(kind==='JSON')assert.equal(result.ok,true,result.error);else assert.match(result.error,/zip/i);}
  if(scenario==='remount')assert.equal(edits,2);
  if(scenario==='disabled-send')assert.ok(progress.some(p=>p.phase==='WAITING_SEND_BUTTON'&&/disabled/.test(p.detail)));
 }finally{dom.window.close();}
});
