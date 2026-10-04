const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');

for(const scenario of ['long-chat','long-work','truncated','stale-node','multiline','empty-paragraphs','empty-divs','trailing-breaks','hard-breaks','nested-blocks','dropped-blank-line','changed-same-length','changes-before-send'])test(`ChatGPT input retention: ${scenario}`,async()=>{
 const mode=scenario==='long-work'?'Work':'Chat';
 const dom=new JSDOM(`<div role="group" aria-label="Composer mode"><button aria-pressed="true">${mode}</button></div><div contenteditable="true" class="ProseMirror" role="textbox" data-composer-markdown aria-label="${mode==='Work'?'Work with ChatGPT':'Ask ChatGPT'}"><p>Old content</p></div><button aria-label="Send">Send</button>`,{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,sent=0,insertions=0,typing=false,waits=0;
 const input=()=>d.querySelector('[contenteditable]'),button=d.querySelector('[aria-label="Send"]');
 const paragraphs=['empty-paragraphs','empty-divs','trailing-breaks','nested-blocks','dropped-blank-line'].includes(scenario);
 const sections=Array.from({length:10},(_,i)=>`${i+1}. Giữ nguyên tiếng Nhật; chia Scene từ 3–15 giây, không bỏ sót lời.`);
 const multiline=sections.join('\n\n').padEnd(3333,'語'); // Nine blank lines: the old reader reports 3324.
 const text=scenario.startsWith('long')?'日本語の原稿です。'.repeat(600):paragraphs?multiline:scenario==='hard-breaks'?'第一行\n第二行\n\n最後の行':scenario==='multiline'?'第一段落\n第二段落\n最終段落':'The complete original prompt';
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return d.body;}});
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f}}};
 w.setTimeout=(fn,ms)=>setImmediate(()=>{
  if(typing&&ms===300&&scenario==='changes-before-send'){
   input().textContent='Stale content';button.disabled=false;
  }
  if(typing&&ms===250&&scenario==='stale-node'&&++waits===1)input().outerHTML='<div contenteditable="true" class="ProseMirror" role="textbox" data-composer-markdown><p>Restored old content</p></div>';
  fn();
 });
 d.execCommand=(cmd,_,value)=>{
  assert.equal(cmd,'insertText','Use the browser editor command for all prompt lengths');
  assert.equal(w.getSelection().getRangeAt(0).commonAncestorContainer,input(),'Selection must be scoped to the input');
  insertions++;typing=true;
  if(paragraphs||scenario==='multiline'){
   const lines=(scenario==='dropped-blank-line'?value.replace('\n\n','\n'):value).split('\n');
   input().replaceChildren(...lines.map(line=>{
    const p=d.createElement(scenario==='empty-divs'?'div':'p');p.textContent=line;
    if(!line&&scenario!=='empty-paragraphs'){const br=d.createElement('br');if(scenario!=='empty-divs')br.className='ProseMirror-trailingBreak';p.append(br);}
    return p;
   }));
   if(scenario==='nested-blocks'){const wrapper=d.createElement('div');wrapper.append(...input().childNodes);input().append(wrapper);}
  }else if(scenario==='hard-breaks'){
   const p=d.createElement('p');value.split('\n').forEach((line,i)=>{if(i)p.append(d.createElement('br'));p.append(d.createTextNode(line));});
   const br=d.createElement('br');br.className='ProseMirror-trailingBreak';p.append(br);input().replaceChildren(p);
  }else if(scenario==='changed-same-length'){
   input().textContent=value.replace('complete','modified');
  }else input().textContent=scenario==='truncated'?value.slice(0,5):value;
  if(scenario==='changes-before-send')button.disabled=true;
  return true;
 };
 button.onclick=()=>{sent++;d.body.insertAdjacentHTML('beforeend','<div data-local-conversation-final-assistant="true" data-markdown-text-style="assistant-message">Answer</div>');};
 w.eval(source);
 const result=await new Promise(resolve=>listener({type:'chat',userMessage:text,composerMode:mode.toLowerCase(),timeout:10000},{},resolve));
 const fails=['truncated','stale-node','dropped-blank-line','changed-same-length','changes-before-send'].includes(scenario);
 assert.equal(result.ok,!fails,result.error);assert.equal(sent,fails?0:1);assert.equal(insertions,1);
 if(fails)assert.match(result.error,/did not retain the complete prompt.*No prompt was sent/);
 dom.window.close();
});
