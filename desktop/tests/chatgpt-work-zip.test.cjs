const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
const zipHTML='<p class="Paragraph-kKnbIo" dir="auto"><span>Đã tạo các file TXT: </span><span class="contents" data-chatgpt-copy-reference="0" data-markdown-copy="contents"><span class="inline-flex items-center gap-1"><span data-file-reference="true" data-markdown-copy-text="image_prompts.zip" role="button" tabindex="0" aria-busy="false" aria-label="Download image_prompts.zip" class="InlineMentionFocusRing-j8iO1a inline cursor-interaction" data-state="closed" data-inline-mention-interactive=""><span class="break-words whitespace-normal"><span>image_prompts.zip</span></span></span></span></span><span>.</span></p>';
const dilZipHTML='<p data-d-component="text"><span data-d-stream-word="">Đã tạo đầy đủ 5 file TXT (191.txt–195.txt) và đóng gói thành ZIP.</span></p><p data-d-component="text"><span data-d-component="pressable" aria-label="Open Tải image_prompts.zip" role="link" tabindex="0"><span data-d-text-decoration="underline-dotted"><span data-d-stream-word="">Tải </span><span data-d-stream-word="">image_prompts.zip</span></span><svg></svg></span></p>';
for(const markup of ['legacy','dil','nested-dil'])for(const composerMode of ['work','chat'])for(const scenario of ['complete','unrelated-busy','remount','preview','download-wait','download-failed','busy','streaming','old-only','old-remount','disabled','hidden','multiple','missing'])test(markup+' '+composerMode+' ZIP output: '+scenario,async()=>{
 const dom=new JSDOM('<div role="group" aria-label="Composer mode"><button aria-pressed="false">Chat</button><button aria-pressed="true">Work</button></div><form><textarea id="prompt-textarea"></textarea><input type="file" accept=".txt"><button type="button" aria-label="Send">Send</button></form><main></main>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;for(const b of d.querySelectorAll('[aria-pressed]'))b.setAttribute('aria-pressed',String(b.textContent.toLowerCase()===composerMode));let handler,sent=0,uploads=0,downloads=0,clicks=0,previewClicks=0,release;
 const gate=new Promise(r=>release=r);

 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
 Object.defineProperty(w.HTMLInputElement.prototype,'files',{get(){return this._files;},set(v){this._files=v;}});
 w.DataTransfer=class{constructor(){this.files=[];this.items={add:f=>this.files.push(f)};}};
 w.setTimeout=f=>setImmediate(f);
 d.execCommand=(cmd,_,text)=>{d.querySelector('textarea').value=text;return true;};
 d.querySelector('input').onchange=e=>{uploads++;const chip=d.createElement('div');chip.dataset.testid='attachment-card';chip.textContent=e.target.files[0].name;d.querySelector('form').append(chip);};
 const append=()=>{const el=d.createElement('div');el.dataset.markdownTextStyle='assistant-message';el.dataset.messageId='answer-'+sent;el.innerHTML=markup==='legacy'?zipHTML:dilZipHTML;
  if(markup!=='legacy'){delete el.dataset.markdownTextStyle;delete el.dataset.messageId;el.className='DilRenderer-tB76Jj DilResponseRoot-HfQrEh Reveal-k2IWvM';el.dataset.dilMessageId='answer-'+sent;}
  const fileSelector=markup==='legacy'?'[data-file-reference]':'[role="link"]';
  if(scenario==='busy')el.querySelector(fileSelector).setAttribute('aria-busy','true');
  if(scenario==='disabled')el.querySelector(fileSelector).setAttribute('aria-disabled','true');
  if(scenario==='hidden')el.querySelector(fileSelector).hidden=true;
  if(scenario==='missing'){el.innerHTML='No file';el.dataset.localConversationFinalAssistant='true';}
  if(scenario==='multiple')el.insertAdjacentHTML('beforeend',(markup==='legacy'?zipHTML:dilZipHTML).replaceAll('image_prompts.zip','second.zip'));
  for(const link of el.querySelectorAll(fileSelector)){link.onclick=()=>{clicks++;if(scenario==='preview'){
   const other=d.createElement('div');other.setAttribute('role','dialog');other.innerHTML='<p>unrelated.zip</p><button>Download</button>';other.querySelector('button').onclick=()=>assert.fail('Unrelated preview was clicked');d.body.append(other);
   const preview=d.createElement('div');preview.setAttribute('role','dialog');preview.innerHTML='<p>image_prompts.zip</p><button aria-label="Download file">Download</button>';preview.querySelector('button').onclick=()=>{previewClicks++;preview.remove();};d.body.append(preview);
  }};}
  if(markup==='nested-dil'){const wrapper=d.createElement('div');wrapper.dataset.messageAuthorRole='assistant';wrapper.dataset.messageId='answer-'+sent;wrapper.append(el);d.querySelector('main').append(wrapper);}else d.querySelector('main').append(el);
 };
 if(scenario==='unrelated-busy'){const old=d.createElement('aside');old.innerHTML='<div aria-busy="true">Old file preview loading</div><div role="status">Working</div>';d.body.append(old);}
 if(['old-only','old-remount'].includes(scenario))append();
 d.querySelector('[aria-label="Send"]').onclick=()=>{sent++;assert.match(d.querySelector('textarea').value,sent===1?/^001 /:/^006 /);if(!['old-only','old-remount'].includes(scenario))append();if(scenario==='old-remount')d.querySelector('main').innerHTML=d.querySelector('main').innerHTML;if(scenario==='streaming')d.body.insertAdjacentHTML('beforeend','<button aria-label="Stop">Stop</button>');d.querySelector('[data-testid="attachment-card"]')?.remove();};
 w.chrome={runtime:{onMessage:{addListener:f=>handler=f},sendMessage:async m=>{
  if(m.type!=='downloadPromptZip')return {ok:true};downloads++;
  if(scenario==='remount'){const old=d.querySelector('main').lastElementChild;const fresh=old.cloneNode(true);for(const link of fresh.querySelectorAll('[data-file-reference], [role="link"]'))link.onclick=()=>clicks++;old.replaceWith(fresh);}
  const clicked=await new Promise(resolve=>handler({type:'clickPromptZipDownload',requestId:m.requestId},{},resolve));assert.equal(clicked.ok,true,clicked.error);
  assert.equal(clicked.activation,'click');assert.equal(clicks,downloads);
  if(scenario==='preview'){
   const continued=await new Promise(resolve=>handler({type:'continuePromptZipDownload',requestId:m.requestId},{},resolve));assert.equal(continued.ok,true,continued.error);assert.equal(continued.clicked,true);
   const again=await new Promise(resolve=>handler({type:'continuePromptZipDownload',requestId:m.requestId},{},resolve));assert.equal(again.clicked,false);assert.equal(previewClicks,downloads);
  }
  if(scenario==='download-wait')await gate;
  if(scenario==='download-failed')return {ok:false,error:'ZIP download interrupted'};
  return {ok:true,nativeDownload:{path:'/Downloads/flowkit-chatgpt/token/prompts.zip',token:'token'}};
 }}};
 try{
  w.eval(source);
  const call=msg=>new Promise(resolve=>handler(msg,{},resolve));
  const base={type:'chat',requestId:'first',textSessionId:'run',newConversation:false,composerMode,temporary:false,downloadPromptZip:true,model:'auto',userMessage:'001 一\n\n002 二\n\n003 三\n\n004 四\n\n005 五',timeout:10000};
  let settled=false;const pending=call({...base,promptAttachment:{name:'prompt-instructions.txt',text:'Create numbered TXT files in ZIP'}}).then(r=>{settled=true;return r;});
  if(scenario==='download-wait'){for(let i=0;i<60&&!downloads;i++)await new Promise(r=>setImmediate(r));assert.equal(downloads,1);assert.equal(settled,false);release();}
  const result=await pending;
  const good=['complete','unrelated-busy','remount','preview','download-wait'].includes(scenario);assert.equal(result.ok,good,result.error);
  if(good){assert.ok(result.nativeDownload);assert.ok(result.textSessionProof);assert.equal(uploads,1);assert.equal(clicks,1);
   const next=await call({...base,requestId:'next',userMessage:'006 六',continueConversation:true,conversationUrl:w.location.href,textSessionProof:result.textSessionProof.proof});assert.equal(next.ok,true,next.error);assert.equal(uploads,1);assert.equal(sent,2);assert.equal(clicks,2);
  }else {assert.equal(sent,1);assert.equal(downloads,scenario==='download-failed'?1:0);}
 }finally{release();dom.window.close();}
});
