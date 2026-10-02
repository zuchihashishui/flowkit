const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const fixture=fs.readFileSync(path.join(__dirname,'fixtures/chatgpt-conversation.html'),'utf8');
for(const mode of ['uploaded','old-only','virtualized','streaming','paragraphs'])test(`ChatGPT supplied response markup: ${mode}`,async()=>{
 const dom=new JSDOM('<textarea id="prompt-textarea"></textarea><button aria-label="Send" type="submit">Send</button><main></main>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let handler;
 const input=d.querySelector('textarea'),main=d.querySelector('main');
 if(['old-only','virtualized'].includes(mode))main.innerHTML=fixture;
 w.chrome={runtime:{onMessage:{addListener:f=>handler=f}}};w.setTimeout=fn=>setImmediate(fn);
 Object.defineProperty(input,'offsetParent',{get:()=>d.body});
 d.execCommand=(cmd,_,value)=>{if(cmd==='insertText')input.value=value;if(cmd==='delete')input.value='';};
 d.querySelector('button').onclick=()=>{
  if(mode==='old-only'){
   // Re-rendering the SAME message must not make it a new answer.
   main.innerHTML=fixture;return;
  }
  main.innerHTML=fixture;
  if(mode==='virtualized')main.querySelector('[data-chatgpt-selection-message-id]').setAttribute('data-chatgpt-selection-message-id','new-answer-id');
  if(mode==='paragraphs')main.querySelector('[data-markdown-text-style]').innerHTML='<p>First paragraph.</p><p>Second paragraph.</p><button>Copy</button>';
  if(mode==='streaming'){const stop=d.createElement('button');stop.setAttribute('aria-label','Stop');d.body.append(stop);}
 };
 w.document.body.insertAdjacentHTML('afterbegin','<div role="group" aria-label="Composer mode"><button aria-pressed="true">Chat</button><button aria-pressed="false">Work</button></div>');
 for(const b of w.document.querySelectorAll('[aria-label="Composer mode"] button'))Object.defineProperty(b,'offsetParent',{get:()=>w.document.body});
 w.eval(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8'));
 const r=await new Promise(resolve=>handler({type:'chat',userMessage:'Hello',newConversation:false,timeout:10000},{},resolve));
 if(['old-only','streaming'].includes(mode)){assert.equal(r.ok,false);assert.match(r.error,/Timeout/);}
 else{assert.equal(r.ok,true);assert.equal(r.content,mode==='paragraphs'?'First paragraph.\nSecond paragraph.':'Hello! Chào bạn 👋 Hôm nay bạn muốn mình giúp gì?');}
 dom.window.close();
});
