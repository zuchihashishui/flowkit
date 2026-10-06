const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os');
const register=require('../maintenance.cjs');
const ID='12345678-1234-1234-1234-123456789abc';

function setup(overrides={}){
 const handlers=new Map(),calls=[];
 const dependencies={handle:(name,fn)=>handlers.set(name,fn),dialog:{showSaveDialog:async()=>({canceled:false,filePath:'/tmp/backup.zip'}),showOpenDialog:async()=>({canceled:true})},
  getWindow:()=>({}),root:'/app',base:'http://127.0.0.1:8100',getOutput:()=>'/exports',platform:'linux',env:{},
  request:async(method,route)=>{calls.push({method,route});return{state:'COMPLETED'};},fetch:async url=>{calls.push({url});return{ok:true,headers:{get:()=> 'application/zip'}};},saveResponse:async(response,target)=>{calls.push({target});},...overrides};
 register(dependencies);return{handlers,calls,invoke:(name,...args)=>handlers.get(name)(...args),dependencies};
}
test('backup export resolves only a completed UUID-backed archive and honors native cancellation',async()=>{
 const s=setup();await assert.rejects(s.invoke('maintenance-save-backup','../outside'),/Invalid/);
 assert.equal(s.calls.length,0);
 assert.deepEqual(await s.invoke('maintenance-save-backup',ID),{canceled:false,path:'/tmp/backup.zip'});
 assert.equal(s.calls[0].route,'/api/maintenance/backups/'+ID);
 assert(s.calls[1].url.endsWith('/'+ID+'/file'));
 s.dependencies.dialog.showSaveDialog=async()=>({canceled:true});
 assert.deepEqual(await s.invoke('maintenance-save-backup',ID),{canceled:true});
 assert.equal(s.calls.filter(x=>x.url).length,1);
 await assert.rejects(setup({request:async()=>({state:'RUNNING'})}).invoke('maintenance-save-backup',ID),/not ready/);
});
test('restore uses an argument array and a new destination, never stopping the live backend',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'flowkit-native-restore-'));
 try{
  const archive=path.join(root,'backup with spaces.zip'),python=path.join(root,'python');await fs.writeFile(archive,'ZIP');await fs.writeFile(python,'python');
  let dialogNumber=0,invocation;
  const s=setup({root,env:{FLOWKIT_PYTHON:python},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[dialogNumber++===0?archive:root]})},adapters:{execFile:async(executable,args,options)=>{
   invocation={executable,args,options};const target=args.at(-1);await fs.mkdir(target);return{stdout:JSON.stringify({directory:target,launch_env:{FLOW_AGENT_DIR:target},include_media:true})};
  }}});
  const result=await s.invoke('maintenance-restore');assert.equal(result.canceled,false);
  assert.equal(invocation.executable,python);assert.deepEqual(invocation.args.slice(0,4),['-m','agent.services.studio_backup','restore',archive]);
  assert.equal(invocation.options.shell,false);assert.equal(invocation.options.cwd,root);
  assert.equal(path.dirname(result.directory),root);assert.match(path.basename(result.directory),/^flowkit-restored-/);
  assert.match(result.instructions,/Close Flowkit Studio and its backend/);assert.match(result.instructions,/FLOW_AGENT_DIR=/);
  assert.equal(await fs.readFile(result.instructions_path,'utf8'),result.instructions);
  assert.equal(s.calls.length,0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('restore cancellation and verification errors are actionable',async()=>{
 assert.deepEqual(await setup().invoke('maintenance-restore'),{canceled:true});
 let number=0;const io={stat:async()=>({isFile:()=>true}),access:async()=>{}};
 const s=setup({dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[number++===0?'/tmp/source.zip':'/tmp']})},adapters:{fs:io,execFile:async()=>{throw{stderr:JSON.stringify({error:'Backup integrity check failed: audio.mp3'})};}}});
 await assert.rejects(s.invoke('maintenance-restore'),/Backup integrity check failed/);
});
test('PowerShell startup instructions quote paths literally without expanding their content',()=>{
 const instructions=register.restoreInstructions("C:\\O'Brien\\flowkit", "D:\\Data $USER\\Bob's restored",'win32');
 assert.match(instructions,/\$env:FLOW_AGENT_DIR = 'D:\\Data \$USER\\Bob''s restored'/);
 assert.match(instructions,/& 'C:\\O''Brien\\flowkit\\start_desktop.bat'/);
});
