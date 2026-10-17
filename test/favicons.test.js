import test from 'node:test';
import assert from 'node:assert/strict';
import { faviconCandidates, loadFavicons } from '../server/favicons.js';
import { createStore } from '../server/store.js';
import { createApp } from '../server/index.js';

const doc = {url:'https://example.com/start', finalUrl:'https://www.example.com/story', originalHtml:'<base href="https://cdn.example.com/assets/"><link rel="shortcut ICON" href="brand.ico"><link rel="apple-touch-icon" href="touch.png">'};

test('existing saved HTML supplies icons using its base URL and redirected origin', () => {
  assert.deepEqual(faviconCandidates(doc), ['https://cdn.example.com/assets/brand.ico', 'https://cdn.example.com/assets/touch.png', 'https://www.example.com/favicon.ico']);
  assert.deepEqual(faviconCandidates({...doc, originalHtml:'<link rel="icon" href="javascript:alert(1)">'}), ['https://www.example.com/favicon.ico']);
});

test('icon fetches are bounded, reject non-images, and preserve fallback order', async () => {
  const icons = await loadFavicons(doc, async (url, limit) => {
    assert.equal(limit, 256_000);
    if (url.endsWith('brand.ico')) throw new Error('Unavailable');
    return {type:url.endsWith('touch.png') ? 'text/html' : 'image/x-icon', body:Buffer.from('icon')};
  });
  assert.deepEqual(icons, ['data:image/x-icon;base64,aWNvbg==']);
  assert.deepEqual(await loadFavicons(doc, async () => {throw new Error('Blocked');}), []);
});

test('data icons need no network request and oversized data is ignored', async () => {
  const data = 'data:image/png;base64,aWNvbg==';
  const icons = await loadFavicons({...doc, originalHtml:`<link rel="icon" href="${data}">`}, async () => {throw new Error('Unavailable');});
  assert.deepEqual(icons, [data]);
  const oversized = await loadFavicons({...doc, originalHtml:`<link rel="icon" href="data:image/png;base64,${'a'.repeat(400_000)}">`}, async () => {throw new Error('Unavailable');});
  assert.deepEqual(oversized, []);
});

test('favicon API handles existing snapshots and shell includes the site favicon', async () => {
  const store = createStore(':memory:');
  const saved = store.save({...doc, capturedAt:new Date().toISOString()});
  const app = createApp({store, faviconLoader:async page => {assert.equal(page.id, saved.id); return ['data:image/png;base64,aWNvbg=='];}});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/api/snapshots/${saved.id}/favicons`);
    assert.deepEqual(await response.json(), {icons:['data:image/png;base64,aWNvbg==']});
    assert.equal((await fetch(`${origin}/api/snapshots/missing/favicons`)).status, 404);
    assert.match(await (await fetch(origin)).text(), /id="favicon" rel="icon"/);
    assert.match((await fetch(`${origin}/favicon.svg`)).headers.get('content-type'), /image\/svg\+xml/);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('viewer composes the badge at bottom right and discards icons after navigation', async () => {
  const { JSDOM } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const dom = new JSDOM('<link id="favicon" rel="icon" href="/favicon.svg">', {url:'https://voicesite.example/', runScripts:'outside-only'});
  const draws = [];
  dom.window.Image = class {
    naturalWidth = 32; naturalHeight = 32;
    set src(value) { this.source = value; queueMicrotask(() => this.onload()); }
  };
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage: (image, ...rect) => draws.push({src:image.source, rect}),
    beginPath() {}, roundRect() {}, fill() {},
  });
  dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,composite';
  dom.window.fetch = async () => ({ok:true, json:async () => ({icons:['data:image/png;base64,source']})});
  try {
    dom.window.eval(readFileSync(new URL('../web/favicon.js', import.meta.url), 'utf8').replace('export async function', 'async function'));
    await dom.window.eval("setFavicon('saved')");
    assert.equal(dom.window.document.querySelector('link').type, 'image/png');
    assert.deepEqual(draws, [
      {src:'data:image/png;base64,source', rect:[0, 0, 64, 64]},
      {src:'/favicon.svg', rect:[36, 36, 28, 28]},
    ]);
    let finish;
    dom.window.fetch = () => new Promise(resolve => {finish = resolve;});
    const pending = dom.window.eval("setFavicon('old')");
    await dom.window.eval('setFavicon()');
    finish({ok:true, json:async () => ({icons:['data:image/png;base64,old']})});
    await pending;
    assert.equal(dom.window.document.querySelector('link').getAttribute('href'), '/favicon.svg');
    assert.equal(draws.length, 2);
    dom.window.fetch = async () => ({ok:true, json:async () => ({icons:[]})});
    await dom.window.eval("setFavicon('no-icon')");
    assert.equal(dom.window.document.querySelector('link').getAttribute('href'), '/favicon.svg');
  } finally { dom.window.close(); }
});
