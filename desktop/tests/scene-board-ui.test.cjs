const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setTimeout(r,5));
function scene(id,extra={}){return{id,ordinal:Number(id.replace('s',''))||1,start_ms:0,end_ms:4500,text:'日本語の文章 <script>bad()</script>',ready:true,active_concept_id:'c'+id,active_concept:{image_prompt:'Detailed image '+id,video_prompt:''},media_jobs:[],...extra};}
const record={video:{id:'v1',project_id:'p1',title:'Episode One'},document:{id:'d1'},segments:[
 scene('s1',{media_jobs:[{id:'image-1',kind:'image',current:true,state:'COMPLETED',files:['1.png']},{id:'old-image',kind:'image',current:false,state:'COMPLETED',files:['old.png']}]}),
 scene('s2',{job:{state:'FAILED',error:'Timeout'},active_concept:{image_prompt:'Image preserved',video_prompt:''},media_jobs:[{id:'failed-image',kind:'image',current:true,state:'FAILED',error:'Download interrupted',files:[]}]}),
 scene('s3',{media_jobs:[{id:'pending',kind:'image',current:true,state:'RUNNING',files:[]}]})],warnings:[]};
function setup(api){
 const dom=new JSDOM('<button data-page="scene-board">Scene Board</button><section data-view="scene-board"><div id="scene-board"></div></section>',{runScripts:'outside-only',url:'http://localhost/'}),w=dom.window,$=id=>w.document.getElementById(id),previews=[],checks=[],urls=[];
 let context={project_id:'p1',video_id:'v1'};w.workflow={context:()=>({...context})};w.confirm=()=>true;w.URL.createObjectURL=()=>{const url='blob:test'+urls.length;urls.push(url);return url;};w.URL.revokeObjectURL=()=>{};
 w.studio={api,preview:async(id,index)=>{previews.push({id,index});return{bytes:new Uint8Array([1,2]),mime:'image/png',kind:'image'};}};
 w.production={check:async(...args)=>{checks.push(args);return true;}};w.projectSettings={assertSaved:()=>{}};w.selectProductionVideo=async()=>true;
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/scene-board.js'),'utf8'));
 return{dom,w,$,previews,checks,context:next=>{context=next;w.document.dispatchEvent(new w.CustomEvent('workflow-changed'));}};
}
test('scene board shows real current image thumbnails, retained older results, timings and safe narration text',async()=>{
 const s=setup(async()=>structuredClone(record));try{await s.w.sceneBoard.open();await tick();assert.match(s.$('scb-rows').textContent,/00:00:04.500/);assert.match(s.$('scb-rows').textContent,/1 older result/);assert.equal(s.$('scb-rows').querySelectorAll('script').length,0);assert.equal(s.$('scb-rows').querySelector('img').src,'blob:test0');assert.deepEqual(s.previews,[{id:'image-1',index:0}]);await s.w.sceneBoard.open();await tick();assert.equal(s.previews.length,1,'status refresh reuses the cached thumbnail');
 s.$('scb-filter').value='missing_image';s.$('scb-filter').dispatchEvent(new s.w.Event('change'));assert.equal(s.$('scb-rows').querySelectorAll('tr').length,2);assert.equal(s.$('scb-rows').querySelector('[data-segment-id=s1]'),null);
 }finally{s.dom.window.close();}
});
test('selected-only media retry excludes successful and running jobs and runs a scoped preflight',async()=>{
 const writes=[],s=setup(async(method,route,body)=>{if(method==='POST'){writes.push({route,body});return{ids:['new'],resumed:[],skipped:[]};}return structuredClone(record);});
 try{await s.w.sceneBoard.open();s.$('scb-target').value='image';s.$('scb-select-filtered').click();s.$('scb-retry').click();await tick();assert.equal(writes.length,1);assert.equal(writes[0].route,'/api/storyboard/videos/v1/retry-failed');assert.deepEqual(Array.from(writes[0].body.segment_ids),['s2']);assert.equal(writes[0].body.kind,'image');assert.equal(writes[0].body.reviewed,true);assert.equal(s.checks[0][0],'images');assert.equal(s.checks[0][1].video_id,'v1');assert.match(s.$('scb-message').textContent,/Successful results were kept/);
 }finally{s.dom.window.close();}
});
test('video prompt retry preserves an existing image prompt and selected filters are separate per video',async()=>{
 const writes=[],s=setup(async(method,route,body)=>{if(method==='POST'){writes.push(body);return{ids:['new'],resumed:[],skipped:[]};}if(route.endsWith('v2'))return{video:{id:'v2',project_id:'p1',title:'Two'},document:{id:'d2'},segments:[scene('s8')],warnings:[]};return structuredClone(record);});
 try{await s.w.sceneBoard.open();s.$('scb-target').value='video_prompt';s.$('scb-select-failed').click();s.$('scb-retry').click();await tick();assert.equal(writes[0].prompt_kind,'video');assert.deepEqual(Array.from(writes[0].segment_ids),['s2']);
 s.$('scb-filter').value='failed';s.$('scb-filter').dispatchEvent(new s.w.Event('change'));s.context({project_id:'p1',video_id:'v2'});await tick();assert.equal(s.$('scb-filter').value,'all');assert.match(s.$('scb-count').textContent,/0 selected/);
 s.context({project_id:'p1',video_id:'v1'});await tick();assert.equal(s.$('scb-filter').value,'failed');assert.match(s.$('scb-count').textContent,/1 selected/);
 }finally{s.dom.window.close();}
});
test('late scenes cannot replace a newly selected video',async()=>{
 let resolveOld;const s=setup(async(method,route)=>route.endsWith('v1')?new Promise(r=>resolveOld=r):{video:{id:'v2',project_id:'p1',title:'Second'},document:{id:'d2'},segments:[scene('s9',{text:'Second video narration'})],warnings:[]});
 try{const first=s.w.sceneBoard.open();s.context({project_id:'p1',video_id:'v2'});await tick();resolveOld(record);await first;assert.match(s.$('scb-rows').textContent,/Second video narration/);assert.doesNotMatch(s.$('scb-count').textContent,/Episode One/);
 }finally{s.dom.window.close();}
});
test('a blocked preflight or changed video prevents retry submission',async()=>{
 let writes=0,resolveCheck;const s=setup(async(method)=>{if(method==='POST')writes++;return structuredClone(record);});
 try{await s.w.sceneBoard.open();s.$('scb-target').value='image';s.$('scb-select-failed').click();s.w.production.check=async()=>false;s.$('scb-retry').click();await tick();assert.equal(writes,0);
 s.w.production.check=async()=>new Promise(r=>resolveCheck=r);s.$('scb-retry').click();await tick();s.context({project_id:'p1',video_id:'v2'});resolveCheck(true);await tick();assert.equal(writes,0);
 }finally{s.dom.window.close();}
});
test('scene retries respect unsaved or loading video production settings',async()=>{
 let writes=0;const s=setup(async(method)=>{if(method==='POST')writes++;return structuredClone(record);});
 try{await s.w.sceneBoard.open();s.$('scb-target').value='image';s.$('scb-select-failed').click();s.w.videoSettings={assertSaved:()=>{throw Error('Save video production settings in Project before starting new jobs.');}};s.$('scb-retry').click();await tick();assert.equal(writes,0);assert.match(s.$('scb-message').textContent,/Save video production settings/);
 }finally{s.dom.window.close();}
});
test('Scene Board generates selected missing images using model and aspect ratio, preserving completed and active jobs',async()=>{
 const writes=[],s=setup(async(method,route,body)=>{
  if(route==='/api/models')return{image_models:{'Test Model':'model-test'}};
  if(method==='POST'){writes.push({route,body});return{ids:['new'],skipped:[]};}
  return structuredClone(record);
 });
 try{await s.w.sceneBoard.open();assert.equal(writes.length,0);s.$('scb-model').value='model-test';s.$('scb-ratio').value='VERTICAL';s.$('scb-select-filtered').click();s.$('scb-generate').click();await tick();
 assert.equal(writes.length,1);assert.equal(writes[0].route,'/api/storyboard/videos/v1/generate-media');assert.deepEqual(JSON.parse(JSON.stringify(writes[0].body)),{segment_ids:['s2'],kind:'image',image_model:'model-test',orientation:'VERTICAL',regenerate:false});assert.equal(s.checks[0][0],'images');assert.match(s.$('scb-message').textContent,/2 scenes skipped/);
 }finally{s.dom.window.close();}
});
test('Scene Board image settings are restored per video and default to video production settings',async()=>{
 const s=setup(async(method,route)=>route==='/api/models'?{image_models:{Test:'test'}}:route.endsWith('v2')?{...structuredClone(record),video:{id:'v2',project_id:'p1'}}:structuredClone(record));
 try{s.w.videoSettings={effective:()=>({media:{image_model:'test',orientation:'VERTICAL'}})};await s.w.sceneBoard.open();assert.equal(s.$('scb-model').value,'test');assert.equal(s.$('scb-ratio').value,'VERTICAL');s.$('scb-ratio').value='HORIZONTAL';s.$('scb-ratio').dispatchEvent(new s.w.Event('change'));
 s.context({project_id:'p1',video_id:'v2'});await tick();assert.equal(s.$('scb-ratio').value,'VERTICAL');s.context({project_id:'p1',video_id:'v1'});await tick();assert.equal(s.$('scb-ratio').value,'HORIZONTAL');
 }finally{s.dom.window.close();}
});
test('Scene Board does not generate with missing prompts, blocked preflight, or changed video',async()=>{
 let writes=0,resolveCheck;const doc=structuredClone(record),s=setup(async(method,route)=>{if(method==='POST')writes++;return route==='/api/models'?{}:doc;});
 try{doc.segments[1].ready=false;await s.w.sceneBoard.open();s.$('scb-select-filtered').click();s.$('scb-generate').click();await tick();assert.equal(writes,0);assert.match(s.$('scb-message').textContent,/current image prompt/);
 doc.segments[1].ready=true;await s.w.sceneBoard.open();s.w.production.check=async()=>false;s.$('scb-generate').click();await tick();assert.equal(writes,0);
 s.w.production.check=async()=>new Promise(r=>resolveCheck=r);s.$('scb-generate').click();await tick();s.context({project_id:'p1',video_id:'v2'});resolveCheck(true);await tick();assert.equal(writes,0);
 }finally{s.dom.window.close();}
});
test('all 300 scenes share one scrollable table; filtering and selection reach rows after the old page boundary',async()=>{
 const doc={...structuredClone(record),segments:Array.from({length:300},(_,i)=>scene('s'+(i+1)))},s=setup(async()=>doc);
 try{
 s.w.localStorage.setItem('flowkit.scene-board.v1/p1/v1',JSON.stringify({page:8}));
 await s.w.sceneBoard.open();assert.equal(s.$('scb-rows').children.length,300);assert.ok(s.$('scb-rows').querySelector('[data-segment-id="s300"]'));assert.equal(s.$('scb-next'),null);
 s.$('scb-table-scroll').scrollTop=450;await s.w.sceneBoard.open();assert.equal(s.$('scb-table-scroll').scrollTop,450);
 s.$('scb-select-filtered').click();assert.match(s.$('scb-count').textContent,/200 selected/);assert.equal(s.$('scb-select-all').indeterminate,true);
 s.$('scb-clear').click();s.$('scb-search').value='Detailed image s300';s.$('scb-search').dispatchEvent(new s.w.Event('input'));assert.equal(s.$('scb-rows').children.length,1);assert.equal(s.$('scb-table-scroll').scrollTop,0);
 s.$('scb-select-all').click();assert.match(s.$('scb-count').textContent,/1 selected/);assert.equal(s.$('scb-select-all').checked,true);assert.equal(s.$('scb-rows').querySelector('input').checked,true);
s.$('scb-select-all').click();assert.match(s.$('scb-count').textContent,/0 selected/);assert.equal(s.$('scb-rows').querySelector('input').checked,false);
 }finally{s.dom.window.close();}
});
test('Scene Board displays the numbered image folder and collects saved images without generating',async()=>{
 const writes=[],doc={...structuredClone(record),image_output_directory:'C:/flowkit/output/scene_images/v1'},s=setup(async(method,route,body)=>{
  if(method==='POST'){writes.push(route);return{directory:doc.image_output_directory,files:['001.png'],warnings:[]};}return doc;
 });
 try{await s.w.sceneBoard.open();assert.match(s.$('scb-image-folder').textContent,/scene_images\/v1/);s.$('scb-collect').click();await tick();assert.deepEqual(writes,['/api/storyboard/videos/v1/collect-images']);assert.match(s.$('scb-message').textContent,/1 images collected/);assert.equal(s.checks.length,0);
 }finally{s.dom.window.close();}
});
test('Scene Board opens files for its video without sending generation',async()=>{
 const opened=[],s=setup(async()=>structuredClone(record));
 s.w.studio.openVideoFiles=async(project,video)=>{opened.push({project,video});return{directory:'/projects/p1/v1',warnings:[]};};
 try{await s.w.sceneBoard.open();s.$('scb-open-files').click();await tick();assert.deepEqual(opened,[{project:'p1',video:'v1'}]);assert.match(s.$('scb-message').textContent,/projects\/p1\/v1/);assert.equal(s.checks.length,0);
 }finally{s.dom.window.close();}
});
