const {test}=require('node:test');
const assert=require('node:assert/strict');
const runtime=require('../backend-runtime.cjs');
const root='C:\\project\\firm\\flowkit',python=root+'\\.venv\\Scripts\\python.exe';
const features={elevenlabs_native_download_files:true,elevenlabs_unlimited_native_audio:true,elevenlabs_recover_downloads:true,elevenlabs_safe_pre_submit_failures:true,elevenlabs_auto_prepare_tab:true};
const record=(changes={})=>({pid:100,executable:python,commandLine:`"${python}" -m agent.main`,created:'2026-10-02T01:00:00.0000000Z',...changes});

for(const [name,p,h,py,expected] of [
 ['legacy same checkout',record(),{studio_api:3},python,true],
 ['Windows venv redirector child',record({executable:'C:\\Python312\\python.exe',parent:record({pid:99})}),{},python,true],
 ['unverified base Python parent',record({executable:'C:\\Python312\\python.exe',parent:record({pid:99,executable:'C:\\other\\python.exe'})}),{},python,false],
 ['other virtualenv',record({executable:'C:\\other\\.venv\\Scripts\\python.exe'}),{},python,false],
 ['shared Python without identity',record({executable:'C:\\Python312\\python.exe',commandLine:'C:\\Python312\\python.exe -m agent.main'}),{},'C:\\Python312\\python.exe',false],
 ['reloader child',record({commandLine:`"${python}" -c "from multiprocessing.spawn import spawn_main"`}),{},python,false],
 ['extra arguments',record({commandLine:`"${python}" -m agent.main --untrusted`}),{},python,false],
 ['different reported source',record(),{runtime:{root:'C:\\other',pid:100}},python,false],
 ['different reported PID',record(),{runtime:{root,pid:101}},python,false],
 ['unrelated service',record(),{service:'another-server'},python,false],
 ['forward slash spelling',record(),{},python.replaceAll('\\','/'),true],
 ['missing process creation identity',record({created:null}),{},python,false]
])test(`restart ownership: ${name}`,()=>assert.equal(runtime.verifiedOwner(p,h,root,py,null),expected));

function harness(options={}) {
 let time=0,current=options.owner===undefined?record():options.owner, info=options.health || {studio_api:3};
 const calls=[],scripts=[];let launches=0,stops=0,child;
 const responses={
  '/api/elevenlabs/status':{state:'IDLE',busy:true,needsReview:true,progress:{phase:'SELECTING_MODEL'}},
  '/api/desktop/jobs':{jobs:[]},'/api/requests/batch-status':{processing:0,pending:0},
  '/api/chatgpt/status':{available:false},'/api/chatgpt/queue':{jobs:[],settings:{workers:3,timeout_seconds:180,temporary:true}},
  '/api/chatgpt/history':{requests:[]},'/api/flow/status':{generation_throttle:{active_submissions:0,waiting_submissions:0}},...options.responses
 };
 const request=async(method,route,body)=>{
  calls.push({method,route,body});
  if(route==='/health') {if(options.healthFails || !current)throw Error('not responding');return info;}
  if(options.failedRoute===route)throw Error('route unavailable');
  return responses[route] || {};
 };
 const service=runtime({root,logDirectory:root,request,platform:'win32',adapters:{
  fs:{access:async()=>{},readFile:async()=>options.oldSource?'old source':'elevenlabs_auto_prepare_tab studio_version',open:async()=>({fd:1,close:async()=>{}})},
  now:()=>time,wait:async ms=>{time+=ms;},
  execFile:async(exe,args)=>{
   assert.equal(exe,'powershell.exe');assert(!args.includes('-Command'));
   const script=Buffer.from(args.at(-1),'base64').toString('utf16le');scripts.push(script);
   if(script.includes('Stop-Process')) {
    if(options.stopRejects)throw Error('Backend process changed; nothing was stopped.');
    stops++;current=options.listenersAfterStop || null; if(child)child.exitCode=0;return{stdout:''};
   }
   return{stdout:JSON.stringify(current?(Array.isArray(current)?current:[current]):[])};
  },
  spawn:(exe,args,settings)=>{
   launches++;calls.push({spawn:{exe,args,settings}});
   child={pid:200,exitCode:null,on(){return this;},kill(){this.exitCode=0;current=null;}};
   current=record({pid:200,created:'2026-10-02T01:01:00.0000000Z'});
   if(options.venvRedirector)current=record({pid:201,executable:'C:\\Python312\\python.exe',parent:current});
   info={service:'flowkit-backend',studio_api:3,studio_features:features,studio_version:'0.7.20',runtime:{pid:options.wrongStartupIdentity?300:options.venvRedirector?201:200,root,python}};
   return child;
  }
 }});
 return{service,calls,scripts,get launches(){return launches;},get stops(){return stops;}};
}

test('old same-checkout backend is diagnosed, not duplicated at startup',async()=>{
 const h=harness();const d=await h.service.start();assert.equal(d.canRestart,true);assert.equal(d.pid,100);assert.equal(d.root,root);assert.equal(d.compatible,false);assert.equal(d.missingFeatures.length,5);assert.equal(h.launches,0);assert.equal(h.stops,0);
});
test('restart pauses queues, ignores stale review activity and starts verified updated source once',async()=>{
 const h=harness();const [a,b]=await Promise.all([h.service.restart(),h.service.restart()]);assert.deepEqual(a,b);
 assert.equal(a.backendDiagnostics.compatible,true);assert.equal(a.backendDiagnostics.pid,200);assert.equal(h.stops,1);assert.equal(h.launches,1);
 assert.deepEqual(h.calls.filter(c=>c.method==='POST').map(c=>c.route),['/api/elevenlabs/control','/api/desktop/pause','/api/chatgpt/config']);
 assert(h.calls.filter(c=>c.method==='POST').every(c=>c.body.paused===true || c.body.action==='pause'));
 assert.equal(h.calls.find(c=>c.spawn).spawn.settings.env.GLA_RELOAD,'0');
 assert.equal(h.service.isRestarting(),false);
 const stop=h.scripts.find(s=>s.includes('Stop-Process'));assert(stop.indexOf('CreationDate')<stop.indexOf('Stop-Process'));assert(stop.includes('CommandLine -cne'));assert(!stop.includes('taskkill'));
});
for(const [name,responses] of [
 ['ElevenLabs active',{'/api/elevenlabs/status':{active:{job_id:'a'},state:'RUNNING'}}],
 ['page generating',{'/api/elevenlabs/status':{state:'IDLE',page:{generating:true}}}],
 ['desktop voice',{'/api/desktop/jobs':{jobs:[{state:'RUNNING',payload:{kind:'voice'}}]}}],
 ['legacy Flow pending',{'/api/requests/batch-status':{processing:0,pending:1}}],
 ['ChatGPT queue',{'/api/chatgpt/queue':{jobs:[{state:'RUNNING'}],settings:{workers:3,timeout_seconds:180}}}],
 ['ChatGPT inspection',{'/api/chatgpt/status':{inspecting:true}}],
 ['ChatGPT history while gateway down',{'/api/chatgpt/history':{requests:[{state:'RUNNING'}]}}],
 ['direct Flow submission',{'/api/flow/status':{generation_throttle:{active_submissions:1}}}]
])test(`restart refuses ${name}`,async()=>{
 const h=harness({responses});await assert.rejects(h.service.restart(),/job is still active/);assert.equal(h.stops,0);assert.equal(h.launches,0);
});
test('unknown port owner is never stopped',async()=>{
 const h=harness({owner:record({commandLine:'python something_else.py'})});assert.equal((await h.service.diagnostics()).canRestart,false);await assert.rejects(h.service.restart(),/not verified/);assert.equal(h.stops,0);
});
test('outdated local source is detected before touching the running backend',async()=>{
 const h=harness({oldSource:true});await assert.rejects(h.service.restart(),/local agent folder is also outdated/);assert.equal(h.stops,0);assert.equal(h.calls.length,0);
});
test('a failed health check on an occupied port never launches duplicate workers',async()=>{
 const h=harness({healthFails:true});await assert.rejects(h.service.start(),/occupied/);assert.equal(h.launches,0);
});
test('ambiguous listeners after stopping are not treated as an empty port',async()=>{
 const h=harness({listenersAfterStop:[record({pid:301}),record({pid:302})]});await assert.rejects(h.service.restart(),/Multiple processes/);assert.equal(h.launches,0);
});
test('process identity race aborts restart without a new process',async()=>{
 const h=harness({stopRejects:true});await assert.rejects(h.service.restart(),/process changed/);assert.equal(h.stops,0);assert.equal(h.launches,0);
});
test('another server cannot masquerade as the newly started backend',async()=>{
 const h=harness({wrongStartupIdentity:true});await assert.rejects(h.service.restart(),/did not return the backend just started/);assert.equal(h.launches,1);
});
test('unverifiable queue activity prevents stopping the old process',async()=>{
 const h=harness({failedRoute:'/api/desktop/jobs'});await assert.rejects(h.service.restart(),/route unavailable/);assert.equal(h.stops,0);
});

test('Windows venv serving child PID is accepted only under the launched redirector',async()=>{
 const h=harness({venvRedirector:true});const result=await h.service.restart();assert.equal(result.backendDiagnostics.compatible,true);assert.equal(result.backendDiagnostics.pid,201);assert.equal(h.launches,1);
});
