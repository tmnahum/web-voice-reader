import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicFetcher, publicIP } from '../server/fetch.js';
import { capture } from '../server/capture.js';

function transport({resolveHost, respond}) {
  const calls = [], dispatchers = [];
  class Dispatcher {
    constructor(options) { this.options = options; dispatchers.push(this); }
    async destroy() { this.destroyed = true; }
  }
  const fetcher = createPublicFetcher({Dispatcher, resolveHost: resolveHost || (async () => [{address:'1.1.1.1',family:4}]), request: async (url, options) => { calls.push({url, options}); return respond(url, options); }});
  return {fetcher, calls, dispatchers};
}

test('redirects do not forward cookies, authorization, or browser headers and pin DNS', async () => {
  let resolutions = 0;
  const t = transport({resolveHost: async () => { resolutions++; return [{address:'1.1.1.1',family:4}]; }, respond: url => url.endsWith('/start') ? new Response('', {status:302,headers:{location:'/end','set-cookie':'secret=server-session'}}) : new Response('article', {headers:{'content-type':'text/html'}})});
  assert.equal((await t.fetcher('https://example.com/start')).body.toString(), 'article');
  assert.equal(resolutions, 2);
  for (const {options} of t.calls) {
    assert.deepEqual(Object.keys(options.headers).sort(), ['accept','user-agent']);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    const pinned = await new Promise((resolve, reject) => options.dispatcher.options.connect.lookup('example.com', {all:true}, (error, result) => error ? reject(error) : resolve(result)));
    assert.deepEqual(pinned, [{address:'1.1.1.1',family:4}]);
  }
  assert.ok(t.dispatchers.every(d => d.destroyed));
});

test('private, mixed DNS, and rebound redirect destinations are rejected before connecting', async () => {
  for (const addresses of [[{address:'127.0.0.1',family:4}], [{address:'1.1.1.1',family:4},{address:'10.0.0.1',family:4}]]) {
    const t = transport({resolveHost: async () => addresses, respond: () => { throw new Error('must not connect'); }});
    await assert.rejects(t.fetcher('https://example.com'), /private/); assert.equal(t.calls.length, 0);
  }
  let lookups = 0;
  const t = transport({resolveHost: async () => [{address:++lookups === 1 ? '1.1.1.1' : '169.254.169.254',family:4}], respond: () => new Response('',{status:302,headers:{location:'/metadata'}})});
  await assert.rejects(t.fetcher('https://example.com'), /private/); assert.equal(t.calls.length, 1);
  for (const ip of ['::ffff:127.0.0.1','64:ff9b::7f00:1','2002:7f00:1::','2001::1','198.18.0.1','invalid']) assert.equal(publicIP(ip), false, ip);
});

test('unsafe redirects, redirect loops, and oversized responses fail with transport cleanup', async () => {
  for (const location of ['file:///etc/passwd','http://user:secret@example.com','https://example.com:8443']) {
    const t = transport({respond: () => new Response('',{status:302,headers:{location}})});
    await assert.rejects(t.fetcher('https://example.com')); assert.equal(t.calls.length, 1); assert.ok(t.dispatchers[0].destroyed);
  }
  const loop = transport({respond: () => new Response('',{status:302,headers:{location:'/loop'}})});
  await assert.rejects(loop.fetcher('https://example.com'), /too many/); assert.equal(loop.calls.length, 6);
  for (const headers of [{}, {'content-length':'100'}]) {
    const t = transport({respond: () => new Response('too large', {headers})});
    await assert.rejects(t.fetcher('https://example.com', 4), /size limit/); assert.ok(t.dispatchers[0].destroyed);
  }
});

test('capture never executes scripts or fetches embedded browser resources on the server', async () => {
  const calls = [];
  const doc = await capture('https://example.com', async url => {
    calls.push(url);
    return {url, type:'text/html',body:Buffer.from(`<title>Untrusted</title><script>throw new Error('source script executed')</script><script src="http://127.0.0.1/admin"></script><iframe src="http://169.254.169.254/"></iframe><img src="file:///etc/passwd"><p>Saved text</p>`) };
  });
  assert.deepEqual(calls, ['https://example.com']);
  assert.match(doc.originalHtml, /source script executed/);
  assert.ok(!doc.readerHtml.includes('<script'));
});
