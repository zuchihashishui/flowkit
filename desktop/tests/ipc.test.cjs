const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');

const compatibleHealth = {studio_api:3,studio_features:{production_workspace:true,project_multi_video:true,project_provider_urls:true,project_video_sources:true,elevenlabs_native_download_files:true,elevenlabs_unlimited_native_audio:true,elevenlabs_recover_downloads:true,elevenlabs_safe_pre_submit_failures:true,elevenlabs_auto_prepare_tab:true}};
async function mainProcess(folder, reply, health=compatibleHealth) {
  const handlers = new Map(), requests = [];
  let win, ready;
  const loaded = new Promise(resolve => {ready=resolve;});
  class Window {
    constructor(){win=this;this.webContents={setWindowOpenHandler(){},on(){}};}
    async loadFile(){ready();}
  }
  const electron = {
    app:{whenReady:()=>Promise.resolve(),getPath:()=>folder,on(){}},
    BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showSaveDialog:async()=>({canceled:false,filePath:path.join(folder,'chat-results.json')}),showOpenDialog:async()=>({canceled:false,filePaths:[path.join(folder,'sample.mp3')]})},shell:{openExternal:async url=>{requests.push({opened:url});}}
  };
  const root=path.resolve(__dirname,'..');
  const source=await fs.readFile(path.join(root,'main.cjs'),'utf8');
  vm.runInNewContext(source, {
    require: name=>name==='electron'?electron:name==='./backend-runtime.cjs'?require('../backend-runtime.cjs'):name==='./backend-compatibility.cjs'?require('../backend-compatibility.cjs'):name.endsWith('chatgpt-process.cjs')?()=>({start:async()=>{},stop(){},getError(){return '';}}):require(name),__dirname:root,process,console,AbortSignal,FormData,Blob,Buffer,
    fetch:async(url,options)=>{requests.push({url,options});return reply && !url.endsWith('/health') ? (typeof reply==='function'?reply(url,options):reply) : {ok:true,text:async()=>JSON.stringify(health)};}
  });
  await loaded;
  const event={sender:win.webContents,senderFrame:{url:pathToFileURL(path.join(root,'ui/index.html')).href}};
  return {requests,handlers,event,dialog:electron.dialog,invoke:(name,...args)=>handlers.get(name)(event,...args)};
}

test('actual main-process IPC supports scene edits and queue cancellation, rejects untrusted routes',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-ipc-'));
  try {
    const main=await mainProcess(folder);
    await main.invoke('api','PATCH','/api/videos/video-123',{title:'New title'});
    await main.invoke('api','DELETE','/api/videos/empty-video');
    await main.invoke('api','DELETE','/api/projects/empty-project');
    await main.invoke('api','DELETE','/api/projects/project-123?cascade=true');
    await main.invoke('api','DELETE','/api/videos/video-123?cascade=true');
    await assert.rejects(main.invoke('api','DELETE','/api/projects/project-123?cascade=true&other=true'),/Unsupported/);
    await assert.rejects(main.invoke('api','DELETE','/api/scenes/scene-123'),/Unsupported/);
    await assert.rejects(main.invoke('api','DELETE','/api/projects/empty-project/settings'),/Unsupported/);
    await main.invoke('api','PATCH','/api/scenes/scene-123',{narrator_text:'Edited'});
    await main.invoke('api','POST','/api/desktop/jobs/cancel',{ids:['job']});
    await main.invoke('api','POST','/api/chatgpt/message',{prompt:'Hello'});
    await main.invoke('api','POST','/api/chatgpt/models',{});
    await main.invoke('api','POST','/api/chatgpt/preflight',{model:'auto'});
    assert(main.requests.some(r=>r.url.endsWith('/api/chatgpt/message') && JSON.parse(r.options.body).prompt==='Hello'));
    await main.invoke('api','PUT','/api/storyboard/videos/video-123',{script_text:'Script'});
    await main.invoke('api','POST','/api/storyboard/videos/video-123/generate-media',{segment_ids:['segment'],kind:'image'});
    await main.invoke('api','POST','/api/storyboard/videos/video-123/retry-failed',{segment_ids:['segment'],kind:'image'});
    for(const route of ['preflight','scene-media','project-sources','jobs/12345678-1234-1234-1234-123456789abc/resume'])await main.invoke('api','POST','/api/assembly/'+route,{});

    assert(main.requests.some(r=>r.url.endsWith('/api/storyboard/videos/video-123')&&r.options.method==='PUT'));
    assert(main.requests.some(r=>r.url.endsWith('/api/scenes/scene-123')&&r.options.method==='PATCH'));
    assert(main.requests.some(r=>r.url.endsWith('/api/desktop/jobs/cancel')));
    await assert.rejects(main.invoke('api','GET','/api/scenes/../private'),/Unsupported/);
    await assert.rejects(main.handlers.get('api')({sender:{},senderFrame:{url:'https://example.com'}},'GET','/health'),/Untrusted/);
    await assert.rejects(main.handlers.get('backend-action')({sender:{},senderFrame:{url:'https://example.com'}},'restart'),/Untrusted/);
    await assert.rejects(main.invoke('backend-action','kill-all'),/Unsupported/);
    assert.equal((await main.invoke('backend-action','status')).backendDiagnostics.compatible,true);
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('auto-export preference is written by IPC and restored after main-process restart',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-settings-'));
  try {
    const main=await mainProcess(folder);
    await main.invoke('update-settings',{autoExport:false});
    assert.equal(JSON.parse(await fs.readFile(path.join(folder,'settings.json'),'utf8')).autoExport,false);
    const restarted=await mainProcess(folder);
    assert.equal((await restarted.invoke('settings')).autoExport,false);
    await assert.rejects(restarted.invoke('update-settings',{autoExport:true,output:'/unauthorized'}),/Invalid preferences/);
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

for (const [label, response, expected] of [
  ['plain-text server error', {ok:false,status:500,text:async()=> 'Internal Server Error'}, /Backend HTTP 500.*Internal Server Error/],
  ['JSON error detail', {ok:false,status:409,text:async()=> '{"detail":"Voice already exists"}'}, /Voice already exists/],
  ['empty server error', {ok:false,status:502,text:async()=> ''}, /Backend HTTP 502.*Empty response/],
]) {
  test(`voice import displays ${label} without a JSON parsing exception`, async()=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-voice-'));
    try {
      await fs.writeFile(path.join(folder,'sample.mp3'),'upload fixture');
      const main=await mainProcess(folder,response);
      await assert.rejects(main.invoke('import-voice','narrator','Sample transcript',true),expected);
    } finally {await fs.rm(folder,{recursive:true,force:true});}
  });
}

test('ChatGPT export saves only selected backend results',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-chat-export-'));
 try{
  const main=await mainProcess(folder,{ok:true,text:async()=>JSON.stringify({jobs:[{id:'a',answer:'A'},{id:'b',answer:'B'}]})});
  await main.invoke('save-chat-results',['b']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder,'chat-results.json'),'utf8')),[{id:'b',answer:'B'}]);
  await assert.rejects(main.invoke('save-chat-results',[]),/Select/);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});


test('ElevenLabs IPC restricts API methods and validates audio IDs before downloading',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-el-ipc-'));
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 try{
  const main=await mainProcess(folder);
  for(const [method,route] of [['GET','status'],['GET','jobs'],['GET','jobs/'+id],['POST','preview'],['POST','jobs'],['POST','probe'],['POST','control'],['POST','jobs/'+id+'/cancel'],['POST','jobs/'+id+'/retry'],['POST','jobs/'+id+'/recover']])await main.invoke('api',method,'/api/elevenlabs/'+route,{});
  await main.invoke('api','GET','/api/desktop/flow-progress');
  for(const [method,route] of [['GET','preview'],['POST','status'],['GET','audio/'+id+'/1'],['GET','jobs/../private'],['POST','jobs/'+id+'/erase']])await assert.rejects(main.invoke('api',method,'/api/elevenlabs/'+route),/Unsupported/);
  await assert.rejects(main.invoke('elevenlabs-audio','../../file',1,'preview'),/Invalid ElevenLabs job ID/);
  await assert.rejects(main.invoke('elevenlabs-audio',id,1,'open'),/Unsupported audio action/);
  await assert.rejects(main.invoke('elevenlabs-action','https://example.com'),/Unsupported ElevenLabs action/);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('ElevenLabs audio preview, save and export resolve files by ID using the local backend',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-el-audio-'));
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',audio=Buffer.from('ID3 audio fixture');
 try{
  const main=await mainProcess(folder,url=>url.includes('/audio/')?new Response(audio,{headers:{'content-type':'audio/mpeg'}}):{ok:true,text:async()=>JSON.stringify({id,chunks:[{index:1,state:'COMPLETED',audio_url:'https://untrusted.example/audio.mp3'}]})});
  const result=await main.invoke('elevenlabs-audio',id,1,'preview');assert.equal(result.mime,'audio/mpeg');assert.deepEqual(Buffer.from(result.bytes),audio);
  await assert.rejects(main.invoke('elevenlabs-audio',id,'../../private','preview'),/Invalid ElevenLabs chunk index/);
  await assert.rejects(main.invoke('elevenlabs-audio',id,2,'preview'),/not ready/);
  await assert.rejects(main.invoke('elevenlabs-audio',id,'merged','preview'),/not ready/);
  await main.invoke('elevenlabs-audio',id,1,'save');assert.deepEqual(await fs.readFile(path.join(folder,'chat-results.json')),audio);
  const exported=await main.invoke('elevenlabs-export',id);assert.equal(exported.count,1);assert.deepEqual(await fs.readFile(path.join(exported.path,'001.mp3')),audio);
  assert(main.requests.every(r=>r.url.startsWith('http://127.0.0.1:8100/')));
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('stale backend is visible in status and cannot accept new ElevenLabs mutations',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-stale-backend-'));
 try {
  const health={studio_api:3};
  const main=await mainProcess(folder,{ok:true,text:async()=>JSON.stringify({connected:true})},health);
  const status=await main.invoke('api','GET','/api/elevenlabs/status');assert.match(status.compatibilityError,/older or incompatible backend/);
  for(const route of ['jobs','probe','control']) await assert.rejects(main.invoke('api','POST','/api/elevenlabs/'+route,{text:'never send'}),/Backend update required/);
  assert.equal(main.requests.some(r=>r.url.includes('/api/elevenlabs/')&&r.options.method==='POST'),false);
  Object.assign(health,compatibleHealth);
  assert.equal((await main.invoke('api','GET','/api/elevenlabs/status')).compatibilityError,'');
  await main.invoke('api','POST','/api/elevenlabs/probe',{});
 } finally {await fs.rm(folder,{recursive:true,force:true});}
});

test('WhisperX IPC accepts only job/settings/check routes and validates export IDs',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-wx-ipc-'));
 try {
  const main=await mainProcess(folder);
  await main.invoke('api','GET','/api/whisperx/status');
  await main.invoke('api','POST','/api/whisperx/jobs',{source_id:'11111111-1111-4111-8111-111111111111'});
  await main.invoke('api','POST','/api/whisperx/settings',{auto:false});
  assert(main.requests.some(r=>r.url.endsWith('/api/whisperx/jobs')));
  await assert.rejects(main.invoke('api','POST','/api/whisperx/run-command',{}),/Unsupported/);
  await assert.rejects(main.invoke('api','GET','/api/whisperx/jobs/../../file/preview'),/Unsupported/);
  await assert.rejects(main.invoke('whisperx-save','../../file'),/Invalid/);
 } finally {await fs.rm(folder,{recursive:true,force:true});}
});

test('WhisperX import uses native file selection and uploads audio without renderer paths',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-wx-import-'));
 try {
  await fs.writeFile(path.join(folder,'sample.mp3'),'ID3fixture');
  const main=await mainProcess(folder,{ok:true,text:async()=>JSON.stringify({id:'imported',title:'sample.mp3'})});
  const result=await main.invoke('whisperx-import');
  assert.equal(result.id,'imported');
  const upload=main.requests.find(r=>r.url.endsWith('/api/whisperx/import'));
  assert.equal(upload.options.body.get('file').name,'sample.mp3');
  assert.equal(upload.options.body.get('file').size,10);
  await assert.rejects(main.invoke('api','POST','/api/whisperx/import',{}),/Unsupported/);
 } finally {await fs.rm(folder,{recursive:true,force:true});}
});

test('WhisperX exports each JSON variant with its own name and allowlists split/preview routes',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-wx-split-'));
 const jid='11111111-1111-1111-1111-111111111111',root='/api/whisperx/jobs/'+jid;
 try{
  const main=await mainProcess(folder,(url)=>new Response(JSON.stringify({route:url})));
  for(const [variant,name,suffix] of [['full','transcript.json',''],['video','transcript_video.json','/video'],['image','transcript_image.json','/image']]){
   main.dialog.showSaveDialog=async(_win,options)=>{assert.equal(options.defaultPath,name);return {canceled:false,filePath:path.join(folder,name)};};
   const result=await main.invoke('whisperx-save',jid,variant);
   assert.equal(JSON.parse(await fs.readFile(result.path,'utf8')).route,'http://127.0.0.1:8100'+root+'/result'+suffix);
   await main.invoke('api','GET',root+'/preview/'+variant);
  }
  await main.invoke('api','POST',root+'/split',{video_duration_seconds:50});
  await assert.rejects(main.invoke('api','GET',root+'/preview/private'),/Unsupported/);
  await assert.rejects(main.invoke('whisperx-save',jid,'../private'),/Invalid transcript variant/);
  await assert.rejects(main.invoke('whisperx-save',jid,'__proto__'),/Invalid transcript variant/);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('SRT picker cancellation skips upload and an older backend reports restart instructions',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-srt-missing-api-'));
 try{
  const main=await mainProcess(folder,()=>new Response('{"detail":"Not Found"}',{status:404}));
  main.dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});
  const requestsBefore=main.requests.length;
  assert.equal((await main.invoke('srt-import')).canceled,true);
  assert.equal(main.requests.length,requestsBefore);
  const filename=path.join(folder,'日本語.json');await fs.writeFile(filename,'{"segments":[]}');
  main.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filename]});
  await assert.rejects(main.invoke('srt-import'),/JSON → SRT is missing.*restart Studio and its backend/);
  await assert.rejects(main.invoke('api','GET','/api/srt/status'),/JSON → SRT is missing/);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('SRT imports through native picker and generic IPC cannot read arbitrary files',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-srt-ipc-'));
 try{
  await fs.writeFile(path.join(folder,'sample.mp3'),'{"word_segments":[]}');
  const main=await mainProcess(folder,(url,options)=>{
   if(url.endsWith('/api/srt/import')){
    assert(options.body instanceof FormData);
    assert.equal(options.body.get('file').name,'sample.mp3');
   }
   return {ok:true,text:async()=>JSON.stringify({id:'source-id',title:'sample.json'})};
  });
  assert.equal((await main.invoke('srt-import')).id,'source-id');
  await main.invoke('api','GET','/api/srt/status');
  await main.invoke('api','POST','/api/srt/jobs',{source_id:'source-id',prompt:'SRT'});
  const jid='11111111-1111-1111-1111-111111111111';
  await main.invoke('api','POST','/api/srt/analyze',{source_id:'source-id'});
  await main.invoke('api','GET',`/api/srt/jobs/${jid}/quality`);
  await main.invoke('api','POST',`/api/srt/jobs/${jid}/approve`,{reviewed:true});
  await assert.rejects(main.invoke('api','GET','/api/srt/analyze'),/Unsupported/);
  await assert.rejects(main.invoke('api','GET',`/api/srt/jobs/${jid}/approve`),/Unsupported/);
  await assert.rejects(main.invoke('api','POST','/api/srt/import',{}),/Unsupported/);
  await assert.rejects(main.invoke('srt-save','../../private'),/Invalid/);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('assembly folder imports supported files and streams completed MP4 to native save location',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-assembly-ipc-'));
 const jid='11111111-1111-1111-1111-111111111111';
 try{
  await fs.writeFile(path.join(folder,'001.png'),'image1');await fs.writeFile(path.join(folder,'002.jpg'),'image2');await fs.writeFile(path.join(folder,'ignore.txt'),'ignore');
  const uploaded=[],video=Buffer.alloc(2*1024*1024,37);
  const main=await mainProcess(folder,(url,options)=>{
   if(url.endsWith('/api/assembly/import/image')){uploaded.push(options.body.get('file').name);return new Response(JSON.stringify({id:'image'+uploaded.length,kind:'image'}));}
   if(url.endsWith('/api/assembly/status'))return new Response(JSON.stringify({jobs:[{id:jid,state:'COMPLETED'}]}));
   if(url.endsWith('/thumbnail'))return new Response(Buffer.from('jpeg'));
   if(url.endsWith('/video'))return new Response(video,{headers:{'Content-Type':'video/mp4'}});
   throw Error('Unexpected request '+url);
  });
  main.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});
  const imported=await main.invoke('assembly-import','images-folder');
  assert.equal(imported.assets.length,2);assert.deepEqual(uploaded.sort(),['001.png','002.jpg']);
  assert.match(await main.invoke('assembly-media',jid,'thumbnail'),/^data:image\/jpeg;base64,/);
  assert.equal((await main.invoke('assembly-media',jid,'preview')).url,`http://127.0.0.1:8100/api/assembly/jobs/${jid}/video`);
  const result=await main.invoke('assembly-media',jid,'save');assert.deepEqual(await fs.readFile(result.path),video);
  await assert.rejects(main.invoke('assembly-media','../../private','save'),/Invalid/);
  await assert.rejects(main.invoke('api','POST','/api/assembly/import/image',{}),/Unsupported/);
  await assert.rejects(main.invoke('assembly-import','arbitrary-path'),/Unsupported/);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('workflow IPC scopes queries and uploads, captures picker context and rejects older backends',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-scope-'));
 try{
  await fs.writeFile(path.join(folder,'sample.mp3'),'fixture');
  const health=structuredClone(compatibleHealth),main=await mainProcess(folder,undefined,health);
  const ctx={project_id:'project-a',video_id:'video-a'};
  for(const route of ['elevenlabs/jobs','whisperx/status','srt/status','assembly/status','workflow/resources']){
   await main.invoke('api','GET','/api/'+route+'?project_id=project-a&video_id=video-a');
  }
  for(const action of ['assignment-preview','assign','import-scenes'])await main.invoke('api','POST','/api/workflow/'+action,{...ctx,kind:'srt',id:'result'});
  for(const channel of ['whisperx-import','srt-import']){
   await assert.rejects(main.invoke(channel,'/untrusted-path'),/Select a project and video/);
   await assert.rejects(main.invoke(channel,{project_id:'project-a'}),/Select a project and video/);
   let release;
   main.dialog.showOpenDialog=()=>new Promise(resolve=>{release=resolve;});
   const original={...ctx},pending=main.invoke(channel,original);
   while(!release)await new Promise(resolve=>setImmediate(resolve));
   original.video_id='video-b';
   release({canceled:false,filePaths:[path.join(folder,'sample.mp3')]});
   await pending;
   const upload=main.requests.filter(r=>r.url.endsWith('/import')).at(-1);
   assert.equal(upload.options.body.get('project_id'),'project-a');
   assert.equal(upload.options.body.get('video_id'),'video-a');
  }
  await assert.rejects(main.invoke('api','GET','/api/workflow/resources?path=secret'),/Unsupported/);
  delete health.studio_features.project_video_sources;
  const before=main.requests.length;
  await assert.rejects(main.invoke('api','POST','/api/srt/jobs',{...ctx,source_id:'source',prompt:'SRT'}),/updated backend/);
  assert(!main.requests.slice(before).some(r=>r.url.endsWith('/api/srt/jobs')));
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});


test('assembly imports optional video files/folders and validates original clip previews',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-video-import-'));
 const aid='22222222-2222-2222-2222-222222222222',uploaded=[];
 try{
  await fs.writeFile(path.join(folder,'001.MP4'),'video1');await fs.writeFile(path.join(folder,'002.webm'),'video2');await fs.writeFile(path.join(folder,'ignore.png'),'image');
  const main=await mainProcess(folder,(url,options)=>{
   if(url.endsWith('/api/assembly/import/video')){uploaded.push(options.body.get('file').name);return new Response(JSON.stringify({id:aid,kind:'video'}));}
   if(url.endsWith('/api/assembly/status'))return new Response(JSON.stringify({assets:[{id:aid,kind:'video'}],jobs:[]}));
   throw Error('Unexpected request '+url);
  });
  main.dialog.showOpenDialog=async(_win,options)=>{assert.ok(options.properties.includes('openDirectory'));return {canceled:false,filePaths:[folder]};};
  const imported=await main.invoke('assembly-import','videos-folder');assert.equal(imported.assets.length,2);assert.deepEqual(uploaded.sort(),['001.MP4','002.webm']);
  main.dialog.showOpenDialog=async(_win,options)=>{assert.ok(options.properties.includes('multiSelections'));assert.ok(options.filters[0].extensions.includes('mp4'));return {canceled:false,filePaths:[path.join(folder,'001.MP4')]};};
  assert.equal((await main.invoke('assembly-import','videos')).assets.length,1);
  assert.equal((await main.invoke('assembly-media',aid,'clip-preview')).url,`http://127.0.0.1:8100/api/assembly/clips/${aid}/video`);
  await assert.rejects(main.invoke('assembly-media','11111111-1111-1111-1111-111111111111','clip-preview'),/not available/);
  await assert.rejects(main.invoke('api','POST','/api/assembly/import/video',{}),/Unsupported/);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('multi-video creation cannot fall back to an old one-video backend',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-multi-ipc-'));
 try{
  const health={...compatibleHealth,studio_features:{...compatibleHealth.studio_features,project_multi_video:false,project_single_video:true}};
  const main=await mainProcess(folder,undefined,health);
  await assert.rejects(main.invoke('api','POST','/api/videos',{project_id:'p',title:'New topic'}),/multiple videos per project/);
  assert.equal(main.requests.some(r=>r.url.endsWith('/api/videos')),false);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('Project Settings IPC opens only the saved service URL and rejects an older backend before submitting prompts',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-project-settings-'));
 try{
  const main=await mainProcess(folder,{ok:true,text:async()=>JSON.stringify({image_prompt_url:'https://chatgpt.com/g/g-channel-image'})});
  await main.invoke('api','GET','/api/projects/project-a/settings');
  await main.invoke('api','PUT','/api/projects/project-a/settings',{revision:0,image_prompt_url:'https://chatgpt.com/g/g-channel-image'});
  await main.invoke('open-project-page','project-a','image_prompt_url');
  assert.ok(main.requests.some(r=>r.opened==='https://chatgpt.com/g/g-channel-image'));
  await assert.rejects(main.invoke('open-project-page','project-a','https://example.com'),/supported service/);
  const stale=await mainProcess(folder,undefined,{...compatibleHealth,studio_features:{...compatibleHealth.studio_features,project_provider_urls:false}});
  await assert.rejects(stale.invoke('api','POST','/api/storyboard/videos/video-a/generate-concepts',{prompt_kind:'image'}),/project URLs/);
  assert.equal(stale.requests.some(r=>r.url.endsWith('/generate-concepts')),false);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('production IPC permits scoped progress/settings/backup operations and rejects unsupported routes and older backends',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-production-ipc-'));
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 try{
  const main=await mainProcess(folder);
  for(const [method,route] of [
   ['GET','/api/production/overview?project_id=p'],['GET','/api/production/recovery?project_id=p&video_id=v'],
   ['POST','/api/production/preflight'],['GET','/api/videos/v/settings'],['PUT','/api/videos/v/settings'],
   ['POST','/api/maintenance/duplicate-project'],['GET','/api/maintenance/backups'],['POST','/api/maintenance/backups'],['GET','/api/maintenance/backups/'+id]
  ])await main.invoke('api',method,route,{});
  for(const [method,route] of [
   ['POST','/api/videos/v/settings'],['POST','/api/production/overview?project_id=p'],
   ['GET','/api/production/overview?project_id=p&path=secret'],['POST','/api/maintenance/restore'],
   ['GET','/api/maintenance/backups/'+id+'/file']
  ])await assert.rejects(main.invoke('api',method,route,{}),/Unsupported/);
  const stale=await mainProcess(folder,undefined,{...compatibleHealth,studio_features:{...compatibleHealth.studio_features,production_workspace:false}});
  await assert.rejects(stale.invoke('api','PUT','/api/videos/v/settings',{overrides:{assembly:{image_motion:'zoom_in'}}}),/updated backend/);
  await assert.rejects(stale.invoke('api','POST','/api/assembly/jobs',{image_motion:'zoom_out'}),/updated backend/);
  assert.equal(stale.requests.some(r=>r.options.method==='POST'||r.options.method==='PUT'),false);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('Text to Prompt IPC imports UTF-8 SRT and TXT and permits the atomic input route',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-prompt-input-'));
 try{
  const main=await mainProcess(folder),filters=[];
  const source=path.join(folder,'instructions.txt');await fs.writeFile(source,'\ufeff日本語の指示。\nNext line','utf8');
  main.dialog.showOpenDialog=async(_,options)=>{filters.push(options.filters[0].extensions);return {canceled:false,filePaths:[source]};};
  for(const kind of ['prompt','srt']){const result=await main.invoke('import-script-source',kind);assert.equal(result.text,'日本語の指示。\nNext line');}
  assert.deepEqual(Array.from(filters[0]),['txt']);assert.deepEqual(Array.from(filters[1]),['srt']);
  await main.invoke('api','POST','/api/storyboard/videos/video-123/prompt-input',{srt_content:'SRT',srt_name:'input.srt',prompt_template:'Instructions',prompt_name:'prompt.txt'});
  assert.ok(main.requests.some(r=>r.url.endsWith('/prompt-input')&&JSON.parse(r.options.body).prompt_name==='prompt.txt'));
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('IPC timeout identifies route and warns against resubmitting uncertain writes',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-timeout-'));
 try {
  const main=await mainProcess(folder,()=>{const e=new Error('aborted');e.name='TimeoutError';throw e;});
  await assert.rejects(main.invoke('api','PUT','/api/storyboard/videos/video-123/prompt-options',{}),/Backend timeout: PUT .*prompt-options.*limit 120s.*Refresh row\/job status/);
  const reads=await mainProcess(folder,()=>({ok:true,text:async()=>{const e=new Error('body timed out');e.name='TimeoutError';throw e;}}));
  await assert.rejects(reads.invoke('api','GET','/api/chatgpt/status'),/Backend timeout: GET .*chatgpt\/status.*limit 10s/);
 }finally{await fs.rm(folder,{recursive:true,force:true});}
});
