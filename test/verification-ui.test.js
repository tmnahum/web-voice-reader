import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

test('verification dialog gates browser view on admin login, relays scaled pointer presses/releases, and resolves after clearance', async () => {
  const dom = new JSDOM('<title>Voicesite</title><body></body>',{url:'https://voicesite.example/',runScripts:'outside-only'});
  const {window} = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  let authenticated = false, verified = false;
  const actions = [];
  window.fetch = async (path, options) => {
    const body = options?.body && JSON.parse(options.body);
    if (path === '/api/admin/login') {
      assert.equal(body.password,'test-only'); authenticated = true;
      return {ok:true};
    }
    if (!authenticated) return {ok:false,status:401,json:async () => ({error:'Sign in'})};
    if (path.endsWith('/input')) { actions.push(body); return {ok:true}; }
    if (path.endsWith('/capture')) { verified = true; return {ok:true}; }
    if (path.endsWith('/image')) return {ok:true,blob:async () => ({})};
    return {ok:true,json:async () => ({status:verified ? 'ready' : 'waiting',url:'https://example.com/'})};
  };
  window.eval(readFileSync(new URL('../web/verification.js',import.meta.url),'utf8').replace('export function','function'));
  try {
    const result = window.verifyCapture('test-id');
    await new Promise(resolve => setTimeout(resolve,10));
    const dialog = window.document.querySelector('dialog');
    assert.ok(dialog.open);
    assert.equal(dialog.querySelector('[data-login]').hidden,false);
    assert.equal(dialog.querySelector('[data-browser]').hidden,true);
    const form = dialog.querySelector('[data-login]');
    form.querySelector('input').value = 'test-only';
    form.dispatchEvent(new window.Event('submit',{cancelable:true}));
    await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(form.querySelector('input').value,'');
    assert.equal(dialog.querySelector('[data-browser]').hidden,false);
    const image = dialog.querySelector('[data-image]');
    image.getBoundingClientRect = () => ({left:0,top:0,width:640,height:450});
    image.setPointerCapture = () => {};
    image.onpointerdown({button:0,clientX:100,clientY:50,pointerId:1,preventDefault() {}});
    image.onpointerup({clientX:100,clientY:50,pointerId:1});
    await new Promise(resolve => setTimeout(resolve,20));
    assert.equal(verified,false);
    await dialog.querySelector('[data-capture]').onclick();
    await result;
    assert.deepEqual(actions,[{type:'down',x:200,y:100},{type:'up',x:200,y:100}]);
    assert.equal(window.document.querySelector('dialog'),null);
    assert.equal(window.document.title,'Voicesite');
  } finally { window.close(); }
});
