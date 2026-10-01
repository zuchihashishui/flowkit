const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
function ui(api){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'});
 dom.window.studio={api,chatgptAction:async()=>{}};
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
