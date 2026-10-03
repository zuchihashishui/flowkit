const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const root=path.join(__dirname,'../../extensions/elevenlabs');
const version=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).version;
const fixture=fs.readFileSync(path.join(__dirname,'fixtures/elevenlabs-tts.html'),'utf8');
function harness({credit='241.9K credits free',cost='',complete=true,model='Eleven v4',onInsert,onWait}={}) {
 const dom=new JSDOM(fixture,{url:'https://elevenlabs.io/app/speech-synthesis/text-to-speech',runScripts:'outside-only'}),w=dom.window,d=w.document;
 Object.defineProperty(w.HTMLElement.prototype,'getClientRects',{value(){return this.closest('[hidden],[aria-hidden="true"]')?[]:[{}];}});
 let listener,time=0,clicks=0,downloads=[],progress=[];
 w.Date.now=()=>time;
 w.setTimeout=(fn,ms)=>{time+=ms;onWait?.(d,time);return setImmediate(fn);};
 w.chrome={runtime:{id:'ext',onMessage:{addListener:fn=>listener=fn,hasListener:fn=>listener===fn},sendMessage:async m=>{
   if(m.type==='downloadAudio') {
     const clicked=await new Promise(resolve=>listener({type:'clickDownload',requestId:m.requestId},{id:'ext'},resolve));
     if(!clicked.ok)return clicked;
     return {ok:true,nativeDownload:{path:'/Downloads/flowkit-elevenlabs/test/audio.mp3',token:'test'}};
   }
   progress.push(m);
 }}};
 const gen=d.querySelector('[data-testid="tts-generate"]'),creditSpan=gen.parentElement.querySelector('span[data-agent-tooltip]');
 const generationFooter=gen.parentElement;
 creditSpan.textContent=credit;
 if(cost){const s=d.createElement('span');s.textContent=cost;gen.parentElement.append(s);}
 d.querySelector('[data-testid="tts-model-selector"]').setAttribute('aria-label',`Select model - ${model}`);
 d.execCommand=(command,_ui,value)=>{if(command==='delete'){d.querySelector('[data-node-view-content-react]').textContent='';return true;}assert.equal(command,'insertText');d.querySelector('[data-node-view-content-react]').textContent=value;[...generationFooter.querySelectorAll('span')].find(s=>/^105\s*\//.test(s.textContent)).firstElementChild.textContent=String(value.length);onInsert?.(d,gen);return true;};
 d.querySelector('button[aria-label="Clear text"]').addEventListener('click',()=>{d.querySelector('[data-node-view-content-react]').textContent='';});
 class Transfer { constructor(){this.values={};} setData(type,value){this.values[type]=value;} getData(type){return this.values[type] || '';} }
 w.DataTransfer=Transfer;
 w.ClipboardEvent=class extends w.Event { constructor(type,options){super(type,options);this.clipboardData=options.clipboardData;} };
 d.querySelector('[contenteditable="true"]').addEventListener('paste',event=>{
   event.preventDefault();
   const value=event.clipboardData.getData('text/plain');
   d.querySelector('[data-node-view-content-react]').textContent=value;
   [...generationFooter.querySelectorAll('span')].find(s=>/^105\s*\//.test(s.textContent)).firstElementChild.textContent=String(value.length);
   onInsert?.(d,gen);
 });
 gen.addEventListener('click',()=>{clicks++;gen.setAttribute('data-loading','true');if(complete){d.querySelector('audio').src='blob:https://elevenlabs.io/new-audio';gen.setAttribute('data-loading','false');}});
 d.addEventListener('click',e=>{const button=e.target.closest('button');if(button?.getAttribute('aria-label')==='Download' || button?.getAttribute('data-testid')==='audio-player-download-button')downloads.push(button);});
 w.fetch=async()=>{throw new Error('Playback URLs must never be fetched');};
 w.eval(fs.readFileSync(path.join(root,'content.js'),'utf8'));
 return {w,d,progress,downloads,get clicks(){return clicks;},request:message=>new Promise(resolve=>listener(message,{id:'ext'},resolve)),close:()=>dom.window.close()};
}
const request={type:'generate',requestId:'chunk-1',text:'日本語の音声を作ります。',model:'Eleven v4',timeout:30000};
test('ElevenLabs supplied markup: read model, voice and model-specific credit balance, not promotional banner',async()=>{
 const h=harness();const banner=h.d.createElement('div');banner.textContent='up to 999M credits';h.d.body.prepend(banner);
 const {page}=await h.request({type:'probe'});assert.equal(page.model,'Eleven v4');assert.equal(page.voice,'Minato - Calm, Warm & Clear');assert.equal(page.creditsRemaining,241900);assert.equal(page.credits.balanceLowerBound,241800);assert.equal(page.credits.approximate,true);assert.equal(page.estimatedCost,null);assert.equal(page.editorReady,true);h.close();
});
test('generation preserves speaker structure, requires new audio and returns bytes plus unknown-cost metadata',async()=>{
 const h=harness();const result=await h.request(request);assert.equal(result.ok,true,result.error);assert.ok(result.nativeDownload.path);assert.equal(result.estimatedCost,null);assert.equal(result.creditCheck,'informational-only');assert.equal(h.clicks,1);assert.equal(h.downloads.length,1);assert.equal(h.d.querySelector('[data-node-view-content-react]').textContent,request.text);assert.equal(h.d.querySelector('[contenteditable="false"] button span').textContent,'Minato - Calm, Warm & Clear');assert.ok(h.progress.some(p=>p.phase==='READING_CREDITS'));h.close();
});
test('Generate is absent before input and appears later: enter text first, then wait and click once',async()=>{
 let inserted=false,button,footer;
 const h=harness({onInsert:()=>{inserted=true;},onWait:(_d,time)=>{if(inserted&&time>=5000&&!button.isConnected)footer.prepend(button);}});
 button=h.d.querySelector('[data-testid="tts-generate"]');footer=button.parentElement;
 button.setAttribute('aria-label','Generate speech Ctrl+Enter');button.textContent='Generate speech';button.remove();
 const p=await h.request({type:'probe'});assert.equal(p.page.editorReady,true);assert.equal(p.page.generateReady,false);
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(inserted,true);assert.equal(h.clicks,1);
 const phases=h.progress.map(p=>p.phase);assert.ok(phases.indexOf('ENTERING_TEXT')<phases.indexOf('WAITING_GENERATE_BUTTON'));assert.ok(phases.indexOf('WAITING_GENERATE_BUTTON')<phases.indexOf('READING_CREDITS'));h.close();
});
test('waits for newly shown Generate to enable even when the character counter stays stale',async()=>{
 let button,footer,counter;
 const h=harness({onInsert:()=>{counter.firstElementChild.textContent='105';},onWait:(_d,time)=>{
  if(time>=4000&&!button.isConnected)footer.prepend(button);
  if(time>=6000)button.disabled=false;
 }});
 button=h.d.querySelector('[data-testid="tts-generate"]');footer=button.parentElement;counter=[...footer.querySelectorAll('span')].find(s=>/^105\s*\//.test(s.textContent));
 button.disabled=true;button.remove();const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);h.close();
});
test('a Generate button that never appears stops before spending any credits',async()=>{
 const h=harness();h.d.querySelector('[data-testid="tts-generate"]').remove();
 const r=await h.request(request);assert.equal(r.code,'GENERATE_NOT_FOUND');assert.equal(r.notSubmitted,true);assert.equal(h.clicks,0);assert.equal(h.downloads.length,0);h.close();
});
test('a Generate button that remains disabled stops before spending any credits',async()=>{
 const h=harness();h.d.querySelector('[data-testid="tts-generate"]').disabled=true;
 const r=await h.request(request);assert.equal(r.code,'PAGE_NOT_READY');assert.equal(r.notSubmitted,true);assert.equal(h.clicks,0);h.close();
});
test('Japanese paragraphs and blank lines survive real contenteditable paragraph/div/br markup',async()=>{
 const value='最初の段落です。\n二行目です。\n\n最後の段落です。';
 for (const markup of ['<p>最初の段落です。<br>二行目です。</p><p><br></p><p>最後の段落です。</p>', '最初の段落です。<div>二行目です。</div><div><br></div><div>最後の段落です。</div>']) {
  const h=harness({onInsert:d=>{d.querySelector('[data-node-view-content-react]').innerHTML=markup;}}),r=await h.request({...request,text:value});assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);h.close();
 }
});
test('completion returns fresh balance instead of the balance from an earlier probe',async()=>{
 const h=harness({credit:'9,000 credits left'});await h.request({type:'probe'});h.d.querySelector('[data-testid="tts-generate"]').addEventListener('click',()=>{h.d.querySelector('[data-testid="tts-generate"]').parentElement.querySelector('span[data-agent-tooltip]').textContent='8,500 credits left';});
 const r=await h.request(request);assert.equal(r.creditsBefore,9000);assert.equal(r.creditsAfter,8500);assert.equal(r.credits.balanceText,'8,500 credits left');h.close();
});
test('quoted cost is informational and does not block an enabled Generate',async()=>{
 const h=harness({credit:'1,000 credits available',cost:'Requires 1,001 credits'}),r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.creditCheck,'informational-only');assert.equal(h.clicks,1);h.close();
});
for(const credit of ['0 credits left','Credit balance unavailable'])test(`unknown or empty credits do not block Generate: ${credit}`,async()=>{
 const h=harness({credit}),r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);assert.ok(h.w.Date.now()<5000,'credit lookup must not add a 15-second wait');h.close();
});
test('explicit zero-cost quote permits free generation even if balance is unavailable',async()=>{
 const h=harness({credit:'Credit balance unavailable',cost:'Cost: 0 credits'}),r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.estimatedCost,0);h.close();
});
test('previous audio and preexisting free-regeneration tooltip are never accepted as new generation',async()=>{
 const h=harness({complete:false}),r=await h.request(request);assert.equal(r.code,'GENERATION_TIMEOUT');assert.equal(r.notSubmitted,false);assert.equal(h.clicks,1);assert.equal(h.downloads.length,0);h.close();
});
test('voice pin mismatch blocks before text replacement and paid click',async()=>{
 const h=harness(),r=await h.request({...request,expectedVoice:'Another voice'});assert.equal(r.code,'VOICE_CHANGED');assert.equal(r.notSubmitted,true);assert.equal(h.clicks,0);assert.equal(h.d.querySelector('[data-node-view-content-react]').textContent,'テスト用の文章です。');h.close();
});
test('voice changes during input block paid click',async()=>{
 const h=harness({onInsert:d=>d.querySelector('[data-testid="tts-voice-selector"]').setAttribute('aria-label','Select voice - Changed')}),r=await h.request(request);assert.equal(r.code,'SETTINGS_CHANGED');assert.equal(h.clicks,0);h.close();
});
test('stale website character count does not block a complete text and ready Generate button',async()=>{
 const h=harness({onInsert:(_d,gen)=>{[...gen.parentElement.querySelectorAll('span')].find(s=>/\/\s*10,000/.test(s.textContent)).firstElementChild.textContent='105';}}),r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);h.close();
});
test('missing website character counter does not block generation',async()=>{
 const h=harness({onInsert:(_d,gen)=>{[...gen.parentElement.querySelectorAll('span')].find(s=>/\/\s*10,000/.test(s.textContent)).remove();}}),r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);h.close();
});
test('incomplete editor text still blocks Generate independently of the website counter',async()=>{
 const h=harness({onInsert:d=>{d.querySelector('[data-node-view-content-react]').textContent='途切れた文章';}}),r=await h.request(request);assert.equal(r.code,'EDITOR_MISMATCH');assert.equal(r.notSubmitted,true);assert.equal(h.clicks,0);h.close();
});
test('explicit page credit rejection after submission is reported without resubmitting',async()=>{
 const h=harness({complete:false});h.d.querySelector('[data-testid="tts-generate"]').addEventListener('click',()=>{const a=h.d.createElement('div');a.setAttribute('role','alert');a.textContent='Not enough credits';h.d.body.append(a);});
 const r=await h.request(request);assert.equal(r.code,'INSUFFICIENT_CREDITS');assert.equal(r.notSubmitted,false);assert.equal(h.clicks,1);h.close();
});
test('model selection confirms Eleven v4 in selector before entering text',async()=>{
 const h=harness({model:'Eleven v3'}),trigger=h.d.querySelector('[data-testid="tts-model-selector"]');trigger.addEventListener('click',()=>{const o=h.d.createElement('button');o.setAttribute('role','option');o.textContent='Eleven v4';o.onclick=()=>trigger.setAttribute('aria-label','Select model - Eleven v4');h.d.body.append(o);});
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.model,'Eleven v4');h.close();
});
test('unconfirmed model or multiple speaker blocks never generate',async()=>{
 const h=harness({model:'Eleven v3'}),r=await h.request(request);assert.equal(r.code,'MODEL_NOT_FOUND');assert.equal(h.clicks,0);h.close();
 const h2=harness();const block=h2.d.querySelector('[data-testid="tts-editor"]');block.after(block.cloneNode(true));const r2=await h2.request(request);assert.equal(r2.code,'MULTI_SPEAKER');assert.equal(h2.clicks,0);h2.close();
});
test('native download does not fetch a third-party playback URL',async()=>{
 const h=harness();h.d.querySelector('[data-testid="tts-generate"]').addEventListener('click',()=>h.d.querySelector('audio').src='https://other.example/audio.mp3');const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(h.downloads.length,1);h.close();
});
test('extension toolbar opens native side panel and requests browser downloads permission',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));assert.equal(manifest.name,'Flowkit ElevenLabs Bridge');assert.equal(manifest.side_panel.default_path,'side_panel.html');assert.equal(manifest.action.default_popup,undefined);assert.ok(manifest.permissions.includes('downloads'));
});
test('receiver injection is idempotent and replaces a stale 1.0.0 or invalidated context marker',async()=>{
 const h=harness(),code=fs.readFileSync(path.join(root,'content.js'),'utf8');
 const first=h.w.__flowkitElevenLabsBridge;
 h.w.eval(code);assert.equal(h.w.__flowkitElevenLabsBridge,first);
 h.w.__flowkitElevenLabsBridge=true;h.w.eval(code);
 assert.equal((await h.request({type:'probe'})).ok,true);assert.notEqual(h.w.__flowkitElevenLabsBridge,first);
 h.w.__flowkitElevenLabsBridge={version,get runtime(){throw Error('Extension context invalidated');}};
 h.w.eval(code);assert.equal((await h.request({type:'probe'})).ok,true);h.close();
});
test('extension worker holds audio until save acknowledgement and quarantines disconnected jobs',async()=>{
 const saved={enabled:false,tabId:null,state:'IDLE'},sent=[],pending=[],tabs=new Map();let listener,socket,documentCounter=1,removedListener,nextTab=7;
 class WS{constructor(){this.readyState=1;socket=this;}send(m){sent.push(JSON.parse(m));}close(){this.readyState=3;this.onclose();}}
 const chrome={runtime:{id:'ext',onMessage:{addListener:fn=>listener=fn}},storage:{local:{get:async()=>structuredClone(saved),set:async v=>Object.assign(saved,structuredClone(v))}},tabs:{query:async()=>[...tabs.values()],get:async id=>{if(!tabs.has(id))throw Error('No tab');return tabs.get(id);},remove:async ids=>{for(const id of [].concat(ids)){tabs.delete(id);await removedListener?.(id);}},create:async options=>{const tab={id:++nextTab,status:'complete',url:options.url};tabs.set(tab.id,tab);documentCounter++;return tab;},sendMessage:async(_id,m)=>m.type==='probe'?{ok:true,page:{generating:false,editorReady:true,voice:'Pinned voice',documentToken:String(documentCounter)}}:m.type==='clearForReload'?{ok:true,voice:'Pinned voice',documentToken:String(documentCounter)}:new Promise(resolve=>pending.push({m,resolve})),reload:async()=>{documentCounter++;},onRemoved:{addListener(fn){removedListener=fn;}}},alarms:{create(){},onAlarm:{addListener(){}}},sidePanel:{setPanelBehavior:async()=>{}}};
 chrome.windows={create:async options=>({id:42,tabs:[await chrome.tabs.create({url:options.url,active:options.focused,windowId:42})]})};
 vm.runInNewContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),{chrome,WebSocket:WS,URL,Date,console,setInterval(){},setTimeout(fn){return setImmediate(fn);}});
 const tick=()=>new Promise(r=>setImmediate(r)),receive=m=>socket.onmessage({data:JSON.stringify(m)}),ui=m=>new Promise(r=>listener(m,{id:'ext'},r));
 await tick();socket.onopen();assert.equal((await ui({type:'status'})).ready,false);receive({...request,type:'generate'});await tick();assert.equal(pending.length,0);assert.equal(saved.state,'IDLE');
 await ui({type:'setEnabled',enabled:true});assert.equal((await ui({type:'status'})).ready,true);receive({...request,type:'generate',expectedVoice:'Pinned voice'});await tick();assert.equal(pending.length,1);assert.equal(pending[0].m.expectedVoice,'Pinned voice');
 listener({type:'elevenlabsProgress',requestId:request.requestId,phase:'READING_CREDITS',credits:{balance:241300,cost:null,balanceText:'241.3K credits free'}},{id:'ext',tab:{id:saved.tabId},frameId:0},()=>{});
 assert.equal((await ui({type:'status'})).page.creditsRemaining,241300);
 listener({type:'elevenlabsProgress',requestId:request.requestId,phase:'READING_CREDITS',credits:{balance:null,cost:null,balanceText:''}},{id:'ext',tab:{id:saved.tabId},frameId:0},()=>{});
 assert.equal((await ui({type:'status'})).page.creditsRemaining,null);
 receive({...request,requestId:'duplicate'});await tick();assert.equal(pending.length,1);assert.equal(sent.find(x=>x.requestId==='duplicate').notSubmitted,true);
 pending[0].resolve({ok:true,audioBase64:'SUQz',mimeType:'audio/mpeg',voice:'Pinned voice',model:'Eleven v4',creditsAfter:400,credits:{balance:400,balanceText:'400 credits left',cost:null}});await tick();assert.equal(saved.state,'AWAITING_SAVE');assert.equal((await ui({type:'status'})).page.credits.balanceText,'400 credits left');
 receive({type:'commit',requestId:'wrong',ok:true});await tick();assert.equal(saved.state,'AWAITING_SAVE');
 receive({type:'commit',requestId:request.requestId,ok:true});await tick();assert.equal(saved.state,'IDLE');assert.ok(sent.some(x=>x.type==='commitAck'&&x.ok&&x.requestId===request.requestId));
 receive({...request,requestId:'quarantined'});await tick();pending[1].resolve({ok:true,audioBase64:'SUQz'});await tick();receive({type:'commit',requestId:'quarantined',ok:false});await tick();assert.equal(saved.state,'NEEDS_REVIEW');receive({type:'commit',requestId:'quarantined',ok:true});await tick();assert.equal(sent.at(-1).type,'commitAck');assert.equal(sent.at(-1).ok,false);assert.equal(saved.state,'NEEDS_REVIEW');receive({type:'review',requestId:'review-q'});await tick();
 receive({...request,requestId:'chunk-2'});await tick();socket.close();await tick();assert.equal(saved.state,'NEEDS_REVIEW');pending[2].resolve({ok:true,audioBase64:'SUQz'});await tick();assert.equal(saved.state,'NEEDS_REVIEW');assert.equal((await ui({type:'status'})).busy,false);assert.equal((await ui({type:'status'})).needsReview,true);
 receive({type:'review',requestId:'review-1'});await tick();assert.equal(saved.state,'IDLE');
});
test('side panel binds and probes the selected tab and renders activity safely',async()=>{
 const html=fs.readFileSync(path.join(root,'side_panel.html'),'utf8'),dom=new JSDOM(html,{url:'https://extension.invalid/side_panel.html',runScripts:'outside-only'}),w=dom.window,commands=[];
 const status={enabled:true,connected:true,tabId:7,state:'IDLE',busy:false,phase:'SAVED',page:{model:'Eleven v4',voice:'Japanese Voice',creditsRemaining:900,estimatedCost:null},events:[{time:new Date().toISOString(),message:'<img src=x onerror=alert(1)>'}]};
 w.chrome={runtime:{sendMessage:async m=>{commands.push(m);return status;}},tabs:{query:async()=>[{id:7,url:'https://elevenlabs.io/app/speech-synthesis/text-to-speech',title:'TTS'}],create:async()=>{},update:async()=>({windowId:1})},windows:{update:async()=>{}}};w.setInterval=()=>{};
 w.eval(fs.readFileSync(path.join(root,'panel.js'),'utf8'));const tick=()=>new Promise(r=>setImmediate(r));await tick();
 assert.equal(w.document.getElementById('voice').textContent,'Japanese Voice');assert.equal(w.document.getElementById('cost').textContent,'Not shown by page');assert.equal(w.document.querySelector('#activity img'),null);
 w.document.getElementById('bind').click();await tick();assert.ok(commands.some(m=>m.type==='bindTab'&&m.tabId===7));w.document.getElementById('probe').click();await tick();assert.ok(commands.some(m=>m.type==='probe'));dom.window.close();
});
const generatingCards=fs.readFileSync(path.join(__dirname,'fixtures/elevenlabs-generating.html'),'utf8');
const completedCards=fs.readFileSync(path.join(__dirname,'fixtures/elevenlabs-completed.html'),'utf8');
function cardHarness({finishAfter=6000,oldCards=false,earlySource=true,selectSource=true,neverFinish=false,partial=false}={}) {
 let slot,start=null,finished=false,playClicks=0,firstReady=false;
 const h=harness({complete:false,onWait:(_d,time)=>{
  if(start===null)return;
  if(!finished)assert.equal(h.downloads.length,0,'Streaming audio must not download before variant Download buttons exist');
  if(partial&&!firstReady&&time-start>=3000){
   const template=h.d.createElement('div');template.innerHTML=completedCards;
   slot.querySelector('p').parentElement.replaceWith(template.querySelector('p').parentElement);firstReady=true;
  }
  if(!neverFinish&&!finished&&time-start>=finishAfter){
   slot.innerHTML=completedCards;finished=true;
   slot.querySelector('button[aria-label="Play"]').addEventListener('click',()=>{playClicks++;if(selectSource)h.d.querySelector('audio').src='blob:https://elevenlabs.io/selected-generation-1';});
  }
 }});
 const gen=h.d.querySelector('[data-testid="tts-generate"]');slot=h.d.createElement('div');gen.before(slot);
 if(oldCards)slot.innerHTML=completedCards;
 gen.addEventListener('click',()=>{start=h.w.Date.now();slot.innerHTML=generatingCards;gen.setAttribute('data-loading','false');if(earlySource)h.d.querySelector('audio').src='blob:https://elevenlabs.io/streaming-generation-1';});
 return {h,slot,get playClicks(){return playClicks;}};
}
test('supplied loading/completed cards override an already-enabled Generate and streaming global player',async()=>{
 const {h}=cardHarness();const result=await h.request(request);assert.equal(result.ok,true,result.error);assert.equal(h.clicks,1);assert.equal(h.downloads.length,1);
 assert.ok(h.progress.some(x=>x.phase==='WAITING_DOWNLOAD'&&x.message.includes('0/2')));assert.ok(h.progress.some(x=>x.phase==='VERIFYING_DOWNLOAD'&&x.message.includes('2/2')));h.close();
});
test('existing Generation 1/2 cards must enter loading then finish for the new request',async()=>{
 const {h}=cardHarness({oldCards:true});const result=await h.request(request);assert.equal(result.ok,true,result.error);assert.equal(h.downloads.length,1);h.close();
});
test('one variant ready is insufficient while another variant is still loading',async()=>{
 const {h}=cardHarness({partial:true,finishAfter:10000});const r=await h.request(request);assert.equal(r.ok,true,r.error);
 assert.ok(h.progress.some(x=>x.phase==='WAITING_DOWNLOAD'&&x.message.includes('1/2')));assert.equal(h.downloads.length,1);h.close();
});
test('cards without Download continue waiting even when new audio can already play',async()=>{
 const {h}=cardHarness({neverFinish:true});const result=await h.request(request);assert.equal(result.code,'GENERATION_TIMEOUT');assert.equal(result.notSubmitted,false);assert.equal(h.downloads.length,0);assert.equal(h.clicks,1);h.close();
});
test('completed cards download Generation 1 directly without Play',async()=>{
 const c=cardHarness({earlySource:false}),r=await c.h.request(request);assert.equal(r.ok,true,r.error);assert.equal(c.playClicks,0);assert.equal(c.h.downloads.length,1);assert.equal(c.h.downloads[0].parentElement.parentElement.parentElement.querySelector('p').textContent,'Generation 1');c.h.close();
});
test('new completed cards download directly even when the player still has previous audio',async()=>{
 const c=cardHarness({earlySource:false,selectSource:false}),r=await c.h.request(request);assert.equal(r.ok,true,r.error);assert.equal(c.playClicks,0);assert.equal(c.h.downloads.length,1);c.h.close();
});
test('old ready cards plus a changed player source without new-card evidence cannot complete the request',async()=>{
 const h=harness(),gen=h.d.querySelector('[data-testid="tts-generate"]'),slot=h.d.createElement('div');slot.innerHTML=completedCards;gen.before(slot);
 const r=await h.request(request);assert.equal(r.code,'GENERATION_TIMEOUT');assert.equal(h.downloads.length,0);h.close();
});
test('probe recognizes card loading even though Generate reports data-loading=false',async()=>{
 const h=harness(),gen=h.d.querySelector('[data-testid="tts-generate"]'),slot=h.d.createElement('div');slot.innerHTML=generatingCards;gen.before(slot);
 const p=await h.request({type:'probe'});assert.equal(p.page.generating,true);const r=await h.request(request);assert.equal(r.code,'BUSY');assert.equal(h.clicks,0);h.close();
});
test('clearForReload empties only the text and preserves the speaker and voice',async()=>{
 const h=harness(),before=await h.request({type:'probe'}),r=await h.request({type:'clearForReload',expectedVoice:before.page.voice});
 assert.equal(r.ok,true,r.error);assert.equal(h.d.querySelector('[data-node-view-content-react]').textContent,'');assert.equal(r.documentToken,before.page.documentToken);
 assert.equal(r.voice,before.page.voice);assert.ok(h.d.querySelector('[contenteditable="false"] button'));assert.equal(h.clicks,0);h.close();
});
test('clearForReload reports failed deletion rather than acknowledging a nonempty editor',async()=>{
 const h=harness();h.d.querySelector('button[aria-label="Clear text"]').remove();h.d.execCommand=()=>false;const r=await h.request({type:'clearForReload'});assert.equal(r.ok,false);assert.equal(r.code,'EDITOR_CLEAR_FAILED');assert.equal(h.clicks,0);h.close();
});
test('clearForReload never deletes text while audio is still generating',async()=>{
 const h=harness();h.d.querySelector('[data-testid="tts-generate"]').setAttribute('data-loading','true');const r=await h.request({type:'clearForReload'});assert.equal(r.code,'BUSY');assert.equal(h.d.querySelector('[data-node-view-content-react]').textContent,'テスト用の文章です。');h.close();
});
test('a stale document token blocks input and Generate after unexpected navigation',async()=>{
 const h=harness(),r=await h.request({...request,expectedDocumentToken:'older-page'});assert.equal(r.code,'PAGE_CHANGED');assert.equal(r.notSubmitted,true);assert.equal(h.clicks,0);assert.equal(h.d.querySelector('[data-node-view-content-react]').textContent,'テスト用の文章です。');h.close();
});
test('empty-page probe accepts no credits, counter, Generate or Download; these appear only after text input',async()=>{
 let footer,player,inserted=false,credit;
 const h=harness({onInsert:()=>{inserted=true;},onWait:(d,time)=>{
  if(inserted&&time>=4000&&!footer.isConnected){d.body.append(footer,player);}
  if(inserted&&time>=8000)credit.textContent='241.9K credits free';
 }});
 const gen=h.d.querySelector('[data-testid="tts-generate"]');footer=gen.parentElement;player=h.d.querySelector('[data-testid="audio-player"]');
 credit=footer.querySelector('span[data-agent-tooltip]');credit.textContent='';footer.remove();player.remove();
 const p=await h.request({type:'probe'});assert.equal(p.ok,true);assert.equal(p.page.editorReady,true);assert.equal(p.page.creditsRemaining,null);assert.equal(p.page.generateReady,false);assert.equal(p.page.generating,false);
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);assert.equal(h.downloads.length,1);h.close();
});
test('a result placeholder with no Download and no loading signal does not block input or Generate',async()=>{
 const h=harness(),gen=h.d.querySelector('[data-testid="tts-generate"]'),slot=h.d.createElement('div');slot.innerHTML=completedCards;slot.querySelectorAll('button[aria-label="Download"]').forEach(e=>e.remove());gen.before(slot);
 const p=await h.request({type:'probe'});assert.equal(p.page.generating,false);
 gen.addEventListener('click',()=>{slot.innerHTML=completedCards;});
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);assert.equal(h.downloads.length,1);h.close();
});

test('credit row outside nested Generate wrapper is read when available after input',async()=>{
 let row,inserted=false;
 const h=harness({credit:'241.3K credits free',onInsert:()=>{inserted=true;},onWait:(_d,time)=>{if(inserted&&time>=700)row.hidden=false;}});
 const button=h.d.querySelector('[data-testid="tts-generate"]'),footer=button.parentElement;
 row=footer.querySelector('div.hstack.justify-between.items-center');row.hidden=true;
 const wrapper=h.d.createElement('div');footer.prepend(wrapper);wrapper.append(button);
 const banner=h.d.createElement('div');banner.textContent='999M credits available';h.d.body.prepend(banner);
 const before=await h.request({type:'probe'});assert.equal(before.page.creditsRemaining,null);
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.creditsBefore,241300);assert.equal(r.estimatedCost,null);assert.equal(h.clicks,1);h.close();
});
test('separate credit row keeps explicit cost as information only',async()=>{
 const h=harness({credit:'100 credits available'}),button=h.d.querySelector('[data-testid="tts-generate"]'),footer=button.parentElement;
 const row=footer.querySelector('div.hstack.justify-between.items-center');
 const cost=h.d.createElement('span');cost.textContent='Cost: 101 credits';row.append(cost);
 const wrapper=h.d.createElement('div');footer.prepend(wrapper);wrapper.append(button);
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.estimatedCost,101);assert.equal(h.clicks,1);h.close();
});
test('hidden credit row is not read through the surrounding visible footer',async()=>{
 const h=harness();h.d.querySelector('div.hstack.justify-between.items-center').hidden=true;
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.creditsBefore,null);assert.equal(h.clicks,1);h.close();
});
test('multiple visible TTS credit rows show unknown balance and do not block Generate',async()=>{
 const h=harness(),row=h.d.querySelector('div.hstack.justify-between.items-center');
 const other=row.cloneNode(true);other.querySelector('span[data-agent-tooltip]').textContent='0 credits left';row.after(other);
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.creditsBefore,null);assert.equal(h.clicks,1);h.close();
});

test('credit label survives removed layout classes and a nested Generate wrapper',async()=>{
 const h=harness({credit:'241.3K credits free'}),button=h.d.querySelector('[data-testid="tts-generate"]'),footer=button.parentElement;
 const wrapper=h.d.createElement('div');footer.prepend(wrapper);wrapper.append(button);
 const row=footer.querySelector('div.hstack.justify-between.items-center');row.removeAttribute('class');
 const label=row.querySelector('[data-agent-tooltip]');label.removeAttribute('class');label.removeAttribute('data-agent-tooltip');
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.creditsBefore,241300);assert.equal(h.clicks,1);h.close();
});
test('display contents balance is readable even without client rectangles',async()=>{
 const h=harness({credit:'241.3K credits free'}),label=h.d.querySelector('[data-agent-tooltip^="You got"]');
 label.style.display='contents';label.getClientRects=()=>[];
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.creditsBefore,241300);h.close();
});
test('CSS-hidden balances are ignored without blocking Generate',async()=>{
 const h=harness(),row=h.d.querySelector('div.hstack.justify-between.items-center');
 const hidden=row.cloneNode(true);hidden.style.visibility='hidden';row.after(hidden);
 assert.equal((await h.request({type:'probe'})).page.creditsRemaining,241900);
 row.style.display='none';
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.creditsBefore,null);assert.equal(h.clicks,1);h.close();
});

test('credit parser exceptions do not block probe or an enabled Generate',async()=>{
 const h=harness();const original=h.w.getComputedStyle.bind(h.w);h.w.getComputedStyle=el=>{if(el.matches('span[data-agent-tooltip]'))throw new Error('Credit layout read failed');return original(el);};
 const p=await h.request({type:'probe'});assert.equal(p.ok,true);assert.equal(p.page.creditsRemaining,null);
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(r.creditsBefore,null);assert.equal(h.clicks,1);h.close();
});

for (const mode of ['aria','text']) test(`Generate without test ID is found through ${mode}`,async()=>{
 const h=harness({onInsert:(_d,button)=>{
   button.removeAttribute('data-testid');
   button.setAttribute('aria-label',mode==='aria'?'Generate speech Ctrl+Enter':'');
   button.textContent=mode==='text'?'Generate speech':'';
 }});
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);h.close();
});
test('Generate may appear after 20 seconds without resubmitting text',async()=>{
 let button,footer,insertions=0;
 const h=harness({onInsert:()=>insertions++,onWait:(_d,time)=>{if(time>=20000&&!button.isConnected)footer.prepend(button);}});
 button=h.d.querySelector('[data-testid="tts-generate"]');footer=button.parentElement;button.remove();
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(insertions,1);assert.equal(h.clicks,1);h.close();
});
test('ambiguous Generate buttons stop without clicking either and report receiver version',async()=>{
 const h=harness(),button=h.d.querySelector('[data-testid="tts-generate"]');button.after(button.cloneNode(true));
 const r=await h.request(request);assert.equal(r.code,'GENERATE_AMBIGUOUS');assert.ok(r.error.includes(`Bridge ${version}; matching buttons=2`));assert.equal(h.clicks,0);h.close();
});

test('slow ProseMirror update is awaited without reinserting text or repeating Generate',async()=>{
 let inserted=0;
 const h=harness({onInsert:d=>{inserted++;d.querySelector('[data-node-view-content-react]').textContent='';},onWait:(d,time)=>{if(time>=2000)d.querySelector('[data-node-view-content-react]').textContent=request.text;}});
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(inserted,1);assert.equal(h.clicks,1);h.close();
});
test('HTML spaces, CR line endings and composed Japanese compare without changing narration',async()=>{
 const input='  カ\u3099イド\r次の 文。\r\n\n最後。  ';
 const h=harness({onInsert:d=>{d.querySelector('[data-node-view-content-react]').innerHTML='<p>ガイド</p><p>次の&nbsp;文。</p><p><br></p><p>最後。</p>';}});
 const r=await h.request({...request,text:input});assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);h.close();
});
test('equal-length wrong text is rejected with useful diagnostics and no Generate',async()=>{
 const h=harness({onInsert:d=>{d.querySelector('[data-node-view-content-react]').textContent='X'+request.text.slice(1);}});
 const r=await h.request(request);assert.equal(r.code,'EDITOR_MISMATCH');assert.match(r.error,/expected=\d+; entered=\d+; first difference=1/);assert.equal(r.notSubmitted,true);assert.equal(h.clicks,0);h.close();
});
test('temporarily correct text that is later truncated does not pass retention confirmation',async()=>{
 const h=harness({onWait:(d,time)=>{if(time>=500)d.querySelector('[data-node-view-content-react]').textContent='短い';}});
 const r=await h.request(request);assert.equal(r.code,'EDITOR_MISMATCH');assert.equal(h.clicks,0);h.close();
});

test('paste handler receives the exact chunk once and updates editor state without DOM insertion',async()=>{
 const h=harness();let pastes=0,inputs=0;
 h.d.execCommand=()=>{throw Error('Text must use the editor paste handler');};
 h.d.querySelector('[contenteditable="true"]').addEventListener('paste',e=>{pastes++;assert.equal(e.clipboardData.getData('text/plain'),request.text);});
 h.d.querySelector('[contenteditable="true"]').addEventListener('input',()=>inputs++);
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(pastes,1);assert.equal(inputs,0);assert.equal(h.clicks,1);h.close();
});
test('unhandled paste stops without falling back to DOM-only text or clicking Generate',async()=>{
 const h=harness();h.d.addEventListener('paste',e=>e.stopPropagation(),true);
 const r=await h.request(request);assert.equal(r.code,'EDITOR_PASTE_NOT_HANDLED');assert.equal(r.notSubmitted,true);assert.equal(h.clicks,0);h.close();
});

test('closed Settings does not hide the voice selected in the single speaker header',async()=>{
 const h=harness();h.d.querySelector('[data-testid="tts-voice-selector"]').hidden=true;
 const p=await h.request({type:'probe'});assert.equal(p.page.voice,'Minato - Calm, Warm & Clear');
 const cleared=await h.request({type:'clearForReload',expectedVoice:p.page.voice});assert.equal(cleared.ok,true,cleared.error);
 const r=await h.request({...request,expectedVoice:p.page.voice});assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);h.close();
});
test('missing voice differs from changed voice and leaves narration untouched',async()=>{
 const h=harness();h.d.querySelector('[data-testid="tts-voice-selector"]').remove();h.d.querySelector('.node-dialogueNode [contenteditable="false"] button span.truncate').remove();
 const before=h.d.querySelector('[data-node-view-content-react]').textContent;
 const r=await h.request({type:'clearForReload'});assert.equal(r.code,'VOICE_UNKNOWN');assert.match(r.error,/Settings or the speaker header/);assert.equal(h.d.querySelector('[data-node-view-content-react]').textContent,before);h.close();
});
test('changed speaker voice reports expected and actual names before clearing',async()=>{
 const h=harness();h.d.querySelector('[data-testid="tts-voice-selector"]').hidden=true;
 const r=await h.request({type:'clearForReload',expectedVoice:'Earlier narrator'});assert.equal(r.code,'VOICE_CHANGED');assert.match(r.error,/Earlier narrator/);assert.match(r.error,/Minato/);assert.equal(h.clicks,0);h.close();
});
test('closed Settings is opened before selecting the model and entering narration',async()=>{
 const h=harness(),model=h.d.querySelector('[data-testid="tts-model-selector"]');model.hidden=true;
 const tab=h.d.createElement('button');tab.dataset.testid='tts-settings-tab';tab.textContent='Settings';let opened=0;
 tab.onclick=()=>{opened++;model.hidden=false;};h.d.body.append(tab);
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(opened,1);assert.equal(h.clicks,1);h.close();
});
test('Clear uses the page-owned button and waits for the resulting editor transaction',async()=>{
 const h=harness();h.d.execCommand=()=>{throw Error('Do not mutate the editor DOM when Clear text is available');};
 const r=await h.request({type:'clearForReload'});assert.equal(r.ok,true,r.error);assert.equal(h.d.querySelector('[data-node-view-content-react]').textContent,'');assert.equal(h.clicks,0);h.close();
});
test('a Generate duplicate under a CSS-hidden ancestor is ignored',async()=>{
 const h=harness(),parent=h.d.createElement('div');parent.style.display='none';parent.append(h.d.querySelector('[data-testid="tts-generate"]').cloneNode(true));h.d.body.append(parent);
 const r=await h.request(request);assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);h.close();
});
test('voice whitespace and Unicode normalization do not create a false voice-change error',async()=>{
 const h=harness();h.d.querySelector('[data-testid="tts-voice-selector"]').setAttribute('aria-label','Select voice - カ\u3099イド   voice');
 const r=await h.request({...request,expectedVoice:'ガイド voice'});assert.equal(r.ok,true,r.error);assert.equal(h.clicks,1);h.close();
});
test('panel action errors remain visible across polling and review is not shown as active work',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(root,'side_panel.html'),'utf8'),{url:'https://extension.invalid/side_panel.html',runScripts:'outside-only'}),w=dom.window;
 let poll;const status={enabled:true,connected:true,tabId:7,state:'NEEDS_REVIEW',busy:false,phase:'NEEDS_REVIEW',page:{},events:[]};
 w.chrome={runtime:{sendMessage:async m=>m.type==='probe'?{ok:false,error:'Choose a voice on the page'}:status},tabs:{query:async()=>[{id:7,url:'https://elevenlabs.io/app/speech-synthesis/text-to-speech'}]}};w.setInterval=fn=>poll=fn;
 w.eval(fs.readFileSync(path.join(root,'panel.js'),'utf8'));const tick=()=>new Promise(r=>setImmediate(r));await tick();
 assert.equal(w.document.getElementById('state').textContent,'Waiting for review');
 w.document.getElementById('probe').click();await tick();assert.equal(w.document.getElementById('notice').textContent,'Choose a voice on the page');
 poll();await tick();assert.equal(w.document.getElementById('notice').textContent,'Choose a voice on the page');
 w.document.getElementById('refresh').click();await tick();assert.equal(w.document.getElementById('notice').textContent,'');dom.window.close();
});
