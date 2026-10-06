const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
function ui(api){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'fixtures/chatgpt-retired-ui.html'),'utf8'),{runScripts:'outside-only'});
 dom.window.studio={api,chatgptAction:async()=>{}};
 dom.window.eval(fs.readFileSync(path.join(__dirname,'../ui/chatgpt-model.js'),'utf8'));
 dom.window.eval(fs.readFileSync(path.join(__dirname,'../ui/chatgpt-chat.js'),'utf8'));
 return {dom,$:id=>dom.window.document.getElementById(id)};
}
test('free prompt: forwards text, prevents duplicate sends and renders response safely',async()=>{
 let release;const calls=[];
 const {dom,$}=ui((...args)=>{calls.push(args);return new Promise(r=>release=r);});
 $('chat-prompt').value='Write my script';
 const submit=$('chat-form').onsubmit({preventDefault(){}});
 assert.equal($('chat-send').disabled,true);
 await $('chat-form').onsubmit({preventDefault(){}});assert.equal(calls.length,1);
 assert.deepEqual(calls[0].slice(0,2),['POST','/api/chatgpt/message']);
 assert.equal(calls[0][2].prompt,'Write my script');
 release({response:'<script>alert(1)</script>\nA script'});await submit;
 assert.equal($('chat-response').textContent,'<script>alert(1)</script>\nA script');
 assert.equal($('chat-response').querySelector('script'),null);
 assert.equal($('chat-send').disabled,false);assert.equal($('chat-copy').disabled,false);
 $('chat-clear').click();assert.equal($('chat-prompt').value,'');assert.equal($('chat-copy').disabled,true);
 dom.window.close();
});
test('free prompt: error leaves prompt intact and allows explicit retry',async()=>{
 const {dom,$}=ui(async()=>{throw Error('Review required');});
 $('chat-prompt').value='Keep this text';await $('chat-form').onsubmit({preventDefault(){}});
 assert.equal($('chat-status').textContent,'Review required');assert.equal($('chat-prompt').value,'Keep this text');
 assert.equal($('chat-send').disabled,false);assert.equal($('chat-copy').disabled,true);dom.window.close();
});
for(const choice of ['auto','custom','extension'])test(`Desktop model selection forwards ${choice}`,async()=>{
 const calls=[];const {dom,$}=ui(async(...args)=>{calls.push(args);return {response:'OK'};});
 $('chat-prompt').value='Test';$('chat-model-mode').value=choice;$('chat-model-mode').onchange();
 $('chat-model').value='GPT-6 Astra';$('chat-model-effort').value='high';
 await $('chat-form').onsubmit({preventDefault(){}});
 assert.equal(calls[0][2].model,choice==='custom'?'GPT-6 Astra :: high':choice);
 assert.equal($('chat-model-fields').hidden,choice!=='custom');dom.window.close();
});
test('Desktop refuses empty custom model before submission',async()=>{
 let sent=0;const {dom,$}=ui(async()=>{sent++;return {response:'OK'};});
 $('chat-prompt').value='Test';$('chat-model-mode').value='custom';
 await $('chat-form').onsubmit({preventDefault(){}});assert.equal(sent,0);assert.match($('chat-status').textContent,/exact model/);dom.window.close();
});

test('Desktop refreshes observed models and applies dropdown choice without sending a prompt',async()=>{
 const calls=[];const {dom,$}=ui(async(...args)=>{calls.push(args);return {tabId:1,models:['GPT-6 Astra','GPT-6 Sol'],current:{model:'GPT-6 Astra',effort:'high'},note:'Observed only'};});
 await $('chat-refresh-models').onclick();assert.equal(calls[0][1],'/api/chatgpt/models');
 $('chat-observed-model').value='GPT-6 Sol';$('chat-observed-model').onchange();assert.equal($('chat-model').value,'GPT-6 Sol');assert.equal($('chat-model-mode').value,'custom');assert.equal(calls.length,1);dom.window.close();
});
