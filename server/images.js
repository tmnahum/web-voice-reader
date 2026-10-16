import parseSrcset from 'parse-srcset';

export function imageUrl(raw, base) {
  if (!raw) return '';
  if (/^data:(?:image\/|font\/|application\/(?:font-|x-font-|vnd.ms-fontobject))/i.test(raw)) return raw;
  if (raw.startsWith('#')) return raw;
  try {
    const url = new URL(raw, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}
export function prepareImages(document, base) {
  for (const img of document.querySelectorAll('img')) {
    const rawSet = img.getAttribute('data-srcset') || img.getAttribute('srcset') || img.closest('picture')?.querySelector('source[srcset]')?.getAttribute('srcset');
    const candidates = parseSrcset(rawSet || '').map(c => ({ ...c, url: imageUrl(c.url, base) })).filter(c => c.url);
    const src = imageUrl(img.getAttribute('data-src') || img.getAttribute('data-original'), base) || imageUrl(img.getAttribute('src'), base) || candidates[0]?.url;
    if (src) img.setAttribute('src', src); else img.removeAttribute('src');
    if (candidates.length) img.setAttribute('srcset', candidates.map(c => `${c.url}${c.w ? ` ${c.w}w` : c.d ? ` ${c.d}x` : ''}`).join(', '));
    else img.removeAttribute('srcset');
    img.setAttribute('loading', 'eager');
    img.setAttribute('decoding', 'async');
    img.setAttribute('referrerpolicy', 'no-referrer');
  }
  for (const source of document.querySelectorAll('picture source')) {
    const candidates = parseSrcset(source.getAttribute('data-srcset') || source.getAttribute('srcset') || '').map(c => ({...c, url:imageUrl(c.url, base)})).filter(c => c.url);
    if (candidates.length) source.setAttribute('srcset', candidates.map(c => `${c.url}${c.w ? ` ${c.w}w` : c.d ? ` ${c.d}x` : ''}`).join(', '));
    else source.removeAttribute('srcset');
  }
}
