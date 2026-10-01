const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
for(const streaming of [false,true])test(`ChatGPT extension: ${streaming?'partial timeout fails':'completed answer returns'}`,async()=>{
 const dom=new JSDOM('<textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window;let handler;
 w.chrome={runtime:{onMessage:{addListener:fn=>handler=fn}}};w.setTimeout=fn=>setImmediate(fn);
 const input=w.document.querySelector('textarea');Object.defineProperty(input,'offsetParent',{get:()=>w.document.body});
 w.document.execCommand=(cmd,_,value)=>{if(cmd==='insertText')input.value=value;if(cmd==='delete')input.value='';};
 w.document.querySelector('button').onclick=()=>{
  const answer=w.document.createElement('div');answer.dataset.messageAuthorRole='assistant';answer.textContent='A complete response';w.document.body.append(answer);
  if(streaming){const stop=w.document.createElement('button');stop.dataset.testid='stop-button';w.document.body.append(stop);}
 };
 w.eval(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8'));
 const response=await new Promise(resolve=>handler({type:'chat',userMessage:'hello',newConversation:false,timeout:10000},{},resolve));
 assert.equal(response.ok,!streaming);
 if(streaming)assert.match(response.error,/Timeout/);else assert.equal(response.content,'A complete response');
 dom.window.close();
});
test('ChatGPT settings sends test and renders history as text',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'});
 const w=dom.window,calls=[];w.confirm=()=>true;
 w.studio={chatgptAction:async cmd=>{calls.push(cmd);return '';},api:async(method,route)=>{calls.push(route);return route.endsWith('/history')?{requests:[{response:'<script>bad</script>'}]}:route.endsWith('/test')?{response:'OK'}:{available:true,extensionConnected:true};}};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/chatgpt.js'),'utf8'));
 for(const id of ['cg-status','cg-test','cg-history','cg-resume','cg-extension'])await w.document.getElementById(id).onclick();
 assert(calls.includes('/api/chatgpt/test'));assert(calls.includes('/api/chatgpt/resume'));assert(calls.includes('extension'));
 assert.equal(w.document.getElementById('cg-history-output').querySelector('script'),null);dom.window.close();
});
for(const label of ['Work with ChatGPT','Ask ChatGPT'])
for(const mode of ['complete','streaming','disabled','long','hidden-duplicate'])test(`User supplied ${label} / Send / Stop markup: ${mode}`,async()=>{
 const dom=new JSDOM('<div contenteditable="true" aria-multiline="true" dir="auto" role="textbox" spellcheck="true" translate="no" class="ProseMirror" data-composer-markdown="" aria-label="Work with ChatGPT" data-virtualkeyboard="true"><p data-empty-paragraph="true" data-placeholder="Work with ChatGPT" class="placeholder"><br class="ProseMirror-trailingBreak"></p></div><div class="flex items-center"><button type="submit" aria-label="Send"><svg></svg></button></div>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window;let handler,clicks=0;
 w.document.querySelector('.ProseMirror').setAttribute('aria-label',label);
 w.document.querySelector('[data-placeholder]').setAttribute('data-placeholder',label);
 w.chrome={runtime:{onMessage:{addListener:fn=>handler=fn}}};w.setTimeout=fn=>setImmediate(fn);
 const editor=w.document.querySelector('.ProseMirror'),button=w.document.querySelector('button');
 Object.defineProperty(editor,'offsetParent',{get:()=>w.document.body});
 if(mode==='hidden-duplicate'){const hidden=editor.cloneNode(true);hidden.hidden=true;w.document.body.prepend(hidden);}

 w.document.execCommand=(cmd,_,value)=>{if(cmd==='insertText')editor.textContent=value;if(cmd==='delete')editor.textContent='';};
 if(mode==='disabled')button.setAttribute('aria-disabled','true');
 button.onclick=()=>{clicks++;const answer=w.document.createElement('div');answer.dataset.messageAuthorRole='assistant';answer.textContent='New answer';w.document.body.append(answer);if(mode==='streaming'){button.type='button';button.setAttribute('aria-label','Stop');}};
 w.eval(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8'));
 const text=mode==='long'?'Long script. '.repeat(500):'Hello from Flowkit';
 const result=await new Promise(resolve=>handler({type:'chat',userMessage:text,newConversation:false,timeout:10000},{},resolve));
 assert.equal(editor.textContent,text);
 assert.equal(clicks,mode==='disabled'?0:1);
 assert.equal(result.ok,['complete','long','hidden-duplicate'].includes(mode));
 if(mode==='streaming')assert.match(result.error,/Timeout/);
 if(mode==='disabled')assert.match(result.error,/disabled/);
 dom.window.close();
});
