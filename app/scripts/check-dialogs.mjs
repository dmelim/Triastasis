// Optional integration check: node --experimental-websocket scripts/check-dialogs.mjs
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
await fs.mkdir(path.join(out, 'dialogs'), { recursive: true });
const profile = path.join(out, 'profile-' + Date.now());
const server = await createServer({ root, optimizeDeps: { entries: ['index.html'] }, plugins: [{ name: 'test-only-hooks', transform(code, id) { if (id.endsWith('/src/main.ts')) return code + '\nwindow.__review = {requestRename, chooseInDialog, confirmDestructive, requestProject, beginManifestBusy, endManifestBusy, closeManifestModal, manifestDialog};'; } }], server: { host: '127.0.0.1', port: 1421, strictPort: true, watch: { ignored: ["**/src-tauri/target/**"] } } });
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
  await call('Page.addScriptToEvaluateOnNewDocument', {source: 'Element.prototype.requestPointerLock = function() { return Promise.resolve(); };'});
  await call('Page.navigate', { url: 'http://127.0.0.1:1421/' });
  await until(`!!document.querySelector('#gallery') && document.querySelector('#gallery').getAttribute('aria-busy') === 'false'`);
  await until('!!window.__review');
  const key = async (key, code = key, modifiers = 0) => {
    await call('Input.dispatchKeyEvent', {type:'keyDown', key, code, modifiers, windowsVirtualKeyCode: {Enter:13,Escape:27,Tab:9}[key], text: key === 'Enter' ? '\r' : undefined});
    await call('Input.dispatchKeyEvent', {type:'keyUp', key, code, modifiers, windowsVirtualKeyCode: {Enter:13,Escape:27,Tab:9}[key], text: key === 'Enter' ? '\r' : undefined});
  };
  const screenshot = async name => {
    const result = await call('Page.captureScreenshot', {format:'png'});
    await fs.writeFile(path.join(out,'dialogs',name+'.png'),Buffer.from(result.data,'base64'));
  };
  const styles = () => evaluate("(()=>{const d=document.querySelector('dialog[open]');const t=getComputedStyle(d.querySelector('.modal-title'));const b=getComputedStyle(d.querySelector('.modal-body'));const a=getComputedStyle(d.querySelector('.modal-actions'));return [t.fontSize,t.fontWeight,b.padding,a.justifyContent]})()");
  await evaluate("document.querySelector('#settings-btn').focus(); void window.__review.requestRename('asset','Example asset').then(v=>window.result=v)");
  assert.equal(await evaluate("document.activeElement.id"),'rename-input');
  const reference=await styles();
  assert.deepEqual(reference.slice(0,2),['16px','600']);
  await screenshot('rename');
  await evaluate("document.querySelector('#rename-input').value='Updated asset'");
  await key('Enter');
  await until("!document.querySelector('dialog[open]')");
  assert.equal(await evaluate("window.result"),'Updated asset');
  assert.equal(await evaluate("document.activeElement.id"),'settings-btn');

  await evaluate("void window.__review.confirmDestructive('Remove asset','Remove this asset and its 3 versions?','Remove asset').then(v=>window.result=v)");
  assert.equal(await evaluate("document.activeElement.textContent"),'Cancel');
  assert.deepEqual(await styles(),reference);
  assert.deepEqual(await evaluate("Array.from(document.querySelector('dialog[open] .modal-actions').children).map(x=>x.textContent)"),['Cancel','Remove asset']);
  await screenshot('remove');
  await key('Escape');
  await until("!document.querySelector('dialog[open]')");
  assert.equal(await evaluate('window.result'),false);

  await evaluate("void window.__review.chooseInDialog('Unsaved edits','Save your edit copy before replacing this model?',[{value:'save',label:'Save derived version',variant:'primary'},{value:'discard',label:'Discard edits',variant:'secondary'},{value:'cancel',label:'Cancel',variant:'secondary'}]).then(v=>window.result=v)");
  assert.deepEqual(await evaluate("Array.from(document.querySelector('dialog[open] .modal-actions').children).map(x=>x.value)"),['cancel','discard','save']);
  await screenshot('unsaved');
  await call('Input.dispatchMouseEvent',{type:'mousePressed',x:10,y:10,button:'left',clickCount:1});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:10,y:10,button:'left',clickCount:1});
  await until("!document.querySelector('dialog[open]')");

  await evaluate("void window.__review.requestProject({assetName:'Example asset',current:null,projects:[{name:'Props',icon:'folder'}]}).then(v=>window.result=v)");
  assert.deepEqual(await styles(),reference);
  await screenshot('project');
  await evaluate("document.querySelector('dialog[open] input').value='Environment';document.querySelector('dialog[open] input').focus()");
  await key('Enter');
  await until("!document.querySelector('dialog[open]')");
  assert.equal(await evaluate('window.result.project.name'),'Environment');

  await evaluate("document.querySelector('#manifest-body').innerHTML='<p>Generation ready to import.</p><footer class=\"modal-actions\"><button class=\"button button--secondary\">Close</button><button class=\"button button--primary\">Import into Assets</button></footer>';window.__review.manifestDialog.open()");
  assert.deepEqual(await styles(),reference);
  await screenshot('manifest');
  await evaluate('window.__review.beginManifestBusy()');
  await key('Escape');
  assert.equal(await evaluate("document.querySelector('#manifest-modal').open"),true);
  await evaluate('window.__review.endManifestBusy()');
  await evaluate("document.querySelector('#manifest-close').focus()");
  await key('Tab','Tab',8);
  assert.equal(await evaluate("document.activeElement.textContent"),'Import into Assets');
  await key('Tab');
  assert.equal(await evaluate("document.activeElement.id"),'manifest-close');
  await evaluate("document.querySelector('#manifest-close').click()");
  await until("!document.querySelector('dialog[open]')");
  if(errors.length) throw Error(errors.join('\n'));
  console.log('PASS: shared visual styles, action order, initial focus, focus return, Enter, Escape, backdrop, close button, focus containment and busy dismissal guard.');
} finally { ws?.close(); chrome.kill(); await server.close(); }
