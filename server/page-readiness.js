import {JSDOM, VirtualConsole} from 'jsdom';

export const redditUrl = url => /(^|\.)reddit\.com$/i.test(new URL(url).hostname);

export function needsRendering(response) {
  if (!/text\/html|application\/xhtml\+xml/i.test(response.type || '')) return false;
  if (redditUrl(response.url)) return true;
  const dom = new JSDOM(response.body.toString('utf8'), {virtualConsole:new VirtualConsole()});
  try {
    const document = dom.window.document;
    const scripts = !!document.querySelector('script[src],script[type="module"],#root,#app,#__next');
    document.querySelectorAll('script,style,template,noscript,nav,header,footer,[hidden],[aria-hidden="true"]').forEach(el => el.remove());
    const text = document.body.textContent.replace(/\s+/g,' ').trim();
    return !text || (scripts && (text.length < 200 || /^(loading|please wait|enable javascript)[\s.!…]*$/i.test(text)));
  } finally {dom.window.close();}
}

// Runs in the real browser. Keep it self-contained for page.evaluate().
export function inspectRenderedPage() {
  const text = (document.body?.innerText || '').replace(/\s+/g,' ').trim();
  const post = document.querySelector('shreddit-post, .thing[data-fullname], [data-testid="post-container"]');
  const main = document.querySelector('main,[role="main"]') || post || document.querySelector('article') || document.body;
  const mainText = (main?.innerText || '').replace(/\s+/g,' ').trim();
  const loading = /^(loading|please wait|loading comments)[\s.!…]*$/i.test(mainText);
  const blocked = !post && /you.ve been blocked by network security|blocked by network policy|whoa there, pardner|log in to continue/i.test(text);
  const reddit = /(^|\.)reddit\.com$/i.test(location.hostname);
  return {title:document.title,text:text.slice(0,4000), signature:mainText.slice(0,24000),
    settleMs:reddit ? 5000 : 2000, ready:document.readyState !== 'loading' && !loading && !blocked && (reddit ? !!post && mainText.length >= 20 : mainText.length >= 20), blocked};
}

// Freeze the composed tree, including open shadow roots and slotted content.
// Source code is removed so hydration cannot replace saved content with a spinner.
export function serializeRenderedPage() {
  const output = document.implementation.createHTMLDocument('');
  const styles = new Map();
  const stylePrefix = 'voicesite-' + Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('') + '-';
  const styleProperties = ['display','visibility','opacity','color','background-color','font-family','font-size','font-weight','line-height','text-align','white-space','padding','margin','border','border-radius','box-sizing','width','max-width','height','min-height','overflow','position','top','right','bottom','left','flex','flex-direction','align-items','justify-content','gap','grid-template-columns'];
  function copy(node, inShadow = false) {
    if (node.nodeType === Node.TEXT_NODE) return output.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = node.localName;
    if (['script','noscript','template','iframe','object','embed'].includes(tag)) return null;
    if (tag === 'slot') {
      const fragment = output.createDocumentFragment();
      const assigned = node.assignedNodes({flatten:true});
      for (const child of assigned.length ? assigned : node.childNodes) {const result = copy(child,inShadow); if (result) fragment.append(result);}
      return fragment;
    }
    if (inShadow && tag === 'style') return null;
    const clone = output.importNode(node,false);
    for (const attr of [...clone.attributes]) {
      if (/^on/i.test(attr.name) || attr.name === 'srcdoc' || /^(?:javascript|vbscript):/i.test(attr.value.trim())) clone.removeAttribute(attr.name);
    }
    if (tag === 'input') clone.setAttribute('value','');
    if (tag === 'textarea') return clone;
    if (tag === 'img' && node.currentSrc) {clone.setAttribute('src',node.currentSrc); clone.removeAttribute('srcset'); clone.setAttribute('loading','eager');}
    if (node.shadowRoot || inShadow || tag.includes('-')) {
      const style = getComputedStyle(node);
      const declarations = styleProperties.map(property => property + ':' + style.getPropertyValue(property) + '!important').join(';');
      if (!styles.has(declarations)) styles.set(declarations, stylePrefix + styles.size);
      clone.classList.add(styles.get(declarations));
      // Computed declarations already include inline styles.
      clone.removeAttribute('style');
    }
    for (const child of (node.shadowRoot || node).childNodes) {const result = copy(child,inShadow || !!node.shadowRoot); if (result) clone.append(result);}
    return clone;
  }
  const root = copy(document.documentElement);
  const stylesheet = output.createElement('style');
  stylesheet.textContent = [...styles].map(([declarations,name]) => '.' + name + '{' + declarations + '}').join('\n');
  root.querySelector('head').append(stylesheet);
  return '<!doctype html>\n' + root.outerHTML;
}
