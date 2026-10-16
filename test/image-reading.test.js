import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createImageReading } from '../server/image-reading.js';
import { readingSurface } from '../web/reading.js';

test('image analysis is deduplicated, persists, and retries failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'image-reading-'));
  let fetched = 0, analyzed = 0;
  const options = {directory, fetchImage:async () => { fetched++; return {body:Buffer.from('image'),type:'image/png'}; }, analyze:async () => { analyzed++; return {kind:'ocr',text:'Read this screenshot.'}; }};
  try {
    const reader = createImageReading(options);
    const results = await Promise.all([reader.read('page','https://example.com/a.png'),reader.read('page','https://example.com/a.png')]);
    assert.deepEqual(results[0], {kind:'ocr',text:'Read this screenshot.'});
    assert.equal(analyzed, 1);
    assert.deepEqual(await createImageReading(options).read('page','https://example.com/a.png'), results[0]);
    assert.equal(fetched, 1);
    let attempts = 0;
    const flaky = createImageReading({...options, analyze:async () => { if (!attempts++) throw new Error('offline'); return {kind:'caption',text:'A tree.'}; }});
    await assert.rejects(flaky.read('page','https://example.com/b.png'), /offline/);
    assert.equal((await flaky.read('page','https://example.com/b.png')).text, 'A tree.');
    await assert.rejects(reader.read('page','data:image/svg+xml;base64,AAAA'), /Unsupported/);
    await assert.rejects(createImageReading({...options,fetchImage:async()=>({type:'text/html',body:Buffer.from('x')})}).read('page','https://example.com/html'), /Unsupported/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('generated image readings preserve order, prefer alt text, and highlight images', () => {
  const dom = new JSDOM('<article><p>Before.</p><img src="alt.png" alt="Author description."><img src="text.png" alt=""><img src="photo.png"><img src="hidden.png" aria-hidden="true"><img src="decorative.png" role="presentation"><p>After.</p></article>');
  const original = new Map();
  for (const key of ['document','NodeFilter','getComputedStyle','CSS']) {
    original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,value:key==='CSS'?{highlights:new Map()}:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
  }
  dom.window.Element.prototype.getClientRects = () => [{}];
  try {
    let words;
    const surface = readingSurface(document.querySelector('article'), value => words=value, ()=>{});
    assert.deepEqual(surface.images(), ['text.png','photo.png']);
    surface.build({'alt.png':'Wrong text','text.png':'Text in image: Hello world.','photo.png':'Image: A green tree.'});
    assert.equal(words.map(w=>w.text).join(' '), 'Before. Author description. Text in image: Hello world. Image: A green tree. After.');
    surface.highlight(words.findIndex(w=>w.text==='Hello'),'word');
    assert.ok(document.querySelector('[src="text.png"]').classList.contains('voicesite-image-reading'));
    surface.destroy();
  } finally {
    for (const [key, descriptor] of original) { if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]; }
    dom.window.close();
  }
});

test('image API requires a saved snapshot, blocks cross-origin calls, and returns analysis', async () => {
  const {createApp} = await import('../server/index.js');
  const {createStore} = await import('../server/store.js');
  const store=createStore(':memory:');
  const doc=store.save({url:'https://example.com/',capturedAt:new Date().toISOString(),originalHtml:'<p>Page</p>',readerHtml:'<p>Page</p>'});
  const calls=[];
  const server=createApp({store,imageReading:{read:async (...args)=>{calls.push(args);return {kind:'caption',text:'A tree.'};}}}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://example.com/tree.png'})};
  try {
    assert.equal((await fetch(`${url}/api/snapshots/missing/image-reading`,options)).status,404);
    assert.equal((await fetch(`${url}/api/snapshots/${doc.id}/image-reading`,{...options,headers:{...options.headers,origin:'https://elsewhere.example'}})).status,403);
    assert.deepEqual(await (await fetch(`${url}/api/snapshots/${doc.id}/image-reading`,options)).json(),{kind:'caption',text:'A tree.'});
    assert.deepEqual(calls,[[doc.id,'https://example.com/tree.png']]);
    const original=await (await fetch(`${url}/snapshots/${doc.id}/original`)).text();
    assert.match(original,/surface.images\(\)/);
    assert.match(original,/surface.build\(event.data.imageText\)/);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
});
