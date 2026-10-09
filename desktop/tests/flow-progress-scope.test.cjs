const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
test('Flow activity uses selected scope, discards late results, and clears without a video',async()=>{
 const dom=new JSDOM('<select id="project-select"><option value="p1">P1</option><option value="p2">P2</option></select><select id="video-select"><option value="">None</option><option value="v1">V1</option><option value="v2">V2</option></select><button data-page="scene-board"></button><section data-view="scene-board"><p id="flow-activity-summary"></p><div id="flow-activity-jobs"></div></section>',{runScripts:'outside-only'});
 const w=dom.window,d=w.document,calls=[],pending=[];const tick=()=>new Promise(r=>setImmediate(r));
 w.setInterval=()=>{};w.studio={api:async(method,url)=>{calls.push(url);return new Promise(resolve=>pending.push(resolve));}};
 try{
  w.eval(fs.readFileSync(path.join(__dirname,'../ui/flow-progress.js'),'utf8'));
  d.querySelector('button').click();assert.equal(calls.length,0);
  d.querySelector('#video-select').value='v1';d.querySelector('#video-select').dispatchEvent(new w.Event('change'));
  assert.equal(calls[0],'/api/desktop/flow-progress?project_id=p1&video_id=v1');
  d.querySelector('#video-select').value='v2';d.querySelector('#video-select').dispatchEvent(new w.Event('change'));
  pending.shift()({completed:999,jobs:[{id:'old',kind:'image',state:'COMPLETED'}]});await tick();
  assert.equal(calls[1],'/api/desktop/flow-progress?project_id=p1&video_id=v2');assert.ok(!d.body.textContent.includes('999'));
  pending.shift()({completed:2,active:1,jobs:[{id:'new',kind:'image',state:'COMPLETED'}]});await tick();
  assert.match(d.querySelector('#flow-activity-summary').textContent,/2 completed/);assert.match(d.querySelector('#flow-activity-jobs').textContent,/new/);
  d.querySelector('#video-select').value='';d.querySelector('#video-select').dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelector('#flow-activity-jobs').children.length,0);assert.match(d.querySelector('#flow-activity-summary').textContent,/Select a project and video/);
 }finally{dom.window.close();}
});
