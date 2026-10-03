const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(initial=[],extra=[]){
 const saved={workers:structuredClone(initial),enabled:true},tabs=new Map([...initial.map(w=>({id:w.tabId,windowId:1,url:'https://chatgpt.com/',active:false})),...extra].map(t=>[t.id,t]));
 const wins=new Map([[1,{id:1,state:'normal'}]]),created=[];let listener,next=100,failAt=0;
 const chrome={storage:{local:{get:async()=>structuredClone(saved),set:async x=>Object.assign(saved,structuredClone(x))}},
  tabs:{get:async id=>{if(!tabs.has(id))throw Error('Missing tab');return {...tabs.get(id)};},query:async q=>[...tabs.values()].filter(t=>t.windowId===q.windowId),
   update:async(id,opts)=>Object.assign(tabs.get(id),opts),onRemoved:{addListener(){}}},
  windows:{get:async id=>wins.get(id),update:async(id,opts)=>Object.assign(wins.get(id),opts),create:async opts=>{
   if(failAt&&created.length+1===failAt){failAt=0;throw Error('Window creation failed');}
   const id=next++;created.push({...opts});wins.set(id,{id,state:'normal'});
   let tab;if(opts.tabId!==undefined){tab=tabs.get(opts.tabId);tab.windowId=id;}else{tab={id:next++,windowId:id,url:opts.url,active:true};tabs.set(tab.id,tab);}
   return {id,tabs:[{...tab}]};}},
  runtime:{id:'ext',onMessage:{addListener:f=>listener=f},onStartup:{addListener(){}},onInstalled:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}}};
 class WS{constructor(){this.readyState=1;}send(){}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/background.js'),'utf8'),{chrome,WebSocket:WS,URL,console,setInterval(){},setTimeout,clearTimeout});
 await tick();await tick();
 return {saved,tabs,wins,created,failOn:n=>failAt=n,send:m=>new Promise(resolve=>listener(m,{id:'ext'},resolve))};
}
const initial=()=>[1,2,3].map(i=>({id:'worker-'+i,tabId:i,state:'IDLE'}));
function separate(b){const workers=b.saved.workers.filter(w=>w.kind!=='srt');assert.equal(workers.length,3);assert.equal(new Set(workers.map(w=>b.tabs.get(w.tabId).windowId)).size,3);for(const w of workers){const t=b.tabs.get(w.tabId);assert.equal([...b.tabs.values()].filter(other=>other.windowId===t.windowId).length,1);assert.equal(t.active,true);}}
test('Prepare creates three separate windows, binds once and reuses them on repeated clicks',async()=>{
 const b=await fixture();assert.equal((await b.send({type:'prepareWindows'})).error,undefined);separate(b);assert.equal(b.created.length,3);
 assert.ok(b.created.every(o=>o.url==='https://chatgpt.com/'&&o.type==='normal'&&o.focused===false));
 const ids=b.saved.workers.map(w=>w.tabId);await b.send({type:'prepareWindows'});separate(b);assert.equal(b.created.length,3);assert.deepEqual(b.saved.workers.map(w=>w.tabId),ids);
});
test('existing tabs move into separate windows without navigating or closing unrelated tabs',async()=>{
 const b=await fixture(initial(),[{id:9,windowId:1,url:'https://example.com/'}]);await b.send({type:'prepareWindows'});separate(b);
 assert.deepEqual(b.saved.workers.map(w=>w.tabId),[1,2,3]);assert.deepEqual(b.created.map(o=>o.tabId),[1,2,3]);assert.equal(b.tabs.get(9).windowId,1);
 const win=b.wins.get(b.tabs.get(1).windowId);win.state='minimized';await b.send({type:'prepareWindows'});assert.equal(win.state,'normal');assert.equal(b.created.length,3);
});
test('partial failure preserves successful bindings; retry creates only missing windows',async()=>{
 const b=await fixture();b.failOn(2);assert.match((await b.send({type:'prepareWindows'})).error,/Window creation failed/);
 assert.equal(b.saved.workers.length,1);const id=b.saved.workers[0].tabId;await b.send({type:'prepareWindows'});separate(b);assert.equal(b.saved.workers[0].tabId,id);assert.equal(b.created.length,3);
});
test('preparing text windows preserves the dedicated SRT reservation and unique migrated worker IDs',async()=>{
 const b=await fixture([{id:'worker-2',tabId:2,state:'IDLE'},{id:'worker-3',tabId:3,state:'IDLE'},{id:'srt-worker',kind:'srt',tabId:10,state:'RUNNING',requestId:'srt'}]);
 await b.send({type:'prepareWindows'});separate(b);assert.equal(new Set(b.saved.workers.map(w=>w.id)).size,4);
 const s=b.saved.workers.find(w=>w.kind==='srt');assert.equal(s.tabId,10);assert.equal(s.requestId,'srt');assert.equal(b.tabs.get(10).windowId,1);
});
test('held text jobs prevent moving or creating windows',async()=>{
 const b=await fixture([{id:'worker-1',tabId:1,state:'RUNNING'}]);assert.match((await b.send({type:'prepareWindows'})).error,/review/);assert.equal(b.created.length,0);
});
