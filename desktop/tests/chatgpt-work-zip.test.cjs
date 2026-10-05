const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
const zipHTML='<p class="Paragraph-kKnbIo" dir="auto"><span>Đã tạo các file TXT: </span><span class="contents" data-chatgpt-copy-reference="0" data-markdown-copy="contents"><span class="inline-flex items-center gap-1"><span data-file-reference="true" data-markdown-copy-text="image_prompts.zip" role="button" tabindex="0" aria-busy="false" aria-label="Download image_prompts.zip" class="InlineMentionFocusRing-j8iO1a inline cursor-interaction" data-state="closed" data-inline-mention-interactive=""><span class="break-words whitespace-normal"><span>image_prompts.zip</span></span></span></span></span><span>.</span></p>';
for(const scenario of ['complete','download-wait','download-failed','busy','streaming','old-only','hidden','multiple','missing'])test('Work ZIP output: '+scenario,async()=>{
 const dom=new JSDOM('<div role="group" aria-label="Composer mode"><button aria-pressed="false">Chat</button><button aria-pressed="true">Work</button></div><form><textarea id="prompt-textarea"></textarea><input type="file" accept=".txt"><button type="button" aria-label="Send">Send</button></form><main></main>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let handler,sent=0,uploads=0,downloads=0,clicks=0,release;
 const gate=new Promise(r=>release=r);
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
 Object.defineProperty(w.HTMLInputElement.prototype,'files',{get(){return this._files;},set(v){this._files=v;}});
 w.DataTransfer=class{constructor(){this.files=[];this.items={add:f=>this.files.push(f)};}};
 w.setTimeout=f=>setImmediate(f);
 d.execCommand=(cmd,_,text)=>{d.querySelector('textarea').value=text;return true;};
 d.querySelector('input').onchange=e=>{uploads++;const chip=d.createElement('div');chip.dataset.testid='attachment-card';chip.textContent=e.target.files[0].name;d.querySelector('form').append(chip);};
 const append=()=>{const el=d.createElement('div');el.dataset.markdownTextStyle='assistant-message';el.dataset.messageId='answer-'+sent;el.innerHTML=zipHTML;
  if(scenario==='busy')el.querySelector('[data-file-reference]').setAttribute('aria-busy','true');
  if(scenario==='hidden')el.querySelector('[data-file-reference]').hidden=true;
  if(scenario==='missing'){el.innerHTML='No file';el.dataset.localConversationFinalAssistant='true';}
  if(scenario==='multiple')el.insertAdjacentHTML('beforeend',zipHTML.replaceAll('image_prompts.zip','second.zip'));
  for(const link of el.querySelectorAll('[data-file-reference]'))link.onclick=()=>clicks++;
  d.querySelector('main').append(el);
 };
 if(scenario==='old-only')append();
 d.querySelector('[aria-label="Send"]').onclick=()=>{sent++;assert.match(d.querySelector('textarea').value,sent===1?/^001 /:/^006 /);if(scenario!=='old-only')append();if(scenario==='streaming')d.body.insertAdjacentHTML('beforeend','<button aria-label="Stop">Stop</button>');d.querySelector('[data-testid="attachment-card"]')?.remove();};
 w.chrome={runtime:{onMessage:{addListener:f=>handler=f},sendMessage:async m=>{
  if(m.type!=='downloadPromptZip')return {ok:true};downloads++;
  const clicked=await new Promise(resolve=>handler({type:'clickPromptZipDownload',requestId:m.requestId},{},resolve));assert.equal(clicked.ok,true);
  if(scenario==='download-wait')await gate;
  if(scenario==='download-failed')return {ok:false,error:'ZIP download interrupted'};
  return {ok:true,nativeDownload:{path:'/Downloads/flowkit-chatgpt/token/prompts.zip',token:'token'}};
 }}};
 try{
  w.eval(source);
  const call=msg=>new Promise(resolve=>handler(msg,{},resolve));
  const base={type:'chat',requestId:'first',textSessionId:'run',newConversation:false,composerMode:'work',temporary:false,downloadPromptZip:true,model:'auto',userMessage:'001 一\n\n002 二\n\n003 三\n\n004 四\n\n005 五',timeout:10000};
  let settled=false;const pending=call({...base,promptAttachment:{name:'prompt-instructions.txt',text:'Create numbered TXT files in ZIP'}}).then(r=>{settled=true;return r;});
  if(scenario==='download-wait'){for(let i=0;i<60&&!downloads;i++)await new Promise(r=>setImmediate(r));assert.equal(downloads,1);assert.equal(settled,false);release();}
  const result=await pending;
  const good=['complete','download-wait'].includes(scenario);assert.equal(result.ok,good,result.error);
  if(good){assert.ok(result.nativeDownload);assert.ok(result.textSessionProof);assert.equal(uploads,1);assert.equal(clicks,1);
   const next=await call({...base,requestId:'next',userMessage:'006 六',continueConversation:true,conversationUrl:w.location.href,textSessionProof:result.textSessionProof.proof});assert.equal(next.ok,true,next.error);assert.equal(uploads,1);assert.equal(sent,2);assert.equal(clicks,2);
  }else {assert.equal(sent,1);assert.equal(downloads,scenario==='download-failed'?1:0);}
 }finally{release();dom.window.close();}
});
