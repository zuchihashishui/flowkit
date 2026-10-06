const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function studio(savedProject='',multiple=false,savedVideo='') {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8'), {runScripts:'outside-only',url:'https://studio.test'});
  const w = dom.window, $ = id => w.document.getElementById(id), calls = [], exports = [], preferences = [];
  let scenes = [
    {id:'s1',display_order:0,prompt:'Boat',video_prompt:'A moving boat',narrator_text:'First narration'},
    {id:'s2',display_order:1,prompt:'Cloud',video_prompt:'A moving cloud',narrator_text:'Second narration'}
  ];
  const jobs = [
    {id:'a',state:'QUEUED',payload:{kind:'video',project_id:'p1',video_id:'v1',label:'Boat job',prompt:'A moving boat'}},
    {id:'b',state:'COMPLETED',payload:{kind:'image',project_id:'p2',video_id:'v1',label:'Cloud job',prompt:'Bright cloud'}},
    {id:'c',state:'FAILED',can_resume:true,payload:{kind:'video',project_id:'p1',video_id:'v1',label:'Saved result',prompt:'A saved prompt'}},
    {id:'d',state:'NEEDS_REVIEW',payload:{kind:'image',project_id:'p1',video_id:'v1',label:'Uncertain job',prompt:'Check Flow'}}
  ].map(j => ({...j,files:j.state==='COMPLETED'?['/output/output.png']:[],created:1,error:j.state==='FAILED'?'Download failed':null}));
  const videoRows=[{id:'v1',title:'First collection',status:'DRAFT'}];
  if(multiple){videoRows.push({id:'v2',title:'Second topic',status:'DRAFT'});jobs.push({id:'second-video-job',state:'QUEUED',files:[],created:2,payload:{kind:'image',project_id:'p1',video_id:'v2',label:'Only video two',prompt:'Forest'}});}
  w.confirm = () => true; w.setInterval = () => 0;
  if(savedVideo)w.localStorage.setItem('active-video:'+savedProject,savedVideo);
  if(savedProject)w.localStorage.setItem('active-project-id',savedProject);
  w.studio = {
    settings: async () => ({autoExport:false,output:'/output',extension:'/extension'}),
    updateSettings: async p => { preferences.push(p); return p; },
    exportJob: async id => { exports.push(id); return '/output/'+id; },
    api: async (method, route, body) => {
      calls.push({method,route,body});
      if(route.startsWith('/api/workflow/resources'))return {resources:[]};
      if(route==='/health')return {version:'test',extension_connected:true};
      if(route==='/api/projects')return [{id:'p1',name:'First project'},{id:'p2',name:'Second project'}];
      if(route==='/api/workflow/project')return {project_id:body.project_id,video_id:videoRows.length===1?'v1':null,title:videoRows.length===1?'First collection':null,videos:structuredClone(videoRows),protocol:3};
      if(route==='/api/videos'&&method==='POST'){const row={id:'v'+(videoRows.length+1),...body,status:'DRAFT'};videoRows.push(row);return row;}
      if(route.startsWith('/api/videos/')&&method==='PATCH'){const row=videoRows.find(v=>v.id===route.split('/').at(-1));Object.assign(row,body);return row;}
      if(route.startsWith('/api/videos?'))return [{id:'v1',title:'First collection'}];
      if(route.startsWith('/api/scenes?'))return (route.endsWith('v1')?scenes:[]).map(s=>({...s}));
      if(route.startsWith('/api/scenes/')&&method==='PATCH') {
        const s=scenes.find(s=>s.id===route.split('/').at(-1));Object.assign(s,body);return {...s};
      }
      if(route==='/api/scenes'&&method==='POST'){const s={id:'s3',...body};scenes.push(s);return s;}
      if(route==='/api/tts/templates')return [{name:'narrator'}];
      if(route==='/api/materials')return [{id:'realistic',name:'Photorealistic'}];
      if(route==='/api/models')return {image_models:{}};
      if(route==='/api/desktop/jobs')return method==='GET'?{paused:false,jobs:structuredClone(jobs)}:{ids:['new']};
      if(route==='/api/desktop/jobs/cancel'){
        const cancelled=[];
        for(const j of jobs)if(body.ids.includes(j.id)&&j.state==='QUEUED'){j.state='CANCELLED';cancelled.push(j.id);}
        return {cancelled,skipped:body.ids.filter(id=>!cancelled.includes(id))};
      }
      throw Error('Unexpected request '+method+' '+route);
    }
  };
  w.eval(fs.readFileSync(path.join(__dirname, '../ui/workflow.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8')); await tick();
  const change = async (id,value) => {const e=$(id); if(e.type==='checkbox')e.checked=value;else e.value=value;e.dispatchEvent(new w.Event(e.type==='search'?'input':'change'));await tick();};
  const submit = async id => {$(id).dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();};
  const click = async (root,text) => {const b=[...root.querySelectorAll('button')].find(b=>b.textContent===text);assert(b,'Button missing: '+text);b.click();await tick();};
  return {dom,w,$,calls,exports,preferences,change,submit,click,scenes};
}

test('scene selection, editing and narration submit only chosen scene data',async()=>{
  const s=await studio();const {$,w,calls,change,submit,click}=s;
  try {
    await change('project-select','p1');
    assert.equal($('scene-selection').textContent,'2 of 2 scenes selected');
    $('clear-scenes').click();
    const check=w.document.querySelector('[data-scene-id="s2"]');check.checked=true;check.dispatchEvent(new w.Event('change'));
    await click($('scenes').children[1],'Edit scene');
    $('scene-video-prompt').value='Updated cloud';$('scene-narration').value='Updated narration';
    $('scene-narration').dispatchEvent(new w.Event('input',{bubbles:true}));
    await change('voice-mode','scenes');await change('voice-template','narrator');
    await submit('voice-form');
    assert.match($('notice').textContent,/Save or discard/);
    assert.equal(calls.filter(c=>c.route==='/api/desktop/jobs'&&c.method==='POST').length,0);
    await submit('scene-editor');
    assert.equal(calls.find(c=>c.method==='PATCH').route,'/api/scenes/s2');
    assert.equal($('scene-selection').textContent,'1 of 2 scenes selected');
    let payload;
    await submit('voice-form');
    payload=calls.filter(c=>c.route==='/api/desktop/jobs'&&c.method==='POST').at(-1).body.jobs;
    assert.equal(payload.length,1);assert.equal(payload[0].prompt,'Updated narration');assert.equal(payload[0].template,'narrator');
    $('add-scene').click();$('scene-prompt').value='A new scene';await submit('scene-editor');
    assert.equal(s.scenes.length,3);assert.equal(s.scenes[2].display_order,2);
    $('clear-scenes').click();await submit('voice-form');assert.match($('notice').textContent,/Select 1–100/);
  }finally{s.dom.window.close();}
});

test('queue filters scope exports and cancellation; details expose full prompt and errors',async()=>{
  const s=await studio();const {$,change,click,exports,calls}=s;
  try {
    assert.equal($('auto-export').checked,false);assert.equal(exports.length,0);
    await change('project-select','p2');await change('job-state','COMPLETED');
    assert.equal($('all-jobs').children.length,1);
    $('export-filtered').click();await tick();assert.deepEqual(exports,['b']);
    await change('project-select','p1');await change('job-state','');await change('job-search','saved prompt');
    assert.equal($('all-jobs').children.length,1);
    await click($('all-jobs'),'Details');assert.match($('job-detail-text').textContent,/A saved prompt/);assert.match($('job-detail-text').textContent,/Download failed/);
    assert([...$('all-jobs').querySelectorAll('button')].some(b=>b.textContent==='Resume saved result'));
    await change('job-search','');await change('job-state','NEEDS_REVIEW');
    assert(![...$('all-jobs').querySelectorAll('button')].some(b=>b.textContent==='Resume saved result'));
    await change('job-state','QUEUED');$('cancel-filtered').click();await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c=>c.route==='/api/desktop/jobs/cancel').body.ids)),['a']);
    assert.match($('all-jobs').textContent,/No jobs match/);
    await change('job-state','CANCELLED');assert.equal($('all-jobs').children.length,1);
  }finally{s.dom.window.close();}
});

test('Projects owns the only selector; selection persists and all media lists follow it',async()=>{
 const s=await studio('p2');const {$,w,change}=s;
 try{
  assert.equal($('project-select').closest('[data-view]').dataset.view,'projects');
  assert.equal(w.document.querySelector('header select'),null);assert.equal($('job-project'),null);
  assert.equal($('project-select').value,'p2');assert.equal($('active-project-name').textContent,'Second project');
  assert.equal(w.workflow.context().project_id,'p2');assert.equal(w.workflow.context().video_id,'v1');assert.equal($('active-video-name').textContent,'First collection');assert.equal($('video-select').hidden,false);assert.equal($('new-collection'),null);
  assert.match($('all-jobs').textContent,/Cloud job/);assert.doesNotMatch($('all-jobs').textContent,/Uncertain job/);
  w.document.querySelector('[data-page="scene-board"]').click();assert.equal($('active-project-name').textContent,'Second project');
  await change('project-select','p1');assert.equal(w.localStorage.getItem('active-project-id'),'p1');
  assert.match($('all-jobs').textContent,/Uncertain job/);assert.doesNotMatch($('all-jobs').textContent,/Cloud job/);
  assert.match($('queue-summary').textContent,/3 jobs/);assert.match($('job-project-context').textContent,/First project/);
  assert.equal(w.document.querySelector('#project-list [data-active="true"]').dataset.projectId,'p1');
  w.document.querySelector('[data-page="whisperx"]').click();assert.equal($('project-scope-note').hidden,true);
  $('change-project').click();assert.equal(w.document.querySelector('[data-page].active').dataset.page,'projects');
 }finally{s.dom.window.close();}
});

test('cancelled project switch keeps the active project and unsaved scene editor',async()=>{
 const s=await studio('p1');const {$,w,change,click}=s;
 try{
  await click($('scenes').children[0],'Edit scene');$('scene-prompt').value='Unsaved edit';$('scene-prompt').dispatchEvent(new w.Event('input',{bubbles:true}));
  w.confirm=()=>false;await change('project-select','p2');
  assert.equal($('project-select').value,'p1');assert.equal($('active-project-name').textContent,'First project');
  assert.equal($('scene-editor').hidden,false);assert.equal($('scene-prompt').value,'Unsaved edit');assert.equal(w.localStorage.getItem('active-project-id'),'p1');
 }finally{s.dom.window.close();}
});

test('auto-export preference is restored, saved, and reverted on a write error',async()=>{
  const s=await studio();
  try {
    assert.equal(s.$('auto-export').checked,false);
    await s.change('auto-export',true);assert.equal(s.preferences[0].autoExport,true);
    s.w.studio.updateSettings=async()=>{throw Error('Disk full');};
    await s.change('auto-export',false);assert.equal(s.$('auto-export').checked,true);assert.match(s.$('notice').textContent,/Disk full/);
  }finally{s.dom.window.close();}
});


test('multiple videos can be selected, created, renamed and restored within one project',async()=>{
 const s=await studio('p1',true),{$,w,change,submit,calls,click}=s;
 try{
  assert.equal($('video-select').value,'');assert.equal(w.workflow.context().video_id,'');
  assert.equal($('project-videos').children.length,2);assert.equal($('all-jobs').children.length,0);
  await change('video-select','v1');assert.equal($('scenes').children.length,2);
  assert.equal($('active-video-name').textContent,'First collection');assert.doesNotMatch($('all-jobs').textContent,/Only video two/);
  await click($('scenes').children[0],'Edit scene');$('scene-prompt').value='Unsaved';$('scene-prompt').dispatchEvent(new w.Event('input',{bubbles:true}));
  w.confirm=()=>false;await change('video-select','v2');assert.equal($('video-select').value,'v1');assert.equal(w.workflow.context().video_id,'v1');
  w.confirm=()=>true;await change('video-select','v2');assert.equal(w.workflow.context().project_id,'p1');assert.equal(w.workflow.context().video_id,'v2');
  assert.equal($('scenes').querySelectorAll('[data-scene-id]').length,0);assert.match($('all-jobs').textContent,/Only video two/);assert.doesNotMatch($('all-jobs').textContent,/Boat job/);
  assert.equal(w.localStorage.getItem('active-video:p1'),'v2');
  $('edit-video-title').value='Updated second topic';await submit('edit-video');assert.equal($('active-video-name').textContent,'Updated second topic');
  assert.equal(calls.filter(c=>c.method==='PATCH').at(-1).route,'/api/videos/v2');
  $('new-video-title').value='Third topic';await submit('create-video');assert.equal($('video-select').value,'v3');assert.equal(w.workflow.context().video_id,'v3');
  assert.equal($('active-project-name').textContent,'First project');assert.equal($('project-videos').children.length,3);
  await change('job-scope','project');assert.match($('all-jobs').textContent,/Boat job/);assert.match($('all-jobs').textContent,/Only video two/);
  await change('project-select','p2');await change('project-select','p1');assert.equal($('video-select').value,'v3');
 }finally{s.dom.window.close();}
 const restored=await studio('p1',true,'v2');
 try{assert.equal(restored.$('video-select').value,'v2');assert.equal(restored.w.workflow.context().video_id,'v2');}finally{restored.dom.window.close();}
});

test('Scene Board owns downloads and recovery links; the old queue route is removed',async()=>{
 const s=await studio('p1',true,'v1'),{$,w,calls}=s;
 try{
  assert.equal(w.document.querySelector('[data-page="queue"]'),null);
  assert.equal(w.document.querySelector('[data-view="queue"]'),null);
  for(const id of ['all-jobs','job-details','pause','export-filtered','flow-activity-jobs'])assert.equal($(id).closest('[data-view]').dataset.view,'scene-board');
  await w.focusProductionJob('c');
  assert.equal(w.document.querySelector('[data-page].active').dataset.page,'scene-board');
  assert.equal($('job-search').value,'c');assert.match($('job-detail-text').textContent,/Download failed/);
  assert.equal($('all-jobs').querySelector('[data-job-id="c"]')!==null,true);
  await assert.rejects(w.focusProductionJob('second-video-job'),/does not belong/);
  assert.equal(calls.filter(c=>c.method==='POST'&&c.route==='/api/desktop/jobs').length,0);
 }finally{s.dom.window.close();}
});

test('job previews and exports stay inside Scene Board and late previews cannot reopen after leaving',async()=>{
 const s=await studio('p2'),{$,w,click,exports}=s;
 const urls=[],revoked=[];w.URL.createObjectURL=()=>{const url='blob:preview-'+urls.length;urls.push(url);return url;};w.URL.revokeObjectURL=url=>revoked.push(url);
 w.studio.preview=async()=>({bytes:new Uint8Array([1]),kind:'image',mime:'image/png'});
 try{
  w.document.querySelector('[data-page="scene-board"]').click();
  await click($('all-jobs'),'Preview');
  assert.equal($('heading').textContent,'Scene Board');assert.equal($('download-preview').hidden,false);
  assert.equal($('download-preview').querySelector('img').src,'blob:preview-0');
  await click($('all-jobs'),'Export files');assert.deepEqual(exports,['b']);
  $('close-job-details').click();assert.equal($('download-preview').hidden,true);assert.deepEqual(revoked,['blob:preview-0']);
  let release;w.studio.preview=()=>new Promise(r=>release=r);
  await click($('all-jobs'),'Preview');
  w.document.querySelector('[data-page="projects"]').click();
  release({bytes:new Uint8Array([2]),kind:'image',mime:'image/png'});await tick();
  assert.equal($('heading').textContent,'Project');assert.equal($('download-preview').hidden,true);assert.equal(urls.length,1);
 }finally{s.dom.window.close();}
});

test('Scene Board history preserves pause, saved-result resume and scoped queued cancellation',async()=>{
 const s=await studio('p1',true,'v1'),{$,w,click,calls}=s;let paused=false,resumed=false;
 const base=w.studio.api;
 w.studio.api=async(method,route,body)=>{
  if(route==='/api/desktop/pause'){calls.push({method,route,body});paused=body.paused;return{paused};}
  if(route==='/api/desktop/jobs/c/resume'){calls.push({method,route,body});resumed=true;return{};}
  const value=await base(method,route,body);
  if(route==='/api/desktop/jobs'&&method==='GET'){value.paused=paused;if(resumed){const row=value.jobs.find(j=>j.id==='c');row.can_resume=false;row.state='DOWNLOADING';}}
  return value;
 };
 try{
  w.document.querySelector('[data-page="scene-board"]').click();
  $('pause').click();await tick();assert.equal(paused,true);assert.equal($('pause').textContent,'Resume all media jobs');
  await click($('all-jobs'),'Resume saved result');assert.match($('all-jobs').textContent,/DOWNLOADING/);
  $('cancel-filtered').click();await tick();assert.deepEqual(Array.from(calls.find(c=>c.route==='/api/desktop/jobs/cancel').body.ids),['a']);
  assert.equal(calls.some(c=>c.route==='/api/desktop/jobs'&&c.method==='POST'),false);
 }finally{s.dom.window.close();}
});
