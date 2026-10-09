const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
const fixture=fs.readFileSync(path.join(__dirname,'fixtures/chatgpt-model-trigger.html'),'utf8');
for(const scenario of ['instant-submenu','fixed-menu','instant-dropdown','current','already-selected','change-model','change-effort','both','missing-option','disabled-option','unverified','unrelated-menu','ambiguous','reset-before-send'])test(`model picker: ${scenario}`,async()=>{
 const dom=new JSDOM('<div role="group" aria-label="Composer mode"><button aria-pressed="true">Chat</button><button aria-pressed="false">Work</button></div>'+fixture+'<textarea id="prompt-textarea"></textarea><button aria-label="Send" type="submit">Send</button><button aria-haspopup="menu" id="unrelated-trigger">Account</button>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,typed=0,sent=0,opened=0,modelClicks=0,effortClicks=0,unrelatedClicks=0,submenuClicks=0;
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.closest('[hidden]')||scenario==='fixed-menu'&&this.matches('[role="menu"]')?null:d.body;}});
 w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{width:100,height:30}];};
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f}}};w.setTimeout=fn=>setImmediate(fn);
 const picker=d.querySelector('[aria-label="Select ChatGPT model"]');
 if(['instant-dropdown','instant-submenu'].includes(scenario)){
  picker.removeAttribute('aria-label');picker.removeAttribute('data-codex-intelligence-trigger');picker.removeAttribute('data-testid');
  picker.innerHTML='<span class="ComposerDropdownLabel-PL6NWE"><span class="ModelPickerTriggerContent-MFmRQj"><span aria-hidden="true">Thinking effort</span><span class="ModelPickerTriggerLabel-xR9gDc"><span class="ModelPickerTriggerModelGroup-uBOG5R"><span>Instant</span></span></span></span></span>';
 }
 function close(){d.querySelector('#model-menu')?.remove();picker.setAttribute('aria-expanded','false');}
 if(scenario==='unrelated-menu')d.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">Test Model</button></div>');
 d.querySelector('#unrelated-trigger').onclick=()=>unrelatedClicks++;
 const unrelated=d.querySelector('[role="menu"] button');if(unrelated)unrelated.onclick=()=>unrelatedClicks++;
 picker.onclick=()=>{
  if(picker.getAttribute('aria-expanded')==='true'){close();return;}
  opened++;picker.setAttribute('aria-expanded','true');picker.setAttribute('aria-controls','model-menu');
  const menu=d.createElement('div');menu.id='model-menu';menu.setAttribute('role','menu');d.body.append(menu);
  if(!['missing-option','unrelated-menu'].includes(scenario)){
   const b=d.createElement('button');b.setAttribute('role','menuitemradio');b.innerHTML='<span>'+(['instant-dropdown','instant-submenu'].includes(scenario)?'GPT-5.6 Sol':'Test Model')+'</span><span>Model description</span>';
   if(scenario==='disabled-option')b.setAttribute('aria-disabled','true');
   b.onclick=()=>{modelClicks++;if(scenario!=='unverified')picker.querySelector('[class*="ModelPickerTriggerModelText-"], [class*="ModelPickerTriggerModelGroup-"]').textContent=['instant-dropdown','instant-submenu'].includes(scenario)?'GPT-5.6 Sol':'Test Model';close();};
 if(scenario==='instant-submenu'){
    const family=d.createElement('button');family.setAttribute('role','menuitem');family.innerHTML='<span>Instant</span><span>Choose a model</span>';
    family.onclick=()=>{submenuClicks++;menu.replaceChildren(b);};menu.append(family);
   }else menu.append(b);
   if(scenario==='ambiguous')menu.append(b.cloneNode(true));
  }
  for(const [key,label] of [['high','High'],['ultra','Ultra']]){const b=d.createElement('button');b.setAttribute('role','menuitemradio');b.textContent=label;b.onclick=()=>{effortClicks++;picker.setAttribute('data-selected-reasoning-effort',key);close();};menu.append(b);}
 };
 d.execCommand=(cmd,_,text)=>{if(cmd==='insertText'){typed++;d.querySelector('textarea').value=text;if(scenario==='reset-before-send')picker.setAttribute('data-selected-reasoning-effort','low');}};
 d.querySelector('[aria-label="Send"]').onclick=()=>{sent++;d.body.insertAdjacentHTML('beforeend','<div data-local-conversation-final-assistant="true" data-markdown-text-style="assistant-message">Answer</div>');};
 const model=['instant-dropdown','instant-submenu'].includes(scenario)?'GPT-5.6 Sol':scenario==='current'?'auto':scenario==='already-selected'?'GPT-6 Astra :: High':scenario==='change-effort'||scenario==='reset-before-send'?'GPT-6 Astra :: Ultra':scenario==='both'?'Test Model :: Ultra':'Test Model';
 w.eval(source);const result=await new Promise(resolve=>listener({type:'chat',newConversation:false,userMessage:'Prompt',model,timeout:10000},{},resolve));
 const failure=['missing-option','disabled-option','unrelated-menu','ambiguous'].includes(scenario);
 assert.equal(result.ok,!failure,result.error);assert.equal(sent,failure?0:1);assert.equal(unrelatedClicks,0);
 if(['current','already-selected'].includes(scenario))assert.equal(opened,0);
 if(['unverified','reset-before-send'].includes(scenario))assert.equal(sent,1,'A stale model label must not block submission');
 if(scenario==='instant-submenu'){assert.equal(opened,1);assert.equal(submenuClicks,1);assert.equal(modelClicks,1);}
 if(scenario==='change-model')assert.equal(modelClicks,1);
 if(scenario==='change-effort'){assert.equal(effortClicks,1);assert.equal(modelClicks,0);}
 if(scenario==='both'){assert.equal(modelClicks,1);assert.equal(effortClicks,1);}
 if(failure&&scenario!=='reset-before-send')assert.equal(typed,0);
 dom.window.close();
});
