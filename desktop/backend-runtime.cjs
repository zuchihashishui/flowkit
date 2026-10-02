'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {spawn,execFile} = require('node:child_process');
const {promisify} = require('node:util');
const compatibility = require('./backend-compatibility.cjs');

const inspectScript = `$ErrorActionPreference='Stop'
$owners=@(Get-NetTCPConnection -LocalPort 8100 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
$rows=@(foreach($owner in $owners) {
 $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$owner)
 if(!$p) { throw 'The port listener could not be identified.' }
 if($p) {
  $parent=Get-CimInstance Win32_Process -Filter ("ProcessId="+$p.ParentProcessId)
  $parentInfo=$null
  if($parent) { $parentInfo=[pscustomobject]@{pid=[int]$parent.ProcessId;executable=$parent.ExecutablePath;commandLine=$parent.CommandLine;created=$parent.CreationDate.ToUniversalTime().ToString('o')} }
  [pscustomobject]@{pid=[int]$p.ProcessId;executable=$p.ExecutablePath;commandLine=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o');parent=$parentInfo}
 }
})
ConvertTo-Json -InputObject $rows -Depth 4 -Compress`;
const normalize = value => String(value || '').replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
const escapeRx = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function sameCommand(record, python) {
 const executable = escapeRx(python.replace(/\//g,'\\'));
 return new RegExp(`^(?:"${executable}"|${executable})\\s+-m\\s+agent\\.main\\s*$`,'i').test((record.commandLine || '').replace(/\//g,'\\').trim());
}
function verifiedOwner(record, health, root, python, ownedPid) {
 if (!record || !Number.isInteger(record.pid) || record.pid <= 0 || !record.created || !record.executable || !record.commandLine) return false;
 if (!sameCommand(record,python)) return false;
 // Windows venv's python.exe is a redirector: its base-Python child owns the
 // socket but retains the venv command line. Verify that direct parent too.
 const parent=record.parent;
 const redirected=parent && Number.isInteger(parent.pid) && parent.pid>0 && parent.pid!==record.pid && parent.created
   && normalize(parent.executable)===normalize(python) && sameCommand(parent,python)
   && path.win32.basename(record.executable).toLowerCase()==='python.exe';
 if (normalize(record.executable) !== normalize(python) && !redirected) return false;
 if (health?.runtime?.root && normalize(health.runtime.root) !== normalize(root)) return false;
 if (health?.runtime?.pid && health.runtime.pid !== record.pid) return false;
 if (health?.service && health.service !== 'flowkit-backend') return false;
 return record.pid === ownedPid || (redirected && parent.pid===ownedPid) || normalize(python) === normalize(path.win32.join(root,'.venv','Scripts','python.exe'))
   || (health?.service === 'flowkit-backend' && normalize(health?.runtime?.root) === normalize(root) && health?.runtime?.pid === record.pid);
}
function stopScript(record) {
 const encoded = Buffer.from(JSON.stringify(record),'utf8').toString('base64');
 return `$ErrorActionPreference='Stop'
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$expected.pid)
$owners=@(Get-NetTCPConnection -LocalPort 8100 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if(!$p -or $owners.Count -ne 1 -or $owners[0] -ne $expected.pid -or $p.ExecutablePath -cne $expected.executable -or $p.CommandLine -cne $expected.commandLine -or $p.CreationDate.ToUniversalTime().ToString('o') -cne $expected.created) { throw 'Backend process changed; nothing was stopped. Check backend again.' }
if($expected.parent) {
 $parent=Get-CimInstance Win32_Process -Filter ("ProcessId="+$p.ParentProcessId)
 if(!$parent -or $parent.ProcessId -ne $expected.parent.pid -or $parent.ExecutablePath -cne $expected.parent.executable -or $parent.CommandLine -cne $expected.parent.commandLine -or $parent.CreationDate.ToUniversalTime().ToString('o') -cne $expected.parent.created) { throw 'Backend parent process changed; nothing was stopped.' }
}
Stop-Process -Id $expected.pid -ErrorAction Stop`;
}

module.exports = function backendRuntime({root,logDirectory,request,platform=process.platform,env=process.env,adapters={}}) {
 const paths = platform === 'win32' ? path.win32 : path;
 const python = env.FLOWKIT_PYTHON || paths.join(root,'.venv',platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
 const io = adapters.fs || fs, launch = adapters.spawn || spawn;
 const execute = adapters.execFile || promisify(execFile), wait = adapters.wait || (ms => new Promise(resolve=>setTimeout(resolve,ms)));
 const now = adapters.now || Date.now;
 let child, log, restarting = null, cachedOwner, ownerTime = 0;
 async function powershell(script) {
  const result = await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:128*1024});
  return result.stdout || '';
 }
 async function owner(fresh=false) {
  if (platform !== 'win32') return null;
  if (!fresh && cachedOwner !== undefined && now()-ownerTime < 10000) return cachedOwner;
  const value = JSON.parse((await powershell(inspectScript)).trim() || '[]');
  const rows = Array.isArray(value) ? value : [value];
  if(rows.length>1)throw Error('Multiple processes own port 8100. Close the old backend consoles before restarting Studio.');
  cachedOwner = rows.length === 1 ? rows[0] : null; ownerTime=now(); return cachedOwner;
 }
 async function health() { return request('GET','/health',undefined,3000); }
 async function diagnostics(info, fresh=false) {
  let problem='';
  if (!info) { try {info=await health();} catch {problem='The backend is not responding on port 8100.';} }
  if (!problem) problem=compatibility(info);
  let record=null, canRestart=false, restartReason='';
  if (platform === 'win32') {
   try {record=await owner(fresh); canRestart=verifiedOwner(record,info,root,python,child?.exitCode===null?child.pid:null);} catch {restartReason='Windows could not identify the process using port 8100. Close its backend console, then restart Studio.';}
  } else canRestart=!!child?.pid && child.exitCode===null && (!info?.runtime?.pid || info.runtime.pid===child.pid);
  if (!canRestart && !restartReason) restartReason='This backend was not verified as belonging to this Studio folder. Close its backend console, then restart Studio from the complete updated folder.';
  return {compatible:!problem,message:problem,missingFeatures:compatibility.missing(info),studioApi:info?.studio_api ?? null,
   studioVersion:info?.studio_version || 'Not reported by this backend',pid:info?.runtime?.pid || record?.pid || null,
   root:info?.runtime?.root || (canRestart?root:'Not reported by this backend'),python:info?.runtime?.python || record?.executable || '',
   startedAt:info?.runtime?.started_at || '',localRoot:root,canRestart,restartReason,managed:!!child?.pid && child.exitCode===null};
 }
 async function launchBackend() {
  await io.access(python);
  if (log) {await log.close();log=null;}
  log=await io.open(paths.join(logDirectory,'backend.log'),'a');
  child=launch(python,['-m','agent.main'],{cwd:root,env:{...env,GLA_RELOAD:'0',PYTHONUNBUFFERED:'1',API_HOST:'127.0.0.1',API_PORT:'8100',WS_HOST:'127.0.0.1',WS_PORT:'9222',TTS_PYTHON_BIN:env.TTS_PYTHON_BIN || python},stdio:['ignore',log.fd,log.fd],windowsHide:true,detached:platform!=='win32'});
  let launchError='';child.on('error',error=>{launchError=error.message;});
  const deadline=now()+30000;
  while(now()<deadline) {
   if(launchError)throw Error('Backend could not start: '+launchError);
   if(child.exitCode!==null && child.exitCode!==undefined)throw Error('Backend exited before it was ready. Open backend.log for details.');
   await wait(500);
   let info;try{info=await health();}catch{continue;}
   // A different process can claim the port during startup. Never call that a repair.
   let owned=info?.runtime?.pid===child.pid;
   if(!owned && platform==='win32') {
    const listener=await owner(true);
    owned=listener?.pid===info?.runtime?.pid && listener?.parent?.pid===child.pid && verifiedOwner(listener,info,root,python,child.pid);
   }
   if(info?.service!=='flowkit-backend' || !owned || normalize(info?.runtime?.root)!==normalize(root))throw Error('Port 8100 did not return the backend just started by this Studio. Check backend.log and the other process.');
   const issue=compatibility(info);if(issue)throw Error(issue);
   cachedOwner=undefined;return diagnostics(info);
  }
  throw Error('Backend did not become ready within 30 seconds. Open backend.log for details.');
 }
 async function start() {
  let info;try{info=await health();}catch{}
  if(info)return diagnostics(info);
  if(platform==='win32' && await owner(true))throw Error('Port 8100 is occupied by a backend that is not responding. Close its console before restarting Studio.');
  return launchBackend();
 }
 async function ensureIdle() {
  // Pause persisted queues before checking their active work. Restart keeps them paused.
  await request('POST','/api/elevenlabs/control',{action:'pause'},5000);
  await request('POST','/api/desktop/pause',{paused:true},5000);
  const chatQueue=await request('GET','/api/chatgpt/queue',undefined,5000);
  if(!chatQueue.settings)throw Error('Cannot read ChatGPT queue settings. Close its backend console before restarting Studio.');
  await request('POST','/api/chatgpt/config',{...chatQueue.settings,paused:true},5000);
  const [el,desktop,legacy,chat,queue,history,flow] = await Promise.all([
   request('GET','/api/elevenlabs/status',undefined,5000),request('GET','/api/desktop/jobs',undefined,5000),
   request('GET','/api/requests/batch-status',undefined,5000),request('GET','/api/chatgpt/status',undefined,5000),
   request('GET','/api/chatgpt/queue',undefined,5000),request('GET','/api/chatgpt/history',undefined,5000),
   request('GET','/api/flow/status',undefined,5000)
  ]);
  const review=el.needsReview || el.reviewRequired || el.settings?.needs_review || el.state==='NEEDS_REVIEW';
  if(el.active || el.processing || (el.busy && !review && el.state!=='IDLE') || el.page?.active || el.page?.generating
     || !Array.isArray(desktop.jobs) || desktop.jobs.some(j=>['RUNNING','SUBMITTING','DOWNLOADING'].includes(j.state))
     || legacy.processing>0 || legacy.pending>0 || chat.busy || chat.inspecting || chat.activeRequests>0
     || !Array.isArray(queue.jobs) || queue.jobs.some(j=>j.state==='RUNNING')
     || !Array.isArray(history.requests) || history.requests.some(j=>j.state==='RUNNING')
     || flow.generation_throttle?.active_submissions>0 || flow.generation_throttle?.waiting_submissions>0
     || (chat.workers || []).some(w=>['RUNNING','AWAITING_SAVE'].includes(w.state))) {
   throw Error('A job is still active. The queues are paused; wait for generation and downloads to finish, then restart the backend.');
  }
 }
 async function restartNow() {
  // Validate this checkout before stopping a working old backend.
  let localHealth;
  try {localHealth=await io.readFile(paths.join(root,'agent','main.py'),'utf8');await io.access(python);} catch {throw Error('The local backend source or Python environment is missing. Update the complete source and run setup_desktop.bat first.');}
  if(!localHealth.includes('elevenlabs_auto_prepare_tab') || !localHealth.includes('studio_version'))throw Error('The local agent folder is also outdated. Replace the complete source before restarting; no process was stopped.');
  const info=await health(), report=await diagnostics(info,true);
  if(!report.canRestart)throw Error(report.restartReason);
  await ensureIdle();
  if(platform==='win32') {
   const current=await owner(true);
   if(!verifiedOwner(current,await health(),root,python,child?.pid) || current.pid!==report.pid)throw Error('Backend ownership changed. Nothing was stopped. Check backend again.');
   await powershell(stopScript(current));
   cachedOwner=undefined;
   const deadline=now()+10000;
   while(await owner(true)) {if(now()>=deadline)throw Error('The old backend still owns port 8100. Close its console before restarting Studio.');await wait(250);}
  } else {
   child.kill();
   const deadline=now()+10000;
   while(child.exitCode===null) {if(now()>=deadline)throw Error('The old backend has not stopped. Close its console before restarting Studio.');await wait(250);}
  }
  child=null;cachedOwner=undefined;
  const backendDiagnostics=await launchBackend();
  return {backendDiagnostics};
 }
 function restart() {
  if(restarting)return restarting;
  restarting=restartNow().finally(()=>{restarting=null;});return restarting;
 }
 function stop() {
  if(!child?.pid || child.exitCode!==null)return;
  if(platform==='win32')launch('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
  else {try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}}
 }
 return {start,diagnostics,restart,stop,isRestarting:()=>!!restarting};
};
module.exports.verifiedOwner=verifiedOwner;
module.exports.stopScript=stopScript;
