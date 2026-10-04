const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(api){
 const dom=new JSDOM('<button data-page="projects">Project</button><section data-view="projects"><div id="production-dashboard"></div></section><select id="sb-prompt-kind"><option value="image">Image</option><option value="video">Video</option></select>',{runScripts:'outside-only',url:'http://localhost/'}),w=dom.window,$=id=>w.document.getElementById(id),calls=[];
 let context={project_id:'p1',video_id:'v1'};
 w.workflow={context:()=>({...context})};w.studio={api};w.selectProductionVideo=async(video,page)=>{calls.push({video,page});context={...context,video_id:video};return true;};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/production.js'),'utf8'));
 return{dom,w,$,calls,context:next=>{context=next;}};
}
const overview={videos:[{id:'v1',title:'Episode One',scene_count:200,stages:[{id:'image_prompts',label:'Image prompts',status:'running',ready:120,total:200,running:3,queued:77}],next_stage:'images'},{id:'v2',title:'Episode Two',scene_count:20,stages:[{id:'video_prompts',status:'missing',ready:0,total:20,optional:true}]}]};
const recovery={counts:{needs_review:1,queued:77},jobs:[{id:'uncertain',video_id:'v1',title:'Scene 121',kind:'concept',stage:'image_prompts',state:'NEEDS_REVIEW',action:'inspect',message:'Inspect the worker before retrying.'}]};
test('dashboard shows every video, routes stages and recovery without submitting generation',async()=>{
 const requests=[],s=setup(async(method,route)=>{requests.push({method,route});return route.includes('/overview')?overview:recovery;});
 try{await tick();assert.match(s.$('pd-videos').textContent,/Episode One/);assert.match(s.$('pd-videos').textContent,/120 \/ 200/);assert.match(s.$('pd-videos').textContent,/Episode Two/);
 s.w.document.querySelector('[data-video-id="v2"] .production-stage').click();await tick();assert.deepEqual(s.calls,[{video:'v2',page:'storyboard'}]);assert.equal(s.$('sb-prompt-kind').value,'video');
 s.$('pd-recovery').querySelector('button').click();await tick();assert.deepEqual(s.calls[1],{video:'v1',page:'settings'});assert.ok(requests.every(r=>r.method==='GET'));
 }finally{s.dom.window.close();}
});
test('preflight forwards snapshot inputs, blocks failures and ignores a stale video result',async()=>{
 let pending,mode='fail',lastBody;const s=setup(async(method,route,body)=>{
 if(route.endsWith('/preflight')){lastBody=body;if(mode==='wait')return new Promise(r=>pending=r);return{blocked:mode==='fail',checks:[{status:mode==='fail'?'fail':'pass',message:mode==='fail'?'Connect the extension.':'Ready.'}]};}
 return route.includes('/overview')?overview:recovery;
 });
 try{await tick();assert.equal(await s.w.production.check('images',{segment_ids:['s1'],silentOnSuccess:true}),false);assert.match(s.w.document.querySelector('[role=dialog]').textContent,/Connect the extension/);assert.equal(lastBody.video_id,'v1');assert.equal('silentOnSuccess'in lastBody,false);
 mode='pass';assert.equal(await s.w.production.check('images',{silentOnSuccess:true}),true);assert.equal(s.w.document.querySelector('[role=dialog]'),null);
 await assert.rejects(s.w.production.check('images',{video_id:'other'}),/no longer active/);
 mode='wait';const checking=s.w.production.check('images');await tick();s.context({project_id:'p1',video_id:'v2'});pending({blocked:false,checks:[]});await assert.rejects(checking,/active video changed/);assert.equal(s.w.document.querySelector('[role=dialog]'),null);
 }finally{s.dom.window.close();}
});
test('late previous-project dashboard response cannot overwrite the selected project',async()=>{
 let resolveOld;const s=setup(async(method,route)=>{if(route.includes('project_id=p1')&&route.includes('/overview'))return new Promise(r=>resolveOld=r);if(route.includes('/overview'))return{videos:[{id:'other',title:'Project Two Video',scene_count:0,stages:[]}]};return{counts:{},jobs:[]};});
 try{s.context({project_id:'p2',video_id:'other'});s.w.document.dispatchEvent(new s.w.CustomEvent('project-changed'));await tick();assert.match(s.$('pd-videos').textContent,/Project Two Video/);resolveOld(overview);await tick();assert.doesNotMatch(s.$('pd-videos').textContent,/Episode One/);
 }finally{s.dom.window.close();}
});
test('recovery routes media to the exact queue job and saved SRT quality review to its stage',async()=>{
 const focused=[],s=setup(async(method,route)=>route.includes('/overview')?overview:{counts:{},jobs:[{id:'media',kind:'image',video_id:'v1',stage:'images',state:'FAILED',action:'resume_download'},{id:'subtitle',kind:'srt',video_id:'v1',stage:'srt',state:'COMPLETED',action:'inspect',message:'Review timing exceptions.'},{id:'done',kind:'image',video_id:'v1',stage:'images',state:'COMPLETED',action:null}]});
 s.w.focusProductionJob=async id=>focused.push(id);
 try{await tick();assert.equal(s.$('pd-recovery').querySelectorAll('article').length,2);s.$('pd-recovery').querySelector('[data-job-id="media"] button').click();await tick();assert.deepEqual(s.calls[0],{video:'v1',page:'queue'});assert.deepEqual(focused,['media']);s.$('pd-recovery').querySelector('[data-job-id="subtitle"] button').click();await tick();assert.deepEqual(s.calls[1],{video:'v1',page:'srt'});
 }finally{s.dom.window.close();}
});
