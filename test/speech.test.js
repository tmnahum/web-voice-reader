import test from 'node:test';
import assert from 'node:assert/strict';
import { splitReading } from '../web/reading.js';
import { createSpeech } from '../server/speech.js';
import { createApp } from '../server/index.js';
import { createStore } from '../server/store.js';

test('long reading is bounded, preserves all words, and prefers sentence boundaries', () => {
  const words = Array.from({length: 900}, (_, i) => ({text: `word${i}`, sentence: Math.floor(i / 13)}));
  const chunks = splitReading(words, 7);
  assert.equal(chunks.map(c => c.text).join(' '), words.slice(7).map(w => w.text).join(' '));
  assert.ok(chunks.every(c => c.text.length <= 450));
  assert.ok(chunks.slice(1).every(c => c.start % 13 === 0));
  const longSentence = splitReading(words.map(w => ({...w, sentence: 0})));
  assert.ok(longSentence.every(c => c.text.length <= 450));
});

test('speech rejects uncurated voices and oversized requests before starting model', async () => {
  const speech = createSpeech();
  await assert.rejects(speech.generate({text:'Hello', voice:'../voice'}), /curated/);
  await assert.rejects(speech.generate({text:'a'.repeat(601), voice:'af_bella'}), /600/);
});

test('speech API returns audio/timings and rejects cross-origin requests', async () => {
  const store = createStore(':memory:');
  const result = {audio:'wav', words:[{index:0,start:0,end:1}], duration:1};
  const app = createApp({store, speech:{generate: async input => { assert.equal(input.voice, 'af_bella'); return result; }}});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/speech`;
  try {
    const options = {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({voice:'af_bella',text:'Hello'})};
    assert.deepEqual(await (await fetch(url, options)).json(), result);
    assert.equal((await fetch(url, {...options, headers:{...options.headers,origin:'https://elsewhere.example'}})).status, 403);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); }
});

test('reading surface includes image alt in order and skips controls and hidden content', async () => {
  const { JSDOM } = await import('jsdom');
  const { readingSurface } = await import('../web/reading.js');
  const dom = new JSDOM('<html><head></head><body><article><h1>Title</h1><p>Hello <em>world.</em></p><img alt="A green tree"><img><p hidden>Hidden</p><button>Ignore</button><p>Next sentence.</p><div class="article-end">End of saved page</div></article></body></html>');
  const original = new Map();
  for (const key of ['document','NodeFilter','getComputedStyle','CSS']) { original.set(key, Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,value:key === 'CSS' ? {highlights:new Map()} : key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key]}); }
  dom.window.Element.prototype.getClientRects = () => [{left:0,right:100,top:0,bottom:20}];
  try {
    let words;
    const surface = readingSurface(document.querySelector('article'), value => {words = value;}, () => {});
    surface.build();
    assert.deepEqual(words.map(w => w.text), ['Title','Hello','world.','A','green','tree','Next','sentence.']);
    assert.equal(words[1].sentence, words[2].sentence);
    surface.highlight(3, 'word');
    assert.ok(document.querySelector('img').classList.contains('voicesite-image-reading'));
    surface.highlight(3, 'none');
    assert.ok(!document.querySelector('img').classList.contains('voicesite-image-reading'));
    document.querySelector('article').innerHTML = '<p>Before <a href="/next">linked <em>words</em><img alt="linked image"></a> after <a>named anchor</a></p>';
    surface.build();
    assert.deepEqual(words.filter(w => w.link).map(w => w.text), ['linked','words','linked','image']);
    assert.ok(words.filter(w => !w.link).some(w => w.text === 'anchor'));
    surface.destroy();
  } finally { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; } dom.window.close(); }
});

test('latest playback chunks jump ahead of queued background and stale lookahead', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  const child = new EventEmitter(), started = [];
  child.stdout = new PassThrough();
  child.stdin = new Writable({write(data,encoding,callback) { started.push(JSON.parse(data)); callback(); }});
  child.kill = () => child.emit('exit',0);
  const speech = createSpeech({spawnWorker:()=>child});
  const input = text => ({voice:'af_bella',text});
  const finish = () => child.stdout.write(JSON.stringify({audio:'wav',words:[]})+'\n');
  const active = speech.generate(input('already running'));
  const background = speech.generate(input('earlier background'));
  const stale = speech.generate(input('old lookahead'),undefined,4);
  const target = speech.generate(input('bottom clicked'),undefined,11);
  const next = speech.generate(input('bottom next'),undefined,10);
  // Promoting an already queued clip must not create a second inference.
  speech.prioritize(input('earlier background'),12);
  try {
    assert.equal(started.length,1);
    finish(); await active;
    assert.equal(started[1].text,'earlier background');
    finish(); await background;
    assert.equal(started[2].text,'bottom clicked');
    finish(); await target;
    assert.equal(started[3].text,'bottom next');
    finish(); await next;
    assert.equal(started[4].text,'old lookahead');
    finish(); await stale;
    assert.equal(started.length,5);
  } finally { speech.close(); }
});
