// Runs in both the clean reader and the sandboxed saved page. No parent DOM access.
export function readingSurface(root, onWords, onClick, onFollowChange = () => {}) {
  let words = [], ranges = [], sentence = 0, previousBlock, lastHighlight, lastScroll = -Infinity;
  const view = root.ownerDocument.defaultView;
  let following = true, activeIndex = -1, activeMode = 'word', pointerDown = false;
  function setFollowing(value) {
    if (following !== value) { following = value; onFollowChange(value); }
    if (value) {
      lastScroll = -Infinity;
      if (ranges[activeIndex] && activeMode !== 'none') keepInView(ranges[activeIndex].range);
    }
  }
  function manualScroll() { setFollowing(false); }
  function keyScroll(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
        event.target.closest?.('input,textarea,select,button,[contenteditable]:not([contenteditable="false"])')) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) manualScroll();
  }
  function pointerStart(event) {
    pointerDown = true;
    // Native scrollbar presses may not produce a later pointer movement.
    const el = event.target;
    if (el === document.documentElement && event.clientX >= el.clientWidth) manualScroll();
    else if (el instanceof view.Element && el.scrollHeight > el.clientHeight && el.offsetWidth > el.clientWidth) {
      const bounds = el.getBoundingClientRect();
      if (event.clientX >= bounds.left + el.clientLeft + el.clientWidth) manualScroll();
    }
  }
  function pointerEnd() { pointerDown = false; }
  function draggedScroll() { if (pointerDown) manualScroll(); }
  const listeners = [['wheel', manualScroll], ['touchmove', manualScroll], ['keydown', keyScroll],
    ['pointerdown', pointerStart], ['pointerup', pointerEnd], ['pointercancel', pointerEnd],
    ['blur', pointerEnd], ['scroll', draggedScroll]];
  listeners.forEach(([type, handler]) => view.addEventListener(type, handler, {capture:true, passive:true}));
  const style = document.createElement('style');
  style.textContent = '::highlight(voicesite-reading){background:#dce7a5;color:#203427} .voicesite-image-reading{outline:4px solid #9aae56!important;outline-offset:4px}';
  document.head.append(style);
  function imageSource(img) { return img.getAttribute('src') || img.currentSrc || ''; }
  function images() {
    return [...new Set([...root.querySelectorAll('img')].filter(img =>
      !img.closest('[hidden],[aria-hidden="true"],[role="presentation"],[role="none"]') &&
      img.getClientRects().length && getComputedStyle(img).visibility !== 'hidden' &&
      getComputedStyle(img).display !== 'none'
    ).map(imageSource).filter(Boolean))];
  }
  function imageReading(node, result) {
    const alt = node.getAttribute('alt')?.trim();
    if (!result || typeof result === 'string') return alt || result || '';
    const description = alt || (result.kind === 'caption' ? `Image: ${result.text}` : '');
    const embedded = result.ocrText || (result.kind === 'ocr' ? result.text : '');
    return [description, embedded ? `Text in image: ${embedded}` : ''].filter(Boolean).join(' ');
  }
  function build(imageText = {}) {
    lastHighlight = null; words = []; ranges = []; sentence = 0; previousBlock = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      const element = node.nodeType === 3 ? node.parentElement : node;
      if (element.closest('script,style,noscript,textarea,input,select,button,[hidden],[aria-hidden="true"],svg,.article-meta,.article-end')) continue;
      const isImage = node.nodeType === 1 && node.tagName === 'IMG';
      if (node.nodeType !== 3 && !isImage) continue;
      if (isImage && element.closest('[role="presentation"],[role="none"]')) continue;
      if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden' || getComputedStyle(element).display === 'none') continue;
      const text = isImage ? imageReading(node, imageText[imageSource(node)]) : node.textContent;
      const block = element.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,pre,div,article') || root;
      if (block !== previousBlock || isImage) sentence++;
      previousBlock = block;
      for (const match of text.matchAll(/\S+/gu)) {
        const range = document.createRange();
        if (isImage) range.selectNode(node); else { range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length); }
        ranges.push({range, image: isImage ? node : null});
        words.push({text: match[0], sentence, link: !!element.closest('a[href]')});
        if (/[.!?][”’"')\]]*$/.test(match[0])) sentence++;
      }
      if (isImage) sentence++;
    }
    onWords(words);
  }
  function keepInView(range) {
    const view = root.ownerDocument.defaultView;
    if (!following || !range.getBoundingClientRect || view.performance.now() - lastScroll < 800) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const behavior = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    // Some saved pages put the article inside their own scrolling panel.
    let element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    for (; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(element).overflowY) || element.scrollHeight <= element.clientHeight) continue;
      const bounds = element.getBoundingClientRect();
      const bottom = Math.min(rect.bottom, rect.top + 40);
      if (rect.top < bounds.top + 24 || bottom > bounds.bottom - Math.min(100, bounds.height * .2)) {
        const delta = rect.top - bounds.top - bounds.height * .4;
        if (delta > 0 ? element.scrollTop >= element.scrollHeight - element.clientHeight : element.scrollTop <= 0) continue;
        element.scrollBy({top:delta, behavior});
        lastScroll = view.performance.now();
        return;
      }
    }
    const height = view.visualViewport?.height || view.innerHeight;
    const top = view.visualViewport?.offsetTop || 0;
    // Leave space for the top header and bottom reading controls. Move the
    // active line into the middle rather than nudging on every spoken word.
    if (rect.top < top + 55 || Math.min(rect.bottom, rect.top + 40) > top + height - Math.max(110, height * .2)) {
      view.scrollBy({top:rect.top - top - height * .4, behavior});
      lastScroll = view.performance.now();
    }
  }
  function highlight(index, mode) {
    activeIndex = index; activeMode = mode;
    const key = `${mode}:${index}`;
    if (key === lastHighlight) return;
    lastHighlight = key;
    CSS.highlights?.delete('voicesite-reading');
    root.querySelectorAll('.voicesite-image-reading').forEach(el => el.classList.remove('voicesite-image-reading'));
    if (mode === 'none' || !words[index]) return;
    const selected = mode === 'sentence' ? ranges.filter((_, i) => words[i].sentence === words[index].sentence) : [ranges[index]];
    if (typeof Highlight !== 'undefined') CSS.highlights.set('voicesite-reading', new Highlight(...selected.map(x => x.range)));
    selected.forEach(x => x.image?.classList.add('voicesite-image-reading'));
    keepInView(ranges[index].range);
  }
  function click(event) {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || !getSelection().isCollapsed) return;
    const index = ranges.findIndex(({range, image}) => image === event.target || [...range.getClientRects()].some(r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom));
    if (index < 0) return;
    event.preventDefault(); event.stopPropagation(); onClick(index);
  }
  root.addEventListener('click', click, true);
  return {build, images, highlight, setFollowing, destroy() {
    listeners.forEach(([type, handler]) => view.removeEventListener(type, handler, true));
    root.removeEventListener('click', click, true); highlight(-1); style.remove();
  }};
}

export function splitReading(words, start = 0, limit = 450) {
  const chunks = [];
  for (let i = start; i < words.length;) {
    const begin = i;
    let length = 0, boundary = -1;
    while (i < words.length && (length + words[i].text.length + 1 <= limit || i === begin)) {
      length += words[i].text.length + 1;
      i++;
      if (i === words.length || words[i].sentence !== words[i - 1].sentence) boundary = i;
    }
    if (boundary > begin) i = boundary;
    chunks.push({start: begin, text: words.slice(begin, i).map(w => w.text).join(' ')});
  }
  return chunks;
}

// Audio timeline seconds: playback rate changes how fast this clock advances.
export function readingProgress(wordCount, chunks, index = 0, position = null, completed = false) {
  const parts = chunks?.length ? chunks : [{start:0}];
  let total = 0, current = 0, estimated = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i], end = parts[i + 1]?.start ?? wordCount;
    const count = Math.max(0, end - part.start);
    const known = Number.isFinite(part.duration) && part.duration >= 0;
    const duration = known ? part.duration : count / 3;
    estimated ||= !known;
    total += duration;
    if (position) {
      if (i < position.chunk) current += duration;
      else if (i === position.chunk) current += Math.max(0, Math.min(duration, position.time));
    } else {
      current += duration * Math.max(0, Math.min(1, count ? (index - part.start) / count : 0));
    }
  }
  return {current:completed ? total : Math.min(current, total), total, estimated};
}

export function formatReadingTime(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(value % 60).padStart(2, '0')}`;
}
