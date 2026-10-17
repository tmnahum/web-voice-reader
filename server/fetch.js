import { logEvent, logUrl, responseDiagnostics } from './diagnostics.js';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';

export function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 8192) throw new Error('Enter a website URL.');
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Use a public HTTP or HTTPS URL on a standard port.');
  url.hash = '';
  return url.href;
}
export function publicIP(address) {
  try { return ipaddr.process(address).range() === 'unicast'; }
  catch { return false; }
}

// Dependencies are injectable for transport-level security regression tests.
export function createPublicFetcher({ resolveHost = lookup, request = fetch, Dispatcher = Agent } = {}) {
  return async function fetchPublic(input, limit = 5_000_000) {
    let url = normalizeUrl(input);
    const started = Date.now();
    const hops = [];
    try {
      const deadline = Date.now() + 45000;
      for (let redirects = 0; redirects < 6; redirects++) {
        const target = new URL(url);
        const host = target.hostname.replace(/^\[|\]$/g, '');
        let timer;
        let addresses;
        try {
          addresses = await Promise.race([
            resolveHost(host, { all: true }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out.')), Math.max(1, Math.min(8000, deadline - Date.now()))); timer.unref(); }),
          ]);
        } finally { clearTimeout(timer); }
        if (!addresses.length || addresses.some(a => !publicIP(a.address))) throw new Error('Local and private network addresses cannot be archived.');
        if (Date.now() >= deadline) throw new Error('The resource fetch timed out.');
        // Pin every connection to the validated answer, including after redirects.
        const dispatcher = new Dispatcher({ connect: { lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family) } });
        try {
          // No cookie jar, browser profile, incoming headers, auth, or environment proxy.
          const response = await request(url, { dispatcher, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(Math.min(12000, deadline - Date.now())), headers: { 'user-agent': 'Voicesite/0.1 (page archive)', accept: 'text/html,*/*;q=0.8' } });
          hops.push({url: logUrl(url), status: response.status});
          if ([301,302,303,307,308].includes(response.status)) {
            await response.body?.cancel();
            if (!response.headers.get('location')) throw new Error('The website returned an invalid redirect.');
            url = normalizeUrl(new URL(response.headers.get('location'), url).href);
            continue;
          }
          if (!response.ok) {
            logEvent('fetch.http_error', {url: logUrl(url), status: response.status, hops, durationMs: Date.now() - started, ...await responseDiagnostics(response)});
            const error = new Error(`The website returned HTTP ${response.status}. It may block automated captures.`);
            error.httpStatus = response.status;
            error.challenged = response.headers.get('cf-mitigated') === 'challenge';
            throw error;
          }
          if (Number(response.headers.get('content-length')) > limit) {
            await response.body?.cancel();
            throw new Error('The resource exceeds the capture size limit.');
          }
          const chunks = []; let size = 0;
          // Enforce the limit on decoded bytes too, including chunked/compressed bodies.
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > limit) throw new Error('The resource exceeds the capture size limit.');
            chunks.push(chunk);
          }
          return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '', url };
        } finally { await dispatcher.destroy(); }
      }
      throw new Error('The website redirected too many times.');
    } catch (error) {
      if (!error.httpStatus) logEvent('fetch.failed', {url: logUrl(url), hops, durationMs: Date.now() - started, errorType: error.name, code: error.code || error.cause?.code});
      throw error;
    }
  };
}
export const fetchPublic = createPublicFetcher();
