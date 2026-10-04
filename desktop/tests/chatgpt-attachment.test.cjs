const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../../extensions/chatgpt/content.js'),'utf8');
for(const scenario of ['ready','multiline-ready','boundary-json','missing-input','upload-busy','no-chip','upload-error'])test('JSON attachment: '+scenario,async()=>{
 const dom=new JSDOM('<div role="group" aria-label="Composer mode"><button aria-pressed="true">Work</button></div><form><div contenteditable="true" class="ProseMirror" role="textbox" data-composer-markdown aria-label="Work with ChatGPT"></div><input type="file" accept=".json"><button type="button" aria-label="Send">Send</button></form>',{url:'https://chatgpt.com/',runScripts:'outside-only'});
 const w=dom.window,d=w.document;let listener,sent=0,uploads=0,uploadedBytes;
 const filename='transcript-11111111-1111-1111-1111-111111111111.json';
 const payload=scenario==='multiline-ready'&&process.env.FLOWKIT_TEST_TRANSCRIPT_JSON?fs.readFileSync(process.env.FLOWKIT_TEST_TRANSCRIPT_JSON):Buffer.from('{"word_segments":[]}');
 const prompt=scenario==='multiline-ready'?'Chuyển JSON thành SRT.\n\n1. Giữ nguyên tiếng Nhật.\n\n2. Chia Scene từ 3–15 giây.\n\nKhông tự tạo timestamp.':'Custom SRT instructions';
 Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return d.body;}});
 Object.defineProperty(w.HTMLInputElement.prototype,'files',{get(){return this._files;},set(v){this._files=v;}});
 w.DataTransfer=class{constructor(){this.files=[];this.items={add:f=>this.files.push(f)};}};w.TextDecoder=TextDecoder;
 w.chrome={runtime:{onMessage:{addListener:f=>listener=f}}};w.setTimeout=fn=>setImmediate(fn);
 d.execCommand=(cmd,_,value)=>{
  assert.equal(value,prompt);
  d.querySelector('[contenteditable]').replaceChildren(...value.split('\n').map(line=>{const p=d.createElement('p');p.textContent=line;if(!line){const br=d.createElement('br');br.className='ProseMirror-trailingBreak';p.append(br);}return p;}));
  return true;
 };
 const fileInput=d.querySelector('input');
 fileInput.onchange=()=>{uploads++;assert.equal(fileInput.files[0].name,filename);assert.equal(fileInput.files[0].type,'application/json');assert.equal(fileInput.files[0].size,payload.length);
  uploadedBytes=new Promise((resolve,reject)=>{const reader=new w.FileReader();reader.onload=()=>resolve(Buffer.from(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(fileInput.files[0]);});
  if(scenario!=='no-chip'){const chip=d.createElement('span');chip.textContent=filename;d.querySelector('form').append(chip);}if(scenario==='upload-error')d.querySelector('form').append('Upload failed');if(scenario==='upload-busy')d.querySelector('form').insertAdjacentHTML('beforeend','<span role="progressbar"></span>');};
 if(scenario==='missing-input')fileInput.remove();
 d.querySelector('button[aria-label="Send"]').onclick=()=>{sent++;d.body.insertAdjacentHTML('beforeend','<div data-local-conversation-final-assistant="true" data-markdown-text-style="assistant-message">Here is the SRT:<pre><button>Copy</button><span>srt</span><code>1\n00:00:00,000 --&gt; 00:00:03,000\n日本語</code></pre><p>1 cue. Full audio duration is not supplied; the audio tail is unverified.</p></div>');};
 const boundaries={schema_version:1,source_sha256:'a'.repeat(64),scene_end_unit_ids:[1,2]};
 if(scenario==='boundary-json')d.querySelector('button[aria-label="Send"]').onclick=()=>{sent++;d.body.insertAdjacentHTML('beforeend','<div data-local-conversation-final-assistant="true" data-markdown-text-style="assistant-message"><pre><span>json</span><button>Copy</button><code></code></pre></div>');d.querySelector('pre code').textContent=JSON.stringify(boundaries);};
 w.eval(source);
 const result=await new Promise(resolve=>listener({type:'chat',composerMode:'work',temporary:false,model:'auto',userMessage:prompt,attachment:{name:filename,base64:payload.toString('base64')},timeout:10000},{},resolve));
 const ready=['ready','multiline-ready','boundary-json'].includes(scenario);
 assert.equal(result.ok,ready,result.error);assert.equal(sent,ready?1:0);assert.equal(uploads,scenario==='missing-input'?0:1);
 if(uploads)assert.deepEqual(await uploadedBytes,payload);
 if(scenario==='boundary-json')assert.deepEqual(JSON.parse(result.content.match(/```srt\n([\s\S]*?)\n```/)[1]),boundaries);
 else if(!ready)assert.match(result.error,/No prompt was sent/);else {assert.match(result.content,/^```srt/);assert.doesNotMatch(result.content,/Copy/);assert.match(result.content,/```\n\nHere is the SRT:[\s\S]*audio tail is unverified/);}
 dom.window.close();
});
