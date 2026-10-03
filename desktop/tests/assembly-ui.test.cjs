const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
function setup({mixedMediaVersion=1,savedDraft}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{url:'https://studio.test',runScripts:'outside-only'}),w=dom.window,d=w.document,$=id=>d.getElementById(id),calls=[];
 w.setInterval=()=>{};w.HTMLMediaElement.prototype.load=()=>{};w.HTMLMediaElement.prototype.pause=()=>{};
 const assets=[{id:'s',kind:'srt',title:'Scene timings'},{id:'a',kind:'audio',title:'Narration'},{id:'i1',kind:'image',title:'001.png'},{id:'i2',kind:'image',title:'002.png'},{id:'v1',kind:'video',title:'001.mp4',metadata:{duration:4}}];
 const jobs=[{id:'finished',title:'Final video',state:'COMPLETED',phase:'Completed',progress:100}];
 w.studio={api:async(method,url,body)=>{calls.push({method,url,body:body&&JSON.parse(JSON.stringify(body))});
  if(url==='/api/assembly/status')return {assets,jobs,ffmpeg:true,ffprobe:true,mixed_media_version:mixedMediaVersion};
  if(url==='/api/srt/status')return {jobs:[{id:'srt-result',title:'Generated SRT',state:'COMPLETED'}]};
  if(url==='/api/elevenlabs/jobs')return {jobs:[]};if(url==='/api/whisperx/status')return {imported_sources:[]};
  if(url==='/api/assembly/source'){assets.push({id:'copy',kind:'srt',title:'Copied SRT'});return assets.at(-1);}
  if(url==='/api/assembly/preview'){
   const key='1';
   const selected=body.mapping[key]===undefined?(body.visual_mode!=='images'&&body.video_ids.length?'v1':'i1'):body.mapping[key];
   return {scenes:[{scene_key:'1',asset_id:selected,kind:selected==='v1'?'video':'image',allowed_kind:body.visual_mode==='images'?'image':'any',index:1,start:.4,end:1.3,text:'<script>日本語</script>',image_start:0,image_end:2.1,image_id:selected}],duration:3.7,missing:selected?[]:[1],unused:[],timeline_note:'Keep gaps'};
  }return {id:'queued'};
 },assemblyImport:async(kind)=>({canceled:false,assets:kind.startsWith('videos')?[{id:'v1'}]:[{id:'i1'},{id:'i2'}],errors:[]}),assemblyMedia:async(id,action)=>{calls.push({id,action});return action==='thumbnail'?'data:image/jpeg;base64,AA==':action==='save'?{path:'movie.mp4'}:{url:'http://127.0.0.1:8100/video'};}};
 if(savedDraft)w.localStorage.setItem('assembly-draft:legacy',JSON.stringify(savedDraft));
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/assembly.js'),'utf8'));
 return {dom,w,d,$,calls};
}
test('assembly UI previews mappings, invalidates edits, blocks missing images, renders and exports',async()=>{
 const {dom,w,d,$,calls}=setup();await $('va-refresh').onclick();
 $('va-srt').value='asset:s';$('va-audio').value='asset:a';
 await $('va-import-folder').onclick();assert.equal($('va-images').selectedOptions.length,2);
 await $('va-preview').onclick();assert.equal($('va-render').disabled,false);assert.equal($('va-scenes').querySelector('script'),null);
 const select=$('va-scenes').querySelector('select');select.value='';await select.onchange();assert.equal($('va-render').disabled,true);
 const updated=$('va-scenes').querySelector('select');updated.value='i2';await updated.onchange();assert.equal($('va-render').disabled,false);
 await $('va-render').onclick();assert.equal(calls.find(c=>c.url==='/api/assembly/jobs').body.mapping['1'],'i2');assert.equal($('va-render').disabled,true);
 await $('va-preview').onclick();$('va-size').value='vertical';$('va-size').dispatchEvent(new w.Event('change'));assert.equal($('va-render').disabled,true);
 const buttons=$('va-jobs').querySelectorAll('button');await buttons[0].onclick();assert.equal($('va-video').hidden,false);await buttons[1].onclick();assert.match($('va-message').textContent,/movie.mp4/);
 assert.equal($('va-title').disabled,false);dom.window.close();
});
test('completed SRT shortcut selects source and resolves a saved copy before preview',async()=>{
 const {dom,w,$,calls}=setup();await $('va-refresh').onclick();w.openAssembly('srt-result');await new Promise(r=>setImmediate(r));assert.equal($('va-srt').value,'job:srt-result');
 $('va-audio').value='asset:a';await $('va-import-images').onclick();await $('va-preview').onclick();
 assert.equal(calls.find(c=>c.url==='/api/assembly/source').body.source_id,'srt-result');assert.equal(calls.find(c=>c.url==='/api/assembly/preview').body.srt_id,'copy');dom.window.close();
});


test('video is optional; clip-only and mixed requests include media settings and support preview',async()=>{
 const {dom,w,$,calls}=setup();await $('va-refresh').onclick();
 assert.equal($('va-visual-mode').value,'images');assert.equal($('va-video-options').hidden,true);
 $('va-srt').value='asset:s';$('va-audio').value='asset:a';
 $('va-visual-mode').value='mixed';$('va-visual-mode').dispatchEvent(new w.Event('change'));
 assert.equal($('va-video-options').hidden,false);assert.equal($('va-intro-options'),null);
 await $('va-import-videos').onclick();await $('va-preview').onclick();
 const request=calls.filter(c=>c.url==='/api/assembly/preview').at(-1).body;
 assert.deepEqual(request.image_ids,[]);assert.deepEqual(request.video_ids,['v1']);assert.equal(request.clip_end,'freeze');
 assert.equal($('va-render').disabled,false);
 await $('va-scenes').querySelector('button').onclick();assert.equal($('va-clip-preview').hidden,false);
 assert.equal(calls.at(-1).action,'clip-preview');
 $('va-clip-end').value='loop';$('va-clip-end').dispatchEvent(new w.Event('change'));assert.equal($('va-render').disabled,true);
 await $('va-preview').onclick();await $('va-render').onclick();
 assert.equal(calls.find(c=>c.url==='/api/assembly/jobs').body.clip_end,'loop');
 // Returning to images-only must not submit previously selected clips.
 $('va-visual-mode').value='images';$('va-visual-mode').dispatchEvent(new w.Event('change'));
 await $('va-import-images').onclick();await $('va-preview').onclick();
 assert.deepEqual(calls.filter(c=>c.url==='/api/assembly/preview').at(-1).body.video_ids,[]);
 dom.window.close();
});

test('removed intro drafts restore optional media and require a fresh SRT mapping',async()=>{
 const {dom,w,$,calls}=setup({savedDraft:{'visual-mode':'intro','video-seconds':'125',srt:'asset:s',audio:'asset:a',images:['i2'],videos:['v1'],mapping:{'1:video':'v1','1:image':'i2'}}});
 await $('va-refresh').onclick();
 assert.deepEqual([...$('va-visual-mode').options].map(o=>o.value),['images','mixed']);
 for(const id of ['va-intro-options','va-video-seconds','va-split-source','va-use-split'])assert.equal($(id),null);
 assert.equal($('va-visual-mode').value,'mixed');assert.equal($('va-videos').selectedOptions[0].value,'v1');
 assert.equal($('va-images').selectedOptions[0].value,'i2');assert.equal($('va-render').disabled,true);
 await $('va-preview').onclick();
 const request=calls.filter(c=>c.url==='/api/assembly/preview').at(-1).body;
 assert.equal(request.visual_mode,'mixed');assert.deepEqual(request.mapping,{});assert.equal('video_duration_seconds' in request,false);
 const select=$('va-scenes').querySelector('select');select.value='i2';await select.onchange();
 assert.equal(calls.filter(c=>c.url==='/api/assembly/preview').at(-1).body.mapping['1'],'i2');
 const draft=JSON.parse(w.localStorage.getItem('assembly-draft:legacy'));
 assert.equal(draft['visual-mode'],'mixed');assert.equal('video-seconds' in draft,false);assert.deepEqual(draft.mapping,{'1':'i2'});
 dom.window.close();
});

test('mixed media cannot silently use an older image-only backend',async()=>{
 const {dom,w,$,calls}=setup({mixedMediaVersion:0});await $('va-refresh').onclick();
 $('va-visual-mode').value='mixed';$('va-visual-mode').dispatchEvent(new w.Event('change'));await $('va-preview').onclick();
 assert.match($('va-message').textContent,/updated backend/);assert.equal($('va-render').disabled,true);
 assert.equal(calls.some(c=>c.url==='/api/assembly/preview'),false);dom.window.close();
});
