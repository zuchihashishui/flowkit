const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {Schema}=require('prosemirror-model');
const {EditorState,TextSelection}=require('prosemirror-state');
// This is the actual ProseMirror paste/selection/transaction implementation,
// running in JSDOM. It does not reproduce ElevenLabs' private React components.
const fixture=fs.readFileSync(path.join(__dirname,'fixtures/elevenlabs-tts.html'),'utf8');
const code=fs.readFileSync(path.join(__dirname,'../../extensions/elevenlabs/content.js'),'utf8');

for (const content of ['paragraph+','inline*']) test(`real ProseMirror ${content} receives complete Japanese chunks and preserves the speaker`,async()=>{
 const dom=new JSDOM(fixture,{url:'https://elevenlabs.io/app/speech-synthesis/text-to-speech',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,original={};
 for(const key of ['window','document','navigator','MutationObserver','getComputedStyle','innerHeight','innerWidth']) {
  original[key]=Object.getOwnPropertyDescriptor(globalThis,key);
  Object.defineProperty(globalThis,key,{value:w[key],writable:true,configurable:true});
 }
 let view;
 try {
  const {EditorView}=require('prosemirror-view');
  const schema=new Schema({nodes:{
   doc:{content:'dialogue+'},
   dialogue:{content,group:'block',attrs:{voice:{default:'Minato - Calm, Warm & Clear'}},toDOM:()=>['div',0]},
   paragraph:{content:'inline*',group:'block',parseDOM:[{tag:'p'}],toDOM:()=>['p',0]},
   text:{group:'inline'},hard_break:{inline:true,group:'inline',selectable:false,parseDOM:[{tag:'br'}],toDOM:()=>['br']}
  }});
  const paragraph=t=>schema.node('paragraph',null,t?schema.text(t):undefined);
  const doc=schema.node('doc',null,[schema.node('dialogue',null,[content==='inline*'?schema.text('前の文章。'):paragraph('前の文章。')])]);
  let enteredState='',count=0,pastes=0,generateClicks=0,listener,time=0;
  Object.defineProperty(w.HTMLElement.prototype,'getClientRects',{value(){return this.closest('[hidden],[aria-hidden="true"]')?[]:[{top:0,left:0,bottom:1,right:1}];}});
  w.Range.prototype.getClientRects=()=>[];w.Range.prototype.getBoundingClientRect=()=>({top:0,left:0,bottom:0,right:0});
  const editorRoot=d.querySelector('[contenteditable=true]');editorRoot.replaceChildren();
  view=new EditorView({mount:editorRoot},{
   state:EditorState.create({schema,doc,selection:TextSelection.atEnd(doc)}),
   nodeViews:{dialogue(node){
    const holder=d.createElement('div');holder.className='node-dialogueNode';
    const header=d.createElement('div');header.contentEditable='false';header.setAttribute('contenteditable','false');
    const voice=d.createElement('button');voice.innerHTML='<span class="truncate"></span>';voice.firstChild.textContent=node.attrs.voice;
    const clear=d.createElement('button');clear.setAttribute('aria-label','Clear text');
    clear.onclick=()=>view.dispatch(view.state.tr.replaceWith(1,view.state.doc.firstChild.nodeSize-1,content==='inline*'?[]:paragraph('')));
    header.append(voice,clear);
    const block=d.createElement('div');block.dataset.testid='tts-editor';
    const contentDOM=d.createElement('div');contentDOM.setAttribute('data-node-view-content-react','');block.append(contentDOM);holder.append(header,block);
    return {dom:holder,contentDOM};
   }},
   dispatchTransaction(tr){view.updateState(view.state.apply(tr));enteredState=view.state.doc.textBetween(0,view.state.doc.content.size,'\n',leaf=>leaf.type.name==='hard_break'?'\n':'');count=enteredState.length;}
  });
  editorRoot.addEventListener('paste',()=>pastes++);
  class Transfer{constructor(){this.data={};}setData(t,v){this.data[t]=v;}getData(t){return this.data[t]||'';}}
  w.DataTransfer=Transfer;w.ClipboardEvent=class extends w.Event{constructor(t,o){super(t,o);this.clipboardData=o.clipboardData;}};
  w.Date.now=()=>time;w.setTimeout=(fn,ms)=>{time+=ms;return setImmediate(fn);};
  w.chrome={runtime:{id:'ext',onMessage:{addListener:fn=>listener=fn,hasListener:fn=>listener===fn},sendMessage:async m=>{
   if(m.type!=='downloadAudio')return;
   const clicked=await new Promise(resolve=>listener({type:'clickDownload',requestId:m.requestId},{id:'ext'},resolve));
   return clicked.ok?{ok:true,nativeDownload:{path:'/Downloads/flowkit-elevenlabs/test/audio.mp3',token:'test'}}:clicked;
  }}};
  d.querySelector('[data-testid="tts-generate"]').onclick=()=>{generateClicks++;d.querySelector('audio').src=`blob:https://elevenlabs.io/generation-${generateClicks}`;};
  w.eval(code);
  const request=m=>new Promise(resolve=>listener(m,{id:'ext'},resolve));
  const chunks=['日本語の文章です。'.repeat(360)+'\n\n次の段落です。','句読点。「テスト」\n改行と絵文字🎵。','[laughs]  二つの空白。\tタブ。<script>文字列</script> & 記号。'];
  for(const [i,input] of chunks.entries()){
   // The first chunk replaces an existing document with its old cursor at the
   // end. Later chunks exercise the real app-style Clear transaction as well.
   if(i>0){const clear=await request({type:'clearForReload'});assert.equal(clear.ok,true,clear.error);assert.equal(view.state.doc.textContent,'');}
   const result=await request({type:'generate',requestId:`real-pm-${i}`,text:input,timeout:30000,model:'Eleven v4'});
   assert.equal(result.ok,true,result.error);
   assert.equal(enteredState,input,'the ProseMirror document, not just the DOM, contains the complete chunk');
   assert.equal(count,input.length);assert.equal(view.state.doc.firstChild.attrs.voice,'Minato - Calm, Warm & Clear');
   assert.equal(view.state.doc.childCount,1);
  }
  assert.equal(pastes,chunks.length);assert.equal(generateClicks,chunks.length);
 } finally {
  view?.destroy();dom.window.close();
  for(const [key,descriptor] of Object.entries(original)) {if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 }
});
