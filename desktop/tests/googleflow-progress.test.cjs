const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const dir = path.resolve(__dirname, '../../extensions/googleflow');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Flow progress renders queue stages, cooldown and escaped labels in popup and side panel', () => {
  for (const page of ['popup.html', 'side_panel.html']) {
    const dom = new JSDOM(fs.readFileSync(path.join(dir, page), 'utf8'), {runScripts: 'outside-only'});
    let current = {active: 3, max_concurrent: 3, queued: 8, completed: 2, failed: 1, rpc_in_flight: 2,
      generation_throttle: {max_concurrent: 3, min_interval_s: 3, cooldown_active: true, cooldown_remaining_s: 89.2},
      jobs: [{id: 'abc123456', label: '<img src=x onerror=alert(1)>', kind: 'video', state: 'RUNNING', stage: 'GENERATING_VIDEO', started: Date.now()/1000 - 20}]};
    let refresh;
    dom.window.chrome = {runtime: {sendMessage(message, callback) {assert.equal(message.type, 'FLOW_PROGRESS'); callback(current);}}};
    dom.window.setInterval = callback => {refresh = callback; return 1;};
    dom.window.eval(fs.readFileSync(path.join(dir, 'progress.js'), 'utf8'));
    const root = dom.window.document.getElementById('flow-progress');
    assert.match(root.textContent, /3 \/ 3 active/);
    assert.match(root.textContent, /Cooldown: 90s/);
    assert.match(root.textContent, /Generating video · polling/);
    assert.match(root.textContent, /RPC returned ≠ file saved/);
    assert.equal(root.querySelector('img'), null);
    current = {error: 'Backend HTTP 404; restart the updated backend.'}; refresh();
    assert.match(root.textContent, /restart the updated backend/);
    assert.doesNotMatch(root.textContent, /3 \/ 3 active/);
    dom.window.close();
  }
});

test('Flow background keeps running badge until concurrent RPCs settle and rejects HTTP failures', async () => {
  let listener;
  const event = () => ({addListener(){}});
  const chrome = {
    action: {setBadgeText(){}, setBadgeBackgroundColor(){}},
    alarms: {create(){}, clear(){}, onAlarm: event()},
    runtime: {onInstalled:event(), onStartup:event(), onMessage:{addListener(fn){listener=fn;}}, sendMessage:async()=>{}, getManifest:()=>({version:'test', host_permissions:[]})},
    storage:{local:{get:async()=>({}),set:async()=>{}}},
    tabs:{query:async()=>[]}, webRequest:{onBeforeSendHeaders:event()},
  };
  class WS {static OPEN=1; static CONNECTING=0; constructor(){this.readyState=0;} send(){}}
  const pending = [];
  const context = vm.createContext({chrome,WebSocket:WS,URL,AbortSignal,console,navigator:{userAgent:'test'},
    setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},
    fakeRpc:()=>new Promise(resolve=>pending.push(resolve)),fetch:async()=>({ok:true,json:async()=>({active:0})})});
  vm.runInContext(fs.readFileSync(path.join(dir, 'background.js'), 'utf8'), context);
  await tick();
  vm.runInContext('runBatchRpc = fakeRpc', context);
  const one = vm.runInContext("handleBatchRpc({id:'one', params:{rpcid:'ogiZ0b',freq:'x',captchaAction:'IMAGE_GENERATION'}})", context);
  const two = vm.runInContext("handleBatchRpc({id:'two', params:{rpcid:'ogiZ0b',freq:'x',captchaAction:'IMAGE_GENERATION'}})", context);
  const status = () => {let data; listener({type:'STATUS'}, {}, result=>data=result); return data;};
  assert.equal(status().rpcInFlight, 2);
  pending[0]({status:200,text:'ok'}); await one;
  assert.equal(status().state,'running'); assert.equal(status().rpcInFlight,1);
  pending[1]({status:429,text:'quota'}); await two;
  assert.equal(status().rpcInFlight,0);
  assert.equal(status().metrics.failedCount,1);
  assert.equal(status().metrics.successCount,1);
  let refused;
  assert.equal(listener({type:'FLOW_PROGRESS'}, {tab:{id:1}}, result=>refused=result),false);
  assert.match(refused.error,/Extension page required/);
});
