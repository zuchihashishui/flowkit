const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const code=fs.readFileSync(path.join(__dirname,'../../extensions/elevenlabs/background.js'),'utf8');
const url='https://elevenlabs.io/app/speech-synthesis/text-to-speech';
const missing='Could not establish connection. Receiving end does not exist.';
const tick=()=>new Promise(r=>setImmediate(r));
async function worker({receive,inject,savedTab=null,savedState='IDLE',tabs=[{id:7,url}]}={}) {
 let listener,socket,documentCounter=1,removed,nextId=100;const saved={enabled:true,tabId:savedTab,state:savedState},sent=[],calls=[],injections=[],operations=[];
 const openTabs=new Map(tabs.map(tab=>[tab.id,{status:'complete',...tab}]));
 let time=0;class Clock extends Date{static now(){return time;}}
 class WS {constructor(){this.readyState=1;socket=this;}send(s){sent.push(JSON.parse(s));}}
 const chrome={runtime:{id:'ext',onMessage:{addListener:f=>listener=f}},storage:{local:{get:async()=>structuredClone(saved),set:async v=>Object.assign(saved,v)}},
 tabs:{get:async id=>{if(!openTabs.has(id))throw Error('No tab with id '+id);return {...openTabs.get(id)};},
 query:async query=>{operations.push({type:'query',query});return [...openTabs.values()].filter(tab=>!query.url||String(tab.url||tab.pendingUrl).startsWith('https://elevenlabs.io/'));},
 remove:async id=>{operations.push({type:'remove',id});if(!openTabs.delete(id))throw Error('No tab with id '+id);await removed(id);},
 create:async options=>{const tab={id:++nextId,...options,status:'complete'};if(options.url===url)documentCounter++;openTabs.set(tab.id,tab);operations.push({type:'create',...tab});return tab;},
 sendMessage:async(id,m,options)=>{calls.push({id,...m,options});operations.push({id,...m,options});if(m.type==='clearForReload')return {ok:true,documentToken:String(documentCounter),voice:'Voice'};const r=receive?await receive(m,id):{ok:true,page:{generating:false}};if(r?.page)r.page={documentToken:String(documentCounter),voice:'Voice',editorReady:true,...r.page};return r;},
 reload:async id=>{operations.push({type:'reload',id});documentCounter++;},onRemoved:{addListener(fn){removed=fn;}}},
 scripting:{executeScript:async options=>{injections.push(options);return inject?.(options);}},alarms:{create(){},onAlarm:{addListener(){}}},sidePanel:{setPanelBehavior:async()=>{}}};
 chrome.windows={create:async options=>({id:42,tabs:[await chrome.tabs.create({url:options.url,active:options.focused,windowId:42})]})};
 vm.runInNewContext(code,{chrome,WebSocket:WS,URL,Date:Clock,console,setInterval(){},setTimeout(fn,ms){time+=ms;return setImmediate(fn);}});await tick();socket.onopen();
 return {saved,sent,calls,injections,operations,openTabs,chrome,remove:id=>chrome.tabs.remove(id),ui:m=>new Promise(resolve=>listener(m,{id:'ext'},resolve)),send:m=>socket.onmessage({data:JSON.stringify(m)})};
}
test('bind repairs an already-open tab with no receiver using one read-only retry',async()=>{
 let loaded=false;const w=await worker({receive:async()=>{if(!loaded)throw Error(missing);return {ok:true,page:{model:'Eleven v4'}};},inject:()=>{loaded=true;}});
 const result=await w.ui({type:'bindTab',tabId:7});assert.equal(result.ready,true);assert.equal(result.pageConnected,true);
 assert.equal(w.injections.length,1);assert.deepEqual(JSON.parse(JSON.stringify(w.injections[0])),{target:{tabId:7,frameIds:[0]},files:['content.js']});
 assert.deepEqual(w.calls.map(c=>c.type),['probe','probe']);assert.ok(w.calls.every(c=>c.options.frameId===0));
 assert.equal(w.calls.filter(c=>c.type==='generate').length,0);
});
test('a failed old-tab probe does not disable fresh preparation, but a denied new receiver still prevents Generate',async()=>{
 const w=await worker({receive:async()=>{throw Error(missing);},inject:()=>{throw Error('Cannot access contents of the page');}});
 const r=await w.ui({type:'bindTab',tabId:7});assert.equal(r.ok,false);assert.match(r.error,/Refresh the Text to Speech tab/);
 const s=await w.ui({type:'status'});assert.equal(s.ready,true);assert.equal(s.autoPrepareTab,true);assert.equal(s.pageConnected,false);assert.match(s.lastError,/allow this extension/);assert.equal(s.state,'IDLE');
 w.send({type:'generate',requestId:'do-not-send',text:'hello'});const failed=await resultFor(w,'do-not-send');assert.equal(failed.notSubmitted,true);assert.equal(w.calls.some(c=>c.type==='generate'),false);
});
test('ambiguous message-channel failure never triggers injection or repeated Generate',async()=>{
 let generations=0;const w=await worker({receive:async m=>{if(m.type==='probe')return {ok:true,page:{generating:false}};generations++;throw Error('The message port closed before a response was received.');}});
 await w.ui({type:'bindTab',tabId:7});w.send({type:'generate',requestId:'uncertain',text:'hello'});await tick();
 assert.equal(generations,1);assert.equal(w.injections.length,0);assert.equal(w.saved.state,'NEEDS_REVIEW');
 assert.equal(w.sent.find(m=>m.type==='result'&&m.requestId==='uncertain').notSubmitted,false);
});
test('receiver disappearing after preflight does not resend Generate',async()=>{
 const w=await worker({receive:async m=>{if(m.type==='probe')return {ok:true,page:{generating:false}};throw Error(missing);}});
 await w.ui({type:'bindTab',tabId:7});w.send({type:'generate',requestId:'lost',text:'hello'});await tick();
 assert.equal(w.calls.filter(c=>c.type==='generate').length,1);assert.equal(w.injections.length,0);assert.equal(w.saved.state,'NEEDS_REVIEW');
});
test('remembered tab is probed and repaired at startup before becoming ready',async()=>{
 let loaded=false;const w=await worker({savedTab:7,receive:async()=>{if(!loaded)throw Error(missing);return {ok:true,page:{}};},inject:()=>{loaded=true;}});
 assert.equal((await w.ui({type:'status'})).ready,true);assert.equal(w.injections.length,1);assert.ok(w.sent.some(m=>m.type==='status'&&!m.ready));
});
test('wrong page cannot be bound or injected',async()=>{
 const w=await worker();w.chrome.tabs.get=async id=>({id,url:'https://example.com/'});
 const r=await w.ui({type:'bindTab',tabId:7});assert.equal(r.ok,false);assert.equal(w.injections.length,0);assert.equal(w.calls.length,0);
});
async function resultFor(w,id){for(let i=0;i<250;i++){const r=w.sent.find(x=>x.type==='result'&&x.requestId===id);if(r)return r;await tick();}throw Error('No worker result');}
test('every chunk replaces the old TTS tab, binds it, clears text and reloads before Generate',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,audioBase64:'SUQz',voice:'Voice'}});
 await w.ui({type:'bindTab',tabId:7});w.calls.length=0;w.operations.length=0;
 w.send({type:'generate',requestId:'reload-order',text:'new text'});const r=await resultFor(w,'reload-order');assert.equal(r.ok,true,r.error);
 assert.deepEqual(w.operations.map(x=>x.type),['query','create','remove','create','remove','probe','clearForReload','reload','probe','generate']);
 assert.equal(w.operations.find(x=>x.type==='remove').id,7);assert.equal(w.saved.tabId,102);assert.equal(w.calls.every(x=>x.id===102),true);
 const generated=w.calls.at(-1);assert.equal(generated.expectedDocumentToken,'3');assert.equal(generated.expectedVoice,'Voice');assert.equal(generated.text,'new text');assert.equal(w.saved.state,'AWAITING_SAVE');
 assert.deepEqual(w.sent.filter(x=>x.type==='progress').map(x=>x.phase),['CLOSING_TABS','OPENING_TAB','BINDING_TAB','WAITING_NEW_PAGE','CLEARING_TEXT','REFRESHING_PAGE','WAITING_PAGE']);
});
test('failed clear acknowledgement prevents both reload and Generate',async()=>{
 const w=await worker();await w.ui({type:'bindTab',tabId:7});const send=w.chrome.tabs.sendMessage;let reloads=0;
 w.chrome.tabs.sendMessage=async(id,m,o)=>m.type==='clearForReload'?{ok:false,error:'Editor stayed nonempty'}:send(id,m,o);
 w.chrome.tabs.reload=async()=>{reloads++;};w.send({type:'generate',requestId:'clear-failed',text:'hello'});
 const r=await resultFor(w,'clear-failed');assert.equal(r.notSubmitted,true);assert.equal(reloads,0);assert.equal(w.calls.some(x=>x.type==='generate'),false);
});
test('reload that leaves the old document active times out without typing or Generate',async()=>{
 const w=await worker();await w.ui({type:'bindTab',tabId:7});w.chrome.tabs.reload=async()=>{};
 w.send({type:'generate',requestId:'old-document',text:'hello'});const r=await resultFor(w,'old-document');
 assert.equal(r.ok,false);assert.equal(r.notSubmitted,true);assert.match(r.error,/60 seconds/);assert.match(r.error,/new page document/);assert.equal(w.calls.some(x=>x.type==='generate'),false);assert.equal(w.saved.state,'IDLE');
});
test('voice changes after reload stop before the first paid generation',async()=>{
 let refreshed=false;const w=await worker({receive:async()=>({ok:true,page:{voice:refreshed?'Other voice':'Voice'}})});
 await w.ui({type:'bindTab',tabId:7});const reload=w.chrome.tabs.reload;w.chrome.tabs.reload=async id=>{refreshed=true;await reload(id);};
 w.send({type:'generate',requestId:'voice-reset',text:'hello'});const r=await resultFor(w,'voice-reset');assert.equal(r.notSubmitted,true);assert.match(r.error,/voice changed after refresh/);assert.equal(w.calls.some(x=>x.type==='generate'),false);
});

test('a refreshed editor can run while Chrome tab status is still loading',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}});
 await w.ui({type:'bindTab',tabId:7});const get=w.chrome.tabs.get;
 w.chrome.tabs.get=async id=>({...await get(id),status:'loading'});
 w.send({type:'generate',requestId:'loading-editor',text:'hello'});
 const r=await resultFor(w,'loading-editor');assert.equal(r.ok,true,r.error);assert.equal(w.calls.filter(x=>x.type==='generate').length,1);
});
test('refresh timeout reports the missing editor instead of hiding its error',async()=>{
 let refreshed=false;const w=await worker({receive:async()=>({ok:true,page:refreshed?{editorReady:false,editorError:'Text to Speech editor missing'}:{}})});
 await w.ui({type:'bindTab',tabId:7});const reload=w.chrome.tabs.reload;
 w.chrome.tabs.reload=async id=>{refreshed=true;await reload(id);};
 w.send({type:'generate',requestId:'missing-editor',text:'hello'});
 const r=await resultFor(w,'missing-editor');assert.equal(r.notSubmitted,true);assert.match(r.error,/Text to Speech editor missing/);assert.equal(w.calls.some(x=>x.type==='generate'),false);
});
test('verified failure before Generate releases the worker without requiring uncertain-audio review',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:false,error:'Paste was not accepted',code:'EDITOR_PASTE_NOT_HANDLED',notSubmitted:true}});
 await w.ui({type:'bindTab',tabId:7});w.send({type:'generate',requestId:'paste-failure',text:'hello'});
 const r=await resultFor(w,'paste-failure');assert.equal(r.notSubmitted,true);assert.equal(r.state,'IDLE');assert.equal(r.needsReview,false);
 const s=await w.ui({type:'status'});assert.equal(s.busy,false);assert.equal(s.phase,'FAILED');assert.equal(s.requestId,null);assert.equal(s.ready,true);
 assert.equal(w.calls.filter(x=>x.type==='generate').length,1,'failure never retries itself');
});
test('a rejected request cannot erase the review state of an earlier uncertain chunk',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:false,error:'Download failed',notSubmitted:false}});
 await w.ui({type:'bindTab',tabId:7});w.send({type:'generate',requestId:'uncertain-first',text:'hello'});await resultFor(w,'uncertain-first');
 w.send({type:'generate',requestId:'stale-ready',text:'hello'});const r=await resultFor(w,'stale-ready');
 assert.equal(r.notSubmitted,true);assert.equal(r.state,'NEEDS_REVIEW');assert.equal(r.needsReview,true);
 const s=await w.ui({type:'status'});assert.equal(s.busy,false);assert.equal(s.ready,false);assert.equal(s.needsReview,true);
 w.send({type:'review',requestId:'release'});const released=await resultFor(w,'release');assert.equal(released.state,'IDLE');assert.equal(released.busy,false);assert.equal((await w.ui({type:'status'})).progressMessage,'');
});
test('closing an idle bound tab leaves automatic preparation ready without requiring review',async()=>{
 const w=await worker();await w.ui({type:'bindTab',tabId:7});await w.remove(7);
 const s=await w.ui({type:'status'});assert.equal(s.state,'IDLE');assert.equal(s.needsReview,false);assert.equal(s.ready,true);assert.equal(s.tabId,null);assert.equal(s.lastError,'');assert.equal(s.autoPrepareTab,true);
});
test('a transient default voice during hydration is allowed to restore before Generate',async()=>{
 let probes=0,refreshed=false;
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{voice:refreshed&&++probes===1?'Default voice':'Voice'}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}});
 await w.ui({type:'bindTab',tabId:7});const reload=w.chrome.tabs.reload;w.chrome.tabs.reload=async id=>{refreshed=true;await reload(id);};
 w.send({type:'generate',requestId:'voice-hydration',text:'hello'});const r=await resultFor(w,'voice-hydration');assert.equal(r.ok,true,r.error);assert.equal(w.calls.filter(x=>x.type==='generate').length,1);
});

test('automatic preparation closes every exact TTS page and leaves other ElevenLabs and browser pages untouched',async()=>{
 const w=await worker({tabs:[{id:7,url},{id:8,url:url+'/?test=1#editor'},{id:9,url:'https://elevenlabs.io/app/voice-lab'},{id:10,url:url+'/history'},{id:11,url:'https://example.com/'}],receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}});
 const initial=await w.ui({type:'status'});assert.equal(initial.ready,true);assert.equal(initial.tabId,null);assert.equal(initial.autoPrepareTab,true);
 w.send({type:'generate',requestId:'all-tabs',text:'新しいナレーション'});const r=await resultFor(w,'all-tabs');assert.equal(r.ok,true,r.error);
 assert.deepEqual(w.operations.filter(x=>x.type==='remove').map(x=>x.id),[7,8]);
 assert.deepEqual([...w.openTabs.keys()],[9,10,11,101]);assert.equal(w.operations.filter(x=>x.type==='create').length,1);
 assert.equal(w.operations.find(x=>x.type==='create').url,url);assert.equal(w.operations.find(x=>x.type==='create').active,true);
 assert.equal(w.saved.tabId,101);assert.equal(w.saved.state,'AWAITING_SAVE');assert.equal(w.sent.some(x=>x.needsReview),false);
});

test('an IDLE worker with no existing tab opens and automatically binds one before generating',async()=>{
 const w=await worker({tabs:[],receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}});
 assert.equal((await w.ui({type:'status'})).ready,true);
 w.send({type:'generate',requestId:'empty-profile',text:'hello'});const r=await resultFor(w,'empty-profile');assert.equal(r.ok,true,r.error);
 assert.equal(w.operations.filter(x=>x.type==='remove').length,0);assert.equal(w.operations.filter(x=>x.type==='create').length,1);
 assert.equal(w.saved.tabId,101);assert.equal(w.calls.filter(x=>x.type==='generate').length,1);
});

test('a remembered tab that no longer exists does not block automatic preparation',async()=>{
 const w=await worker({tabs:[],savedTab:99,receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}});
 assert.equal((await w.ui({type:'status'})).ready,true);
 w.send({type:'generate',requestId:'stale-tab',text:'hello'});const r=await resultFor(w,'stale-tab');assert.equal(r.ok,true,r.error);assert.equal(w.saved.tabId,101);
});

test('each subsequent chunk replaces the previous tab only after its save acknowledgement',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}});
 w.send({type:'generate',requestId:'chunk-one',text:'one'});assert.equal((await resultFor(w,'chunk-one')).ok,true);
 const operations=w.operations.length;
 w.send({type:'generate',requestId:'premature-next',text:'two'});const rejected=await resultFor(w,'premature-next');assert.equal(rejected.code,'BUSY');assert.equal(w.operations.length,operations);assert.equal(w.saved.tabId,102);
 w.send({type:'commit',requestId:'chunk-one',ok:true});await tick();assert.equal(w.saved.state,'IDLE');
 w.send({type:'generate',requestId:'chunk-two',text:'two',expectedVoice:'Voice'});assert.equal((await resultFor(w,'chunk-two')).ok,true);
 assert.deepEqual(w.operations.filter(x=>x.type==='remove').map(x=>x.id),[7,101,102,103]);assert.equal(w.saved.tabId,104);assert.deepEqual([...w.openTabs.keys()],[104]);
});

test('a review lock never closes tabs or creates a new one',async()=>{
 const w=await worker({savedState:'NEEDS_REVIEW'});
 w.send({type:'generate',requestId:'locked-worker',text:'hello'});const r=await resultFor(w,'locked-worker');assert.equal(r.code,'BUSY');assert.equal(r.needsReview,true);
 assert.equal(w.operations.length,0);assert.deepEqual([...w.openTabs.keys()],[7]);
});

test('failure to close an existing TTS tab prevents opening a replacement and generating',async()=>{
 const w=await worker();w.chrome.tabs.remove=async()=>{throw Error('Tab removal denied');};
 w.send({type:'generate',requestId:'cannot-close',text:'hello'});const r=await resultFor(w,'cannot-close');assert.equal(r.notSubmitted,true);assert.match(r.error,/Tab removal denied/);
 assert.equal(w.operations.some(x=>x.type==='create'&&x.url===url),false);assert.equal(w.calls.some(x=>x.type==='generate'),false);assert.equal(w.saved.state,'IDLE');
});

test('new-page readiness timeout occurs before clearing, reloading or sending Generate',async()=>{
 const w=await worker({receive:async()=>({ok:true,page:{editorReady:false,editorError:'Sign in to use Text to Speech'}})});
 w.send({type:'generate',requestId:'not-ready',text:'hello'});const r=await resultFor(w,'not-ready');assert.equal(r.notSubmitted,true);assert.match(r.error,/new Text to Speech page.*60 seconds/);assert.match(r.error,/Sign in/);
 assert.equal(w.calls.some(x=>['clearForReload','generate'].includes(x.type)),false);assert.equal(w.operations.some(x=>x.type==='reload'),false);assert.equal(w.saved.state,'IDLE');
});

test('closing the fresh tab during page preparation is a definite pre-submit failure',async()=>{
 let w,closed=false;w=await worker({receive:async(m,id)=>{if(m.type==='probe'&&!closed){closed=true;await w.remove(id);}return {ok:true,page:{}};}});
 w.send({type:'generate',requestId:'closed-before',text:'hello'});const r=await resultFor(w,'closed-before');assert.equal(r.notSubmitted,true);assert.equal(r.needsReview,false);assert.equal(w.saved.state,'IDLE');
 assert.equal(w.calls.some(x=>x.type==='generate'),false);assert.equal(w.saved.tabId,null);
});

test('closing the fresh tab after sending Generate retains uncertain-result review',async()=>{
 let w;w=await worker({receive:async(m,id)=>{if(m.type==='probe')return {ok:true,page:{}};await w.remove(id);throw Error('Message port closed during Generate');}});
 w.send({type:'generate',requestId:'closed-after',text:'hello'});const r=await resultFor(w,'closed-after');assert.equal(r.notSubmitted,false);assert.equal(r.needsReview,true);assert.equal(w.saved.state,'NEEDS_REVIEW');
 assert.equal(w.calls.filter(x=>x.type==='generate').length,1);
});

test('the first chunk uses the new page voice instead of cached old-tab metadata',async()=>{
 const w=await worker({savedTab:7,receive:async(m,id)=>m.type==='probe'?{ok:true,page:{voice:id===7?'Stale voice':'Voice'}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}});
 assert.equal((await w.ui({type:'status'})).page.voice,'Stale voice');
 w.send({type:'generate',requestId:'fresh-voice',text:'hello'});const r=await resultFor(w,'fresh-voice');assert.equal(r.ok,true,r.error);
 assert.equal(w.calls.find(x=>x.type==='clearForReload').expectedVoice,'Voice');assert.equal(w.calls.find(x=>x.type==='generate').expectedVoice,'Voice');
});

test('a pinned backend voice cannot silently change when a new tab opens',async()=>{
 const w=await worker({receive:async()=>({ok:true,page:{voice:'Other voice'}})});
 w.send({type:'generate',requestId:'pinned-voice',text:'hello',expectedVoice:'Voice'});const r=await resultFor(w,'pinned-voice');assert.equal(r.notSubmitted,true);assert.equal(r.code,'VOICE_CHANGED');assert.match(r.error,/voice changed on the new page/);
 assert.equal(w.calls.some(x=>x.type==='clearForReload'||x.type==='generate'),false);
});

test('a temporary blank tab keeps Chrome alive while all of its TTS tabs are replaced',async()=>{
 const w=await worker({tabs:[{id:7,url},{id:8,url:url+'?draft=2'}],receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}});
 const remove=w.chrome.tabs.remove,create=w.chrome.tabs.create;
 w.chrome.tabs.remove=async id=>{assert.ok(w.openTabs.size>1,'closing the last tab would stop Chrome');return remove(id);};
 w.chrome.tabs.create=async options=>{if(options.url===url)assert.equal([...w.openTabs.values()].some(tab=>tab.url.startsWith(url)),false,'new TTS navigation must happen after all old TTS tabs close');return create(options);};
 w.send({type:'generate',requestId:'keep-chrome-alive',text:'hello'});const r=await resultFor(w,'keep-chrome-alive');assert.equal(r.ok,true,r.error);
 const created=w.operations.filter(x=>x.type==='create');assert.deepEqual(created.map(x=>x.url),['about:blank',url]);assert.equal(created[0].active,false);
 assert.deepEqual(w.operations.filter(x=>x.type==='remove').map(x=>x.id),[7,8,101]);assert.deepEqual([...w.openTabs.keys()],[102]);assert.equal(w.saved.tabId,102);
});

test('an unrelated open tab means no temporary blank tab is created or closed',async()=>{
 const w=await worker({tabs:[{id:7,url},{id:8,url:'https://example.com/notes'}],receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}});
 w.send({type:'generate',requestId:'other-page-open',text:'hello'});const r=await resultFor(w,'other-page-open');assert.equal(r.ok,true,r.error);
 assert.deepEqual(w.operations.filter(x=>x.type==='create').map(x=>x.url),[url]);assert.deepEqual(w.operations.filter(x=>x.type==='remove').map(x=>x.id),[7]);assert.deepEqual([...w.openTabs.keys()],[8,101]);
});

test('a failed replacement leaves its blank tab open to report failure without closing Chrome',async()=>{
 const w=await worker(),create=w.chrome.tabs.create;
 w.chrome.tabs.create=async options=>{if(options.url===url)throw Error('Could not open the new TTS page');return create(options);};
 w.send({type:'generate',requestId:'create-failed',text:'hello'});const r=await resultFor(w,'create-failed');assert.equal(r.notSubmitted,true);assert.match(r.error,/Could not open/);
 assert.equal(w.calls.some(x=>x.type==='generate'),false);assert.deepEqual([...w.openTabs.values()].map(x=>x.url),['about:blank']);assert.equal(w.saved.tabId,null);assert.equal(w.saved.state,'IDLE');
});

test('a failed old-tab removal cleans up its own placeholder while leaving the old tab',async()=>{
 const w=await worker(),remove=w.chrome.tabs.remove;
 w.chrome.tabs.remove=async id=>{if(id===7)throw Error('Cannot close this TTS tab');return remove(id);};
 w.send({type:'generate',requestId:'remove-failed-cleanup',text:'hello'});const r=await resultFor(w,'remove-failed-cleanup');assert.equal(r.notSubmitted,true);assert.match(r.error,/Cannot close/);
 assert.deepEqual([...w.openTabs.keys()],[7]);assert.equal(w.operations.some(x=>x.type==='create'&&x.url===url),false);
});

test('placeholder cleanup never closes a tab the user has navigated elsewhere',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,nativeDownload:{path:'/test',token:'test'},voice:'Voice'}}),create=w.chrome.tabs.create;
 w.chrome.tabs.create=async options=>{if(options.url===url)w.openTabs.get(101).url='https://example.com/user-page';return create(options);};
 w.send({type:'generate',requestId:'placeholder-navigation',text:'hello'});const r=await resultFor(w,'placeholder-navigation');assert.equal(r.ok,true,r.error);
 assert.equal(w.openTabs.get(101).url,'https://example.com/user-page');assert.deepEqual(w.operations.filter(x=>x.type==='remove').map(x=>x.id),[7]);assert.equal(w.saved.tabId,102);
});

test('new worker uses a separate window and closes only after final saved acknowledgement',async()=>{
 const w=await worker({tabs:[{id:7,url:'https://example.com/'}],receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,audioBase64:'SUQz'}});
 let options;const create=w.chrome.windows.create;w.chrome.windows.create=async o=>{options=o;return create(o);};
 w.send({type:'generate',requestId:'final',text:'hello'});assert.equal((await resultFor(w,'final')).ok,true);
 const id=w.saved.tabId;assert.equal(options.type,'normal');assert.equal(options.focused,true);assert.equal(options.url,url);assert.ok(w.openTabs.has(id));
 w.send({type:'commit',requestId:'wrong',ok:true,jobComplete:true});await tick();assert.ok(w.openTabs.has(id));
 w.send({type:'commit',requestId:'final',ok:true,jobComplete:true});await tick();
 assert.equal(w.openTabs.has(id),false);assert.ok(w.openTabs.has(7));assert.equal(w.saved.state,'IDLE');assert.equal(w.saved.tabId,null);
 assert.ok(w.sent.some(m=>m.type==='commitAck'&&m.requestId==='final'&&m.ok));
});
test('intermediate saved acknowledgement retains the worker page',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,audioBase64:'SUQz'}});
 w.send({type:'generate',requestId:'middle',text:'hello'});await resultFor(w,'middle');const id=w.saved.tabId;
 w.send({type:'commit',requestId:'middle',ok:true,jobComplete:false});await tick();assert.ok(w.openTabs.has(id));assert.equal(w.saved.state,'IDLE');
});
test('final cleanup preserves Chrome when worker is its only tab',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,audioBase64:'SUQz'}});
 w.send({type:'generate',requestId:'last',text:'hello'});await resultFor(w,'last');
 w.send({type:'commit',requestId:'last',ok:true,jobComplete:true});await tick();
 assert.equal(w.saved.state,'IDLE');assert.equal(w.openTabs.size,1);assert.equal([...w.openTabs.values()][0].url,'about:blank');
});
test('cleanup failure never invalidates saved audio or locks the queue',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,audioBase64:'SUQz'}});
 w.send({type:'generate',requestId:'cleanup-fail',text:'hello'});await resultFor(w,'cleanup-fail');const id=w.saved.tabId;
 w.chrome.tabs.remove=async()=>{throw Error('Chrome refused');};
 w.send({type:'commit',requestId:'cleanup-fail',ok:true,jobComplete:true});await tick();
 assert.equal(w.saved.state,'IDLE');assert.ok(w.openTabs.has(id));assert.match((await w.ui({type:'status'})).lastError,/could not close/);
 assert.ok(w.sent.some(m=>m.type==='commitAck'&&m.requestId==='cleanup-fail'&&m.ok));
});
test('final cleanup preserves a worker page navigated elsewhere',async()=>{
 const w=await worker({receive:async m=>m.type==='probe'?{ok:true,page:{}}:{ok:true,audioBase64:'SUQz'}});
 w.send({type:'generate',requestId:'navigated',text:'hello'});await resultFor(w,'navigated');const id=w.saved.tabId;
 w.openTabs.get(id).pendingUrl='https://example.com/';
 w.send({type:'commit',requestId:'navigated',ok:true,jobComplete:true});await tick();assert.ok(w.openTabs.has(id));assert.equal(w.saved.state,'IDLE');
});

test('narration uses the project TTS URL and preserves its query through refresh',async()=>{
 const w=await worker({receive:async m=>m.type==='generate'?{ok:true,nativeDownload:{path:'/test',token:'token'},voice:'Voice'}:{ok:true,page:{}}});
 const pageUrl=url+'?voiceId=project-a';w.send({type:'generate',requestId:'project-url',text:'Japanese narration',pageUrl});
 const r=await resultFor(w,'project-url');assert.equal(r.ok,true,r.error);
 const created=w.operations.find(o=>o.type==='create'&&o.url===pageUrl);assert.ok(created);
 assert.equal(w.openTabs.get(created.id).url,pageUrl);assert.ok(w.operations.some(o=>o.type==='reload'&&o.id===created.id));
 assert.equal(w.calls.filter(c=>c.type==='generate').length,1);
});
