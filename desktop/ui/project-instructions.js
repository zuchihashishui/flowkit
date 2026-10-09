(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const names={image:'template_image_prompt.txt',video_4s:'template_video_4s_prompt.txt',video_6s:'template_video_6s_prompt.txt',video_8s:'template_video_8s_prompt.txt',video_10s:'template_video_10s_prompt.txt',zip_file:'template_zip_file_prompt.txt',json_to_srt:'template_json_to_srt_prompt.txt'};
 const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
 const open=()=>{document.querySelector('[data-page="projects"]')?.click();$('workspace-project-settings')?.click();$('ps-instructions')?.scrollIntoView({block:'start'});};
 window.projectInstructions={open,async refreshSrt(){
  const pid=$('project-select')?.value;if(!pid)return;
  const settings=await window.studio.api('GET','/api/projects/'+pid+'/settings');
  if(pid!==$('project-select').value)return;
  const files=settings.instruction_files;
  if(files?.configured&&$('srt-prompt'))$('srt-prompt').value=files.templates.json_to_srt.text;
  return files;
 }};
 window.projectInstructionEditor={create(host){
  const section=node('fieldset');section.id='ps-instructions';section.append(node('legend','Shared prompt instructions'));
  section.append(node('p','Used by every video in this project. Choose TXT files or edit their contents here, then save. Existing queued jobs keep their saved instructions.'));
  const folder=node('p');folder.id='ps-instructions-folder';const warning=node('p');warning.id='ps-instructions-warning';warning.setAttribute('role','status');
  const label=node('label','Instruction file'),select=node('select');select.id='ps-instruction-kind';
  for(const [kind,name] of Object.entries(names)){const o=node('option',name);o.value=kind;select.append(o);}label.append(select);
  const text=node('textarea');text.id='ps-instruction-text';text.rows=12;text.maxLength=97000;text.setAttribute('aria-label','Instruction file contents');
  const summary=node('ul');summary.id='ps-instruction-files';
  const actions=node('div');actions.className='actions';
  const makeButton=(caption,id,fn)=>{const b=node('button',caption);b.type='button';b.id=id;b.onclick=fn;actions.append(b);return b;};
  let files={},revision='',dirty=false,owner='',turn=0;
  function mark(){dirty=true;host.dispatchEvent(new Event('input',{bubbles:true}));renderSummary();}
  function renderSummary(){summary.replaceChildren(...Object.entries(names).map(([kind,name])=>node('li',name+' · '+(files[kind]?.text.trim()?'Ready':'Empty'))));}
  function show(){text.value=files[select.value]?.text||'';renderSummary();}
  select.onchange=e=>{e?.stopPropagation();show();};
  text.oninput=()=>{files[select.value]={name:names[select.value],text:text.value};mark();};
  makeButton('Choose TXT file','ps-instruction-upload',async()=>{
   const ticket=turn,kind=select.value;
   try{const f=await window.studio.importScriptSource('prompt');if(!f||ticket!==turn)return;
    if(!f.name.toLowerCase().endsWith('.txt')||f.text.length>97000)throw Error('Choose a UTF-8 TXT file up to 97,000 characters.');
    files[kind]={name:names[kind],text:f.text};mark();show();warning.textContent='Loaded '+f.name+'. Save project settings to write '+names[kind]+'.';
   }catch(e){warning.textContent=e.message;}
  });
  makeButton('Import from selected video','ps-instructions-import',async()=>{
   const vid=$('video-select').value,pid=$('project-select').value,ticket=turn;
   if(!vid||pid!==owner){warning.textContent='Select a video in this project first.';return;}
   try{
    const result=await window.studio.api('GET','/api/storyboard/videos/'+vid);
    if(ticket!==turn||vid!==$('video-select').value||pid!==$('project-select').value)return;
    const templates=result.document?.prompt_options?.templates||result.prompt_options?.templates||{};
    for(const kind of ['image','video_4s','video_6s','video_8s','video_10s'])if(templates[kind]?.text)files[kind]={name:names[kind],text:templates[kind].text};
    // The visible JSON-to-SRT draft may contain the user's existing custom prompt.
    if($('srt-prompt')?.value.trim())files.json_to_srt={name:names.json_to_srt,text:$('srt-prompt').value};
    mark();show();warning.textContent='Imported the selected video’s instructions. Review, then save to share them with every video in this project.';
   }catch(e){warning.textContent=e.message;}
  });
  makeButton('Open project folder','ps-instructions-folder-open',async()=>{try{if(owner)await window.studio.openVideoFiles(owner);}catch(e){warning.textContent=e.message;}});
  makeButton('Save shared instructions','ps-instructions-save',()=>{mark();host.closest('form').requestSubmit();});
  section.append(folder,warning,label,text,actions,node('p','GPT-5.6 Sol image and video jobs append template_zip_file_prompt.txt to the selected image or video-duration template and download a ZIP. Video is grouped by SRT duration (4s, 6s, 8s, 10s templates), up to 10 rows per batch. This ZIP rule applies only to GPT-5.6 Sol. ZIP may use {batch_size}; each output TXT must use the original scene number (001.txt, 002.txt, …). Other provider/model ZIP adapters are not configured yet.'),summary);
  host.append(section);
  return {
   load(value,pid){turn++;owner=pid;files=JSON.parse(JSON.stringify(value?.templates||{}));revision=value?.revision||'';dirty=false;folder.textContent=value?.directory?'Folder: '+value.directory:'Select a project.';warning.textContent=(value?.warnings||[]).join('\n')||(!value?.configured?'No shared files saved yet. Import existing instructions or choose TXT files, then save.':'Shared instructions loaded.');show();},
   read(){return dirty?{revision,templates:Object.fromEntries(Object.keys(names).map(k=>[k,files[k]?.text||'']))}:null;}
  };
 }};
 document.addEventListener('project-settings-saved',()=>{void window.projectInstructions.refreshSrt().catch(()=>{});});
})();
