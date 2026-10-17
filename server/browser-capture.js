import { verifications, VerificationRequired } from './browser-verification.js';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserProxy, publicAddress } from './browser-proxy.js';
import { fetchPublic, normalizeUrl } from './fetch.js';
import { logEvent, logUrl } from './diagnostics.js';

async function virtualDisplay() {
  const process = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], {stdio:['ignore', 'ignore', 'ignore', 'pipe']});
  try {
    const display = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => { reject(new Error('Browser display startup timed out.')); }, 8000);
      const fail = () => { clearTimeout(timer); reject(new Error('Could not start browser display.')); };
      process.once('error', fail); process.once('exit', fail);
      process.stdio[3].on('data', chunk => {
        output += chunk;
        if (/^\d+\n/.test(output)) { clearTimeout(timer); resolve(`:${output.trim()}`); }
      });
    });
    return {display, close: () => process.kill()};
  } catch (error) { process.kill(); throw error; }
}

export function isChallenge({status, headers = {}, title = '', text = ''}) {
  return headers['cf-mitigated'] === 'challenge' ||
    /^(just a moment|attention required|verify (you are|you're) human|access denied)/i.test(title.trim()) ||
    (status >= 400 && /captcha|enable javascript|verify you are human/i.test(text));
}

export function createBrowserCapture({directory = process.env.BROWSER_STATE_DIR || 'data/browser-state', launch = options => chromium.launch(options), createProxy = createBrowserProxy, createDisplay = virtualDisplay, timeoutMs = 35000, verificationManager = verifications, resolveAddress = publicAddress, challengeWaitMs = 8000, pollMs = 1000} = {}) {
  // One live fallback at a time: bounded CPU/memory and stable per-site state.
  const pending = new Map();
  function browserCapture(input, limit = 5_000_000) {
    const key = normalizeUrl(input);
    const previous = pending.get(key);
    if (previous) {
      if (previous.verification?.status === 'waiting') return Promise.reject(new VerificationRequired(previous.verification.id));
      return previous.task.finally(() => { if (pending.get(key) === previous) pending.delete(key); });
    }
    if ([...pending.values()].some(job => !job.finished)) return Promise.reject(new Error('A browser capture is already in progress. Please try again shortly.'));
    const job = {};
    pending.set(key, job);
    let notifyVerification;
    const needsVerification = new Promise((_, reject) => { notifyVerification = reject; });
    const task = Promise.resolve().then(async () => {
      const url = normalizeUrl(input);
      await resolveAddress(new URL(url).hostname);
      const started = Date.now();
      logEvent('browser.started', {url:logUrl(url)});
      let proxy, display, browser, context, timer;
      try {
        proxy = await createProxy();
        display = await createDisplay();
        browser = await launch({
          executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
          headless:false, chromiumSandbox:true, timeout:10000,
          env:{...process.env, DISPLAY:display.display},
          proxy:{server:proxy.url, bypass:'<-loopback>'},
          args:['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
        });
        const statePath = resolve(directory, createHash('sha256').update(new URL(url).origin).digest('hex') + '.json');
        let storageState;
        try { storageState = JSON.parse(await readFile(statePath, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') logEvent('browser.state_unavailable', {url:logUrl(url)}); }
        context = await browser.newContext({storageState, viewport:{width:1280,height:900}, locale:'en-US', serviceWorkers:'block', acceptDownloads:false});
        await context.route('**/*', route => {
          try {
            const request = route.request();
            normalizeUrl(request.url());
            if (['media', 'font'].includes(request.resourceType())) return route.abort();
            return route.continue();
          } catch { return route.abort(); }
        });
        const page = await context.newPage();
        context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
        let lastResponse = {status:0, headers:{}};
        page.on('response', response => {
          if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
            lastResponse = {status:response.status(), headers:response.headers()};
          }
        });
        let timedOut = false;
        const expire = () => { timedOut = true; void context.close().catch(() => {}); };
        timer = setTimeout(expire, timeoutMs);
        await page.goto(url, {waitUntil:'domcontentloaded', timeout:timeoutMs});
        // Allow automatic challenges/reloads and client rendering, but never click a CAPTCHA.
        let deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await delay(pollMs);
          let state;
          try { state = await page.evaluate(() => ({title:document.title, text:(document.body?.innerText || '').slice(0, 4000)})); }
          catch (error) { if (timedOut || page.isClosed()) throw error; continue; }
          if (isChallenge({...lastResponse, ...state})) {
            if (!job.verification && Date.now() - started >= challengeWaitMs) {
              job.verification = verificationManager.create(url, page);
              deadline = job.verification.expiresAt;
              clearTimeout(timer);
              timer = setTimeout(expire, Math.max(1, deadline - Date.now()));
              notifyVerification(new VerificationRequired(job.verification.id));
            }
            continue;
          }
          if (lastResponse.status >= 400) throw new Error(`The browser received HTTP ${lastResponse.status}.`);
          if (!lastResponse.status || !state.text.trim()) continue;
          const finalUrl = normalizeUrl(page.url());
          const body = Buffer.from(await page.content());
          if (body.length > limit) throw new Error('The resource exceeds the capture size limit.');
          // Save only this isolated anonymous context; never use a personal browser profile.
          await mkdir(directory, {recursive:true, mode:0o700});
          const temporary = `${statePath}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(await context.storageState()), {mode:0o600});
          await rename(temporary, statePath);
          verificationManager.finish(job.verification, 'ready');
          logEvent('browser.completed', {url:logUrl(finalUrl), status:lastResponse.status, durationMs:Date.now() - started, bytes:body.length, networkBytes:proxy.bytes});
          return {url:finalUrl, body, type:'text/html; charset=utf-8'};
        }
        throw new Error('This site still requires browser verification. Please try again later.');
      } catch (error) {
        verificationManager.finish(job.verification, job.verification?.status === 'cancelled' ? 'cancelled' : 'failed');
        logEvent('browser.failed', {url:logUrl(url), durationMs:Date.now() - started, errorType:error.name});
        // Browser exceptions can contain internal paths and raw URLs; keep them server-side.
        if (/^The (browser received HTTP|resource exceeds)/.test(error.message)) throw error;
        throw new Error('The browser could not capture this page. It may still require verification or be unavailable.');
      } finally {
        clearTimeout(timer);
        await context?.close().catch(() => {});
        await browser?.close().catch(() => {});
        display?.close();
        await proxy?.close();
      }
    });
    job.task = task;
    void task.finally(() => {
      job.finished = true;
      if (!job.verification) pending.delete(key);
      else setTimeout(() => { if (pending.get(key) === job) pending.delete(key); }, 120000).unref();
    }).catch(() => {});
    return Promise.race([task, needsVerification]);
  }
  browserCapture.has = url => pending.has(normalizeUrl(url));
  return browserCapture;
}

const browserCapture = createBrowserCapture();
export function createPageFetcher({fetcher = fetchPublic, browser = browserCapture} = {}) {
  return async (url, limit) => {
    if (browser.has?.(url)) return browser(url, limit);
    try { return await fetcher(url, limit); }
    catch (error) {
      if (process.env.BROWSER_CAPTURE === '0' || ![403, 429, 503].includes(error.httpStatus)) throw error;
      // Retry challenge responses and plain 403 blocks, but respect ordinary rate limiting.
      if (error.httpStatus !== 403 && !error.challenged) throw error;
      logEvent('capture.browser_fallback', {url:logUrl(url), status:error.httpStatus});
      return browser(url, limit);
    }
  };
}
export const fetchPage = createPageFetcher();
