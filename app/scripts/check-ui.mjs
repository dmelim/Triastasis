// Optional integration check: node --experimental-websocket scripts/check-ui.mjs
// Uses only synthetic assets in an isolated browser profile. Test hooks are injected
// by this server plugin and are never included in normal dev or production builds.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src-tauri/target/ui-review');
await fs.mkdir(out, { recursive: true });
const profile = path.join(out, 'profile-' + Date.now());
const server = await createServer({ root, plugins: [{ name: 'test-only-hooks', transform(code, id) { if (id.endsWith('/src/main.ts')) return code + '\nwindow.__review = {viewer:()=>viewer, beginManifestBusy, endManifestBusy, closeManifestModal, loadRecordData, candidates:(slots)=>{ candidates=slots;renderCandidates(); }};'; } }], server: { host: '127.0.0.1', port: 1421, strictPort: true, watch: { ignored: ["**/src-tauri/target/**"] } } });
await server.listen();
const browser = process.env.TRIASTASIS_TEST_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chrome = spawn(browser, ['--headless=new', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1280,900', '--enable-unsafe-swiftshader', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let launchError; chrome.on('error', error => { launchError = error; });
let ws;
try {
  let tabs;
  for (let i = 0;i < 100;i++) {
    try {
      const port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      tabs = await (await fetch('http://127.0.0.1:' + port + '/json', { signal: AbortSignal.timeout(1000) })).json();
      break;
    } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!tabs) throw launchError ?? Error('Browser startup timeout; set TRIASTASIS_TEST_BROWSER to a Chromium executable');
  ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description ?? '')); };
  function call(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); }); }
  async function evaluate(expression) { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
  async function until(expression) { for (let i = 0;i < 100;i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); } console.log('PAGE', await evaluate('location.href + document.body.innerText.slice(0,1500)')); console.log('ERRORS', errors); throw Error('Timed out: ' + expression); }
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.navigate', { url: 'http://127.0.0.1:1421/' });
  await until(`!!document.querySelector('#gallery') && document.querySelector('#gallery').getAttribute('aria-busy') === 'false'`);
  console.log('UI booted', await evaluate(`document.querySelector('#gallery').textContent`));
  await evaluate(`(async()=>{
  const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,name:'Triangle'}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[0.8,0.3,0.2,1],metallicFactor:0,roughnessFactor:0.7}}],buffers:[{byteLength:44}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36,target:34962},{buffer:0,byteOffset:36,byteLength:6,target:34963}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5123,count:3,type:'SCALAR'}]};
  let text=JSON.stringify(json);while(text.length%4)text+=' ';
  const buffer=new ArrayBuffer(12+8+text.length+8+44),v=new DataView(buffer),bytes=new Uint8Array(buffer);
  v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,buffer.byteLength,true);v.setUint32(12,text.length,true);v.setUint32(16,0x4e4f534a,true);bytes.set(new TextEncoder().encode(text),20);
  const offset=20+text.length;v.setUint32(offset,44,true);v.setUint32(offset+4,0x004e4942,true);new Float32Array(buffer,offset+8,9).set([0,0,0,1,0,0,0,1,0]);new Uint16Array(buffer,offset+44,3).set([0,1,2]);
  const {put}=await import('/src/store.ts');
  for(const [i,label] of ['A','B'].entries())await put({id:label,versionId:label,assetId:label,label,name:label+'.png',ts:i+1,createdAt:i+1,input:new Blob(['source']),glb:new Blob([buffer],{type:'model/gltf-binary'}),thumb:null,params:{},operation:'generated',operationParams:{},favorite:false});
 })()`);
  await call('Page.reload');
  await until(`document.querySelectorAll('.asset-item').length >= 2`);
  await evaluate(`document.querySelector('.asset-item').click()`);
  await until(`!document.querySelector('#edit-start').disabled`);
  await evaluate(`document.querySelector('#edit-start').click()`);
  await until(`document.querySelector('#edit-status').textContent.includes('Editing copy')`);
  await until(`!document.querySelector('#edit-apply-transform').disabled`);
  await evaluate(`document.querySelector('#edit-position-x').value='2';document.querySelector('#edit-apply-transform').click()`);
  await until(`document.querySelector('#edit-status').textContent.includes('pending change')`);
  assert.equal(Number(await evaluate(`document.querySelector('#edit-position-x').value`)), 2);
  await evaluate(`document.querySelectorAll('.asset-item')[1].click()`);
  await until(`!!document.querySelector('.unsaved-dialog[open]')`);
  await evaluate(`document.querySelector('.unsaved-dialog button[value=cancel]').click()`);
  await until(`!document.querySelector('.unsaved-dialog')`);
  assert.equal(Number(await evaluate(`document.querySelector('#edit-position-x').value`)), 2);
  await evaluate(`document.querySelector('#edit-save-derived').click()`);
  await until(`document.querySelector('#edit-status').textContent.includes('no unsaved changes')`);
  console.log('PASS: typed transform survives operation start; cancel preserves edits; derived save becomes clean');
  await evaluate(`document.querySelector('#edit-position-x').value='3';document.querySelector('#edit-apply-transform').click()`);
  await until(`document.querySelector('#edit-status').textContent.includes('pending change') && !document.querySelector('#edit-save-derived').disabled`);
  await evaluate(`(async()=>{const {get}=await import('/src/store.ts');void window.__review.loadRecordData({...await get('A'),glb:new Blob(['bad'])});})()`);
  await until(`!!document.querySelector('.unsaved-dialog[open]')`);
  await evaluate(`document.querySelector('.unsaved-dialog button[value=discard]').click()`);
  await until(`!document.querySelector('.unsaved-dialog') && !document.querySelector('#edit-save-derived').disabled`);
  assert.equal(Number(await evaluate(`document.querySelector('#edit-position-x').value`)), 3);
  console.log('PASS: invalid replacement preserves the original dirty edit copy');
  await evaluate(`window.__review.candidates([{seed:2147483647,status:'generating'},{seed:2147483646,status:'failed',error:'Synthetic failure detail'}])`);
  const layout = await evaluate(`Array.from(document.querySelectorAll('.candidate')).map(c=>({height:c.querySelector('.candidate-preview').getBoundingClientRect().height,direction:getComputedStyle(c).flexDirection,text:c.textContent}))`);
  assert.equal(layout.length, 2); assert.ok(layout.every(c => c.height >= 88 && c.direction === 'column')); assert.ok(layout[1].text.includes('Synthetic failure detail'));
  await call('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFile(path.join(out, 'candidates.png'), Buffer.from(r.data, 'base64')));
  console.log('PASS: candidate previews retain height with long seeds and visible failure details');
  await evaluate(`document.querySelector('#manifest-modal').classList.remove('hidden');window.__review.beginManifestBusy();document.querySelector('#manifest-close').click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
  assert.equal(await evaluate(`document.querySelector('#manifest-modal').classList.contains('hidden')`), false);
  await evaluate(`window.__review.endManifestBusy();document.querySelector('#manifest-close').click();`);
  assert.equal(await evaluate(`document.querySelector('#manifest-modal').classList.contains('hidden')`), true);
  console.log('PASS: actual modal close handlers block while busy and work after recovery');
  await new Promise(r => setTimeout(r, 400));
  const idle = await evaluate('window.__review.viewer().renderer.info.render.frame');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await evaluate('window.__review.viewer().renderer.info.render.frame'), idle);
  await evaluate(`document.querySelector('#settings-btn').click()`);
  const hidden = await evaluate('window.__review.viewer().renderer.info.render.frame');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await evaluate('window.__review.viewer().renderer.info.render.frame'), hidden);
  console.log('PASS: idle and hidden viewer do not render extra frames');
  await until(`!!document.querySelector('#set-port')`);
  await call('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFile(path.join(out, 'settings.png'), Buffer.from(r.data, 'base64')));
  if (errors.length) throw Error('Page errors: ' + errors.join('\n'));
  console.log('PASS: no uncaught page exceptions');
} finally { ws?.close(); chrome.kill(); await server.close(); }
