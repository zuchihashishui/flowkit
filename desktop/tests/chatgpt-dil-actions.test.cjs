const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
const toolbar=fs.readFileSync(path.join(__dirname,'fixtures/chatgpt-dil-actions.html'),'utf8');
for(const scenario of ['sibling','nested','old-toolbar','hidden','code-copy','streaming','busy','zip'])test('supplied DIL action toolbar: '+scenario,async()=>{
 const dom=new JSDOM('<div role="group" aria-label="Composer mode"><button aria-pressed="true">Chat</button></div><textarea id="prompt-textarea"></textarea><button aria-label="Send"></button><main><div id="thread"></div></main>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,clicks=0;const updates=[];
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.hidden?null:d.body;}});
 w.setTimeout=f=>setImmediate(f);if(!w.PointerEvent)w.PointerEvent=w.MouseEvent;
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f},sendMessage:async m=>{
  updates.push(m);if(m.type!=='downloadPromptZip')return {ok:true};
  const clicked=await new Promise(resolve=>listener({type:'clickPromptZipDownload',requestId:m.requestId},{},resolve));assert.equal(clicked.ok,true,clicked.error);
  assert.equal(clicked.activation,'click');
  return {ok:true,nativeDownload:{path:'/Downloads/flowkit-chatgpt/token/prompts.zip',token:'token'}};
 }}};
 d.execCommand=(cmd,_,value)=>{d.querySelector('textarea').value=value;};
 const answer=id=>'<div class="DilRenderer-tB76Jj DilResponseRoot-HfQrEh" data-dil-message-id="'+id+'"><p>Completed prompt</p></div>';
 if(scenario==='old-toolbar')d.querySelector('#thread').innerHTML='<section>'+answer('old')+toolbar+'</section>';
 d.querySelector('[aria-label="Send"]').onclick=()=>{
  const host=d.createElement('section');host.innerHTML=answer('new');const root=host.firstElementChild;
  if(!['old-toolbar','code-copy'].includes(scenario)){
   if(scenario==='nested'){const wrapper=d.createElement('div');wrapper.dataset.messageAuthorRole='assistant';wrapper.dataset.messageId='outer-new';root.replaceWith(wrapper);wrapper.append(root);wrapper.insertAdjacentHTML('afterend',toolbar);}
   else host.insertAdjacentHTML('beforeend',toolbar);
  }
  if(scenario==='hidden')host.querySelector('.turn-action-controls').hidden=true;
  if(scenario==='code-copy')root.insertAdjacentHTML('beforeend','<pre><code>Code</code>'+toolbar+'</pre>');
  if(scenario==='streaming')d.body.insertAdjacentHTML('beforeend','<button aria-label="Stop"></button>');
  if(scenario==='busy')host.insertAdjacentHTML('beforeend','<div aria-busy="true">Working</div>');
  if(scenario==='zip'){root.insertAdjacentHTML('beforeend','<span data-d-component="pressable" role="link" tabindex="0" aria-label="Open Tải image_prompts.zip">Tải image_prompts.zip</span>');root.querySelector('[role="link"]').onclick=()=>clicks++;}
  d.querySelector('#thread').append(host);
 };
 try{
  w.eval(source);
  const result=await new Promise(resolve=>listener({type:'chat',requestId:'r',userMessage:'001 Scene',newConversation:false,composerMode:'chat',temporary:false,timeout:15000,...(scenario==='zip'?{downloadPromptZip:true,textSessionId:'session'}:{})},{},resolve));
  const complete=['sibling','nested','zip'].includes(scenario);
  assert.equal(result.ok,complete,result.error);
  if(complete)assert.ok(updates.some(u=>u.completionEvidence==='response-actions'),'Must identify supplied toolbar as belonging to this response');
  if(scenario==='zip'){assert.equal(clicks,1);assert.ok(result.nativeDownload);}
  if(scenario==='old-toolbar')assert.ok(!updates.some(u=>u.completionEvidence==='response-actions'),'Old toolbar must not finish new answer');
 }finally{w.close();}
});
