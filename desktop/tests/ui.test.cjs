const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

test('English UI routes project, scene, generation and voice actions to the bridge', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
  const dom = new JSDOM(html, {runScripts: 'outside-only', url: 'file:///flowkit/index.html'});
  const w = dom.window, calls = [];
  const project = {id: '11111111-1111-4111-8111-111111111111', name: 'Test project'};
  const collection = {id: 'collection', title: 'Video 1'};
  const scenes = [{id: 'scene', display_order: 0, prompt: 'Image prompt', video_prompt: 'Video prompt'}];
  w.confirm = () => true;
  w.setInterval = () => 0;
  w.studio = {
    settings: async () => ({output: '/output', extension: '/extension'}),
    importPrompts: async () => ({name: 'scenes.json', text: JSON.stringify([{prompt:'Imported image',video_prompt:'Imported video',narrator_text:'Narration'}])}),
    importVoice: async (...args) => {calls.push(['voice-import', ...args]);return {name:'my_voice'};},
    api: async (method, route, body) => {
      calls.push([method, route, body]);
      if(route==='/health') return {version:'test',extension_connected:true};
      if(route==='/api/projects') return method==='GET'?[project]:project;
      if(route.startsWith('/api/projects/')) return {...project,...body};
      if(route==='/api/workflow/project') return {project_id:project.id,video_id:collection.id,title:collection.title,videos:[collection],protocol:3};
      if(route.startsWith('/api/videos')) return method==='GET'?[collection]:collection;
      if(route.startsWith('/api/scenes')) return method==='GET'?scenes:{id:'new',...body};
      if(route==='/api/tts/templates') return [{name:'my_voice'}];
      if(route==='/api/materials') return [{id:'realistic',name:'Photorealistic'}];
      if(route==='/api/models') return {image_models:{NANO_BANANA_PRO:'GEM_PIX_2'}};
      if(route==='/api/desktop/jobs') return method==='GET'?{paused:false,jobs:[]}:{ids:['job']};
      if(route==='/api/desktop/pause') return body;
      throw Error('Unexpected route '+route);
    }
  };
  const tick = () => new Promise(resolve=>setImmediate(resolve));
  const form = async id => {w.document.getElementById(id).dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();};
  try {
    w.eval(fs.readFileSync(path.join(__dirname,'../ui/data-table.js'),'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'));
    await tick();
    assert.match(w.document.getElementById('notice').textContent,/Ready/);
    const select=w.document.getElementById('project-select');
    select.value=project.id;select.dispatchEvent(new w.Event('change'));await tick();
    assert.match(w.document.getElementById('scenes').textContent,/Video prompt/);
    assert.equal(w.document.getElementById('new-collection'),null);
    assert.equal(w.document.getElementById('video-select').hidden,false);
    assert(calls.some(c=>c[0]==='POST'&&c[1]==='/api/workflow/project'&&c[2].project_id===project.id));
    w.document.getElementById('import-scenes').click();await tick();
    assert(calls.some(c=>c[1]==='/api/scenes'&&c[2]?.narrator_text==='Narration'));
    assert.equal(w.document.querySelector('[data-page="image"]'),null);
    assert.equal(w.document.querySelector('[data-page="video"]'),null);
    let job;
    w.document.getElementById('voice-name').value='my_voice';
    w.document.getElementById('voice-transcript').value='Sample text';
    w.document.getElementById('voice-consent').checked=true;
    await form('voice-import');
    assert(calls.some(c=>c[0]==='voice-import'&&c[1]==='my_voice'&&c[3]===true));
    w.document.getElementById('voice-prompt').value='Hello world';
    await form('voice-form');
    job=calls.filter(c=>c[0]==='POST'&&c[1]==='/api/desktop/jobs').at(-1)[2].jobs[0];
    assert.equal(job.kind,'voice');assert.equal(job.template,'my_voice');
    assert.equal(w.document.documentElement.lang,'en');
    assert.equal(w.document.getElementById('notice').classList.contains('error'),false);
  } finally {dom.window.close();}
});

test('Project contains shared app settings and Settings navigation is removed',()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'));
 const d=dom.window.document;
 assert.equal(d.querySelector('[data-page="settings"]'),null);
 assert.equal(d.querySelector('[data-view="settings"]'),null);
 for(const id of ['project-settings-form','project-app-settings','output-dir','auto-export','extension-folder','cg-status','cg-history','diagnostics']){
  assert.ok(d.getElementById(id).closest('[data-view="projects"]'),id);
  assert.equal(d.querySelectorAll('#'+id).length,1);
 }
 assert.equal(d.getElementById('project-app-settings').closest('form'),null);
 dom.window.close();
});
