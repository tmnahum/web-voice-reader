import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { prepareImages } from '../server/images.js';
import { capture } from '../server/capture.js';
import { normalizeUrl, publicIP, fetchPublic } from '../server/fetch.js';
import { createStore } from '../server/store.js';
import { createApp } from '../server/index.js';

const paragraph = 'An archive preserves the words that matter. This article explains how thoughtful reading gives us room to understand complicated ideas, return to them later, and share the original context with others. ';
const fixture = `<!doctype html><html><head><title>A thoughtful web</title><link rel="stylesheet" href="/main.css"><script>fetch('/secret')</script></head><body><nav>Navigation noise</nav><article><h1>A thoughtful web</h1><p onclick="alert(1)">${paragraph.repeat(8)}</p><img src="/huge.jpg" alt="A library full of books"><p>${paragraph.repeat(8)} <a href="/next">Continue reading</a></p></article><iframe src="http://127.0.0.1/secret"></iframe></body></html>`;
const calls = [];
const fakeFetch = async url => {
  calls.push(url);
  if (url.endsWith('/main.css')) return {body:Buffer.from('@import "nested.css"; body { color: navy; background: url(huge.jpg) } @font-face{font-family:Test;src:url(huge.woff2)}'), type:'text/css', url};
  if (url.endsWith('/nested.css')) return {body:Buffer.from('p {line-height: 1.6}'),type:'text/css', url};
  return {body:Buffer.from(fixture), type:'text/html; charset=utf-8', url};
};

test('normalization and private network protection', async () => {
  assert.equal(normalizeUrl('example.com/path?q=hello%20world#part'), 'https://example.com/path?q=hello%20world');
  for (const url of ['file:///etc/passwd','ftp://example.com','https://user:pass@example.com','https://example.com:8080']) assert.throws(() => normalizeUrl(url));
  for (const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','100.100.100.100','0.0.0.0']) assert.equal(publicIP(ip), false, ip);
  assert.equal(publicIP('1.1.1.1'), true);
  await assert.rejects(fetchPublic('http://127.0.0.1'), /private/);
});

test('capture preserves article, styles, source references, and skips binary assets', async () => {
  calls.length = 0;
  const doc = await capture('https://example.com/story', fakeFetch);
  assert.equal(doc.title, 'A thoughtful web');
  assert.ok(doc.readerHtml.includes(paragraph));
  assert.ok(!doc.readerHtml.includes('Navigation noise'));
  assert.ok(doc.readerHtml.includes('src="https://example.com/huge.jpg"'));
  assert.ok(doc.originalHtml.includes('src="https://example.com/huge.jpg"'));
  const page = new JSDOM(doc.originalHtml);
  const css = Buffer.from(page.window.document.querySelector('link').href.split(',')[1], 'base64').toString();
  assert.ok(css.includes('https://example.com/huge.jpg'));
  assert.ok(css.includes('https://example.com/huge.woff2'));
  page.window.close();
  assert.ok(doc.readerHtml.includes('https://example.com/next'));
  assert.ok(doc.originalHtml.includes('data:text/css;base64,'));
  assert.ok(doc.originalHtml.includes('<script'));
  assert.ok(!doc.readerHtml.includes('<script'));
  assert.ok(doc.originalHtml.includes('onclick'));
  assert.ok(!doc.readerHtml.includes('onclick'));
  assert.ok(doc.originalHtml.includes('<iframe'));
  assert.ok(doc.blocks.some(b => b.text === 'Navigation noise'));
  assert.ok(doc.blocks.every(b => doc.originalHtml.includes(`data-read-id="${b.id}"`)));
  assert.equal(doc.assets.saved, 2);
  assert.deepEqual(calls, ['https://example.com/story','https://example.com/main.css','https://example.com/nested.css']);
});

test('non HTML responses fail clearly', async () => {
  await assert.rejects(capture('https://example.com/file', async url => ({body:Buffer.from('pdf'),type:'application/pdf',url})), /not an HTML/);
});

test('persistent snapshot history survives reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voicesite-'));
  try {
    let store = createStore(join(dir, 'archive.db'));
    const doc = await capture('https://example.com/story', fakeFetch);
    const first = store.save(doc); store.save({...doc, originalHtml:doc.originalHtml + '<!-- changed -->', capturedAt:'2099-01-01T00:00:00Z'}); store.close();
    store = createStore(join(dir, 'archive.db'));
    assert.equal(store.list(doc.url).length, 2);
    assert.equal(store.get(first.id).originalHtml, doc.originalHtml);
    assert.equal(store.list()[0].capturedAt, '2099-01-01T00:00:00Z');
    store.close();
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('API captures, reuses snapshots, creates new versions, and replays safely', async () => {
  const store = createStore(':memory:');
  let captures = 0;
  const app = createApp({store, capturePage: async url => {captures++; const doc = await capture(url, fakeFetch); if (captures > 2) doc.originalHtml += '<!-- updated -->'; return doc;}});
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${origin}/api/capture`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try {
    const first = await (await post({url:'https://example.com/story?q=a%26b'})).json();
    assert.ok(first.id);
    const reused = await (await post({url:'https://example.com/story?q=a%26b'})).json();
    assert.equal(reused.id, first.id); assert.equal(captures,1);
    const second = await (await post({url:'https://example.com/story?q=a%26b',fresh:true})).json();
    assert.equal(second.id, first.id); assert.equal(second.unchanged,true); assert.equal(captures,2);
    const third = await (await post({url:'https://example.com/story?q=a%26b',fresh:true})).json();
    assert.notEqual(third.id, first.id); assert.equal(third.unchanged,false); assert.equal(captures,3);
    const doc = await (await fetch(`${origin}/api/snapshots/${first.id}`)).json();
    assert.ok(doc.blocks.length); assert.equal(doc.originalHtml,undefined);
    const original = await fetch(`${origin}/snapshots/${first.id}/original`);
    assert.match(original.headers.get('content-security-policy'), /sandbox allow-scripts allow-forms/);
    assert.ok(!original.headers.get('content-security-policy').includes('allow-same-origin'));
    assert.match(original.headers.get('content-security-policy'), /img-src https: http: data:/);
    assert.match(await original.text(), /A thoughtful web/);
    const shellResponse = await fetch(`${origin}/https://example.com/story?q=a%26b`);
    assert.equal(shellResponse.status,200);
    assert.equal(shellResponse.headers.get('cache-control'), 'no-store');
    const shell = await shellResponse.text();
    const assets = [...shell.matchAll(/(?:src|href)="(\/assets\/[a-f0-9]+\/[^"]+)"/g)].map(m => m[1]);
    assert.equal(assets.length, 2);
    for (const asset of assets) {
      const response = await fetch(origin + asset);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control'), /immutable/);
      assert.ok((await response.text()).length > 1000);
    }
    assert.equal((await fetch(origin + '/assets/obsolete/app.js')).status,404);
    assert.equal((await post({url:'file:///etc/passwd'})).status,400);
    const opaque = await fetch(origin + '/api/capture', {method:'POST', headers:{'Content-Type':'application/json',Origin:'null'},body:JSON.stringify({url:'https://example.com'})});
    assert.equal(opaque.status,403);
    assert.equal((await fetch(`${origin}/api/snapshots/missing`)).status,404);
    assert.equal((await fetch(`${origin}/api/capture`,{method:'POST',headers:{'content-type':'application/json',origin:'https://elsewhere.example'},body:'{"url":"https://example.com"}'})).status,403);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});


test('live image URLs handle relative, responsive, lazy, and picture sources without unsafe schemes', () => {
  const dom = new JSDOM(`<body><img src="/a.jpg" srcset="/a.jpg 1x, //cdn.example.com/a@2.jpg 2x"><img src="data:image/gif;base64,R0lG" data-src="../large.jpg"><picture><source srcset="/wide.jpg 1200w"><img alt="Landscape"></picture><img src="javascript:alert(1)"></body>`);
  prepareImages(dom.window.document, 'https://example.com/posts/story');
  const imgs = [...dom.window.document.images];
  assert.equal(imgs[0].src, 'https://example.com/a.jpg');
  assert.match(imgs[0].srcset, /https:\/\/cdn.example.com\/a@2.jpg 2x/);
  assert.equal(imgs[1].src, 'https://example.com/large.jpg');
  assert.equal(imgs[2].src, 'https://example.com/wide.jpg');
  assert.equal(imgs[3].hasAttribute('src'),false);
  assert.equal(dom.window.document.querySelector('picture source').getAttribute('srcset'),'https://example.com/wide.jpg 1200w');
  dom.window.close();
});


test('original markup retains styled controls, SVG, media, scripts, and live stylesheet fallback', async () => {
  const html = `<html><head><base href="https://cdn.example.com/resources/"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><link rel="stylesheet" href="saved.css" integrity="sha256-old"><link rel="stylesheet" href="missing.css"><link rel="icon" href="icon.png"><script src="widget.js"></script></head><body><article><p>${paragraph.repeat(8)}</p></article><button class="primary" data-state="ready" onclick="this.textContent='Done'">Subscribe<svg viewBox="0 0 24 24"><path d="M0 0L24 24" /></svg></button><form action="/subscribe"><input name="email"><select><option>Weekly</option></select></form><video poster="poster.jpg" controls><source src="movie.mp4"></video><audio src="clip.mp3"></audio><img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"></body></html>`;
  const visited = [];
  const doc = await capture('https://example.com/story', async url => {
    visited.push(url);
    if (url.endsWith('missing.css')) throw new Error('Unavailable');
    if (url.endsWith('saved.css')) return {url, type:'text/css',body:Buffer.from('@font-face{font-family:Icons;src:url(icons.woff2)}.primary{mask:url(#mask);background:image-set("small.jpg" 1x,"large.jpg" 2x)}')};
    return {url,type:'text/html',body:Buffer.from(html)};
  });
  const dom = new JSDOM(doc.originalHtml); const d = dom.window.document;
  assert.equal(d.querySelector('button').className,'primary');
  assert.equal(d.querySelector('button').dataset.state,'ready');
  assert.ok(d.querySelector('button svg path'));
  assert.ok(d.querySelector('form input'));
  assert.equal(d.querySelector('form').action,'https://cdn.example.com/subscribe');
  assert.equal(d.querySelector('script[src]').src,'https://cdn.example.com/resources/widget.js');
  assert.equal(d.querySelector('video source').src,'https://cdn.example.com/resources/movie.mp4');
  assert.equal(d.querySelector('audio').src,'https://cdn.example.com/resources/clip.mp3');
  assert.match(d.querySelector('img').src,/^data:image/);
  assert.ok(!d.querySelector('meta[http-equiv]'));
  const links = [...d.querySelectorAll('link[rel=stylesheet]')];
  assert.equal(links[0].hasAttribute('integrity'),false);
  const css = Buffer.from(links[0].href.split(',')[1], 'base64').toString();
  assert.ok(css.includes('https://cdn.example.com/resources/icons.woff2'));
  assert.ok(css.includes('https://cdn.example.com/resources/small.jpg'));
  assert.ok(css.includes('url("#mask")'));
  assert.equal(links[1].href,'https://cdn.example.com/resources/missing.css');
  assert.equal(doc.assets.saved,1); assert.equal(doc.assets.missing,1);
  assert.equal(visited.length,3); // HTML + stylesheets; other assets remain live.
  dom.window.close();
});


test('identical captures refresh latest timestamp without duplicating or rewriting older versions', async () => {
  const store = createStore(':memory:');
  try {
    const a = {...await capture('https://example.com/versioned', fakeFetch),capturedAt:'2026-01-01T00:00:00Z'};
    const first = store.save(a);
    const identical = store.save({...a,capturedAt:'2026-01-02T00:00:00Z',assets:{...a.assets,bytes:123}});
    assert.equal(identical.id,first.id); assert.equal(identical.unchanged,true);
    assert.equal(store.list(a.url).length,1);
    assert.equal(store.get(first.id).capturedAt,'2026-01-02T00:00:00Z');
    const b = {...a,originalHtml:a.originalHtml.replace('color', 'background-color'),capturedAt:'2026-01-03T00:00:00Z'};
    // A script/markup-only change still creates a version even when reader text is identical.
    b.originalHtml += '<script src="https://example.com/new.js"></script>';
    const changed = store.save(b);
    assert.notEqual(changed.id,first.id); assert.equal(changed.unchanged,false);
    assert.equal(store.get(first.id).originalHtml,a.originalHtml);
    const reverted = store.save({...a,capturedAt:'2026-01-04T00:00:00Z'});
    assert.notEqual(reverted.id,first.id); assert.notEqual(reverted.id,changed.id);
    assert.equal(store.list(a.url).length,3);
    assert.equal(store.list(a.url)[0].id,reverted.id);
  } finally {store.close();}
});

test('Cloudflare request noise and CSP nonces do not create versions; real site changes do', async () => {
  const store = createStore(':memory:');
  try {
    const doc = await capture('https://example.com/request-noise', fakeFetch);
    const html = (ray, nonce) => doc.originalHtml + `<style nonce="${nonce}">button{color:red}</style><script nonce="${nonce}">window.appVersion=1</script><script>(function(){window.__CF$cv$params={r:'${ray}',t:'${ray}'};var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';})();</script>`;
    const first = store.save({...doc,originalHtml:html('ray1','nonce1'),capturedAt:'2026-01-01T00:00:00Z'});
    const second = store.save({...doc,originalHtml:html('ray2','nonce2'),capturedAt:'2026-01-02T00:00:00Z'});
    assert.equal(second.id,first.id); assert.equal(second.unchanged,true);
    assert.ok(store.get(first.id).originalHtml.includes('ray2')); // Keep fresh replay code.
    const changedStyle = store.save({...doc,originalHtml:html('ray3','nonce3').replace('color:red','color:blue'),capturedAt:'2026-01-03T00:00:00Z'});
    assert.notEqual(changedStyle.id,second.id);
    const changedScript = store.save({...doc,originalHtml:changedStyle.originalHtml.replace('appVersion=1','appVersion=2'),capturedAt:'2026-01-04T00:00:00Z'});
    assert.notEqual(changedScript.id,changedStyle.id);
    assert.equal(store.list(doc.url).length,3);
  } finally {store.close();}
});
