import { verifications, VerificationRequired } from './browser-verification.js';
import {needsRendering, inspectRenderedPage, serializeRenderedPage} from './page-readiness.js';
import { createDesktopPool } from './desktop-browser.js';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserProxy, publicAddress } from './browser-proxy.js';
import { fetchPublic, normalizeUrl } from './fetch.js';
import { logEvent, logUrl } from './diagnostics.js';

export async function virtualDisplay() {
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
    (/^reddit(?:\s[-–|].*)?$/i.test(title.trim()) && /^prove your humanity\b/i.test(text.trim())) ||
    (status >= 400 && /captcha|enable javascript|verify you are human/i.test(text));
}

export function createBrowserCapture({directory = process.env.BROWSER_STATE_DIR || 'data/browser-state', launch, createProxy = createBrowserProxy, createDisplay = virtualDisplay, timeoutMs = 60000, verificationManager = verifications, resolveAddress = publicAddress, challengeWaitMs = 8000, pollMs = 1000} = {}) {
  // One live fallback at a time: bounded CPU/memory and stable per-site state.
  const pending = new Map();
  const desktops = !launch && createDesktopPool({directory:resolve(directory), createProxy, createDisplay});
  function browserCapture(input, limit = Infinity, {manual = false} = {}) {
    const key = normalizeUrl(input);
    const previous = pending.get(key);
    if (previous) {
      if (previous.verification?.status === 'waiting') return Promise.reject(new VerificationRequired(previous.verification.id));
      // Concurrent callers must receive the same handoff, not wait for its five-minute task.
      if (!previous.verification && !previous.finished) return previous.publicTask;
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
      let proxy, display, browser, context, timer, desktop, page, responseHandler;
      try {
        const origin = new URL(url).origin;
        const profileName = createHash('sha256').update(origin).digest('hex');
        const statePath = resolve(directory, profileName + '.json');
        if (desktops) {
          desktop = await desktops.acquire(origin, profileName);
          ({proxy, context, page} = desktop);
        } else {
          proxy = await createProxy();
          display = await createDisplay();
          browser = await launch({
            executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
            headless:false, chromiumSandbox:true, timeout:10000,
            env:{...process.env, DISPLAY:display.display},
            proxy:{server:proxy.url, bypass:'<-loopback>'},
            args:['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
          });
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
          page = await context.newPage();
          context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
        }
        let lastResponse = {status:0, headers:{}};
        responseHandler = response => {
          if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
            lastResponse = {status:response.status(), headers:response.headers()};
            logEvent('browser.navigation', {url:logUrl(response.url?.() || url), status:lastResponse.status, challenged:lastResponse.headers['cf-mitigated'] === 'challenge'});
          }
        };
        page.on('response', responseHandler);
        let timedOut = false;
        const expire = () => { timedOut = true; void page.close().catch(() => {}); };
        timer = setTimeout(expire, timeoutMs);
        await page.goto(url, {waitUntil:'domcontentloaded', timeout:timeoutMs});
        // Allow automatic challenges/reloads and client rendering, but never click a CAPTCHA.
        let deadline = Date.now() + timeoutMs;
        let signature, stableSince = 0;
        while (Date.now() < deadline) {
          await delay(pollMs);
          let state;
          try { state = await page.evaluate(inspectRenderedPage); }
          catch (error) { if (timedOut || page.isClosed()) throw error; continue; }
          const challenged = isChallenge({...lastResponse, ...state});
          const stillRendering = state.ready === false && !state.blocked;
          if (manual || challenged || (stillRendering && Date.now() - started >= 15000)) {
            if (!job.verification && (manual || Date.now() - started >= challengeWaitMs)) {
              job.verification = verificationManager.create(url, page, challenged ? 'verification' : 'rendering');
              deadline = job.verification.expiresAt;
              clearTimeout(timer);
              timer = setTimeout(expire, Math.max(1, deadline - Date.now()));
              notifyVerification(new VerificationRequired(job.verification.id));
            }
            if (challenged) {
              if (job.verification?.captureRequested) {
                job.verification.captureRequested = false;
                job.verification.error = 'The site is still showing verification. Complete it before capturing.';
              }
              continue;
            }
          }
          if (lastResponse.status >= 400) throw new Error(`The browser received HTTP ${lastResponse.status}.`);
          if (state.blocked) throw new Error('This site is blocking access to its content. Try opening it directly in your browser.');
          if (!lastResponse.status || !state.text.trim()) continue;
          const requested = job.verification?.captureRequested;
          if (job.verification && !requested) continue;
          // Test adapters may omit readiness metadata; real desktops always provide it.
          if (!requested && state.ready !== undefined) {
            if (!state.ready) {stableSince = 0; continue;}
            if (signature !== state.signature || !stableSince) {signature = state.signature; stableSince = Date.now();}
            if (Date.now() - stableSince < (state.settleMs || 2000)) continue;
          }
          const finalUrl = normalizeUrl(page.url());
          const body = Buffer.from(desktop ? await page.evaluate(serializeRenderedPage) : await page.content());
          if (body.length > limit) {
            logEvent('browser.snapshot_too_large', {bytes:body.length, limit});
            throw new Error('The resource exceeds the capture size limit.');
          }
          // Save only this isolated anonymous context; never use a personal browser profile.
          if (!desktop) {
            await mkdir(directory, {recursive:true, mode:0o700});
            const temporary = `${statePath}.${randomUUID()}.tmp`;
            await writeFile(temporary, JSON.stringify(await context.storageState()), {mode:0o600});
            await rename(temporary, statePath);
          }
          verificationManager.finish(job.verification, 'ready');
          logEvent('browser.completed', {url:logUrl(finalUrl), status:lastResponse.status, durationMs:Date.now() - started, bytes:body.length, networkBytes:proxy.bytes});
          return {url:finalUrl, body, type:'text/html; charset=utf-8', rendered:true};
        }
        throw new Error('The page did not finish loading readable content. No loading screen was saved.');
      } catch (error) {
        if (job.verification) job.verification.error = /^(The |This site)/.test(error.message) ? error.message : 'The browser could not capture this page. Try saving it again.';
        verificationManager.finish(job.verification, job.verification?.status === 'cancelled' ? 'cancelled' : 'failed');
        logEvent('browser.failed', {url:logUrl(url), durationMs:Date.now() - started, errorType:error.name});
        // Browser exceptions can contain internal paths and raw URLs; keep them server-side.
        if (/^(The (browser received HTTP|resource exceeds|page did not finish)|This site is blocking)/.test(error.message)) throw error;
        throw new Error('The browser could not capture this page. It may still require verification or be unavailable.');
      } finally {
        clearTimeout(timer);
        if (responseHandler) page?.off?.('response', responseHandler);
        if (desktop) {
          await desktops.release(desktop);
        } else {
          await context?.close().catch(() => {});
          await browser?.close().catch(() => {});
          display?.close();
          await proxy?.close();
        }
      }
    });
    job.task = task;
    void task.finally(() => {
      job.finished = true;
      if (!job.verification) pending.delete(key);
      else setTimeout(() => { if (pending.get(key) === job) pending.delete(key); }, 120000).unref();
    }).catch(() => {});
    job.publicTask = Promise.race([task, needsVerification]);
    return job.publicTask;
  }
  browserCapture.close = () => desktops?.close();
  browserCapture.has = url => pending.has(normalizeUrl(url));
  return browserCapture;
}

const browserCapture = createBrowserCapture();
export const closeCaptureBrowser = () => browserCapture.close();
export function createPageFetcher({fetcher = fetchPublic, browser = browserCapture} = {}) {
  return async (url, limit = Infinity, mode = 'auto') => {
    if (mode === 'html') return fetcher(url, limit);
    if (mode === 'browser') {
      if (process.env.BROWSER_CAPTURE === '0') throw new Error('Browser capture is disabled.');
      return browser(url,limit,{manual:true});
    }
    if (browser.has?.(url)) return browser(url, limit);
    try {
      const response = await fetcher(url, limit);
      if (process.env.BROWSER_CAPTURE !== '0' && needsRendering(response)) {
        logEvent('capture.browser_render', {url:logUrl(url)});
        return browser(url,limit);
      }
      return response;
    }
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
