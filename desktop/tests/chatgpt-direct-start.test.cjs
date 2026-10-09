const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(r=>setImmediate(r));
for(const video of [true,false])test('New Chat tab sends '+(video?'video TXT every row':'image TXT once')+' without the old setup lock',async()=>{
 const saved={enabled:true,workers:[{id:'worker-1',kind:'text',tabId:1,state:'IDLE',owned:true},{id:'srt-worker',kind:'srt',tabId:3,state:'IDLE',owned:true}]};
 const tabs=new Map([1,3].map(id=>[id,{id,windowId:id,url:'https://chatgpt.com/'}])),sent=[],payloads=[],opened=[],navigated=[];let socket,newTabReads=0;
 class WS{constructor(){this.readyState=1;socket=this;}send(raw){sent.push(JSON.parse(raw));}}
 const event={addListener(){}};
 const chrome={storage:{local:{get:async()=>saved,set:async v=>Object.assign(saved,structuredClone(v))}},runtime:{onMessage:event,onStartup:event,onInstalled:event},alarms:{create(){},onAlarm:event},windows:{create:async options=>{opened.push(options);const tab={id:4,windowId:4,url:video?'about:blank':options.url,pendingUrl:video?options.url:undefined};tabs.set(4,tab);return {id:4,tabs:[tab]};},update:async()=>{}},tabs:{onRemoved:event,get:async id=>{if(!tabs.has(id))throw Error('missing');if(id===4&&newTabReads++>0&&tabs.get(id).pendingUrl){tabs.get(id).url=tabs.get(id).pendingUrl;delete tabs.get(id).pendingUrl;}return tabs.get(id);},query:async()=>[...tabs.values()],remove:async id=>tabs.delete(id),update:async(id,options)=>{if(options.url){navigated.push(options.url);tabs.get(id).url=options.url;}},sendMessage:async(id,m)=>{
  if(m.type==='ping')return {ok:true,inputReady:true,submissionAck:true,promptZip:true,verifiedSend:true,textSessionProof:tabs.get(id).proof};
  assert.equal(m.type,'chat');payloads.push(m);tabs.get(id).url='https://chatgpt.com/c/fresh';const proof={id:m.textSessionId,proof:m.requestId,url:tabs.get(id).url};tabs.get(id).proof=proof;
  return {ok:true,content:'Prompt result',conversation_url:tabs.get(id).url,textSessionProof:proof};
 }}};
 const ctx=vm.createContext({chrome,WebSocket:WS,URL,console,setInterval(){},setTimeout:fn=>setImmediate(fn),clearTimeout:clearImmediate});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/background.js'),'utf8'),ctx);await tick();await tick();socket.onopen();
 vm.runInContext("setupOwner={requestId:'old',release(){throw Error('Old lock must not be used');}};setupTail=new Promise(()=>{});",ctx);
 await socket.onmessage({data:JSON.stringify({type:'openText',controlId:'open'})});
 assert.equal(sent.find(m=>m.controlId==='open')?.ok,true);assert.equal(opened.length,1);assert.equal(opened[0].url,'https://chatgpt.com/');assert.ok(tabs.has(3));assert.ok(!tabs.has(1));
 for(const id of ['first','second']){
  const message={type:'chat',workerId:'worker-1',requestId:id,messages:[{content:id+' SRT text'}],textSessionId:'session',promptTemplate:video?'Video '+id:'Image instructions',composerMode:'chat',temporary:false,model:'auto',videoPromptText:video,downloadPromptZip:!video};
  await socket.onmessage({data:JSON.stringify(message)});
  for(let i=0;i<60&&!sent.some(m=>m.type==='response'&&m.requestId===id);i++)await tick();
  const response=sent.find(m=>m.type==='response'&&m.requestId===id);assert.equal(response?.ok,true,response?.error||'No response; probably waiting on old lock');
  const payload=payloads.at(-1);assert.equal(payload.composerMode,'chat');assert.equal(payload.userMessage,id+' SRT text');assert.equal(payload.promptAttachment?.text,video?'Video '+id:id==='first'?'Image instructions':undefined);
  await socket.onmessage({data:JSON.stringify({type:'commit',controlId:'save-'+id,requestId:id,ok:true})});
 }
 assert.equal(opened.length,1);assert.deepEqual(navigated,[]);assert.equal(vm.runInContext('setupOwner.requestId',ctx),'old');
});
