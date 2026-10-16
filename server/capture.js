import { JSDOM, VirtualConsole } from 'jsdom';
import createDOMPurify from 'dompurify';
import { Readability } from '@mozilla/readability';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { fetchPublic } from './fetch.js';
import { imageUrl, prepareImages } from './images.js';

const domOptions = url => ({ url, virtualConsole: new VirtualConsole() });
export async function capture(url, fetcher = fetchPublic) {
  const response = await fetcher(url);
  if (!/\b(text\/html|application\/xhtml\+xml)\b/i.test(response.type)) throw new Error('This URL is not an HTML page. Try a web article instead.');
  const charset = response.type.match(/charset=["']?([^\s;"']+)/i)?.[1] || 'utf-8';
  let html; try { html = new TextDecoder(charset).decode(response.body); } catch { html = response.body.toString('utf8'); }
  const dom = new JSDOM(html, domOptions(response.url));
  const { document } = dom.window;
  const purifier = createDOMPurify(dom.window);
  const base = document.baseURI;
  prepareImages(document, base);
  let article;
  try { article = new Readability(document.cloneNode(true), { maxElemsToParse: 60000 }).parse(); } catch { /* fall back to visible body */ }
  const title = article?.title || document.title || new URL(response.url).hostname;
  // Original replay keeps the source markup and behavior. It is served in an
  // opaque-origin sandbox; only reader HTML is sanitized for our own document.
  for (const meta of document.querySelectorAll('meta[http-equiv]')) {
    if (/^(content-security-policy|refresh)$/i.test(meta.httpEquiv)) meta.remove();
  }
  for (const oldBase of document.querySelectorAll('base')) oldBase.remove();
  const sourceBase = document.createElement('base'); sourceBase.href = base;
  document.head.prepend(sourceBase);
  for (const el of document.querySelectorAll('[src], [poster], [action], [formaction], [data], use[href], use[*|href]')) {
    for (const attr of ['src', 'poster', 'action', 'formaction', 'data', 'href', 'xlink:href']) {
      const raw = el.getAttribute(attr);
      if (!raw || raw.startsWith('#') || raw.startsWith('data:')) continue;
      try { el.setAttribute(attr, new URL(raw, base).href); } catch { /* keep source markup */ }
    }
  }
  for (const form of document.forms) { form.action = new URL(form.getAttribute('action') || response.url, base).href; form.target = '_blank'; }
  for (const el of document.querySelectorAll('[data-read-id]')) el.removeAttribute('data-read-id');
  const blocks = [];
  const walker = document.createTreeWalker(document.body, dom.window.NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    const el = node.parentElement;
    if (!text || el.closest('style,script,noscript,[hidden],[aria-hidden="true"]')) continue;
    if (!el.hasAttribute('data-read-id')) el.setAttribute('data-read-id', `source-${blocks.length}`);
    blocks.push({ id: el.getAttribute('data-read-id'), text, tag: el.tagName.toLowerCase() });
  }
  for (const a of document.querySelectorAll('a')) {
    if (a.getAttribute('href')?.startsWith('#')) continue;
    try { const dest = new URL(a.getAttribute('href') || '', base); a.href = ['http:', 'https:', 'mailto:'].includes(dest.protocol) ? dest.href : '#'; } catch { a.removeAttribute('href'); }
    a.target = '_blank'; a.rel = 'noopener noreferrer'; a.removeAttribute('ping');
  }
  let count = 0, bytes = 0, missing = 0;
  const cache = new Map();
  const deadline = Date.now() + 45000;
  async function resource(raw, from, depth = 0) {
    if (!raw || raw.startsWith('#')) return raw || '';
    if (raw.startsWith('data:')) return raw;
    let absolute; try { absolute = new URL(raw, from).href; } catch { missing++; return ''; }
    if (cache.has(absolute)) return cache.get(absolute);
    if (++count > 80 || bytes > 25_000_000 || depth > 4 || Date.now() > deadline) { missing++; return absolute; }
    // Cache a placeholder first to break cyclic CSS imports.
    cache.set(absolute, absolute);
    try {
      const data = await fetcher(absolute, 2_000_000); bytes += data.body.length;
      const mime = data.type.split(';')[0].trim();
      let body = data.body;
      if (mime === 'text/css') body = Buffer.from(await css(body.toString('utf8'), data.url, depth + 1));
      else throw new Error('Only stylesheets are archived.');
      const result = `data:${mime};base64,${body.toString('base64')}`;
      cache.set(absolute, result); return result;
    } catch { missing++; return absolute; }
  }
  async function css(text, from, depth = 0) {
    const root = postcss.parse(text);
    const imports = []; root.walkAtRules('import', rule => imports.push(rule));
    for (const rule of imports) {
      const value = valueParser(rule.params); const first = value.nodes[0];
      const raw = first?.type === 'string' ? first.value : first?.type === 'function' && first.value === 'url' ? valueParser.stringify(first.nodes).replace(/^["']|["']$/g, '') : '';
      const saved = await resource(raw, from, depth);
      if (saved) { rule.params = `url("${saved}") ${valueParser.stringify(value.nodes.slice(1))}`; } else rule.remove();
    }
    const decls = []; root.walkDecls(d => decls.push(d));
    for (const d of decls) {
      const value = valueParser(d.value); const urls = [];
      value.walk(n => { if (n.type === 'function' && n.value.toLowerCase() === 'url') { urls.push(n); return false; } });
      for (const n of urls) { const raw = valueParser.stringify(n.nodes).replace(/^["']|["']$/g, ''); const saved = imageUrl(raw, from); n.nodes = [{ type: 'string', quote: '"', value: saved }]; }
      value.walk(n => {
        if (n.type === 'function' && /^(?:-webkit-)?image-set$/i.test(n.value)) {
          for (const child of n.nodes) if (child.type === 'string') child.value = imageUrl(child.value, from);
        }
      });
      d.value = value.toString();
    }
    return root.toString();
  }
  for (const el of [...document.querySelectorAll('link')]) {
    if (el.relList.contains('stylesheet')) {
      const saved = await resource(el.getAttribute('href'), base);
      if (saved) { el.href = saved; el.removeAttribute('integrity'); }
    } else if (el.hasAttribute('href')) {
      try { el.href = new URL(el.getAttribute('href'), base).href; } catch { /* keep source markup */ }
    }
  }
  for (const el of document.querySelectorAll('style')) { try { el.textContent = await css(el.textContent, base); } catch { /* retain CSS the browser may still parse */ } }
  for (const el of document.querySelectorAll('[style]')) { try { el.setAttribute('style', (await css(`x{${el.getAttribute('style')}}`, base)).replace(/^x\{|\}$/g, '')); } catch { /* retain original declaration */ } }
  prepareImages(document, base);
  const readerDom = new JSDOM(article?.content || document.body.innerHTML, domOptions(response.url));
  prepareImages(readerDom.window.document, base);
  for (const a of readerDom.window.document.querySelectorAll('a')) { try { a.href = new URL(a.getAttribute('href'), base).href; } catch { a.removeAttribute('href'); } a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  const readerHtml = purifier.sanitize(readerDom.window.document.body.innerHTML, { ADD_ATTR: ['target'], FORBID_TAGS: ['style','link','form','input','button','textarea','select','iframe','svg','math','audio','video','source','object','embed','picture'], FORBID_ATTR: ['style','id','name'] });
  readerDom.window.document.body.innerHTML = readerHtml;
  const text = readerDom.window.document.body.textContent.replace(/\s+/g, ' ').trim();
  for (const oldViewport of document.querySelectorAll('meta[name=viewport]')) oldViewport.remove();
  const viewport = document.createElement('meta');
  viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1'; document.head.append(viewport);
  const spacer = document.createElement('div');
  spacer.setAttribute('aria-hidden', 'true'); spacer.style.cssText = 'height:100px;clear:both;pointer-events:none'; document.body.append(spacer);
  const result = { captureVersion: 3, url, finalUrl: response.url, title, byline: article?.byline || '', excerpt: article?.excerpt || text.slice(0, 180), readerHtml, text, blocks, originalHtml: dom.serialize(), wordCount: text.split(/\s+/).filter(Boolean).length, readerFallback: !article, assets: { saved: [...cache.values()].filter(v => v.startsWith('data:text/css;')).length, missing, bytes }, capturedAt: new Date().toISOString() };
  readerDom.window.close(); dom.window.close(); return result;
}
