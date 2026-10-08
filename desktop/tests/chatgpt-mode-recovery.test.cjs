const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
const functions=source.slice(source.indexOf('  function composerButton('),source.indexOf('  function temporaryEnabled('));
function setup(onSleep=()=>{}){
 const dom=new JSDOM('<div role="group" aria-label="Composer mode"><button aria-pressed="false">Chat</button><button aria-pressed="true"><span class="relative inline-flex items-center gap-1">Work</span></button></div>',{runScripts:'outside-only'}),w=dom.window;
 w.visible=()=>true;w.temporaryEnabled=()=>false;w.sleep=async()=>onSleep(w);w.progress=()=>{};
 w.eval(functions+';window.choose=selectComposerMode;window.lookup=composerButton;');return dom;
}
test('user markup resolves nested Work label and already-selected mode without clicking',async()=>{
 const d=setup();try{let clicks=0;d.window.lookup('work').onclick=()=>clicks++;await d.window.choose('work');assert.equal(clicks,0);}finally{d.window.close();}
});
test('Chat selection recovers when first click is lost during page rerender',async()=>{
 let replace=false,clicks=0;
 const d=setup(w=>{if(replace){replace=false;const b=w.lookup('chat'),copy=b.cloneNode(true);b.replaceWith(copy);copy.onclick=()=>{clicks++;copy.setAttribute('aria-pressed','true');w.lookup('work').setAttribute('aria-pressed','false');};}});
 try{d.window.lookup('chat').onclick=()=>{clicks++;replace=true;};await d.window.choose('chat');assert.equal(d.window.lookup('chat').getAttribute('aria-pressed'),'true');assert.equal(clicks,2);}finally{d.window.close();}
});
test('unresponsive mode switch fails with bounded attempts',async()=>{
 const d=setup();try{let clicks=0;d.window.lookup('chat').onclick=()=>clicks++;await assert.rejects(d.window.choose('chat'),/Cannot verify Chat/);assert.ok(clicks>0&&clicks<=5);}finally{d.window.close();}
});
