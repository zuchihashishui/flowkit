const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const dir=path.resolve(__dirname,'../../extensions/chatgpt');
const tick=()=>new Promise(r=>setImmediate(r));
test('bridge OFF persists, blocks reconnect and ON reconnects; tab binding is validated',async()=>{
 let listener;const saved={enabled:false};const sockets=[];
 class WS{constructor(){this.readyState=0;sockets.push(this);}close(){this.readyState=3;}send(){}}
 const behavior=[];
 const chrome={sidePanel:{setPanelBehavior:async opts=>behavior.push(opts)},storage:{local:{get:async()=>saved,set:async d=>Object.assign(saved,d)}},
 tabs:{get:async id=>({id,url:id===7?'https://chatgpt.com/':'https://example.com/',title:'ChatGPT'})},
 runtime:{id:'extension',onMessage:{addListener:f=>listener=f},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
 alarms:{create(){},onAlarm:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(dir,'background.js'),'utf8'),{chrome,WebSocket:WS,setInterval(){},setTimeout,URL,console});
 await tick();assert.equal(sockets.length,0);assert.equal(behavior[0].openPanelOnActionClick,true);
 const send=m=>new Promise(resolve=>listener(m,{id:'extension'},resolve));
 assert.equal((await send({type:'status'})).enabled,false);
 await send({type:'setEnabled',enabled:true});assert.equal(saved.enabled,true);assert.equal(sockets.length,1);
 sockets[0].readyState=1;
 await send({type:'setEnabled',enabled:false});assert.equal(sockets[0].readyState,3);assert.equal(saved.enabled,false);
 assert.match((await send({type:'reconnect'})).error,/Turn the bridge on/);
 assert.match((await send({type:'selectTab',tabId:8})).error,/Select a ChatGPT/);
 await send({type:'selectTab',tabId:7});assert.equal(saved.tabId,7);
 assert.equal(listener({type:'setEnabled',enabled:true},{id:'extension',tab:{id:7}},()=>{}),false);
});
test('popup and side panel expose controls and render activity safely',async()=>{
 for(const page of ['popup.html','side_panel.html']){
 const dom=new JSDOM(fs.readFileSync(path.join(dir,page),'utf8'),{runScripts:'outside-only'});
 const calls=[];dom.window.chrome={runtime:{sendMessage:async m=>{calls.push(m);return {enabled:true,connected:true,busy:false,tabId:7,tabTitle:'ChatGPT',completed:2,events:[{time:new Date().toISOString(),message:'<script>bad</script>'}]};}},tabs:{query:async()=>[{id:7,title:'ChatGPT'}]}};
 dom.window.setInterval=()=>{};dom.window.eval(fs.readFileSync(path.join(dir,'panel.js'),'utf8'));await tick();
 assert.equal(dom.window.document.getElementById('connection').textContent,'Connected');
 assert.equal(dom.window.document.querySelector('#activity script'),null);
 dom.window.document.getElementById('enabled').click();await tick();
 assert.ok(calls.some(m=>m.type==='setEnabled' && m.enabled===false));
 assert.equal(dom.window.document.getElementById('sidepanel').hidden,page==='side_panel.html');dom.window.close();
 }
});

test('toolbar action opens a dedicated ChatGPT panel, with no popup interception',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
 assert.equal(manifest.action.default_popup,undefined);
 assert.equal(manifest.side_panel.default_path,'side_panel.html');
 assert.ok(manifest.permissions.includes('sidePanel'));
 assert.match(fs.readFileSync(path.join(dir,manifest.side_panel.default_path),'utf8'),/FLOW KIT <span>\/ ChatGPT/);
});
