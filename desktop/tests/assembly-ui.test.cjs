const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
function setup({mixedMediaVersion=1,productionVersion=0,imageMotionVersion=1,savedDraft,productionDefaults}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{url:'https://studio.test',runScripts:'outside-only'}),w=dom.window,d=w.document,$=id=>d.getElementById(id),calls=[];
 w.setInterval=()=>{};w.HTMLMediaElement.prototype.load=()=>{};w.HTMLMediaElement.prototype.pause=()=>{};
 const assets=[{id:'s',kind:'srt',title:'Scene timings'},{id:'a',kind:'audio',title:'Narration'},{id:'i1',kind:'image',title:'001.png'},{id:'i2',kind:'image',title:'002.png'},{id:'v1',kind:'video',title:'001.mp4',metadata:{duration:4}}];
 const jobs=[{id:'finished',title:'Final video',state:'COMPLETED',phase:'Completed',progress:100}];
 w.studio={api:async(method,url,body)=>{calls.push({method,url,body:body&&JSON.parse(JSON.stringify(body))});
  if(url==='/api/assembly/status')return {assets,jobs,ffmpeg:true,ffprobe:true,mixed_media_version:mixedMediaVersion,production_version:productionVersion,image_motion_version:imageMotionVersion};
  if(url==='/api/srt/status')return {jobs:[{id:'srt-result',title:'Generated SRT',state:'COMPLETED'}]};
  if(url==='/api/elevenlabs/jobs')return {jobs:[]};if(url==='/api/whisperx/status')return {imported_sources:[]};
  if(url==='/api/assembly/source'){assets.push({id:'copy',kind:'srt',title:'Copied SRT'});return assets.at(-1);}
  if(url==='/api/assembly/scene-media')return {assets:[assets[2],assets[3]],mapping:{'1':'i2'},issues:[]};
  if(url==='/api/assembly/preview'||url==='/api/assembly/preflight'){
   const key='1';
   const selected=body.mapping[key]===undefined?(body.visual_mode!=='images'&&body.video_ids.length?'v1':'i1'):body.mapping[key];
   return {blocked:productionVersion&&selected==='i1',checks:productionVersion?[{scene:1,status:selected==='i1'?'ERROR':'OK',messages:[selected==='i1'?'Saved file is missing.':'Ready.']}]:[],scenes:[{scene_key:'1',asset_id:selected,kind:selected==='v1'?'video':'image',allowed_kind:body.visual_mode==='images'?'image':'any',index:1,start:.4,end:1.3,text:'<script>日本語</script>',image_start:0,image_end:2.1,image_id:selected}],duration:3.7,missing:selected?[]:[1],unused:[],timeline_note:'Keep gaps'};
  }return {id:'queued'};
 },assemblyImport:async(kind)=>({canceled:false,assets:kind.startsWith('videos')?[{id:'v1'}]:[{id:'i1'},{id:'i2'}],errors:[]}),assemblyMedia:async(id,action)=>{calls.push({id,action});return action==='thumbnail'?'data:image/jpeg;base64,AA==':action==='save'?{path:'movie.mp4'}:{url:'http://127.0.0.1:8100/video'};}};
 if(productionDefaults)w.videoSettings={ready:async()=>{},effective:()=>({assembly:productionDefaults})};
 if(savedDraft)w.localStorage.setItem('assembly-draft:legacy',JSON.stringify(savedDraft));
 w.eval(fs.readFileSync(path.join(__dirname,'../ui/data-table.js'),'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname,'../ui/assembly.js'),'utf8'));
 return {dom,w,d,$,calls,jobs};
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
 assert.deepEqual(request.image_ids,[]);assert.deepEqual(request.video_ids,['v1']);assert.equal(request.clip_end,'slow');
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


test('production scene load stops for review; file errors block render and resume uses the same job',async()=>{
 const {dom,w,$,calls,jobs}=setup({productionVersion:1});await $('va-refresh').onclick();
 $('va-srt').value='asset:s';$('va-audio').value='asset:a';
 await $('va-load-scenes').onclick();
 assert.equal($('va-images').selectedOptions.length,2);
 assert.equal(calls.some(c=>c.url==='/api/assembly/jobs'),false);
 assert.equal($('va-render').disabled,true);
 await $('va-preview').onclick();assert.equal($('va-render').disabled,false);
 assert.equal(calls.filter(c=>c.url==='/api/assembly/preflight').at(-1).body.mapping['1'],'i2');
 let select=$('va-scenes').querySelector('select');select.value='i1';await select.onchange();
 assert.equal($('va-render').disabled,true);assert.match($('va-scenes').textContent,/Saved file is missing/);
 select=$('va-scenes').querySelector('select');select.value='i2';await select.onchange();
 assert.equal($('va-render').disabled,false);
 jobs.push({id:'stopped',title:'Interrupted render',state:'FAILED',phase:'Failed',progress:35,saved_scenes:12,can_resume:true});
 await $('va-refresh').onclick();
 const resume=[...$('va-jobs').querySelectorAll('button')].find(b=>b.textContent==='Resume render');assert(resume);
 await resume.onclick();assert(calls.some(c=>c.url==='/api/assembly/jobs/stopped/resume'));
 assert.equal(calls.some(c=>c.url==='/api/assembly/jobs'),false);
 dom.window.close();
});


test('still-image motion defaults off, persists drafts and invalidates the render preview',async()=>{
 const {dom,w,$,calls}=setup();await $('va-refresh').onclick();
 assert.equal($('va-image-motion').value,'none');
 $('va-srt').value='asset:s';$('va-audio').value='asset:a';await $('va-import-images').onclick();
 await $('va-preview').onclick();assert.equal($('va-render').disabled,false);
 assert.equal(calls.filter(c=>c.url==='/api/assembly/preview').at(-1).body.image_motion,'none');
 $('va-image-motion').value='zoom_in';$('va-image-motion').dispatchEvent(new w.Event('change'));
 assert.equal($('va-render').disabled,true);
 assert.equal(JSON.parse(w.localStorage.getItem('assembly-draft:legacy'))['image-motion'],'zoom_in');
 await $('va-preview').onclick();await $('va-render').onclick();
 assert.equal(calls.find(c=>c.url==='/api/assembly/jobs').body.image_motion,'zoom_in');
 dom.window.close();
});

test('saved image-motion drafts restore and cannot silently use an older backend',async()=>{
 const {dom,w,$,calls}=setup({imageMotionVersion:0,savedDraft:{'image-motion':'zoom_out',srt:'asset:s',audio:'asset:a',images:['i1']}});
 await $('va-refresh').onclick();assert.equal($('va-image-motion').value,'zoom_out');
 await $('va-preview').onclick();assert.match($('va-message').textContent,/updated backend/);
 assert.equal(calls.some(c=>c.url==='/api/assembly/preview'),false);
 assert.equal($('va-render').disabled,true);dom.window.close();
});


test('assembly inherits per-video defaults but keeps explicit saved and edited selections',async()=>{
 const first=setup({productionDefaults:{size:'vertical',fps:24,image_motion:'zoom_in'}});
 await first.$('va-refresh').onclick();
 assert.equal(first.$('va-size').value,'vertical');assert.equal(first.$('va-fps').value,'24');assert.equal(first.$('va-image-motion').value,'zoom_in');
 first.$('va-image-motion').value='zoom_out';first.$('va-image-motion').dispatchEvent(new first.w.Event('change'));
 first.d.dispatchEvent(new first.w.CustomEvent('production-settings-changed',{detail:{production:{assembly:{size:'720p',image_motion:'none'}}}}));
 assert.equal(first.$('va-size').value,'720p');assert.equal(first.$('va-image-motion').value,'zoom_out');
 first.dom.window.close();
 const second=setup({savedDraft:{size:'720p','image-motion':'none'},productionDefaults:{size:'vertical',image_motion:'zoom_in'}});
 await second.$('va-refresh').onclick();assert.equal(second.$('va-size').value,'720p');assert.equal(second.$('va-image-motion').value,'none');
 second.dom.window.close();
});

test('reset to video defaults resets render options while preserving scene inputs and title',async()=>{
 const {dom,w,d,$}=setup({savedDraft:{'image-motion':'zoom_out',size:'720p',title:'Keep title',srt:'asset:s',audio:'asset:a',images:['i1']}});
 await $('va-refresh').onclick();
 d.dispatchEvent(new w.CustomEvent('production-defaults-reset',{detail:{production:{assembly:{size:'vertical',fps:24,fit:'fit',subtitles:'off',font:'Arial',image_motion:'none'}}}}));
 assert.equal($('va-image-motion').value,'none');assert.equal($('va-size').value,'vertical');
 assert.equal($('va-title').value,'Keep title');assert.equal($('va-srt').value,'asset:s');assert.equal($('va-audio').value,'asset:a');
 assert.equal($('va-images').selectedOptions[0].value,'i1');assert.equal($('va-render').disabled,true);
 dom.window.close();
});

test('upgrade disables legacy subtitles, sends the selected mode to render, and remembers explicit choices',async()=>{
 const {dom,w,d,$,calls}=setup({savedDraft:{srt:'asset:s',audio:'asset:a',images:['i1'],subtitles:'burn',_settings_edited:['subtitles']},productionDefaults:{subtitles:'burn'}});
 await $('va-refresh').onclick();
 assert.equal($('va-subtitles').value,'off');assert.equal($('va-subtitle-font').hidden,true);
 assert.equal($('va-subtitles').closest('.split'),null,'Subtitle choice must stay visible outside collapsed settings');
 await $('va-preview').onclick();await $('va-render').onclick();
 assert.equal(calls.filter(c=>c.url==='/api/assembly/jobs').at(-1).body.subtitles,'off');
 assert.match($('va-plan-note').textContent,/Subtitles: Off/);
 for(const mode of ['burn','soft']){
  $('va-subtitles').value=mode;$('va-subtitles').dispatchEvent(new w.Event('change'));
  assert.equal($('va-render').disabled,true);
  assert.equal($('va-subtitle-font').hidden,mode!=='burn');
  await $('va-preview').onclick();await $('va-render').onclick();
  assert.equal(calls.filter(c=>c.url==='/api/assembly/jobs').at(-1).body.subtitles,mode);
 }
 const savedDraft=JSON.parse(w.localStorage.getItem('assembly-draft:legacy'));dom.window.close();
 const reopened=setup({savedDraft,productionDefaults:{subtitles:'off'}});
 await reopened.$('va-refresh').onclick();assert.equal(reopened.$('va-subtitles').value,'soft');reopened.dom.window.close();
});

for(const mode of ['slow','freeze','loop'])test('clip option persists after choosing '+mode,async()=>{
 const {dom,w,$}=setup({savedDraft:{'clip-end':mode,_clip_options_version:1}});
 await $('va-refresh').onclick();assert.equal($('va-clip-end').value,mode);
 assert.deepEqual([...$('va-clip-end').options].map(o=>o.value),['slow','freeze','loop']);
 $('va-clip-end').dispatchEvent(new w.Event('change'));
 assert.equal(JSON.parse(w.localStorage.getItem('assembly-draft:legacy'))['clip-end'],mode);dom.window.close();
});
test('old clip draft switches to slow once',async()=>{
 const {dom,$}=setup({savedDraft:{'clip-end':'freeze'}});
 await $('va-refresh').onclick();assert.equal($('va-clip-end').value,'slow');dom.window.close();
});
