// Shared by the reader and the sandboxed original-page bridge.
export function archiveLinks(root, sourceUrl, archiveOrigin, navigate) {
  const originals = new WeakMap();
  function rewrite(link) {
    const raw = link.getAttribute('href');
    if (!raw || raw.startsWith('#')) return null;
    const previous = originals.get(link);
    if (previous?.archived === raw) return previous.archived;
    let url;
    try { url = new URL(raw, sourceUrl); } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    // Fragments belong to the source page, not Voicesite's snapshot selector.
    url.hash = '';
    const archived = `${archiveOrigin}/${url.href}`;
    originals.set(link, {archived});
    link.setAttribute('href', archived);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.removeAttribute('download');
    return archived;
  }
  function scan(node) {
    if (node.matches?.('a[href], area[href]')) rewrite(node);
    node.querySelectorAll?.('a[href], area[href]').forEach(rewrite);
  }
  scan(root);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') rewrite(record.target);
      else record.addedNodes.forEach(scan);
    }
  });
  observer.observe(root, {subtree:true, childList:true, attributes:true, attributeFilter:['href']});
  function click(event) {
    const link = event.target.closest?.('a[href], area[href]');
    if (!link) return;
    const archived = rewrite(link);
    if (!archived || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate(archived.slice(archiveOrigin.length));
  }
  root.addEventListener('click', click, true);
  return () => { observer.disconnect(); root.removeEventListener('click', click, true); };
}
