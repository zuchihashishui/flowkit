const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');

const compatibleHealth = {studio_api:3,studio_features:{elevenlabs_native_download_files:true,elevenlabs_unlimited_native_audio:true,elevenlabs_recover_downloads:true,elevenlabs_safe_pre_submit_failures:true,elevenlabs_auto_prepare_tab:true}};
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
    BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showSaveDialog:async()=>({canceled:false,filePath:path.join(folder,'chat-results.json')}),showOpenDialog:async()=>({canceled:false,filePaths:[path.join(folder,'sample.mp3')]})},shell:{}
  };
  const root=path.resolve(__dirname,'..');
  const source=await fs.readFile(path.join(root,'main.cjs'),'utf8');
  vm.runInNewContext(source, {
    require: name=>name==='electron'?electron:name==='./backend-runtime.cjs'?require('../backend-runtime.cjs'):name==='./backend-compatibility.cjs'?require('../backend-compatibility.cjs'):name.endsWith('chatgpt-process.cjs')?()=>({start:async()=>{},stop(){},getError(){return '';}}):require(name),__dirname:root,process,console,AbortSignal,FormData,Blob,
    fetch:async(url,options)=>{requests.push({url,options});return reply && !url.endsWith('/health') ? (typeof reply==='function'?reply(url,options):reply) : {ok:true,text:async()=>JSON.stringify(health)};}
  });
  await loaded;
  const event={sender:win.webContents,senderFrame:{url:pathToFileURL(path.join(root,'ui/index.html')).href}};
  return {requests,handlers,event,invoke:(name,...args)=>handlers.get(name)(event,...args)};
}

test('actual main-process IPC supports scene edits and queue cancellation, rejects untrusted routes',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-ipc-'));
  try {
    const main=await mainProcess(folder);
    await main.invoke('api','PATCH','/api/scenes/scene-123',{narrator_text:'Edited'});
    await main.invoke('api','POST','/api/desktop/jobs/cancel',{ids:['job']});
    await main.invoke('api','POST','/api/chatgpt/message',{prompt:'Hello'});
    await main.invoke('api','POST','/api/chatgpt/models',{});
    await main.invoke('api','POST','/api/chatgpt/preflight',{model:'auto'});
    assert(main.requests.some(r=>r.url.endsWith('/api/chatgpt/message') && JSON.parse(r.options.body).prompt==='Hello'));
    await main.invoke('api','PUT','/api/storyboard/videos/video-123',{script_text:'Script'});
    await main.invoke('api','POST','/api/storyboard/videos/video-123/generate-media',{segment_ids:['segment'],kind:'image'});
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
