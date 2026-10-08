const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/background.js'),'utf8');
const helper=source.slice(source.indexOf('async function nativeZipClick('),source.indexOf('async function downloadWorkerFile('));
for(const scenario of ['success','attach-error','covered','cancelled','invalid-point','press-error','no-preview','wrong-site'])test('native ZIP input: '+scenario,async()=>{
 const calls=[],worker={tabId:12,requestId:'job',state:'RUNNING'};
 const chrome={tabs:{get:async()=>({url:scenario==='wrong-site'?'https://example.com/':'https://chatgpt.com/c/job',windowId:3}),update:async()=>calls.push('activate'),sendMessage:async(id,m)=>{
  calls.push('resolve');assert.equal(id,12);assert.equal(m.native,true);assert.equal(m.requestId,'job');
  if(scenario==='covered')return {ok:false,error:'covered'};
  if(scenario==='cancelled')worker.state='CANCELLED';
  return scenario==='no-preview'?{ok:true,clicked:false}:{ok:true,point:{x:scenario==='invalid-point'?NaN:42,y:24}};
 }},windows:{update:async()=>calls.push('focus')},debugger:{
  attach:async(target,version)=>{calls.push('attach');assert.equal(target.tabId,12);assert.equal(version,'1.3');if(scenario==='attach-error')throw Error('permission denied');},
  detach:async()=>calls.push('detach'),
  sendCommand:async(target,method,p)=>{assert.equal(target.tabId,12);assert.equal(method,'Input.dispatchMouseEvent');calls.push(p.type);assert.equal(p.x,42);assert.equal(p.y,24);if(p.type==='mousePressed'){assert.equal(p.buttons,1);assert.equal(p.clickCount,1);if(scenario==='press-error')throw Error('detached');}if(p.type==='mouseReleased'){assert.equal(p.buttons,0);assert.equal(p.clickCount,1);}}
 }};
 const context=vm.createContext({chrome});vm.runInContext(helper,context);
 const action=context.nativeZipClick(worker,scenario==='no-preview'?'continuePromptZipDownload':'clickPromptZipDownload');
 if(['success','no-preview'].includes(scenario))await action;else await assert.rejects(action);
 if(scenario==='success')assert.deepEqual(calls,['attach','focus','activate','resolve','mouseMoved','mousePressed','mouseReleased','detach']);
 if(!['attach-error','wrong-site'].includes(scenario))assert.equal(calls.at(-1),'detach');
 if(['covered','cancelled','invalid-point','no-preview','attach-error','wrong-site'].includes(scenario))assert.ok(!calls.includes('mousePressed'));
});

test('ZIP point refuses a covering element',()=>{
 const content=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
 const code=content.slice(content.indexOf('  function nativeFilePoint('),content.indexOf('  function findSrtLink('));
 const link={scrollIntoView(){},querySelectorAll:()=>[],getBoundingClientRect:()=>({left:10,top:20,right:110,bottom:50,width:100,height:30}),contains:()=>false};
 const ctx=vm.createContext({document:{elementFromPoint:()=>({})},innerWidth:800,innerHeight:600});vm.runInContext(code,ctx);
 assert.throws(()=>ctx.nativeFilePoint(link),/covered/);
});
