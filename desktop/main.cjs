const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8100';
const gateway = require(path.join(__dirname,'chatgpt-process.cjs'))(app, ROOT);
let win, backend, settings = {}, backendLog;
const entry = pathToFileURL(path.join(__dirname, 'ui/index.html')).href;
const storyboardAllowed = /^\/api\/storyboard\/(providers|videos\/[a-zA-Z0-9_-]+(?:\/(segments|generate-concepts|cancel-concepts|generate-media))?|segments\/[a-zA-Z0-9_-]+(?:\/concepts)?|concepts\/[a-zA-Z0-9_-]+\/select)$/;
const allowed = /^\/(health|api\/(projects(?:\/[a-zA-Z0-9_-]+)?|videos|scenes(?:\/[a-zA-Z0-9_-]+)?|models|materials|flow\/status|tts\/templates(?:\/[a-zA-Z0-9_-]+)?|desktop\/(jobs(?:\/cancel|\/[a-f0-9-]+\/resume)?|pause|diagnostics)))(\?[^#]*)?$/;
async function readBackendResponse(response, route) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch {
    const summary = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    console.error(`[Backend Error] ${response.status} on ${route}: ${summary}`);
    throw Error(`Backend HTTP ${response.status} on ${route}: ${summary || 'Empty response'}. Check backend.log for details.`);
  }
  if (!response.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : JSON.stringify(data?.detail || data);
    console.error(`[Backend Error] ${response.status} on ${route}: ${detail}`);
    throw Error(`Backend HTTP ${response.status} on ${route}: ${detail}`);
  }
  return data;
}
async function request(method, route, body) {
  const response = await fetch(BASE + route, {method, headers:body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(route.startsWith('/api/chatgpt/')?620000:120000)});
  return readBackendResponse(response, route);
}
function handle(name, fn) { ipcMain.handle(name, async (event,...args) => {
  if(event.sender !== win.webContents || event.senderFrame.url !== entry) throw Error('Untrusted caller');
  return fn(...args);
}); }
let settingsWrite = Promise.resolve();
function saveSettings(){
  const data = JSON.stringify(settings,null,2);
  const target = path.join(app.getPath('userData'),'settings.json');
  settingsWrite = settingsWrite.catch(()=>{}).then(async()=>{
    await fs.writeFile(target+'.tmp',data);
    await fs.rename(target+'.tmp',target);
  });
  return settingsWrite;
}
async function startBackend(){
  try {
    const health=await request('GET','/health');
    if(health.studio_api!==1)dialog.showErrorBox?.('Backend update required','An older backend is already using port 8100. Stop that backend and restart Flowkit before using ChatGPT Web.');
    return;
  } catch {}
  const python = process.env.FLOWKIT_PYTHON || path.join(ROOT,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  try {await fs.access(python);} catch {return;}
  backendLog=await fs.open(path.join(app.getPath('userData'),'backend.log'),'a');
  backend=spawn(python,['-m','agent.main'],{cwd:ROOT,env:{...process.env,PYTHONUNBUFFERED:'1',API_HOST:'127.0.0.1',API_PORT:'8100',WS_HOST:'127.0.0.1',WS_PORT:'9222',TTS_PYTHON_BIN:process.env.TTS_PYTHON_BIN || python},stdio:['ignore',backendLog.fd,backendLog.fd],windowsHide:true,detached:process.platform!=='win32'});
  backend.on('error',err=>console.error('Backend:',err.message));
  // Wait for backend ready
  for(let i=0; i<30; i++) {
    await new Promise(r=>setTimeout(r,1000));
    try { await request('GET','/health'); console.log('[Backend] Ready after',i+1,'seconds'); return; } catch {}
  }
  console.warn('[Backend] Health check timed out after 30s');
}
async function jobById(id){
  if(!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid job ID');
  const data=await request('GET','/api/desktop/jobs');
  const job=data.jobs.find(j=>j.id===id);
  if(!job || job.state!=='COMPLETED') throw Error('Job has no completed files');
  return job;
}
async function media(id,index){
  const route = `/api/desktop/jobs/${id}/files/${index}`;
  const response=await fetch(`${BASE}${route}`,{signal:AbortSignal.timeout(300000)});
  if(!response.ok) {
    const text = await response.text();
    console.error(`[Media Error] ${response.status} on ${route}: ${text.slice(0, 200)}`);
    throw Error(`Cannot read generated file: HTTP ${response.status}`);
  }
  return response;
}
app.whenReady().then(async()=>{
  try {settings=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'settings.json'),'utf8'));}catch{}
  settings.output ||= path.join(app.getPath('videos'),'Flowkit');
  await startBackend();
  await gateway.start();
  win=new BrowserWindow({width:1280,height:900,minWidth:920,minHeight:650,title:'Flowkit Studio',backgroundColor:'#11151e',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  handle('api',(method,route,body)=>{
    if(!['GET','POST','PATCH','PUT'].includes(method)||typeof route!=='string'||!(allowed.test(route)||storyboardAllowed.test(route)||/^\/api\/chatgpt\/(status|history|test|resume|message)$/.test(route))||route.includes('..')||route.includes('\\')) throw Error('Unsupported API operation');
    return request(method,route,body);
  });
  handle('settings',()=>({...settings,extension:path.join(ROOT,'extensions','googleflow')}));
  handle('update-settings',async change=>{
    if(!change || Object.keys(change).some(k=>k!=='autoExport') || typeof change.autoExport!=='boolean')throw Error('Invalid preferences');
    const previous=settings.autoExport;
    settings.autoExport=change.autoExport;
    try {await saveSettings();} catch(error) {settings.autoExport=previous;throw error;}
    return {...settings};
  });
  handle('choose-output',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});if(!r.canceled){settings.output=r.filePaths[0];await saveSettings();}return settings;});
  handle('open-output',async()=>{await fs.mkdir(settings.output,{recursive:true});const error=await shell.openPath(settings.output);if(error)throw Error(error);});
  handle('chatgpt-action',async action=>{
    if(action==='open')return shell.openExternal('https://chatgpt.com/');
    if(action==='extension')return shell.openPath(path.join(ROOT,'extensions/chatgpt'));
    if(action==='logs')return shell.openPath(app.getPath('userData'));
    if(action==='startup-error')return gateway.getError();
    throw Error('Unsupported ChatGPT action');
  });
  handle('open-flow',()=>shell.openExternal('https://flow.google.com/'));
  handle('open-extension',()=>shell.openPath(path.join(ROOT,'extensions','googleflow')));
  handle('import-script-source',async kind=>{
    if(!['script','segments'].includes(kind))throw Error('Invalid source type');
    const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Source text',extensions:kind==='script'?['txt']:['srt','json']}]});
    if(r.canceled)return null;
    if((await fs.stat(r.filePaths[0])).size>2*1024*1024)throw Error('Source file must be under 2 MiB');
    return {name:path.basename(r.filePaths[0]),text:await fs.readFile(r.filePaths[0],'utf8')};
  });
  handle('import-script-audio',async videoId=>{
    if(typeof videoId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(videoId))throw Error('Invalid collection');
    const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Narration audio',extensions:['mp3','wav','m4a','flac','ogg','aac','mp4']}]});
    if(r.canceled)return null;
    if((await fs.stat(r.filePaths[0])).size>512*1024*1024)throw Error('Audio must be under 512 MiB');
    const form=new FormData();form.append('audio',new Blob([await fs.readFile(r.filePaths[0])]),path.basename(r.filePaths[0]));
    const route = '/api/storyboard/videos/'+videoId+'/audio';
    const response=await fetch(BASE+route,{method:'POST',body:form,signal:AbortSignal.timeout(300000)});
    return readBackendResponse(response, route);
  });
  handle('import-prompts',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Scene prompts',extensions:['txt','json']}]});if(r.canceled)return null;const st=await fs.stat(r.filePaths[0]);if(st.size>1024*1024)throw Error('Prompt file must be under 1 MiB');const text=await fs.readFile(r.filePaths[0],'utf8');return{text,name:path.basename(r.filePaths[0])};});
  handle('import-voice',async(name,text,consent)=>{
    if(!consent)throw Error('Confirm permission to use this voice');
    const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Reference audio',extensions:['wav','mp3','m4a','flac','ogg']}]});
    if(r.canceled)return null;const st=await fs.stat(r.filePaths[0]);if(st.size>25*1024*1024)throw Error('Reference audio must be under 25 MiB');
    const ext=path.extname(r.filePaths[0]).toLowerCase();
    const mimeMap={'.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.flac':'audio/flac','.ogg':'audio/ogg'};
    const mime=mimeMap[ext]||'application/octet-stream';
    const form=new FormData();form.append('name',name);form.append('text',text);form.append('consent','true');form.append('audio',new Blob([await fs.readFile(r.filePaths[0])],{type:mime}),path.basename(r.filePaths[0]));
    const route = '/api/desktop/voices/import';
    const response=await fetch(BASE+route,{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
    return readBackendResponse(response, route);
  });
  handle('export-job',async id=>{
    const job=await jobById(id);const folder=path.join(settings.output,id);await fs.mkdir(folder,{recursive:true});
    const {pipeline}=require('node:stream/promises');const {Readable}=require('node:stream');const {createWriteStream}=require('node:fs');
    for(let i=0;i<job.files.length;i++){
      const filename=path.basename(job.files[i]);if(!/^[a-zA-Z0-9_.-]+$/.test(filename))throw Error('Invalid file name');
      const dest=path.join(folder,filename);try{if((await fs.stat(dest)).size>0)continue;}catch{}
      const response=await media(id,i);const part=dest+'.part';try{await pipeline(Readable.fromWeb(response.body),createWriteStream(part));await fs.rename(part,dest);}finally{await fs.rm(part,{force:true});}
    } return folder;
  });
  handle('preview',async(id,index)=>{const job=await jobById(id);if(!Number.isInteger(index)||index<0||index>=job.files.length)throw Error('Invalid file');const response=await media(id,index);const bytes=await response.arrayBuffer();if(bytes.byteLength>100*1024*1024)throw Error('Preview exceeds 100 MiB. Export to play locally.');return{bytes,mime:response.headers.get('content-type')||'application/octet-stream',kind:job.payload.kind};});
  await win.loadFile(path.join(__dirname,'ui/index.html'));
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{
  gateway.stop();
  if(!backend?.pid || backend.exitCode!==null)return;
  if(process.platform==='win32')spawn('taskkill',['/PID',String(backend.pid),'/T','/F'],{windowsHide:true});
  else {try{process.kill(-backend.pid,'SIGTERM');}catch{backend.kill();}}
});
