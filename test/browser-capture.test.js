import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createBrowserProxy, publicAddress } from '../server/browser-proxy.js';
import { createPageFetcher, isChallenge } from '../server/browser-capture.js';
import { createVerifications, VerificationRequired } from '../server/browser-verification.js';
import { createApp } from '../server/index.js';
import { createStore } from '../server/store.js';

const publicDNS = async () => [{address:'1.1.1.1', family:4}];
const request = (proxy, target, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(proxy, {method, path:target}, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
  req.on('error', reject); req.end();
});

test('browser fallback retries blocks but respects ordinary rate limits and network failures', async () => {
  let calls = 0;
  const browser = async () => { calls++; return {body:Buffer.from('rendered')}; };
  for (const [status, challenged, expected] of [[403,false,true],[429,true,true],[503,true,true],[429,false,false],[503,false,false],[404,false,false],[undefined,false,false]]) {
    const error = Object.assign(new Error('fetch failed'), {httpStatus:status,challenged});
    const fetch = createPageFetcher({fetcher:async () => { throw error; }, browser});
    const before = calls;
    if (expected) assert.equal((await fetch('https://example.com')).body.toString(), 'rendered');
    else await assert.rejects(fetch('https://example.com'), e => e === error);
    assert.equal(calls - before, expected ? 1 : 0);
  }
  browser.has = () => true;
  await createPageFetcher({fetcher:() => { throw new Error('must reuse pending session'); }, browser})('https://example.com');
});

test('challenge detection does not mistake ordinary articles mentioning CAPTCHA for challenges', () => {
  assert.equal(isChallenge({status:200,title:'Understanding CAPTCHA',text:'Verify you are human'}), false);
  assert.equal(isChallenge({status:403,headers:{'cf-mitigated':'challenge'}}), true);
  assert.equal(isChallenge({status:200,title:'Just a moment...'}), true);
});

test('proxy rejects private, mixed DNS, invalid authorities, and nonstandard ports before connecting', async t => {
  let connected = 0;
  const proxy = await createBrowserProxy({resolveHost: async host => [{address:host === 'mixed.example' ? '1.1.1.1' : '127.0.0.1',family:4}, {address:'10.0.0.1',family:4}], connect:() => { connected++; throw new Error('must not connect'); }});
  t.after(() => proxy.close());
  for (const target of ['http://localhost/','http://mixed.example/','http://169.254.169.254/','http://user:pass@example.com/','http://example.com:8080/','file:///etc/passwd']) assert.equal(await request(proxy.url, target), 403);
  for (const target of ['localhost:443','mixed.example:443','example.com:22','example.com:443/path','user:pass@example.com:443']) assert.equal(await request(proxy.url,target,'CONNECT'), 403);
  assert.equal(connected, 0);
  await assert.rejects(publicAddress('example.com', async () => []), /private/);
});

test('HTTP proxy uses the already-validated socket and preserves original Host', async t => {
  const origin = http.createServer((req,res) => res.end(req.headers.host));
  await new Promise(resolve => origin.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => origin.close(resolve)));
  const dials = [];
  const proxy = await createBrowserProxy({resolveHost:publicDNS,connect:options => {
    dials.push(options);
    // Test seam: actual network is local, while verifying the production dial target.
    return net.connect({host:'127.0.0.1',port:origin.address().port});
  }});
  t.after(() => proxy.close());
  const body = await new Promise((resolve,reject) => {
    http.get(proxy.url, {path:'http://not-a-real-dns-name.invalid/story',headers:{host:'wrong.example'}}, res => {
      let data = ''; res.on('data', b => data += b); res.on('end', () => resolve(data));
    }).on('error',reject);
  });
  assert.equal(body,'not-a-real-dns-name.invalid');
  assert.deepEqual(dials,[{host:'1.1.1.1',family:4,port:80}]);
});

test('verification viewing and control require admin, reject cross-origin actions, and validate inputs', async t => {
  const manager = createVerifications();
  const clicks = [];
  const entry = manager.create('https://example.com/?token=private', {screenshot:async () => Buffer.from('image'), mouse:{click:async (...point) => clicks.push(point)}, close:async () => {}});
  const store = createStore(':memory:');
  const server = createApp({store,adminPassword:'test-password',verificationManager:manager,capturePage:async () => { throw new VerificationRequired(entry.id); }}).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/api/admin/verifications/${entry.id}`;
  for (const path of ['', '/image']) assert.equal((await fetch(base+path)).status,401);
  for (const path of ['/input','/cancel']) assert.equal((await fetch(base+path,{method:'POST'})).status,401);
  const login = await fetch(origin+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-password'})});
  const headers = {'Content-Type':'application/json',cookie:login.headers.get('set-cookie').split(';')[0]};
  const status = await fetch(base,{headers});
  assert.equal(status.status,200); assert.equal(status.headers.get('cache-control'),'no-store');
  assert.doesNotMatch(await status.text(), /private|screenshot|mouse/);
  assert.equal((await fetch(base+'/image',{headers})).status,200);
  const action = (body, extra = {}) => fetch(base+'/input',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await action({type:'click',x:10,y:20},{origin:'https://evil.example'})).status,403);
  assert.equal((await action({type:'click',x:-1,y:20})).status,400);
  assert.equal((await action({type:'key',key:'Control+L'})).status,400);
  assert.equal((await action({type:'click',x:10,y:20})).status,200);
  assert.deepEqual(clicks,[[10,20]]);
  const capture = await fetch(origin+'/api/capture',{method:'POST',headers,body:'{"url":"https://example.com/"}'});
  assert.equal(capture.status,409); assert.equal((await capture.json()).verificationId,entry.id);
  manager.finish(entry,'ready');
  assert.equal((await fetch(base+'/image',{headers})).status,409);
});

test('manual verification retains the same browser, saves state, resumes once, and cleans up', async t => {
  const {mkdtemp, rm, readdir} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {createBrowserCapture} = await import('../server/browser-capture.js');
  const directory = await mkdtemp(join(tmpdir(),'voicesite-browser-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const manager = createVerifications();
  let solved = false, responseHandler, closes = 0, launches = 0;
  const frame = {};
  const emitResponse = () => responseHandler({request:() => ({isNavigationRequest:() => true}),frame:() => frame,status:() => solved ? 200 : 403,headers:() => solved ? {} : {'cf-mitigated':'challenge'}});
  const page = {
    on:(_event,handler) => { responseHandler = handler; }, mainFrame:() => frame,
    goto:async () => emitResponse(), evaluate:async () => ({title:solved ? 'Article' : 'Just a moment',text:solved ? 'Saved article text.' : 'Verify you are human'}),
    isClosed:() => false, url:() => 'https://example.com/article', content:async () => '<h1>Saved article text.</h1>',
    mouse:{click:async () => { solved = true; emitResponse(); }},
  };
  const context = {route:async () => {},newPage:async () => page,on:() => {},close:async () => { closes++; },storageState:async () => ({cookies:[],origins:[]})};
  const browser = createBrowserCapture({directory,verificationManager:manager,resolveAddress:async () => {},challengeWaitMs:0,pollMs:5,
    createDisplay:async () => ({display:':test',close:() => { closes++; }}),createProxy:async () => ({url:'http://127.0.0.1:1234',bytes:100,close:async () => { closes++; }}),
    launch:async options => { assert.equal(options.chromiumSandbox,true); launches++; return {newContext:async () => context,close:async () => { closes++; }}; },
  });
  let verificationId;
  await assert.rejects(browser('https://example.com/article'), error => { verificationId = error.verificationId; return !!verificationId; });
  await assert.rejects(browser('https://another.example/'), /already in progress/);
  await assert.rejects(browser('https://example.com/article'), error => error.verificationId === verificationId);
  const entry = manager.get(verificationId);
  await entry.page.mouse.click(1,1);
  for (let i = 0; i < 100 && entry.status === 'waiting'; i++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(entry.status,'ready');
  const response = await browser('https://example.com/article');
  assert.equal(response.body.toString(),'<h1>Saved article text.</h1>');
  assert.equal(browser.has('https://example.com/article'),false);
  assert.equal(launches,1); assert.equal(closes,4);
  assert.equal((await readdir(directory)).filter(n => n.endsWith('.json')).length,1);
});
