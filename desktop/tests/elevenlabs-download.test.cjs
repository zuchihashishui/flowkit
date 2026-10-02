const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../../extensions/elevenlabs/background.js'),'utf8');
const token='11111111-2222-4333-8444-555555555555';
function harness({mode='complete'}={}) {
 let listener,time=10000,clicks=0,removed=0,suggestion;
 const item={id:4,url:'blob:https://elevenlabs.io/audio',referrer:'https://elevenlabs.io/app/speech-synthesis/text-to-speech',startTime:new Date(10000).toISOString(),state:mode==='interrupted'?'interrupted':'complete',exists:true,error:'NETWORK_FAILED'};
 class Clock extends Date {static now(){return time;}}
 const chrome={runtime:{onMessage:{addListener(){}}},storage:{local:{get:async()=>({}),set:async()=>{}}},tabs:{onRemoved:{addListener(){}},sendMessage:async(_id,m)=>{
   assert.equal(m.type,'clickDownload');clicks++;
   if(mode==='missing')return {ok:true};
   listener({...item,id:88,url:'https://unrelated.example/file',referrer:'https://unrelated.example/'},s=>assert.equal(s,undefined));
   listener(item,s=>{suggestion=s;item.filename='/Downloads/'+s.filename;});
   if(mode==='conflict')listener({...item,id:5},()=>{});
   return {ok:true};
 }},downloads:{onDeterminingFilename:{addListener:f=>listener=f,removeListener:f=>{assert.equal(f,listener);removed++;}},search:async()=>[item]},alarms:{create(){},onAlarm:{addListener(){}}},sidePanel:{setPanelBehavior:async()=>{}}};
 const context=vm.createContext({chrome,URL,Date:Clock,crypto:{randomUUID:()=>token},WebSocket:class{},setInterval(){},setTimeout(fn,ms){time+=ms;return setImmediate(fn);}});
 vm.runInContext(code,context);
 return {run:()=>vm.runInContext("downloadCompletedAudio(7,'chunk')",context),get clicks(){return clicks;},get removed(){return removed;},get suggestion(){return suggestion;}};
}
test('arms browser listener before clicking Download and waits for the owned file',async()=>{
 const h=harness(),result=await h.run();assert.equal(result.path,`/Downloads/flowkit-elevenlabs/${token}/audio.mp3`);assert.equal(result.token,token);assert.equal(h.clicks,1);assert.equal(h.removed,1);assert.equal(h.suggestion.conflictAction,'uniquify');
});
for(const [mode,pattern] of [['missing',/60 seconds/],['interrupted',/interrupted/],['conflict',/Multiple/]])test(`native download ${mode} stops without another click`,async()=>{
 const h=harness({mode});await assert.rejects(h.run(),pattern);assert.equal(h.clicks,1);assert.equal(h.removed,1);
});
