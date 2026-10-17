import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createApp } from '../server/index.js';

test('appearance controls survive audio setup failure and remember the theme', () => {
  const dom = new JSDOM(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), {url:'http://localhost/', runScripts:'outside-only'});
  try {
    dom.window.localStorage.setItem('voicesite.darkMode', 'true');
    const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
    dom.window.createPlayer = () => { throw new Error('Audio unavailable'); };
    assert.throws(() => dom.window.eval(script), /Audio unavailable/);
    const button = dom.window.document.getElementById('dark-mode');
    assert.equal(button.previousElementSibling.id, 'reader-mode');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    button.click();
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(dom.window.document.body.classList.contains('dark-mode'), false);
    assert.equal(dom.window.localStorage.getItem('voicesite.darkMode'), 'false');
    button.click();
    const messages = [];
    const frame = dom.window.document.getElementById('original');
    frame.contentWindow.postMessage = data => messages.push(data);
    frame.dispatchEvent(new dom.window.Event('load'));
    assert.equal(messages.at(-1).dark, true);
  } finally { dom.window.close(); }
});

test('original HTML theme remains reversible when speech initialization fails', async t => {
  const originalHtml = '<html><head></head><body><p>Saved page</p><img src="data:," style="filter:none"></body></html>';
  const app = createApp({store:{get:() => ({originalHtml})}, speech:{}, imageReading:{}});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const html = await (await fetch(`http://127.0.0.1:${server.address().port}/snapshots/test/original`)).text();
  const dom = new JSDOM(html, {runScripts:'outside-only'});
  try {
    const bridge = dom.window.document.querySelector('script').textContent;
    dom.window.document.body.addEventListener = () => { throw new Error('Speech unavailable'); };
    assert.throws(() => dom.window.eval(bridge), /Speech unavailable/);
    const send = (dark, source = dom.window.parent) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {source, data:{voicesite:true, type:'theme', dark}}));
    const theme = () => [...dom.window.document.head.querySelectorAll('style')].find(style => style.textContent.includes('color-scheme: dark'));
    send(true, null);
    assert.equal(theme(), undefined);
    send(true);
    const style = theme();
    assert.match(style.textContent, /color-scheme: dark/);
    assert.equal(dom.window.document.querySelector('img').style.filter, 'none');
    send(false);
    assert.equal(style.isConnected, false);
    send(true);
    assert.equal(style.isConnected, true);
  } finally { dom.window.close(); }
});
