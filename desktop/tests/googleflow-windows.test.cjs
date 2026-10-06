const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(r=>setImmediate(r));
async function setup(){
 const tabs=new Map([[1,{id:1,windowId:1,url:'https://example.com/'}],[2,{id:2,windowId:2,url:'https://flow.google.com/project/personal'}]]),windows=[],saved={},tabUpdates=[],windowUpdates=[];let next=10,listener;
 const event={addListener(){}};
 const chrome={action:{setBadgeText(){},setBadgeBackgroundColor(){}},alarms:{create(){},clear(){},onAlarm:event},webRequest:{onBeforeSendHeaders:event},
 runtime:{onInstalled:event,onStartup:event,onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>{},getManifest:()=>({version:'test'})},
 storage:{local:{get:async()=>saved,set:async x=>Object.assign(saved,x)}},
 tabs:{query:async q=>[...tabs.values()].filter(t=>!q.url||t.url.startsWith('https://flow.google.com/')),get:async id=>{if(!tabs.has(id))throw Error('Missing tab');return tabs.get(id);},remove:async id=>{tabs.delete(id);},create:async o=>{const tab={id:next++,...o};tabs.set(tab.id,tab);return tab;}},
 windows:{get:async id=>({id,state:'normal'}),update:async(id,props)=>{windowUpdates.push({id,...props});return{id,...props};},create:async o=>{windows.push(o);await tick();const tab=await chrome.tabs.create({url:o.url,windowId:next});return {id:tab.windowId,tabs:[tab]};}}};
 chrome.tabs.update=async(id,props)=>{const tab=await chrome.tabs.get(id);Object.assign(tab,props);tabUpdates.push({id,...props});return tab;};
 chrome.tabs.reload=async id=>{const tab=await chrome.tabs.get(id);tab.discarded=false;};
 class WS{static OPEN=1;static CONNECTING=0;constructor(){this.readyState=0;}}
 const c=vm.createContext({chrome,WebSocket:WS,URL,console,navigator:{userAgent:'test'},setInterval(){},clearInterval(){},setTimeout(fn,ms){if(ms<10000)return setImmediate(fn);},clearTimeout(){},fetch:async()=>({ok:true})});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../extensions/googleflow/background.js'),'utf8'),c);await tick();
 return {tabs,windows,saved,chrome,tabUpdates,windowUpdates,message:(msg,sender={})=>new Promise(resolve=>listener(msg,sender,resolve)),run:code=>vm.runInContext(code,c)};
}
test('three concurrent Flow operations share one separately opened window',async()=>{
 const b=await setup();const result=await b.run('Promise.all([openFlowWindow(),openFlowWindow(),openFlowWindow()])');
 assert.equal(b.windows.length,1);assert.ok(result.every(t=>t.id===result[0].id));assert.equal(b.windows[0].type,'normal');assert.equal(b.windows[0].focused,false);
 assert.ok(b.tabs.has(2),'Personal Flow tab preserved');assert.deepEqual(b.saved.ownedFlowTabs.length,1);
});
test('Flow closes only owned tabs after saved notification, preserves other tabs and reopens next time',async()=>{
 const b=await setup(),first=await b.run('openFlowWindow()');
 b.run("activeBatchRpcs.add('busy')");await b.run('closeSavedFlowTabs()');assert.ok(b.tabs.has(first.id));
 b.run("activeBatchRpcs.delete('busy')");await b.run('closeSavedFlowTabs()');assert.equal(b.tabs.has(first.id),false);assert.ok(b.tabs.has(1));assert.ok(b.tabs.has(2));
 const next=await b.run('openFlowWindow()');assert.notEqual(next.id,first.id);assert.equal(b.windows.length,2);
});
test('Flow keeps last Chrome window alive and preserves navigated tabs',async()=>{
 const b=await setup(),worker=await b.run('openFlowWindow()');b.tabs.delete(1);b.tabs.delete(2);
 b.tabs.get(worker.id).pendingUrl='https://example.org/';await b.run('closeSavedFlowTabs()');assert.ok(b.tabs.has(worker.id));
 delete b.tabs.get(worker.id).pendingUrl;await b.run('closeSavedFlowTabs()');assert.equal(b.tabs.size,1);assert.equal([...b.tabs.values()][0].url,'about:blank');
});
test('next Flow operation waits for tab cleanup, then gets a fresh window',async()=>{
 const b=await setup(),first=await b.run('openFlowWindow()');let release;
 b.chrome.tabs.remove=async id=>{await new Promise(r=>release=r);b.tabs.delete(id);};
 const close=b.run('closeSavedFlowTabs()');await tick();const next=b.run('openFlowWindow()');await tick();assert.equal(b.windows.length,1);
 release();await close;const reopened=await next;assert.notEqual(reopened.id,first.id);assert.equal(b.windows.length,2);
});

test('Flow routes each project to its configured page and deduplicates concurrent opens',async()=>{
 const b=await setup();const a='https://flow.google.com/project/11111111-2222-3333-4444-555555555555',other='https://flow.google.com/project/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 const [x,y]=await b.run(`Promise.all([openFlowWindow({url:${JSON.stringify(a)}}),openFlowWindow({url:${JSON.stringify(a)}})])`);
 assert.equal(x.id,y.id);assert.equal(b.windows.length,1);assert.equal(b.windows[0].url,a);
 const z=await b.run(`openFlowWindow({url:${JSON.stringify(other)}})`);assert.notEqual(z.id,x.id);
 const root=await b.run('openFlowWindow()');assert.notEqual(root.id,x.id);assert.notEqual(root.id,z.id);
 b.tabs.get(x.id).url=other;
 const fresh=await b.run(`openFlowWindow({url:${JSON.stringify(a)}})`);assert.notEqual(fresh.id,x.id);assert.equal(fresh.url,a);
 await b.run('closeSavedFlowTabs()');assert.ok(b.tabs.has(2));assert.equal(b.saved.ownedFlowTabs.length,0);
});

test('Open Flow Tab activates an existing tab and restores its minimized window before confirming',async()=>{
 const b=await setup();b.chrome.windows.get=async id=>({id,state:'minimized'});
 const result=await b.message({type:'OPEN_FLOW_TAB'});
 assert.equal(result.ok,true);assert.equal(result.tabId,2);assert.equal(b.windows.length,0);
 assert.deepEqual(b.tabUpdates,[{id:2,active:true}]);
 assert.deepEqual(b.windowUpdates,[{id:2,state:'normal',focused:true}]);
 await b.run('closeSavedFlowTabs()');assert.ok(b.tabs.has(2),'Opening a personal tab must not adopt it for automatic cleanup');
});
test('Open Flow Tab opens a foreground window without needing the backend and reuses it',async()=>{
 const b=await setup();b.tabs.delete(2);
 const result=await b.message({type:'OPEN_FLOW_TAB'});assert.equal(result.ok,true);
 assert.equal(b.windows.length,1);assert.equal(b.windows[0].focused,true);assert.equal(b.windows[0].url,'https://flow.google.com/');
 assert.equal(b.windowUpdates[0].focused,true);
 assert.equal((await b.message({type:'OPEN_FLOW_TAB'})).tabId,result.tabId);assert.equal(b.windows.length,1);
});
test('Open Flow Tab reports tab/window/create failures instead of confirming success',async()=>{
 for(const stage of ['activate','focus','create']){
  const b=await setup();
  if(stage==='activate')b.chrome.tabs.update=async()=>{throw Error('Tab was closed');};
  if(stage==='focus')b.chrome.windows.update=async()=>{throw Error('Window unavailable');};
  if(stage==='create'){b.tabs.delete(2);b.chrome.windows.create=async()=>{throw Error('Chrome refused a new window');};}
  const result=await b.message({type:'OPEN_FLOW_TAB'});assert.equal(result.ok,undefined);assert.ok(result.error);
 }
});
test('Open Flow Tab prefers a managed project tab and preserves maximized window size',async()=>{
 const b=await setup(),project=await b.run("openFlowWindow({url:'https://flow.google.com/project/11111111-2222-3333-4444-555555555555'})");
 b.chrome.windows.get=async id=>({id,state:'maximized'});
 assert.equal((await b.message({type:'OPEN_FLOW_TAB'})).tabId,project.id);
 assert.deepEqual(b.windowUpdates,[{id:project.windowId,focused:true}]);
});
test('Open Flow Tab revives a discarded tab and refuses requests from web content',async()=>{
 const b=await setup();b.tabs.get(2).discarded=true;
 assert.equal((await b.message({type:'OPEN_FLOW_TAB'})).ok,true);assert.equal(b.tabs.get(2).discarded,false);
 const result=await b.message({type:'OPEN_FLOW_TAB'},{tab:{id:3}});assert.match(result.error,/Extension page required/);
});
