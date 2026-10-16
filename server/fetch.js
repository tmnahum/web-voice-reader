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
  const ip = ipaddr.process(address);
  return ip.range() === 'unicast';
}
export async function fetchPublic(input, limit = 5_000_000) {
  let url = normalizeUrl(input);
  for (let redirects = 0; redirects < 6; redirects++) {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const addresses = await Promise.race([lookup(host, { all: true }), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('DNS lookup timed out.')), 8000); t.unref(); })]);
    if (!addresses.length || addresses.some(a => !publicIP(a.address))) throw new Error('Local and private network addresses cannot be archived.');
    const dispatcher = new Agent({ connect: { lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family) } });
    try {
      const response = await fetch(url, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Voicesite/0.1 (page archive)', accept: 'text/html,*/*;q=0.8' } });
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        if (!response.headers.get('location')) throw new Error('The website returned an invalid redirect.');
        url = normalizeUrl(new URL(response.headers.get('location'), url).href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`The website returned HTTP ${response.status}. It may block automated captures.`); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error('The resource exceeds the capture size limit.');
        chunks.push(chunk);
      }
      return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '', url };
    } finally { await dispatcher.close(); }
  }
  throw new Error('The website redirected too many times.');
}
