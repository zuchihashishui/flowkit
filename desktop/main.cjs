const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8100';
const backendProblem = require('./backend-compatibility.cjs');
const gateway = require(path.join(__dirname,'chatgpt-process.cjs'))(app, ROOT);
let win, settings = {};
let runtime;
const entry = pathToFileURL(path.join(__dirname, 'ui/index.html')).href;
function workflowAllowed(method,route){
  return method==='GET'&&/^\/api\/(elevenlabs\/jobs|whisperx\/status|srt\/status|assembly\/status|workflow\/resources)(\?(project_id|video_id|unassigned)=[a-zA-Z0-9_-]+(&(project_id|video_id|unassigned)=[a-zA-Z0-9_-]+){0,2})?$/.test(route)
    ||method==='POST'&&/^\/api\/workflow\/(project|assignment-preview|assign|import-scenes)$/.test(route);
}
function productionAllowed(method,route){
  return method==='GET'&&/^\/api\/production\/(overview|recovery)\?project_id=[a-zA-Z0-9_-]{1,100}(?:&video_id=[a-zA-Z0-9_-]{1,100})?$/.test(route)
    ||method==='POST'&&route==='/api/production/preflight'
    ||['GET','PUT'].includes(method)&&/^\/api\/videos\/[a-zA-Z0-9_-]+\/settings$/.test(route)
    ||method==='POST'&&route==='/api/maintenance/duplicate-project'
    ||['GET','POST'].includes(method)&&route==='/api/maintenance/backups'
    ||method==='GET'&&/^\/api\/maintenance\/backups\/[a-f0-9-]{36}$/.test(route);
}
async function requireProduction(){
  const health=await request('GET','/health',undefined,5000);
  if(health?.studio_features?.production_workspace!==true)throw Error('Production workspace requires the updated backend. Restart Studio from the complete release before saving defaults or starting production. Existing files and jobs are retained.');
}
function importContext(value){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['project_id','video_id'].includes(k))||!['project_id','video_id'].every(k=>typeof value[k]==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value[k])))throw Error('Select a project and video before importing files.');
  return {project_id:value.project_id,video_id:value.video_id};
}
function contextForm(form,ctx){for(const [key,value] of Object.entries(ctx))form.append(key,value);}
let workflowCheck;
async function requireWorkflow(){
  if(!workflowCheck)workflowCheck=request('GET','/health',undefined,5000).then(health=>{
    if(health?.studio_features?.project_video_sources!==true||health?.studio_features?.project_multi_video!==true||health?.studio_features?.project_provider_urls!==true)throw Error('Project sources require the updated backend for multiple videos per project and project URLs. Restart Studio from this complete release. Existing files and jobs are retained.');
  }).finally(()=>{workflowCheck=null;});
  await workflowCheck;
}
const storyboardAllowed = /^\/api\/storyboard\/(providers|videos\/[a-zA-Z0-9_-]+(?:\/(segments|prompt-input|generate-concepts|cancel-concepts|generate-media|retry-failed))?|segments\/[a-zA-Z0-9_-]+(?:\/concepts)?|concepts\/[a-zA-Z0-9_-]+\/select)$/;
const allowed = /^\/(health|api\/(projects(?:\/[a-zA-Z0-9_-]+(?:\/settings)?)?|videos(?:\/[a-zA-Z0-9_-]+)?|scenes(?:\/[a-zA-Z0-9_-]+)?|models|materials|flow\/status|tts\/templates(?:\/[a-zA-Z0-9_-]+)?|desktop\/(jobs(?:\/cancel|\/[a-f0-9-]+\/resume)?|pause|diagnostics|flow-progress)))(\?[^#]*)?$/;
function whisperxAllowed(method, route) {
  return method === 'GET' && /^\/api\/whisperx\/(status|jobs\/[a-f0-9-]{36}\/preview(?:\/(full|video|image))?)$/.test(route)
    || method === 'POST' && /^\/api\/whisperx\/(check|settings|jobs|jobs\/[a-f0-9-]{36}\/(cancel|split|retry))$/.test(route);
}
function srtAllowed(method, route) {
  return method === 'GET' && /^\/api\/srt\/(status|jobs\/[a-f0-9-]{36}\/(preview|quality))$/.test(route)
    || method === 'POST' && /^\/api\/srt\/(prepare|jobs|analyze|jobs\/[a-f0-9-]{36}\/(cancel|approve))$/.test(route);
}
function assemblyAllowed(method, route) {
  return method === 'GET' && route === '/api/assembly/status'
    || method === 'POST' && /^\/api\/assembly\/(source|preview|preflight|scene-media|jobs|jobs\/[a-f0-9-]{36}\/(cancel|resume))$/.test(route);
}
function elevenlabsAllowed(method, route) {
  return method === 'GET' && /^\/api\/elevenlabs\/(status|jobs(?:\/[a-f0-9-]{36})?)$/.test(route)
    || method === 'POST' && /^\/api\/elevenlabs\/(preview|jobs|probe|control|jobs\/[a-f0-9-]{36}\/(cancel|retry|recover))$/.test(route);
}
async function readBackendResponse(response, route) {
  const text = await response.text();
  if(response.status===404 && ['/api/srt/status','/api/srt/import'].includes(route))throw Error('JSON → SRT is missing from the running backend. Update the complete source, then restart Studio and its backend.');
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
async function request(method, route, body, timeoutMs) {
  if(timeoutMs===undefined && route==='/api/srt/prepare')timeoutMs=130000;
  if(timeoutMs===undefined && method==='GET' && ['/api/srt/status','/api/whisperx/status','/api/chatgpt/status','/api/workflow/resources'].includes(route.split('?')[0]))timeoutMs=10000;
  if(timeoutMs===undefined && method==='POST' && /^\/api\/assembly\/(preflight|scene-media|jobs)$/.test(route))timeoutMs=1800000;
  const response = await fetch(BASE + route, {method, headers:body ? {'Content-Type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(timeoutMs ?? (route.startsWith('/api/chatgpt/')?720000:120000))});
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
async function elevenlabsJob(id) {
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw Error('Invalid ElevenLabs job ID');
  return request('GET','/api/elevenlabs/jobs/'+id);
}
function elevenlabsIndex(job,index) {
  if(index==='merged') { if(!job.merged_url)throw Error('Joined audio is not ready'); return; }
  if(!Number.isInteger(index)||index<1||index>10000)throw Error('Invalid ElevenLabs chunk index');
  if(!job.chunks?.some(c=>c.index===index&&c.state==='COMPLETED'&&c.audio_url))throw Error('Chunk audio is not ready');
}
async function elevenlabsMedia(id,index) {
  const response=await fetch(`${BASE}/api/elevenlabs/audio/${id}/${index}`,{signal:AbortSignal.timeout(300000)});
  if(!response.ok)throw Error(`Cannot read ElevenLabs audio: HTTP ${response.status}`);
  const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  const ext=({'audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/ogg':'ogg','audio/flac':'flac','audio/mp4':'m4a','audio/x-m4a':'m4a'})[mime];
  if(!ext)throw Error('Backend did not return a supported audio file');
  return {response,mime,ext};
}
async function saveAudioResponse(response,target) {
  const {pipeline}=require('node:stream/promises'),{Readable}=require('node:stream'),{createWriteStream}=require('node:fs');
  const part=target+'.part';
  try {await pipeline(Readable.fromWeb(response.body),createWriteStream(part));await fs.rename(part,target);}
  finally {await fs.rm(part,{force:true});}
}
app.whenReady().then(async()=>{
  try {settings=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'settings.json'),'utf8'));}catch{}
  settings.output ||= path.join(app.getPath('videos'),'Flowkit');
  runtime = require('./backend-runtime.cjs')({root:ROOT,logDirectory:app.getPath('userData'),request});
  try {await runtime.start();} catch(error) {console.error('[Backend startup]',error.message);}
  await gateway.start();
  win=new BrowserWindow({width:1280,height:900,minWidth:920,minHeight:650,title:'Flowkit Studio',backgroundColor:'#11151e',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  require(path.join(__dirname,'maintenance.cjs'))({handle,dialog,getWindow:()=>win,root:ROOT,base:BASE,request,saveResponse:saveAudioResponse,fetch:(...args)=>fetch(...args),getOutput:()=>settings.output});
  handle('api',async(method,route,body)=>{
    if(!['GET','POST','PATCH','PUT'].includes(method)||typeof route!=='string'||!(productionAllowed(method,route)||workflowAllowed(method,route)||assemblyAllowed(method,route)||srtAllowed(method,route)||whisperxAllowed(method,route)||elevenlabsAllowed(method,route)||allowed.test(route)||storyboardAllowed.test(route)||/^\/api\/chatgpt\/(status|history|test|resume|message|queue|config|cancel|retry|preflight|models)$/.test(route))||route.includes('..')||route.includes('\\')) throw Error('Unsupported API operation');
    if (method !== 'GET' && runtime.isRestarting()) throw Error('The backend is restarting. Wait for it to become ready.');
    if(route.startsWith('/api/workflow/')||(method!=='GET'&&/^\/api\/videos(?:\/|$)/.test(route))||(workflowAllowed(method,route)&&route.includes('?'))||(method==='POST'&&body?.video_id&&/^\/api\/(elevenlabs|whisperx|srt|assembly)\//.test(route)))await requireWorkflow();
    if(/^\/api\/projects\/[^/]+\/settings$/.test(route)||(method==='POST'&&(/^\/api\/storyboard\/videos\/[^/]+\/(generate-concepts|generate-media|retry-failed)$/.test(route)||(route==='/api/desktop/jobs'&&body?.jobs?.some(j=>j.video_id)))))await requireWorkflow();
    if(productionAllowed(method,route)||(method==='PUT'&&/^\/api\/projects\/[^/]+\/settings$/.test(route)&&body?.production)||(method==='POST'&&/^\/api\/assembly\/(preview|preflight|jobs)$/.test(route)&&body?.image_motion&&body.image_motion!=='none'))await requireProduction();
    if(route.startsWith('/api/elevenlabs/')) {
      let issue = '', health;
      try { health = await request('GET','/health',undefined,5000); issue = backendProblem(health); }
      catch { issue = 'Cannot verify the running backend. Restart Flowkit Studio and check backend.log before generating speech.'; }
      if(method !== 'GET' && issue) throw Error(issue);
      const result = await request(method,route,body);
      return route === '/api/elevenlabs/status' ? {...result,compatibilityError:issue,backendDiagnostics:issue ? await runtime.diagnostics(health) : {compatible:true}} : result;
    }
    return request(method,route,body);
  });
  handle('assembly-import',async(kind,scope)=>{
    const ctx=importContext(scope);
    if(ctx.video_id)await requireWorkflow();
    if(!['srt','audio','images','images-folder','videos','videos-folder'].includes(kind))throw Error('Unsupported assembly input');
    const image=kind.startsWith('images'),video=kind.startsWith('videos'),folder=kind.endsWith('-folder');
    const extensions=image?['png','jpg','jpeg','webp']:video?['mp4','mov','mkv','webm','m4v']:kind==='audio'?['mp3','wav','m4a','aac','flac','ogg','opus']:['srt'];
    const selected=await dialog.showOpenDialog(win,{title:'Choose '+kind.replace('-',' '),properties:folder?['openDirectory']:(image||video)?['openFile','multiSelections']:['openFile'],...folder?{}:{filters:[{name:kind,extensions}]}});
    if(selected.canceled||!selected.filePaths?.length)return {canceled:true};
    const paths=folder?(await fs.readdir(selected.filePaths[0],{withFileTypes:true})).filter(e=>e.isFile()&&extensions.includes(path.extname(e.name).slice(1).toLowerCase())).map(e=>path.join(selected.filePaths[0],e.name)):selected.filePaths;
    if(!paths.length)throw Error('No supported files found in the selected folder.');
    if(paths.length>1000)throw Error('Choose up to 1,000 files per import.');
    const assets=[],errors=[];
    for(const filename of paths){
      try{
        const blob=await require('node:fs').openAsBlob(filename);
        const form=new FormData();form.append('file',blob,path.basename(filename));contextForm(form,ctx);
        const route='/api/assembly/import/'+(image?'image':video?'video':kind);
        const response=await fetch(BASE+route,{method:'POST',body:form,signal:AbortSignal.timeout(600000)});
        assets.push(await readBackendResponse(response,route));
      }catch(e){errors.push(path.basename(filename)+': '+e.message);}
    }
    return {canceled:false,assets,errors};
  });
  handle('assembly-media',async(id,action)=>{
    if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw Error('Invalid assembly ID');
    if(!['thumbnail','clip-preview','preview','save'].includes(action))throw Error('Unsupported assembly action');
    if(action==='thumbnail'){
      const response=await fetch(`${BASE}/api/assembly/images/${id}/thumbnail`,{signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw Error('Image thumbnail is not available.');
      return 'data:image/jpeg;base64,'+Buffer.from(await response.arrayBuffer()).toString('base64');
    }
    const status=await request('GET','/api/assembly/status');
    if(action==='clip-preview'){
      if(!status.assets?.some(a=>a.id===id&&a.kind==='video'))throw Error('Selected clip is not available.');
      return {url:`${BASE}/api/assembly/clips/${id}/video`};
    }
    if(!status.jobs.some(j=>j.id===id&&j.state==='COMPLETED'))throw Error('Rendered video is not available.');
    const url=`${BASE}/api/assembly/jobs/${id}/video`;
    if(action==='preview')return {url};
    const dest=await dialog.showSaveDialog(win,{title:'Save assembled video',defaultPath:path.join(settings.output,`video-${id}.mp4`),filters:[{name:'MP4 video',extensions:['mp4']}]});
    if(dest.canceled||!dest.filePath)return {canceled:true};
    const response=await fetch(url,{signal:AbortSignal.timeout(3600000)});
    if(!response.ok)throw Error('Rendered video is not available.');
    await saveAudioResponse(response,dest.filePath);
    return {canceled:false,path:dest.filePath};
  });
  handle('srt-import',async scope=>{
    const ctx=importContext(scope);
    if(ctx.video_id)await requireWorkflow();
    const selected=await dialog.showOpenDialog(win,{title:'Choose transcript JSON',properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});
    if(selected.canceled||!selected.filePaths?.length)return {canceled:true};
    const filename=selected.filePaths[0];
    if((await fs.stat(filename)).size>16*1024*1024)throw Error('Choose a JSON file up to 16 MiB.');
    const blob=await require('node:fs').openAsBlob(filename);
    const form=new FormData();form.append('file',blob,path.basename(filename));contextForm(form,ctx);
    const response=await fetch(BASE+'/api/srt/import',{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
    return {canceled:false,...await readBackendResponse(response,'/api/srt/import')};
  });
  handle('srt-save',async id=>{
    if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw Error('Invalid SRT job ID');
    const dest=await dialog.showSaveDialog(win,{title:'Save subtitles',defaultPath:`subtitles-${id}.srt`,filters:[{name:'SubRip subtitles',extensions:['srt']}]});
    if(dest.canceled||!dest.filePath)return {canceled:true};
    const response=await fetch(`${BASE}/api/srt/jobs/${id}/result`,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error('Completed SRT is not available.');
    await saveAudioResponse(response,dest.filePath);
    return {canceled:false,path:dest.filePath};
  });
  handle('whisperx-import',async scope=>{
    const ctx=importContext(scope);
    if(ctx.video_id)await requireWorkflow();
    const selected=await dialog.showOpenDialog(win,{title:'Choose audio for WhisperX',properties:['openFile'],filters:[{name:'Audio',extensions:['mp3','wav','m4a','flac','ogg','opus','aac']}]});
    if(selected.canceled||!selected.filePaths?.length)return {canceled:true};
    const filename=selected.filePaths[0];
    const {openAsBlob}=require('node:fs');
    const audio=await openAsBlob(filename);
    const form=new FormData();form.append('file',audio,path.basename(filename));contextForm(form,ctx);
    const response=await fetch(BASE+'/api/whisperx/import',{method:'POST',body:form,signal:AbortSignal.timeout(600000)});
    return {canceled:false,...await readBackendResponse(response,'/api/whisperx/import')};
  });
  handle('whisperx-save',async (id,variant='full')=>{
    if(typeof id!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw Error('Invalid transcription ID');
    const files={full:'transcript.json',video:'transcript_video.json',image:'transcript_image.json'};
    if(!Object.hasOwn(files,variant))throw Error('Invalid transcript variant');
    const dest=await dialog.showSaveDialog(win,{title:'Save WhisperX JSON',defaultPath:files[variant],filters:[{name:'JSON',extensions:['json']}]});
    if(dest.canceled||!dest.filePath)return {canceled:true};
    const response=await fetch(`${BASE}/api/whisperx/jobs/${id}/result${variant==='full'?'':'/'+variant}`,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error('Aligned JSON is not available yet.');
    await saveAudioResponse(response,dest.filePath);
    return {path:dest.filePath,canceled:false};
  });
  handle('backend-action',async action=>{
    if(action==='status')return {backendDiagnostics:await runtime.diagnostics(undefined,true)};
    if(action==='restart')return runtime.restart();
    throw Error('Unsupported backend action');
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
  handle('save-chat-results',async ids=>{
    if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=='string'))throw Error('Select 1–200 jobs');
    const result=await request('GET','/api/chatgpt/queue');
    const jobs=result.jobs.filter(j=>ids.includes(j.id));
    const dest=await dialog.showSaveDialog(win,{title:'Export ChatGPT results',defaultPath:'chatgpt-results.json',filters:[{name:'JSON',extensions:['json']}]});
    if(dest.canceled||!dest.filePath)return {canceled:true};
    await fs.writeFile(dest.filePath,JSON.stringify(jobs,null,2),'utf8');return {canceled:false};
  });
  handle('elevenlabs-action',async action=>{
    if(action==='open')return shell.openExternal('https://elevenlabs.io/app/speech-synthesis/text-to-speech');
    if(action==='extension'){const error=await shell.openPath(path.join(ROOT,'extensions','elevenlabs'));if(error)throw Error(error);return;}
    throw Error('Unsupported ElevenLabs action');
  });
  handle('elevenlabs-audio',async(id,index,action)=>{
    if(!['preview','save'].includes(action))throw Error('Unsupported audio action');
    const job=await elevenlabsJob(id);elevenlabsIndex(job,index);
    const {response,mime,ext}=await elevenlabsMedia(id,index);
    if(action==='preview'){
      if(Number(response.headers.get('content-length'))>100*1024*1024){await response.body.cancel();throw Error('Preview exceeds 100 MiB. Save the audio to play locally.');}
      const bytes=await response.arrayBuffer();if(bytes.byteLength>100*1024*1024)throw Error('Preview exceeds 100 MiB. Save the audio to play locally.');
      return {bytes,mime};
    }
    const name=index==='merged'?'narration':String(index).padStart(3,'0');
    const dest=await dialog.showSaveDialog(win,{title:'Save ElevenLabs audio',defaultPath:`elevenlabs-${id}-${name}.${ext}`,filters:[{name:'Audio',extensions:[ext]}]});
    if(dest.canceled||!dest.filePath){await response.body.cancel();return {canceled:true};}
    await saveAudioResponse(response,dest.filePath);return {canceled:false,path:dest.filePath};
  });
  handle('elevenlabs-export',async id=>{
    const job=await elevenlabsJob(id),indices=(job.chunks||[]).filter(c=>c.state==='COMPLETED'&&c.audio_url).map(c=>c.index);
    if(job.merged_url)indices.push('merged');
    if(!indices.length)throw Error('No completed audio to export');
    const folder=path.join(settings.output,'elevenlabs',id);await fs.mkdir(folder,{recursive:true});
    for(const index of indices){
      elevenlabsIndex(job,index);const {response,ext}=await elevenlabsMedia(id,index);
      const name=index==='merged'?'narration':String(index).padStart(3,'0');await saveAudioResponse(response,path.join(folder,name+'.'+ext));
    }
    return {path:folder,count:indices.length};
  });
  handle('chatgpt-action',async action=>{
    if(action==='open')return shell.openExternal('https://chatgpt.com/');
    if(action==='extension')return shell.openPath(path.join(ROOT,'extensions/chatgpt'));
    if(action==='logs')return shell.openPath(app.getPath('userData'));
    if(action==='startup-error')return gateway.getError();
    throw Error('Unsupported ChatGPT action');
  });
  handle('open-project-page',async(pid,key)=>{
    if(typeof pid!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(pid)||!['chatgpt_url','image_prompt_url','video_prompt_url','elevenlabs_url','google_flow_url'].includes(key))throw Error('Select a project and a supported service.');
    const settings=await request('GET','/api/projects/'+pid+'/settings');
    const u=new (require('node:url').URL)(settings[key]),hosts=key==='google_flow_url'?['flow.google.com','labs.google']:key==='elevenlabs_url'?['elevenlabs.io']:['chatgpt.com'];
    if(u.protocol!=='https:'||!hosts.includes(u.hostname)||u.username||u.password)throw Error('Invalid project service URL.');
    return shell.openExternal(u.href);
  });
  handle('open-flow',()=>shell.openExternal('https://flow.google.com/'));
  handle('open-extension',()=>shell.openPath(path.join(ROOT,'extensions','googleflow')));
  handle('import-script-source',async kind=>{
    if(!['script','segments','prompt','srt'].includes(kind))throw Error('Invalid source type');
    const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Source text',extensions:kind==='srt'?['srt']:['script','prompt'].includes(kind)?['txt']:['srt','json']}]});
    if(r.canceled)return null;
    if((await fs.stat(r.filePaths[0])).size>2*1024*1024)throw Error('Source file must be under 2 MiB');
    return {name:path.basename(r.filePaths[0]),text:(await fs.readFile(r.filePaths[0],'utf8')).replace(/^\uFEFF/,'')};
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
  runtime?.stop();
});
