import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readingSurface } from '../web/reading.js';

test('reading follows words near viewport edges without repeatedly scrolling or moving centered words', () => {
  const dom = new JSDOM('<article><p>One two three four five.</p></article>');
  const view = dom.window, original = new Map(), calls = [];
  for (const key of ['document','NodeFilter','getComputedStyle','CSS']) {
    original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,value:key==='CSS'?{highlights:new Map()}:key==='getComputedStyle'?view.getComputedStyle.bind(view):view[key]});
  }
  let now=1000, top=300;
  Object.defineProperty(view,'innerHeight',{value:800});
  view.performance.now = () => now;
  view.matchMedia = () => ({matches:true});
  view.scrollBy = options => calls.push(options);
  view.Element.prototype.getClientRects = () => [{}];
  view.Range.prototype.getBoundingClientRect = () => ({top,bottom:top+22,width:50,height:22});
  try {
    const changes = [];
    const surface = readingSurface(document.querySelector('article'),()=>{},()=>{}, value => changes.push(value));
    surface.build();
    surface.highlight(0,'word');
    assert.equal(calls.length,0);
    top=710;surface.highlight(1,'word');
    assert.deepEqual(calls,[{top:390,behavior:'instant'}]);
    now+=100;surface.highlight(2,'word');
    assert.equal(calls.length,1); // Smooth scroll isn't restarted every word.
    now+=900;top=20;surface.highlight(3,'word');
    assert.equal(calls[1].top,-300);
    now+=900;surface.highlight(4,'none');
    assert.equal(calls.length,2);
    // Programmatic scrolling must keep following enabled.
    view.dispatchEvent(new view.Event('scroll'));
    surface.highlight(0,'word');
    assert.equal(calls.length,3);
    for (const event of [
      new view.WheelEvent('wheel', {deltaY:100}),
      new view.Event('touchmove'),
      new view.KeyboardEvent('keydown', {key:'PageDown'}),
    ]) {
      view.dispatchEvent(event);
      now += 1000;
      const before = calls.length;
      surface.highlight(1,'word');
      surface.highlight(2,'word');
      assert.equal(calls.length,before);
      assert.equal(changes.at(-1),false);
      // Resume scrolls even when the current word has not changed.
      surface.setFollowing(true);
      assert.equal(calls.length,before+1);
      assert.equal(changes.at(-1),true);
    }
    // Dragging a scrollbar suspends following, including nested scroll panels.
    document.querySelector('p').dispatchEvent(new view.Event('pointerdown', {bubbles:true}));
    document.querySelector('p').dispatchEvent(new view.Event('scroll'));
    view.dispatchEvent(new view.Event('pointerup'));
    const before = calls.length;
    now += 1000;
    surface.highlight(3,'word');
    assert.equal(calls.length,before);
    surface.setFollowing(true);
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new view.KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));
    assert.equal(changes.at(-1),true);
    surface.destroy();
    view.dispatchEvent(new view.WheelEvent('wheel', {deltaY:100}));
    assert.equal(changes.at(-1),true); // Destroy removes input listeners.
  } finally {
    for(const [key,descriptor] of original) { if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]; }
    dom.window.close();
  }
});
