import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createApp } from '../server/index.js';
import { createStore } from '../server/store.js';

async function serve(t, password) {
  const store = createStore(':memory:');
  store.save({url:'https://example.com/', finalUrl:'https://example.com/', title:'Shared page', wordCount:100, capturedAt:new Date().toISOString(), originalHtml:'<p>Saved</p>'});
  const server = createApp({store, adminPassword:password}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('global lists require admin login, reject bypasses, and revoke sessions on logout', async t => {
  const origin = await serve(t, 'test-admin-password');
  for (const path of ['/api/snapshots', '/api/snapshots?url=', '/api/snapshots?url=%20', '/api/snapshots?url[x]=y', '/api/admin/snapshots']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!(await response.text()).includes('Shared page'));
  }
  const login = (password, headers = {}) => fetch(origin + '/api/admin/login', {method:'POST', headers:{'Content-Type':'application/json', ...headers}, body:JSON.stringify({password})});
  assert.equal((await login('wrong')).status, 401);
  assert.equal((await login('test-admin-password', {Origin:'null'})).status, 403);
  const success = await login('test-admin-password');
  assert.equal(success.status, 200);
  const cookie = success.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const headers = {Cookie:cookie.split(';')[0]};
  for (const path of ['/api/admin/snapshots', '/api/snapshots']) {
    const response = await fetch(origin + path, {headers});
    assert.equal(response.status, 200); assert.equal((await response.json())[0].title, 'Shared page');
  }
  assert.equal((await fetch(origin + '/api/snapshots?url=https%3A%2F%2Fexample.com%2F')).status, 200);
  await fetch(origin + '/api/admin/logout', {method:'POST', headers});
  assert.equal((await fetch(origin + '/api/admin/snapshots', {headers})).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await login('wrong')).status, 401);
  assert.equal((await login('test-admin-password')).status, 429);
});
test('unconfigured admin access fails closed', async t => {
  const origin = await serve(t, '');
  assert.equal((await fetch(origin + '/api/admin/snapshots')).status, 401);
  assert.equal((await fetch(origin + '/api/admin/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{"password":""}'})).status, 503);
});

test('home uses browser-local history; capture persists it without adding shared views', async () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const key = 'voicesite.recentlyArchived.v1';
  const doc = {id:'saved-1', url:'https://example.com/', finalUrl:'https://example.com/', title:'My saved page', wordCount:100, capturedAt:new Date().toISOString(), assets:{saved:0}, readerHtml:'<p>Saved</p>'};
  const dom = new JSDOM(html, {url:'http://localhost/', runScripts:'outside-only'});
  const requests = [];
  dom.window.fetch = async path => { requests.push(path); return {ok:true, json:async () => path.startsWith('/api/snapshots?') ? [doc] : doc}; };
  try {
    // Isolate archive behavior from speech playback and favicon rendering.
    dom.window.setFavicon = () => {};
    dom.window.eval(script.replace(/^import .*;$/gm, '') .replace('const player = createPlayer();', 'const player = {reset() {}, setMode() {}};'));
    assert.deepEqual(requests, []);
    assert.equal(dom.window.document.getElementById('archive-count').textContent, '0');
    await dom.window.eval("saveUrl('https://example.com/')");
    assert.equal(JSON.parse(dom.window.localStorage.getItem(key))[0].id, doc.id);
    dom.window.eval("navigate('/')");
    assert.equal(dom.window.document.querySelector('#archive-list h3').textContent, doc.title);
    dom.window.localStorage.removeItem(key);
    dom.window.eval("navigate('/archive/shared-id')");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dom.window.localStorage.getItem(key), null);
    dom.window.eval("navigate('/')");
    assert.equal(dom.window.document.getElementById('archive-count').textContent, '0');
    dom.window.localStorage.setItem(key, '{broken');
    dom.window.eval("navigate('/')");
    assert.equal(dom.window.document.getElementById('archive-count').textContent, '0');
    assert.ok(!requests.includes('/api/snapshots'));
  } finally { dom.window.close(); }
});
