import { JSDOM, VirtualConsole } from 'jsdom';
import { fetchPublic } from './fetch.js';

const limit = 256_000;
const imageType = /^image\/(?:png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp)$/i;

export function faviconCandidates(doc) {
  const url = doc.finalUrl || doc.url;
  const dom = new JSDOM(doc.originalHtml, {url, virtualConsole:new VirtualConsole()});
  try {
    const links = [...dom.window.document.querySelectorAll('link[href]')];
    const icons = links.filter(el => el.rel.toLowerCase().split(/\s+/).includes('icon'));
    const touch = links.filter(el => el.rel.toLowerCase() === 'apple-touch-icon');
    return [...new Set([...icons, ...touch].map(el => el.href)
      .filter(href => /^(https?:|data:image\/)/i.test(href)))].slice(0, 2)
      .concat(new URL('/favicon.ico', url).href);
  } finally { dom.window.close(); }
}

export async function loadFavicons(doc, fetcher = fetchPublic) {
  const results = await Promise.allSettled(faviconCandidates(doc).map(async url => {
    if (url.startsWith('data:')) {
      if (url.length > limit * 1.4 || !imageType.test(url.slice(5).split(/[;,]/)[0])) throw new Error('Invalid icon.');
      return url;
    }
    const response = await fetcher(url, limit);
    const type = response.type.split(';')[0].trim();
    if (!imageType.test(type) || response.body.length > limit) throw new Error('Invalid icon.');
    return `data:${type};base64,${response.body.toString('base64')}`;
  }));
  return results.filter(result => result.status === 'fulfilled').map(result => result.value);
}
