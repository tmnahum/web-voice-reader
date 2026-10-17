import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopPool, desktopInput} from '../server/desktop-browser.js';

test('desktop leases reuse same origin, clear the active page, and close before switching origins', async () => {
  const events = [];
  const pool = createDesktopPool({directory:'/isolated',idleMs:15,
    createProxy:async () => ({url:'http://proxy',close:async () => events.push('proxy closed')}),
    createDisplay:async () => ({display:':1',close:() => events.push('display closed')}),
    launch:async options => {
      events.push(options.profile);
      return {page:{isClosed:() => false,goto:async url => events.push(url)},close:async () => events.push('browser closed')};
    },
  });
  try {
    const first = await pool.acquire('https://one.example','one');
    await pool.release(first);
    assert.equal(await pool.acquire('https://one.example','one'),first);
    const second = await pool.acquire('https://two.example','two');
    assert.notEqual(second,first);
    assert.deepEqual(events.slice(0,6), ['/isolated/profiles/one','about:blank','browser closed','display closed','proxy closed','/isolated/profiles/two']);
    await pool.release(second);
    await new Promise(resolve => setTimeout(resolve,40));
    assert.equal(events.filter(e => e === 'browser closed').length,2);
  } finally {await pool.close();}
});

test('desktop startup failures close the proxy and display', async () => {
  const events = [];
  const pool = createDesktopPool({directory:'/isolated',createProxy:async () => ({close:async () => events.push('proxy')}),createDisplay:async () => ({close:() => events.push('display')}),launch:async () => {throw new Error('launch failed');}});
  await assert.rejects(pool.acquire('https://example.com','example'),/launch failed/);
  assert.deepEqual(events,['display','proxy']);
  await pool.close();
});

test('native controls use argv with no shell interpretation and forward actual press/release', async () => {
  const calls = [];
  const input = desktopInput(':9',async (file,args,options) => calls.push({file,args,options}));
  await input({type:'down',x:12.2,y:34.8});
  await input({type:'up',x:12.2,y:34.8});
  await input({type:'text',text:'$(not-a-command) --help'});
  assert.deepEqual(calls.map(c => c.args),[
    ['mousemove','12','35','mousedown','1'], ['mousemove','12','35','mouseup','1'],
    ['type','--clearmodifiers','--delay','0','--','$(not-a-command) --help'],
  ]);
  assert.ok(calls.every(c => c.file === 'xdotool' && c.options.env.DISPLAY === ':9' && !c.options.shell));
});

test('profile recovery removes retired-container locks but refuses a live local owner', async t => {
  const {mkdtemp,symlink,lstat,rm} = await import('node:fs/promises');
  const {tmpdir,hostname} = await import('node:os');
  const {join} = await import('node:path');
  const {clearStaleProfileLock} = await import('../server/desktop-browser.js');
  const profile = await mkdtemp(join(tmpdir(),'desktop-lock-'));
  t.after(() => rm(profile,{recursive:true,force:true}));
  await symlink('retired-container-123',join(profile,'SingletonLock'));
  await symlink('/old/container/socket',join(profile,'SingletonSocket'));
  await clearStaleProfileLock(profile);
  await assert.rejects(lstat(join(profile,'SingletonLock')), {code:'ENOENT'});
  await symlink(`${hostname()}-${process.pid}`,join(profile,'SingletonLock'));
  await assert.rejects(clearStaleProfileLock(profile),/already in use/);
  assert.ok((await lstat(join(profile,'SingletonLock'))).isSymbolicLink());
});
