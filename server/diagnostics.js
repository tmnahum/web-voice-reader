import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const context = new AsyncLocalStorage();
export function logUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`.slice(0, 2048);
  } catch { return '[invalid URL]'; }
}
export function logEvent(event, fields = {}) {
  console.error(JSON.stringify({time: new Date().toISOString(), event, ...context.getStore(), ...fields}));
}
export function captureDiagnostics(url, task) {
  return context.run({captureId: randomUUID(), captureUrl: logUrl(url)}, async () => {
    const started = Date.now();
    logEvent('capture.started');
    try {
      const doc = await task();
      logEvent('capture.completed', {durationMs: Date.now() - started, snapshotId: doc.id});
      return doc;
    } catch (error) {
      // Avoid arbitrary exception messages, which may include credentials or full URLs.
      logEvent('capture.failed', {durationMs: Date.now() - started, errorType: error.name, code: error.code || error.cause?.code});
      throw error;
    }
  });
}

export async function responseDiagnostics(response) {
  const headers = {};
  for (const key of ['server', 'content-type', 'cf-ray', 'cf-mitigated', 'x-request-id', 'x-cache', 'retry-after']) {
    const value = response.headers.get(key);
    if (value) headers[key] = value.slice(0, 256);
  }
  // Inspect a bounded prefix, but never persist source HTML, cookies, or tokens.
  let sample = '', bytes = 0, readError = false;
  const reader = response.body?.getReader();
  if (reader) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic timeout')), 1500); });
    try {
      while (bytes < 16384) {
        const {done, value} = await Promise.race([reader.read(), timeout]);
        if (done) break;
        const part = value.subarray(0, 16384 - bytes);
        bytes += part.length;
        sample += Buffer.from(part).toString('utf8');
      }
    } catch { readError = true; }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }
  const markers = Object.entries({
    cloudflareChallenge: /cf-chl-|\/cdn-cgi\/challenge-platform|just a moment/i,
    captcha: /captcha|turnstile/i,
    accessDenied: /access denied|forbidden|request blocked/i,
    javascriptRequired: /enable javascript|javascript is required/i,
    loginRequired: /sign in to continue|log in to continue|login required/i,
    datadome: /datadome/i,
    perimeterx: /perimeterx|px-captcha/i,
  }).filter(([, pattern]) => pattern.test(sample)).map(([name]) => name);
  return {headers, markers, inspectedBytes: bytes, diagnosticReadError: readError};
}
