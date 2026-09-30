const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');

async function mainProcess(folder, reply) {
  const handlers = new Map(), requests = [];
  let win, ready;
  const loaded = new Promise(resolve => {ready=resolve;});
  class Window {
    constructor(){win=this;this.webContents={setWindowOpenHandler(){},on(){}};}
    async loadFile(){ready();}
  }
  const electron = {
    app:{whenReady:()=>Promise.resolve(),getPath:()=>folder,on(){}},
    BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[path.join(folder,'sample.mp3')]})},shell:{}
  };
  const root=path.resolve(__dirname,'..');
  const source=await fs.readFile(path.join(root,'main.cjs'),'utf8');
  vm.runInNewContext(source, {
    require: name=>name==='electron'?electron:require(name),__dirname:root,process,console,AbortSignal,FormData,Blob,
    fetch:async(url,options)=>{requests.push({url,options});return reply && !url.endsWith('/health') ? reply : {ok:true,text:async()=>'{"ok":true}'};}
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
    await main.invoke('api','PUT','/api/storyboard/videos/video-123',{script_text:'Script'});
    await main.invoke('api','POST','/api/storyboard/videos/video-123/generate-media',{segment_ids:['segment'],kind:'image'});
    assert(main.requests.some(r=>r.url.endsWith('/api/storyboard/videos/video-123')&&r.options.method==='PUT'));
    assert(main.requests.some(r=>r.url.endsWith('/api/scenes/scene-123')&&r.options.method==='PATCH'));
    assert(main.requests.some(r=>r.url.endsWith('/api/desktop/jobs/cancel')));
    await assert.rejects(main.invoke('api','GET','/api/scenes/../private'),/Unsupported/);
    await assert.rejects(main.handlers.get('api')({sender:{},senderFrame:{url:'https://example.com'}},'GET','/health'),/Untrusted/);
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
  ['plain-text server error', {ok:false,status:500,text:async()=> 'Internal Server Error'}, /Backend HTTP 500: Internal Server Error/],
  ['JSON error detail', {ok:false,status:409,text:async()=> '{"detail":"Voice already exists"}'}, /Voice already exists/],
  ['empty server error', {ok:false,status:502,text:async()=> ''}, /Backend HTTP 502: Empty response/],
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
