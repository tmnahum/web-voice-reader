import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readlink,unlink} from 'node:fs/promises';
import {hostname} from 'node:os';
import {chromium} from 'playwright-core';
import {normalizeUrl} from './fetch.js';
import net from 'node:net';

const exec = promisify(execFile);
const keys = {Tab:'Tab', Enter:'Return', Space:'space', Backspace:'BackSpace', Escape:'Escape', ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right'};

// Actual admin input only: no generated gestures, challenge solving, or browser API spoofing.
export function desktopInput(display, run = exec) {
  const send = args => run('xdotool', args, {env:{PATH:process.env.PATH, DISPLAY:display}, timeout:3000, maxBuffer:4096});
  const point = (x, y) => ['mousemove', String(Math.round(x)), String(Math.round(y))];
  return async action => {
    const {type, x, y, key, text, deltaY} = action;
    if (type === 'move') return send(point(x,y));
    if (type === 'down') return send([...point(x,y), 'mousedown', '1']);
    if (type === 'up') return send([...point(x,y), 'mouseup', '1']);
    if (type === 'click') return send([...point(x,y), 'click', '1']);
    if (type === 'key') return send(['key', keys[key]]);
    if (type === 'text') return send(['type', '--clearmodifiers', '--delay', '0', '--', text]);
    if (type === 'scroll' && deltaY) return send(['click', '--repeat', String(Math.min(8, Math.ceil(Math.abs(deltaY)/120))), '--delay', '0', deltaY < 0 ? '4' : '5']);
  };
}

// Profiles belong exclusively to this service; candidate containers use disposable data.
// A retired container's hostname/PID lock cannot identify a live browser here.
export async function clearStaleProfileLock(profile) {
  let lock;
  try {lock = await readlink(`${profile}/SingletonLock`);}
  catch (error) {if (error.code === 'ENOENT') return; throw error;}
  const match = lock.match(/^(.*)-(\d+)$/);
  if (!match) throw new Error('Unrecognized browser profile lock.');
  if (match[1] === hostname()) {
    try {process.kill(Number(match[2]),0); throw new Error('Browser profile is already in use.');}
    catch (error) {if (error.code !== 'ESRCH') throw error;}
  }
  for (const name of ['SingletonLock','SingletonCookie','SingletonSocket']) {
    await unlink(`${profile}/${name}`).catch(error => {if (error.code !== 'ENOENT') throw error;});
  }
}

export async function launchDesktop({profile, display, proxy, executablePath = process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome'}) {
  await mkdir(profile, {recursive:true, mode:0o700});
  await clearStaleProfileLock(profile);
  // Only desktop necessities enter the browser's environment, never app credentials.
  const env = Object.fromEntries(['PATH','HOME','LANG','LC_ALL','XDG_RUNTIME_DIR'].filter(k => process.env[k]).map(k => [k,process.env[k]]));
  env.DISPLAY = display;
  const listener = net.createServer();
  await new Promise((resolve,reject) => {listener.once('error',reject); listener.listen(0,'127.0.0.1',resolve);});
  const debugPort = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(executablePath, [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--kiosk', '--window-position=0,0', '--window-size=1280,900',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`,
    `--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>',
    '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], {env, stdio:['ignore','ignore','pipe']});
  let browser;
  let exited = false;
  const exit = new Promise(resolve => { child.once('exit', () => {exited = true; resolve();}); child.once('error', () => {exited = true; resolve();}); });
  const close = async () => {
    let timer;
    try {
      if (browser) await Promise.race([(async () => {
        // Closing a CDP connection alone does not guarantee browser shutdown.
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send('Browser.close').catch(() => {});
        await exit;
      })().catch(() => {}), new Promise(resolve => {timer = setTimeout(resolve,3000);})]);
    } finally {clearTimeout(timer);}
    if (!exited) child.kill('SIGTERM');
    timer = setTimeout(() => {if (!exited) child.kill('SIGKILL');}, 3000);
    await exit; clearTimeout(timer);
    await browser?.close().catch(() => {});
  };
  try {
    const endpoint = await new Promise((resolve,reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Desktop browser startup timed out.')), 10000);
      const fail = () => {clearTimeout(timer); reject(new Error('Desktop browser exited during startup.'));};
      child.once('error', fail); child.once('exit', fail);
      child.stderr.on('data', chunk => {
        buffer = (buffer + chunk).slice(-8192);
        const match = buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
        if (match) {clearTimeout(timer); resolve(match[1]);}
      });
    });
    browser = await chromium.connectOverCDP(endpoint, {noDefaults:true, timeout:10000});
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    // No emulated viewport: native input and screenshots share the kiosk's screen coordinates.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setDownloadBehavior', {behavior:'deny'});
    await cdp.send('Network.enable');
    await cdp.send('Network.setBypassServiceWorker', {bypass:true});
    await context.route('**/*', async route => {
      const request = route.request();
      try {normalizeUrl(request.url());}
      catch {return route.abort();}
      if (request.resourceType() === 'media') return route.abort();
      return route.continue();
    });
    context.on('page', popup => {if (popup !== page) void popup.close().catch(() => {});});
    page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    page.captureViewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight}));
    page.nativeInput = desktopInput(display);
    return {browser, context, page, close};
  } catch (error) {await close(); throw error;}
}

// One retained desktop, isolated by requested origin. Only a blank page remains while idle.
export function createDesktopPool({directory, createProxy, createDisplay, launch = launchDesktop, idleMs = 120000}) {
  let current, timer, closing = Promise.resolve();
  async function close() {
    clearTimeout(timer);
    const session = current;
    current = undefined;
    const previous = closing;
    closing = (async () => {
      await previous;
      if (!session) return;
      await session.close().catch(() => {});
      session.display.close();
      await session.proxy.close();
    })();
    return closing;
  }
  return {
    async acquire(origin, profileName) {
      clearTimeout(timer);
      await closing;
      if (current && (current.origin !== origin || current.page.isClosed())) await close();
      if (current) return current;
      const proxy = await createProxy();
      let display;
      try {
        display = await createDisplay();
        const session = await launch({profile:`${directory}/profiles/${profileName}`, proxy:proxy.url, display:display.display});
        current = {...session, origin, proxy, display};
        return current;
      } catch (error) {display?.close(); await proxy.close(); throw error;}
    },
    async release(session) {
      if (session !== current) return;
      if (session.page.isClosed()) return close();
      try {await session.page.goto('about:blank', {waitUntil:'domcontentloaded', timeout:3000});}
      catch {return close();}
      timer = setTimeout(() => {void close();}, idleMs);
      timer.unref();
    },
    close,
  };
}
