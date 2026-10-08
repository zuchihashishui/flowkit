const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=n=>fs.readFileSync(path.join(__dirname,'../ui/'+n+'.js'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(html){const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://local'}),w=dom.window;w.eval(source('popups'));return{dom,w,d:w.document};}
test('create popup keeps form identity and draft, blocks close during submit and traps keyboard focus',()=>{
 const {dom,w,d}=setup('<button id="open">New</button><form><input value="Draft"><button type="submit">Save</button></form>');
 try{const form=d.querySelector('form'),submit=form.querySelector('button');let sent=0;form.onsubmit=e=>{e.preventDefault();sent++;};const popup=w.studioPopups.modal(form,'Create',{canClose:()=>!submit.disabled});d.getElementById('open').focus();popup.open();assert.equal(popup.dialog.querySelector('form'),form);assert.equal(d.activeElement,form.querySelector('input'));
 submit.click();assert.equal(sent,1);submit.disabled=true;popup.dialog.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(popup.dialog.open,true);submit.disabled=false;
 submit.focus();popup.dialog.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(d.activeElement,popup.dialog.querySelector('button'));
 popup.close();assert.equal(popup.dialog.open,false);assert.equal(d.activeElement,d.getElementById('open'));popup.open();assert.equal(form.querySelector('input').value,'Draft');
 }finally{dom.window.close();}
});
test('more menu retains exact action handlers, disabled state and keyed row across polling',()=>{
 const {dom,w,d}=setup('<div class="table-wrap"><table><thead><tr><th>Scene</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table></div>');
 try{w.eval(source('data-table'));let removed=0;const body=d.getElementById('rows');const make=()=>{const f=d.createDocumentFragment(),row=d.createElement('tr');row.dataset.rowId='s1';row.append(d.createElement('td'));const cell=d.createElement('td');for(const title of ['Edit','View','Delete','Export']){const b=d.createElement('button');b.textContent=title;b.disabled=title==='Export';b.onclick=()=>{if(title==='Delete')removed++;};cell.append(b);}row.append(cell);f.append(row);return f;};
 w.studioTables.reconcile(body,make());w.studioTables.enhance(d.querySelector('table'));const old=body.firstChild,more=old.querySelector('.row-more');assert.ok(more);more.click();assert.equal(more.getAttribute('aria-expanded'),'true');assert.equal(old.querySelector('.row-action-menu').hidden,false);
 w.studioTables.reconcile(body,make());assert.equal(body.firstChild,old);assert.equal(more.getAttribute('aria-expanded'),'true');const del=[...old.querySelectorAll('button')].find(b=>b.textContent==='Delete');del.click();assert.equal(removed,1);assert.equal(more.getAttribute('aria-expanded'),'false');assert.equal([...old.querySelectorAll('button')].find(b=>b.textContent==='Export').disabled,true);
 }finally{dom.window.close();}
});
test('workspace create dialogs display errors, preserve failed inputs and close only after success',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../ui/index.html'),'utf8'),{dom,w,d}=setup(html),$=id=>d.getElementById(id);
 try{w.setInterval=()=>0;w.workflow={context:()=>({})};w.studio={api:async()=>({})};w.eval(source('data-table'));w.eval(source('production'));w.eval(source('workspace'));
 $('workspace-new-project').click();const popup=$('project-form').closest('dialog');assert.equal(popup.open,true);$('project-name').value='Saved draft';d.dispatchEvent(new w.CustomEvent('studio-notice',{detail:{text:'Flow disconnected',error:true}}));assert.match(popup.textContent,/Flow disconnected/);assert.equal(popup.open,true);assert.equal($('project-name').value,'Saved draft');d.dispatchEvent(new w.CustomEvent('studio-record-created',{detail:{kind:'project'}}));assert.equal(popup.open,false);
 const create=[...d.querySelectorAll('button')].find(b=>b.textContent==='New video');create.click();assert.equal($('create-video').closest('dialog').open,true);assert.equal($('create-video').closest('[hidden]'),null);
 }finally{dom.window.close();}
});
test('media viewer switches saved scenes and close cancels an in-flight preview',async()=>{
 const {dom,w,d}=setup('<button id="opener">Preview</button><button data-page="scene-board">Media</button><section data-view="scene-board"><div id="scene-board"></div></section>');let pending,delayed=false;
 const scenes=[1,2].map(n=>({id:'s'+n,ordinal:n,start_ms:0,end_ms:4000,text:'Scene '+n,ready:true,active_concept_id:'c'+n,active_concept:{image_prompt:'Prompt'},media_jobs:[{id:'j'+n,kind:'image',current:true,state:'COMPLETED',files:['a.png']}]}));
 try{w.setInterval=()=>0;w.workflow={context:()=>({project_id:'p',video_id:'v'})};w.URL.createObjectURL=()=> 'blob:preview';w.URL.revokeObjectURL=()=>{};w.studio={api:async()=>({video:{id:'v',project_id:'p'},document:{id:'d'},segments:scenes,warnings:[]}),preview:async()=>delayed?new Promise(r=>pending=r):{bytes:new Uint8Array([1]),mime:'image/png'}};w.eval(source('scene-board'));await w.sceneBoard.open();await tick();const view=[...d.querySelectorAll('#scb-rows button')].find(b=>b.textContent==='View image');view.click();await tick();let popup=d.querySelector('dialog[open]');assert.match(popup.getAttribute('aria-label'),/001/);[...popup.querySelectorAll('button')].find(b=>b.textContent==='Next scene').click();await tick();popup=d.querySelector('dialog[open]');assert.match(popup.getAttribute('aria-label'),/002/);
 delayed=true;[...popup.querySelectorAll('button')].find(b=>b.textContent==='Previous scene').click();await tick();popup.querySelector('.popup-header button').click();pending({bytes:new Uint8Array([1]),mime:'image/png'});await tick();assert.equal(d.querySelector('dialog[open]'),null);
 }finally{dom.window.close();}
});
