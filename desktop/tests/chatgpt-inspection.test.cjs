const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const dir=path.join(__dirname,'../../extensions/chatgpt');
function page(){
 const fixture=fs.readFileSync(path.join(__dirname,'fixtures/chatgpt-model-trigger.html'),'utf8');
 const dom=new JSDOM(fixture+'<div role="group" aria-label="Composer mode"><button aria-pressed="true">Chat</button><button>Work</button></div><textarea id="prompt-textarea"></textarea><button aria-label="Send" disabled></button><button aria-label="Temporary chat"></button>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,selected=0,sent=0;
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.closest('[hidden]')?null:d.body;}});
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f}}};w.setTimeout=f=>setImmediate(f);
 const picker=d.querySelector('[aria-label="Select ChatGPT model"]');picker.onclick=()=>{
  if(picker.getAttribute('aria-expanded')==='true'){picker.setAttribute('aria-expanded','false');d.querySelector('#menu')?.remove();return;}
  picker.setAttribute('aria-expanded','true');picker.setAttribute('aria-controls','menu');
  d.body.insertAdjacentHTML('beforeend','<div role="menu" id="menu"><button role="menuitemradio">GPT-6 Astra</button><button role="menuitemradio">GPT-6 Sol</button><button role="menuitemradio" aria-disabled="true">GPT Disabled</button><button role="menuitemradio">High</button><button role="menuitem">Settings</button></div>');
  d.querySelectorAll('#menu button').forEach(b=>b.onclick=()=>selected++);
 };
 d.querySelector('[aria-label="Send"]').onclick=()=>sent++;
 w.eval(fs.readFileSync(path.join(dir,'content.js'),'utf8'));
 return {dom,d,request:m=>new Promise(r=>listener(m,{},r)),counts:()=>({selected,sent})};
}
test('reads available model menu options, filters disabled/settings, closes menu without selecting or sending',async()=>{
 const p=page();const r=await p.request({type:'discoverModels'});
 assert.equal(r.ok,true);assert.deepEqual(Array.from(r.data.models),['GPT-6 Astra','GPT-6 Sol']);assert.deepEqual(Array.from(r.data.efforts),['high']);
 assert.equal(p.d.querySelector('[aria-label="Select ChatGPT model"]').getAttribute('aria-expanded'),'false');assert.deepEqual(p.counts(),{selected:0,sent:0});p.dom.window.close();
});
test('preflight checks empty composer without sending; missing editor and unknown model fail',async()=>{
 const p=page();let r=await p.request({type:'preflight',temporary:true,model:'GPT-6 Astra :: high',composerMode:'chat'});
 assert.equal(r.data.passed,true);p.d.querySelector('textarea').remove();r=await p.request({type:'preflight',temporary:true,model:'GPT Unknown',composerMode:'work'});
 assert.equal(r.data.passed,false);assert.ok(r.data.checks.some(c=>c.name==='Input editor'&&!c.ok));assert.ok(r.data.checks.some(c=>c.name==='Model'&&!c.ok));
 assert.deepEqual(p.counts(),{selected:0,sent:0});p.dom.window.close();
});

test('extension inspector excludes concurrent work and releases the lock after tab errors',async()=>{
 const vm=require('node:vm');let listener,socket,release;const requests=[];
 const saved={enabled:true,workers:[{id:'w1',tabId:1,state:'IDLE'}]};
 class WS{constructor(){this.readyState=1;socket=this;}send(m){requests.push(JSON.parse(m));}}
 const chrome={storage:{local:{get:async()=>saved,set:async()=>{}}},tabs:{get:async()=>({url:'https://chatgpt.com/'}),onRemoved:{addListener(){}},sendMessage:async(_,m)=>new Promise(resolve=>release=resolve)},runtime:{id:'ext',onMessage:{addListener:f=>listener=f},onStartup:{addListener(){}},onInstalled:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(dir,'background.js'),'utf8'),{chrome,WebSocket:WS,setTimeout,clearTimeout,setInterval(){},URL,console});
 const tick=()=>new Promise(r=>setImmediate(r));await tick();
 const send=m=>new Promise(resolve=>listener(m,{id:'ext'},resolve));
 const pending=send({type:'preflight',temporary:false});await tick();
 assert.equal((await send({type:'status'})).inspecting,true);
 await socket.onmessage({data:JSON.stringify({type:'chat',workerId:'w1',requestId:'blocked'})});
 assert.equal(requests.find(m=>m.type==='response').not_submitted,true);
 release({ok:false,error:'Tab unavailable'});const r=await pending;
 assert.equal(r.data.passed,false);assert.equal(r.data.reports[0].error,'Tab unavailable');assert.equal((await send({type:'status'})).inspecting,false);
});
