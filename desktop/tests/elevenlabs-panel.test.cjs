const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.join(__dirname,'../../extensions/elevenlabs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(initial){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'side_panel.html'),'utf8'),{url:'https://extension.invalid/side_panel.html',runScripts:'outside-only'}),w=dom.window,calls=[];
 let status={connected:true,enabled:true,ready:true,autoPrepareTab:true,state:'IDLE',phase:'IDLE',tabId:null,pageConnected:false,...initial},poll;
 w.setInterval=fn=>poll=fn;
 w.chrome={runtime:{sendMessage:async message=>{calls.push(message);return status;}},tabs:{query:async()=>[]}};
 w.eval(fs.readFileSync(path.join(root,'panel.js'),'utf8'));await tick();
 return {dom,w,$:id=>w.document.getElementById(id),calls,async update(next){status={...status,...next};poll();await tick();}};
}

test('ElevenLabs panel shows automatic readiness without a tab and enables inspection only after binding',async()=>{
 const {dom,$,calls,update}=await setup();
 assert.equal($('state').textContent,'Ready to open a new tab');assert.equal($('phase').textContent,'Waiting for the next chunk');
 assert.match($('page-connection').textContent,/new Text to Speech tab will open/);assert.doesNotMatch($('page-connection').textContent,/Choose a tab/);
 assert.equal($('bind').disabled,false);assert.equal($('probe').disabled,true);assert.equal($('open').disabled,false);assert.equal($('focus').disabled,true);
 assert.match(dom.window.document.body.textContent,/Before each chunk, the bridge closes all ElevenLabs Text to Speech tabs in this Chrome profile/);
 assert.match(dom.window.document.body.textContent,/Other tabs stay open/);assert.match(dom.window.document.body.textContent,/Sign in to ElevenLabs first/);
 $('probe').click();await tick();assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{type:'status'}]);
 await update({tabId:17,pageConnected:true});assert.equal($('probe').disabled,false);assert.equal($('focus').disabled,false);dom.window.close();
});

test('ElevenLabs panel labels every fresh-tab phase and disables commands that could interfere',async()=>{
 const {dom,$,update}=await setup({ready:false,busy:true,state:'RUNNING'});
 for(const [phase,label] of [['CLOSING_TABS','Closing previous Text to Speech tabs'],['OPENING_TAB','Opening a new Text to Speech tab'],['BINDING_TAB','Binding the new tab'],['WAITING_NEW_PAGE','Waiting for the new page']]){
  await update({phase});assert.equal($('phase').textContent,label);assert.equal($('state').textContent,'Processing');
  assert.match($('page-connection').textContent,/Preparing a fresh Text to Speech tab/);
  for(const id of ['bind','probe','open'])assert.equal($(id).disabled,true,id);
 }
 dom.window.close();
});

test('ElevenLabs panel preserves the review lock and never presents stale readiness as permission to replace tabs',async()=>{
 const {dom,$,calls}=await setup({state:'NEEDS_REVIEW',needsReview:true,phase:'FAILED'});
 assert.equal($('state').textContent,'Waiting for review');assert.equal($('phase').textContent,'Review required');
 assert.match($('page-connection').textContent,/No tabs will be replaced/);assert.equal(calls.length,1);assert.equal(calls[0].type,'status');dom.window.close();
});
