const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r));
const defaults={revision:0,chatgpt_url:'https://chatgpt.com/',image_prompt_url:'https://chatgpt.com/g/g-image-a',video_prompt_url:'https://chatgpt.com/g/g-video-a',elevenlabs_url:'https://elevenlabs.io/app/speech-synthesis/text-to-speech',google_flow_url:'https://flow.google.com/'};
function setup(api){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id),opened=[];
 w.studio={api,openProjectPage:async(...args)=>opened.push(args)};w.confirm=()=>false;
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/project-settings.js'),'utf8'));
 return {dom,w,$,opened,select:id=>w.document.dispatchEvent(new w.CustomEvent('project-changed',{detail:{id}}))};
}
test('Project Settings loads, saves once per project, guards dirty switches and opens the saved GPT',async()=>{
 const calls=[],records={a:{...defaults},b:{...defaults,image_prompt_url:'https://chatgpt.com/g/g-image-b'}};
 const s=setup(async(method,route,body)=>{calls.push({method,route,body});const pid=route.split('/')[3];if(method==='PUT')records[pid]={...body,revision:body.revision+1};return structuredClone(records[pid]);});
 try{
  assert.equal(s.$('ps-image_prompt_url').disabled,true);s.select('a');await tick();
  s.$('ps-image_prompt_url').value='https://chatgpt.com/g/g-new-a';s.$('ps-image_prompt_url').dispatchEvent(new s.w.Event('input',{bubbles:true}));
  assert.equal(s.w.projectSettings.canChangeProject('b'),false);assert.throws(()=>s.w.projectSettings.assertSaved(),/Save project settings/);
  s.$('project-settings-form').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();
  assert.equal(records.a.image_prompt_url,'https://chatgpt.com/g/g-new-a');assert.equal(records.a.revision,1);
  assert.equal(s.w.projectSettings.canChangeProject('b'),true);
  s.w.document.querySelector('[data-project-page="image_prompt_url"]').click();await tick();assert.deepEqual(s.opened,[['a','image_prompt_url']]);
  s.select('b');await tick();assert.equal(s.$('ps-image_prompt_url').value,records.b.image_prompt_url);
  s.select('a');await tick();assert.equal(s.$('ps-image_prompt_url').value,records.a.image_prompt_url);
  assert.equal(calls.filter(c=>c.method==='PUT').length,1);
 }finally{s.dom.window.close();}
});
test('late settings from the previous project never overwrite the newly selected project; load can be retried',async()=>{
 let old,fail=true;const s=setup(async(method,route)=>{if(route.includes('/a/'))return new Promise(r=>old=r);if(fail)throw Error('Backend unavailable');return {...defaults,image_prompt_url:'https://chatgpt.com/g/g-b'};});
 try{
  s.select('a');s.select('b');await tick();assert.match(s.$('ps-message').textContent,/unavailable/);assert.equal(s.$('ps-reload').disabled,false);
  fail=false;s.$('ps-reload').click();await tick();old(defaults);await tick();assert.equal(s.$('ps-image_prompt_url').value,'https://chatgpt.com/g/g-b');
 }finally{s.dom.window.close();}
});
