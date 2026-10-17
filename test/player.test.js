import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPlayer } from '../web/player.js';

async function setup(t) {
  const dom = new JSDOM(`<iframe id="original"></iframe>${['play', 'follow-narration', 'generate-speech', 'toast', 'read-time', 'voice', 'speed-presets', 'speed', 'slower', 'faster'].map(id => `<button id="${id}"></button>`).join('')}`);
  const clips = [];
  class Audio {
    paused = true;
    ended = false;
    currentTime = 0;
    duration = 1;
    constructor() { clips.push(this); }
    set src(value) { this.source = value; queueMicrotask(() => this.onloadedmetadata?.()); }
    get src() { return this.source; }
    async play() { this.paused = false; this.onplay?.(); }
    pause() {
      if (this.paused) return;
      this.paused = true;
      // Real media events are queued, including events from retired elements.
      queueMicrotask(() => this.onpause?.());
    }
    finish() { this.ended = true; this.pause(); queueMicrotask(() => this.onended?.()); }
  }
  const rendition = {id:'test', status:'complete', chunks:[{start:0, ready:true}, {start:1, ready:true}]};
  const globals = {
    window:dom.window, document:dom.window.document, Audio,
    requestAnimationFrame:() => 1, cancelAnimationFrame:() => {},
    setTimeout:() => 1, clearTimeout:() => {},
    fetch:async url => ({ok:true, json:async () => url.includes('/chunks/')
      ? {audio:'', duration:1, words:[{index:0, start:0, end:1}]}
      : structuredClone(rendition)}),
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable:true, writable:true, value});
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  t.after(() => dom.window.close());
  const player = createPlayer();
  player.setSnapshot('page');
  const original = dom.window.document.getElementById('original');
  original.dispatchEvent(new dom.window.Event('load'));
  const message = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source:original.contentWindow, data:{voicesite:true, token:2, ...data},
  }));
  message({type:'images', urls:[]});
  await flush();
  message({type:'words', words:[{text:'Hello', sentence:0}, {text:'world', sentence:0}]});
  await flush();
  const button = dom.window.document.getElementById('play');
  await button.onclick();
  await flush();
  assert.equal(clips.length, 1);
  assert.equal(button.getAttribute('aria-label'), 'Pause reading');
  return {player, clips, button, message, follow:dom.window.document.getElementById('follow-narration')};
}

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function assertPaused(button) {
  assert.equal(button.textContent, '▶');
  assert.equal(button.getAttribute('aria-label'), 'Read aloud');
}

test('external pause and resume synchronize the button and its next action', async t => {
  const {clips, button} = await setup(t);
  clips[0].pause();
  await flush();
  assertPaused(button);
  await button.onclick();
  assert.equal(clips[0].paused, false);
  assert.equal(button.getAttribute('aria-label'), 'Pause reading');
  clips[0].pause();
  await flush();
  await clips[0].play();
  assert.equal(button.getAttribute('aria-label'), 'Pause reading');
  await button.onclick();
  assert.equal(clips[0].paused, true);
  assertPaused(button);
});

test('ending a chunk continues playback and ignores events from the old clip', async t => {
  const {clips, button} = await setup(t);
  clips[0].finish();
  await flush();
  assert.equal(clips.length, 2);
  assert.equal(clips[1].paused, false);
  clips[1].pause();
  await flush();
  clips[0].ended = false;
  await clips[0].play();
  assertPaused(button);
});

test('reset ignores queued playback events from the previous session', async t => {
  const {player, clips, button} = await setup(t);
  player.reset();
  await flush();
  await clips[0].play();
  assertPaused(button);
});


test('follow button reflects manual scrolling and resumes following in archived pages', async t => {
  const {player, message, follow} = await setup(t);
  assert.equal(follow.hidden, true);
  message({type:'follow', enabled:false});
  assert.equal(follow.hidden, false);
  follow.onclick();
  assert.equal(follow.hidden, true);
  message({type:'follow', enabled:false});
  player.reset();
  assert.equal(follow.hidden, true);
});
