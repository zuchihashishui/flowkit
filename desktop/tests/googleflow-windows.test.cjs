const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const tick=()=>new Promise(r=>setImmediate(r));
async function setup(){
 const tabs=new Map([[1,{id:1,url:'https://example.com/'}],[2,{id:2,url:'https://flow.google.com/project/personal'}]]),windows=[],saved={};let next=10;
 const event={addListener(){}};
 const chrome={action:{setBadgeText(){},setBadgeBackgroundColor(){}},alarms:{create(){},clear(){},onAlarm:event},webRequest:{onBeforeSendHeaders:event},
 runtime:{onInstalled:event,onStartup:event,onMessage:event,sendMessage:async()=>{},getManifest:()=>({version:'test'})},
 storage:{local:{get:async()=>saved,set:async x=>Object.assign(saved,x)}},
 tabs:{query:async q=>[...tabs.values()].filter(t=>!q.url||t.url.startsWith('https://flow.google.com/')),get:async id=>{if(!tabs.has(id))throw Error('Missing tab');return tabs.get(id);},remove:async id=>{tabs.delete(id);},create:async o=>{const tab={id:next++,...o};tabs.set(tab.id,tab);return tab;}},
 windows:{create:async o=>{windows.push(o);await tick();const tab=await chrome.tabs.create({url:o.url,windowId:next});return {id:tab.windowId,tabs:[tab]};}}};
 class WS{static OPEN=1;static CONNECTING=0;constructor(){this.readyState=0;}}
 const c=vm.createContext({chrome,WebSocket:WS,URL,console,navigator:{userAgent:'test'},setInterval(){},clearInterval(){},setTimeout(fn,ms){if(ms<10000)return setImmediate(fn);},clearTimeout(){},fetch:async()=>({ok:true})});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../../extensions/googleflow/background.js'),'utf8'),c);await tick();
 return {tabs,windows,saved,chrome,run:code=>vm.runInContext(code,c)};
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
