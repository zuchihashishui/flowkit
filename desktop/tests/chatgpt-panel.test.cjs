const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const dir=path.resolve(__dirname,'../../extensions/chatgpt');
const tick=()=>new Promise(r=>setImmediate(r));
test('bridge OFF persists without accepting work; pool tab binding is validated',async()=>{
 let listener;const saved={enabled:false};const sockets=[];
 class WS{constructor(){this.readyState=0;sockets.push(this);}close(){this.readyState=3;}send(){}}
 const behavior=[];
 const chrome={sidePanel:{setPanelBehavior:async opts=>behavior.push(opts)},storage:{local:{get:async()=>saved,set:async d=>Object.assign(saved,d)}},
 tabs:{onRemoved:{addListener(){}},get:async id=>({id,url:id===7?'https://chatgpt.com/':'https://example.com/',title:'ChatGPT'})},
 runtime:{id:'extension',onMessage:{addListener:f=>listener=f},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
 alarms:{create(){},onAlarm:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(dir,'background.js'),'utf8'),{chrome,WebSocket:WS,setInterval(){},setTimeout,URL,console});
 await tick();assert.equal(sockets.length,1);assert.equal(behavior[0].openPanelOnActionClick,true);
 const send=m=>new Promise(resolve=>listener(m,{id:'extension'},resolve));
 assert.equal((await send({type:'status'})).enabled,false);
 assert.equal((await send({type:'status'})).composerMode,'chat');
 assert.equal((await send({type:'status'})).modelPreference,'auto');
 await send({type:'setModelPreference',model:'GPT-6 Astra :: high'});assert.equal(saved.modelPreference,'GPT-6 Astra :: high');
 await send({type:'setComposerMode',composerMode:'work'});assert.equal(saved.composerMode,'work');
 assert.equal((await send({type:'status'})).composerMode,'work');
 assert.match((await send({type:'setComposerMode',composerMode:'invalid'})).error,/Choose Chat or Work/);
 await send({type:'setEnabled',enabled:true});assert.equal(saved.enabled,true);assert.equal(sockets.length,1);
 sockets[0].readyState=1;
 await send({type:'setEnabled',enabled:false});assert.equal(sockets[0].readyState,1);assert.equal(saved.enabled,false);

 assert.match((await send({type:'configurePool',tabIds:[8]})).error,/Select ChatGPT/);
 await send({type:'configurePool',tabIds:[7]});assert.equal(saved.workers[0].tabId,7);
 assert.equal(listener({type:'setEnabled',enabled:true},{id:'extension',tab:{id:7}},()=>{}),false);
});
test('popup and side panel expose controls and render activity safely',async()=>{
 for(const page of ['popup.html','side_panel.html']){
 const dom=new JSDOM(fs.readFileSync(path.join(dir,page),'utf8'),{runScripts:'outside-only'});
 const calls=[];dom.window.chrome={runtime:{sendMessage:async m=>{calls.push(m);return {enabled:true,connected:true,busy:false,tabId:7,tabTitle:'ChatGPT',completed:2,workers:[{id:'w1',tabId:7,state:'AWAITING_SAVE',requestOptions:{composerMode:'work',temporary:false,model:'GPT-6 Astra',hasAttachment:true}}],events:[{time:new Date().toISOString(),message:'<script>bad</script>'}]};}},tabs:{query:async()=>[{id:7,title:'ChatGPT'}]}};
 dom.window.setInterval=()=>{};dom.window.eval(fs.readFileSync(path.join(dir,'panel.js'),'utf8'));await tick();
 assert.equal(dom.window.document.getElementById('connection').textContent,'Connected');
 assert.match(dom.window.document.getElementById('pool').textContent,/Work · Temporary OFF · Model: GPT-6 Astra · Text \+ JSON/);
 const mode=dom.window.document.getElementById('composer-mode');assert.equal(mode.value,'chat');
 mode.value='work';mode.dispatchEvent(new dom.window.Event('change'));await tick();
 assert.ok(calls.some(m=>m.type==='setComposerMode'&&m.composerMode==='work'));
 assert.equal(dom.window.document.querySelector('#activity script'),null);
 const byId=id=>dom.window.document.getElementById(id);assert.equal(byId('model-mode').value,'auto');
 byId('model-mode').value='custom';byId('model-mode').dispatchEvent(new dom.window.Event('input'));
 byId('model-name').value='GPT-6 Astra';byId('model-effort').value='high';await byId('save-model').onclick();
 assert.ok(calls.some(m=>m.type==='setModelPreference'&&m.model==='GPT-6 Astra :: high'));
 assert.equal(byId('create-pool').textContent,'Prepare 3 windows');await byId('create-pool').onclick();assert.ok(calls.some(m=>m.type==='prepareWindows'));
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

test('side panel shows one SRT binding separately without changing three text selectors',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(dir,'side_panel.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
 const state={enabled:true,connected:true,busy:false,textBusy:false,completed:0,events:[],workers:[7,8,9].map((id,i)=>({id:'worker-'+(i+1),tabId:id,state:'IDLE'}))};
 w.chrome={runtime:{sendMessage:async()=>structuredClone(state)},tabs:{query:async()=>[7,8,9,100].map(id=>({id,title:'ChatGPT'}))}};
 w.setInterval=()=>{};w.eval(fs.readFileSync(path.join(dir,'panel.js'),'utf8'));await tick();assert.equal($('tab-1').value,'7');
 state.srtWorker={id:'srt-worker',tabId:null,state:'RUNNING',progress:{phase:'CREATING_TAB'}};state.busy=true;
 await $('refresh').onclick();assert.equal($('tab-1').value,'7');assert.equal($('srt-worker').querySelector('button').disabled,true);
 state.srtWorker.tabId=100;await $('refresh').onclick();assert.equal($('srt-worker').querySelector('button').disabled,false);
 assert.deepEqual([1,2,3].map(i=>$('tab-'+i).value),['7','8','9']);assert.equal($('configure').disabled,false);assert.equal($('create-pool').disabled,false);
 assert.equal($('tab-1').querySelector('option[value="100"]'),null);
 assert.match($('srt-worker').textContent,/srt-worker · Tab 100/);assert.doesNotMatch($('pool').textContent,/srt-worker/);
 dom.window.close();
});
