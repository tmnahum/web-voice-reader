const $ = id => document.getElementById(id);
let snapshots = [], current = null, mode = 'original', routeVersion = 0, fontSize = 20, saving = false;
const date = value => new Date(value).toLocaleString(undefined, {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'});
async function api(url, options) { const response = await fetch(url, options); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.'); return result; }
function screen(name) { document.body.classList.toggle('viewing', name === 'viewer'); for (const id of ['home','viewer','loading','error']) $(id).hidden = id !== name; }
function notify(message) { $('toast').textContent = message; $('toast').classList.add('visible'); setTimeout(() => $('toast').classList.remove('visible'), 2500); }
function fail(error) { screen('error'); $('error-message').textContent = error.message; }
const snapshotPath = (url, id) => `/${url}${id ? `#snapshot=${encodeURIComponent(id)}` : ''}`;
function navigate(path) { history.pushState(null, '', path); route(); }
function renderLibrary() {
  const query = $('search').value.toLowerCase();
  const filtered = snapshots.filter(s => `${s.title} ${s.url}`.toLowerCase().includes(query));
  $('archive-count').textContent = snapshots.length;
  $('archive-list').replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.innerHTML = `<div class="empty-symbol">▤</div><h3>${query ? 'No pages found.' : 'Your next good read belongs here.'}</h3><p>${query ? 'Try a different title or website.' : 'Paste your first link above to start your collection.<br>We’ll keep the words and a saved view of the page.'}</p>`;
    $('archive-list').append(empty); return;
  }
  for (const snapshot of filtered) {
    const domain = new URL(snapshot.finalUrl).hostname.replace(/^www\./,'');
    const row = document.createElement('a'); row.href = snapshotPath(snapshot.url, snapshot.id); row.className = 'archive-row';
    row.innerHTML = '<span class="site-letter"></span><div class="row-copy"><span class="row-meta"></span><h3></h3><span class="row-meta read-time"></span></div><span class="row-date"></span><span class="row-arrow">↗</span>';
    row.querySelector('.site-letter').textContent = domain[0].toUpperCase();
    row.querySelector('.row-meta').textContent = domain;
    row.querySelector('h3').textContent = snapshot.title;
    row.querySelector('.read-time').textContent = `${Math.max(1, Math.ceil(snapshot.wordCount / 220))} min read · Saved snapshot`;
    row.querySelector('.row-date').textContent = date(snapshot.capturedAt);
    $('archive-list').append(row);
  }
}
async function showSnapshot(id, version, preserveView = false) {
  const doc = await api(`/api/snapshots/${encodeURIComponent(id)}`);
  const versions = await api(`/api/snapshots?url=${encodeURIComponent(doc.url)}`);
  if (version !== routeVersion) return;
  const samePage = current?.id === doc.id;
  current = doc;
  $('page-title').textContent = $('reader-title').textContent = doc.title;
  document.title = `${doc.title} — Voicesite`;
  $('source-domain').textContent = new URL(doc.finalUrl).hostname;
  $('header-title').textContent = doc.title;
  $('header-title').title = `${doc.title} — ${new URL(doc.finalUrl).hostname}`;
  $('header-live-link').href = doc.finalUrl;
  $('live-link').href = doc.finalUrl;
  $('capture-date').textContent = `Saved ${date(doc.capturedAt)}`;
  $('article-meta').textContent = [doc.byline, `${Math.max(1, Math.ceil(doc.wordCount / 220))} min read`, `${doc.wordCount.toLocaleString()} words`].filter(Boolean).join(' · ');
  $('reader-content').innerHTML = doc.readerHtml;
  $('capture-note').textContent = `Text and ${doc.assets.saved} stylesheets saved. Other assets load from their original websites.${doc.assets.missing ? ` ${doc.assets.missing} stylesheets use live fallback links.` : ''}${doc.captureVersion < 3 || !doc.captureVersion ? ' Saved with older capture settings; use the header refresh button to restore full styling and assets.' : ''} Some interactions may require the live site.${doc.readerFallback ? ' Reader mode shows available page content.' : ''}`;
  $('versions').replaceChildren(...versions.map(v => { const option = document.createElement('option'); option.value = v.id; option.textContent = date(v.capturedAt); option.title = new Date(v.capturedAt).toString(); option.selected = v.id === id; return option; }));
  $('versions').title = `Saved ${new Date(doc.capturedAt).toString()}`;
  if (!preserveView || !samePage) $('original').removeAttribute('src');
  $('page-options').open = false;
  setMode(preserveView ? mode : 'original'); screen('viewer');
}
function setMode(next) {
  mode = next;
  document.body.classList.toggle('original-view', next === 'original');
  $('reader-tools').hidden = next !== 'reader';
  $('reader').hidden = next !== 'reader'; $('original').hidden = next !== 'original';
  $('reader-mode').setAttribute('aria-pressed', String(next === 'reader'));
  $('original-mode').setAttribute('aria-pressed', String(next === 'original'));
  $('smaller').disabled = $('larger').disabled = next !== 'reader';
  if (next === 'original' && current && !$('original').getAttribute('src')) $('original').src = `/snapshots/${current.id}/original`;
}
async function saveUrl(url, fresh = false, replace = false) {
  const version = ++routeVersion; screen('loading');
  try {
    const result = await api('/api/capture', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url, fresh})});
    if (version !== routeVersion) return;
    await showSnapshot(result.id, version);
    if (version === routeVersion) history[replace ? 'replaceState' : 'pushState'](null, '', snapshotPath(current.url));
  } catch (error) { if (version === routeVersion) fail(error); }
}
async function route() {
  const version = ++routeVersion;
  const path = location.pathname;
  try {
    if (path === '/') {
      screen('home'); document.title = 'Voicesite — A quieter place for the web';
      snapshots = await api('/api/snapshots'); if (version === routeVersion) renderLibrary();
    } else if (path.startsWith('/archive/')) {
      screen('loading'); await showSnapshot(path.slice(9), version);
      if (version === routeVersion) history.replaceState(null, '', snapshotPath(current.url, current.id));
    } else {
      // Preserve the source query string; decode only when the entire URL is encoded.
      let source = path.slice(1) + location.search;
      if (/^https?%3a/i.test(source)) source = decodeURIComponent(source);
      const selected = new URLSearchParams(location.hash.slice(1)).get('snapshot');
      if (selected) { screen('loading'); await showSnapshot(selected, version);
        if (version === routeVersion) history.replaceState(null, '', snapshotPath(current.url, current.id));
      } else await saveUrl(source, false, true);
    }
  } catch (error) { if (version === routeVersion) fail(error); }
}
$('domain').textContent = location.host;
$('capture-form').addEventListener('submit', e => { e.preventDefault(); saveUrl($('url-input').value); });
$('search').addEventListener('input', renderLibrary);
$('reader-mode').onclick = () => setMode('reader');
$('original-mode').onclick = () => setMode('original');
$('versions').onchange = e => navigate(snapshotPath(current.url, e.target.value));
$('recapture').onclick = async () => {
  if (!current || saving) return;
  const version = routeVersion;
  const source = current.url;
  saving = true;
  $('recapture').disabled = true;
  $('recapture').classList.add('saving');
  $('recapture').setAttribute('aria-label', 'Saving page');
  notify('Saving a fresh copy…');
  try {
    const result = await api('/api/capture', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:source, fresh:true})});
    if (version !== routeVersion) return;
    await showSnapshot(result.id, version, true);
    if (version === routeVersion) history.replaceState(null, '', snapshotPath(current.url));
    if (version === routeVersion) notify(result.unchanged ? 'Page unchanged · saved time updated' : 'New version saved');
  } catch (error) { if (version === routeVersion) notify(`Couldn’t save: ${error.message}`); }
  finally {
    saving = false;
    $('recapture').disabled = false;
    $('recapture').classList.remove('saving');
    $('recapture').setAttribute('aria-label', 'Resave page');
  }
};
$('smaller').onclick = () => { fontSize = Math.max(16, fontSize - 2); document.documentElement.style.setProperty('--reader-size', `${fontSize}px`); };
$('larger').onclick = () => { fontSize = Math.min(32, fontSize + 2); document.documentElement.style.setProperty('--reader-size', `${fontSize}px`); };
$('copy-link').onclick = async () => { try { await navigator.clipboard.writeText(location.origin + snapshotPath(current.url, current.id)); notify('Snapshot link copied'); } catch { notify('Copy the snapshot URL from your address bar'); } };
$('dismiss-error').onclick = () => navigate('/');
window.addEventListener('popstate', route);
document.addEventListener('click', e => { const a = e.target.closest('a'); if (a && a.origin === location.origin && !a.target && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0 && (!a.hash || a.hash.startsWith('#snapshot='))) { e.preventDefault(); navigate(a.pathname + a.search + a.hash); window.scrollTo(0,0); } });
route();

document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('page-options').open = false; $('page-options').querySelector('summary').focus(); } });
document.addEventListener('click', e => { if (!e.target.closest('#page-options')) $('page-options').open = false; });
window.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement === $('original')) $('page-options').open = false; }, 0); });
