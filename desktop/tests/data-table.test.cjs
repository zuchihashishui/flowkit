const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=name=>fs.readFileSync(path.join(__dirname,'../ui/'+name+'.js'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
test('tables sort numerically, filter, preserve row actions, hide columns and remember widths',async()=>{
 const dom=new JSDOM('<div class="table-wrap"><table><thead><tr><th>Scene</th><th>Text</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table></div>',{runScripts:'outside-only',url:'http://local'}),w=dom.window,d=w.document;
 try{w.eval(source('data-table'));let clicks=0;const body=d.getElementById('rows');
 for(const n of [10,2,1]){const content=d.createElement('div'),b=d.createElement('button');b.textContent='Open';b.onclick=()=>clicks++;content.append(b);body.append(w.studioTables.jobRow(content,[String(n),'Text '+n],String(n),'COMPLETED'));}
 const table=d.querySelector('table');w.studioTables.enhance(table);d.querySelector('.table-sort').click();assert.deepEqual([...body.rows].map(r=>r.cells[0].textContent),['1','2','10']);
 body.rows[0].querySelector('button').click();assert.equal(clicks,1);
 const search=d.querySelector('input[type=search]');search.value='Text 2';search.dispatchEvent(new w.Event('input'));assert.deepEqual([...body.rows].filter(r=>!r.hidden).map(r=>r.dataset.key),['2']);
 const hide=d.querySelectorAll('.table-column-menu input')[1];hide.click();assert.equal(body.rows[0].cells[1].hidden,true);
 const resize=d.querySelector('.column-resize');resize.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(table.querySelector('col').style.width,'60px');assert.equal(JSON.parse(w.localStorage.getItem('flowkit-table-v1:rows')).hidden[0],1);
 const content=d.createElement('p');content.textContent='Poll updated';body.append(w.studioTables.jobRow(content,['3','Text 3'],'3'));await tick();assert.equal(body.rows[2].dataset.key,'3');assert.equal(body.rows[2].hidden,true);
 }finally{dom.window.close();}
});
test('1000 keyed scene rows retain node identity, checked selection, focus and scroll across refresh',async()=>{
 const dom=new JSDOM('<div class="table-wrap"><table><thead><tr><th>Select</th><th>Scene</th></tr></thead><tbody id="sb-rows"></tbody></table></div>',{runScripts:'outside-only',url:'http://local'}),w=dom.window,d=w.document;
 try{w.eval(source('data-table'));const body=d.getElementById('sb-rows'),wrap=d.querySelector('.table-wrap');let clicks=0;
 const make=(changed=false)=>{const f=d.createDocumentFragment();for(let i=1;i<=1000;i++){const row=d.createElement('tr');row.dataset.rowId='s'+i;const cell=d.createElement('td'),input=d.createElement('input');input.type='checkbox';input.checked=i===750;input.setAttribute('aria-label','Select '+i);input.onchange=()=>clicks++;cell.append(input);row.append(cell);const text=d.createElement('td');text.textContent=String(i)+(changed&&i===1?' changed':'');row.append(text);f.append(row);}return f;};
 w.studioTables.reconcile(body,make());const retained=body.children[749],input=retained.querySelector('input');input.focus();wrap.scrollTop=900;wrap.scrollLeft=80;
 w.studioTables.reconcile(body,make(true));assert.equal(body.children.length,1000);assert.equal(body.children[749],retained);assert.equal(d.activeElement,input);assert.equal(input.checked,true);assert.equal(wrap.scrollTop,900);assert.equal(wrap.scrollLeft,80);input.click();assert.equal(clicks,1);
 }finally{dom.window.close();}
});
test('workspace uses instruction rows, drawers and a single visible video list without replacing controls',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{runScripts:'outside-only',url:'http://local'}),w=dom.window,d=w.document,$=id=>d.getElementById(id);
 try{w.setInterval=()=>0;w.workflow={context:()=>({})};w.studio={api:async()=>({})};w.eval(source('popups'));w.eval(source('data-table'));w.eval(source('production'));
 const upload=$('sb-upload-video_6s');let calls=0;upload.onclick=()=>calls++;w.eval(source('workspace'));upload.click();assert.equal(calls,1);assert.equal($('instruction-rows').rows.length,5);assert.equal($('sb-upload-video_6s'),upload);
 assert.equal($('project-videos').closest('.panel').hidden,true);assert.equal($('pd-videos').tagName,'TBODY');assert.equal($('video-select').closest('[hidden]'),null);
 w.workspaceUI.projectSettings();assert.equal($('project-settings-form').closest('.record-drawer').hidden,false);
 $('ps-google_flow_url').value='https://flow.google.com/project/draft';$('project-settings-form').closest('.record-drawer').querySelector('button').click();w.workspaceUI.projectSettings();assert.equal($('ps-google_flow_url').value,'https://flow.google.com/project/draft','closing a drawer retains unsaved input');
 for(const id of ['wx-jobs','srt-jobs','va-jobs','all-jobs'])assert.equal($(id).tagName,'TBODY');
 const ids=[...d.querySelectorAll('[id]')].map(n=>n.id);assert.equal(ids.length,new Set(ids).size,'no duplicated input IDs');
 }finally{dom.window.close();}
});
