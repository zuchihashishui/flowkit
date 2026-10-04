const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom'),tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(api){
 const dom=new JSDOM('<select id="project-select"><option value="p1" selected>Original</option></select><section id="project-maintenance"></section>',{runScripts:'outside-only',url:'http://localhost/'});
 const w=dom.window,$=id=>w.document.getElementById(id),calls=[];
 w.workflow={context:()=>({project_id:'p1'})};w.projectSettings={assertSaved(){}};w.refreshStudioProjects=async()=>calls.push('refresh-projects');
 w.studio={api,maintenanceSaveBackup:async id=>{calls.push(id);return{canceled:false,path:'/saved.zip'};},maintenanceRestore:async()=>({canceled:false,directory:'/new data',instructions:'FLOW_AGENT_DIR=example',missing_media_paths:0})};
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/maintenance.js'),'utf8'));return{dom,w,$,calls};
}
test('duplicate submits only saved project configuration and refreshes the project list',async()=>{
 const requests=[],s=setup(async(method,route,body)=>{requests.push({method,route,body});if(route.endsWith('duplicate-project'))return{project:{id:'p2',name:body.name},message:'Configuration copied.'};return{backups:[]};});
 try{await tick();s.$('maintenance-copy-name').value='Second channel';s.$('maintenance-copy').click();await tick();
  const call=requests.find(r=>r.method==='POST');assert.deepEqual(JSON.parse(JSON.stringify(call.body)),{project_id:'p1',name:'Second channel'});
  assert.deepEqual(s.calls,['refresh-projects']);assert.equal(s.$('project-select').value,'p1');assert.match(s.$('maintenance-message').textContent,/Created “Second channel”/);
  s.w.projectSettings.assertSaved=()=>{throw Error('Save project settings first.');};s.$('maintenance-copy').click();await tick();assert.equal(requests.filter(r=>r.method==='POST').length,1);assert.match(s.$('maintenance-message').textContent,/Save project settings/);
 }finally{s.dom.window.close();}
});
test('backup includes the explicit media choice and only completed files can be exported',async()=>{
 const requests=[],s=setup(async(method,route,body)=>{requests.push({method,route,body});return method==='POST'?{id:'backup'}:{busy:false,backups:[{id:'done',filename:'done.zip',state:'COMPLETED',bytes:1024},{id:'working',filename:'working.zip',state:'RUNNING'},{id:'failed',filename:'failed.zip',state:'FAILED',error:'Finish queued work first.'}]};});
 try{await tick();assert.equal(s.w.document.querySelectorAll('[data-backup-id]').length,1);s.w.document.querySelector('[data-backup-id]').click();await tick();assert.deepEqual(s.calls,['done']);
  assert.equal(s.$('maintenance-media').checked,false);s.$('maintenance-media').checked=true;s.$('maintenance-create').click();await tick();assert.equal(requests.find(r=>r.method==='POST').body.include_media,true);
  assert.match(s.$('maintenance-backups').textContent,/Finish queued work/);
 }finally{s.dom.window.close();}
});
test('restore displays separate-folder instructions without switching active data or generating jobs',async()=>{
 const requests=[],s=setup(async(method,route)=>{requests.push({method,route});return{backups:[]};});
 try{await tick();s.$('maintenance-restore').click();await tick();assert.match(s.$('maintenance-message').textContent,/Current Studio data remains unchanged/);assert.equal(s.$('maintenance-instructions').hidden,false);assert.equal(s.$('maintenance-instructions').textContent,'FLOW_AGENT_DIR=example');assert.ok(requests.every(r=>r.method==='GET'));
 }finally{s.dom.window.close();}
});
