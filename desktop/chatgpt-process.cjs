const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
module.exports=function(app,root){
 let child, log, error='';
 async function start(){
  try{
   const r=await fetch('http://127.0.0.1:18790/health',{signal:AbortSignal.timeout(2000)});
   if(r.ok){const info=await r.json();if(info.service!=='flowkit-chatgpt-gateway'||info.protocol!==2)throw Error('Port 18790 belongs to an incompatible gateway. Stop it and restart Flowkit.');return;}
  }catch(e){if(!/fetch failed|abort|timeout/i.test(e.message)){error=e.message;return;}}
  const folder=path.join(root,'integrations/chatgpt-gateway');
  try{
   await fs.access(path.join(folder,'node_modules/ws/package.json'));
   log=await fs.open(path.join(app.getPath('userData'),'chatgpt-gateway.log'),'a');
   child=spawn(process.execPath,[path.join(folder,'server.mjs')],{cwd:folder,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',CHATGPT_GATEWAY_PORT:'18790'},windowsHide:true,stdio:['ignore',log.fd,log.fd]});
   child.on('error',e=>{error=e.message;});
  }catch(e){error='ChatGPT gateway could not start. Run setup_desktop.bat. '+e.message;}
 }
 return {start,stop(){if(child && child.exitCode===null)child.kill();},getError(){return error;}};
};
