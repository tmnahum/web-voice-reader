import { archiveLinks } from './archive-links.js';
import { verifyCapture } from './verification.js';
import { setFavicon } from './favicon.js';
import { createPlayer } from './player.js';
const LOCAL_ARCHIVE_KEY = 'voicesite.recentlyArchived.v1';
let localFallback = [], localUnavailable = false, adminSnapshots = [];
function localArchive() {
  if (localUnavailable) return localFallback;
  let raw;
  try { raw = localStorage.getItem(LOCAL_ARCHIVE_KEY); } catch { return localFallback; }
  try {
    const rows = JSON.parse(raw || '[]');
    return Array.isArray(rows) ? rows.filter(s => {
      try { return s && typeof s.id === 'string' && typeof s.url === 'string' && ['http:', 'https:'].includes(new URL(s.finalUrl).protocol) && typeof s.title === 'string'; } catch { return false; }
    }).slice(0, 100) : [];
  } catch { return []; }
}
function rememberArchive(doc) {
  const {id, url, finalUrl, title, wordCount, capturedAt} = doc;
  localFallback = [{id, url, finalUrl, title, wordCount, capturedAt, archivedAt: new Date().toISOString()}, ...localArchive().filter(s => s.id !== id)].slice(0, 100);
  try { localStorage.setItem(LOCAL_ARCHIVE_KEY, JSON.stringify(localFallback)); } catch { localUnavailable = true; notify('Browser storage is unavailable; this list will last for this visit only.'); }
}
const $ = id => document.getElementById(id);
let releaseArchiveLinks;
let snapshots = [], current = null, mode = 'original', routeVersion = 0, saving = false;
let darkMode = false;
try { darkMode = localStorage.getItem('voicesite.darkMode') === 'true'; } catch {}
function syncPageTheme() {
  $('original').contentWindow?.postMessage({voicesite:true, type:'theme', dark:darkMode}, '*');
}
function applyTheme() {
  document.body.classList.toggle('dark-mode', darkMode);
  $('dark-mode').setAttribute('aria-pressed', String(darkMode));
  $('dark-mode').title = `${darkMode ? 'Turn off' : 'Turn on'} dark mode for this page`;
  syncPageTheme();
}
$('dark-mode').onclick = () => {
  darkMode = !darkMode;
  try { localStorage.setItem('voicesite.darkMode', String(darkMode)); } catch {}
  applyTheme();
};
$('original').addEventListener('load', syncPageTheme);
window.addEventListener('message', event => {
  if (event.source !== $('original').contentWindow || !event.data?.voicesite) return;
  if (event.data.type === 'ready') syncPageTheme();
  if (event.data.type === 'navigate' && typeof event.data.path === 'string' && /^\/https?:\/\//.test(event.data.path)) navigate(event.data.path);
});
applyTheme();
// Appearance controls remain usable even if audio initialization fails.
const player = createPlayer();

const date = value => new Date(value).toLocaleString(undefined, {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'});
async function api(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (response.status === 409 && result.verificationId && url === '/api/capture') {
    await verifyCapture(result.verificationId);
    return api(url, options);
  }
  if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.');
  return result;
}
function screen(name) { if (name !== 'viewer') { setFavicon(); player.reset(); closeUrlEditor(); } document.body.classList.toggle('viewing', name === 'viewer'); for (const id of ['home','admin','viewer','loading','error']) $(id).hidden = id !== name; }
function notify(message) { $('toast').textContent = message; $('toast').classList.add('visible'); setTimeout(() => $('toast').classList.remove('visible'), 2500); }
function fail(error) { screen('error'); $('error-message').textContent = error.message; }
const snapshotPath = (url, id) => `/${url}${id ? `#snapshot=${encodeURIComponent(id)}` : ''}`;
function navigate(path) { history.pushState(null, '', path); route(); }
function renderLibrary(admin = false) {
  const rows = admin ? adminSnapshots : snapshots;
  const list = $(admin ? 'admin-list' : 'archive-list');
  const query = $(admin ? 'admin-search' : 'search').value.toLowerCase();
  const filtered = rows.filter(s => `${s.title} ${s.url}`.toLowerCase().includes(query));
  $(admin ? 'admin-count' : 'archive-count').textContent = rows.length;
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.innerHTML = `<div class="empty-symbol">▤</div><h3>${query ? 'No pages found.' : admin ? 'No pages archived yet.' : 'Your next good read belongs here.'}</h3><p>${query ? 'Try a different title or website.' : admin ? 'Pages saved by anyone will appear here.' : 'Paste your first link above to start your collection.<br>We’ll keep the words and a saved view of the page.'}</p>`;
    list.append(empty); return;
  }
  for (const snapshot of filtered) {
    const domain = new URL(snapshot.finalUrl).hostname.replace(/^www\./,'');
    const row = document.createElement('a'); row.href = snapshotPath(snapshot.url, snapshot.id); row.className = 'archive-row';
    row.innerHTML = '<span class="site-letter"></span><div class="row-copy"><span class="row-meta"></span><h3></h3><span class="row-meta read-time"></span></div><span class="row-date"></span><span class="row-arrow">↗</span>';
    row.querySelector('.site-letter').textContent = domain[0].toUpperCase();
    row.querySelector('.row-meta').textContent = domain;
    row.querySelector('h3').textContent = snapshot.title;
    row.querySelector('.read-time').textContent = `${Math.max(1, Math.ceil(snapshot.wordCount / 220))} min read · Saved snapshot`;
    row.querySelector('.row-date').textContent = date(admin ? snapshot.capturedAt : snapshot.archivedAt || snapshot.capturedAt);
    list.append(row);
  }
}
async function showSnapshot(id, version, preserveView = false) {
  const doc = await api(`/api/snapshots/${encodeURIComponent(id)}`);
  const versions = await api(`/api/snapshots?url=${encodeURIComponent(doc.url)}`);
  if (version !== routeVersion) return;
  player.reset();
  const samePage = current?.id === doc.id;
  current = doc;
  $('reader-title').textContent = doc.title;
  player.setSnapshot(doc.id);
  document.title = `${doc.title} — Voicesite`;
  void setFavicon(doc.id);
  $('header-title').textContent = doc.title;
  $('header-title').title = `${doc.title} — click to open another URL`;
  closeUrlEditor();
  $('header-live-link').href = doc.finalUrl;
  $('article-meta').textContent = [doc.byline, `${Math.max(1, Math.ceil(doc.wordCount / 220))} min read`, `${doc.wordCount.toLocaleString()} words`].filter(Boolean).join(' · ');
  releaseArchiveLinks?.();
  $('reader-content').innerHTML = doc.readerHtml;
  releaseArchiveLinks = archiveLinks($('reader-content'), doc.finalUrl, location.origin, navigate);
  $('versions').replaceChildren(...versions.map(v => { const option = document.createElement('option'); option.value = v.id; option.textContent = date(v.capturedAt); option.title = new Date(v.capturedAt).toString(); option.selected = v.id === id; return option; }));
  $('versions').title = `Saved ${new Date(doc.capturedAt).toString()}`;
  if (!preserveView || !samePage) $('original').removeAttribute('src');
  setMode(preserveView ? mode : 'original'); screen('viewer');
}
function setMode(next) {
  mode = next;
  document.body.classList.toggle('original-view', next === 'original');
  $('reader').hidden = next !== 'reader'; $('original').hidden = next !== 'original';
  $('reader-mode').setAttribute('aria-pressed', String(next === 'reader'));
  player.setMode(next);
  if (next === 'original' && current && !$('original').getAttribute('src')) $('original').src = `/snapshots/${current.id}/original`;
}
async function saveUrl(url, fresh = false, replace = false) {
  const version = ++routeVersion; screen('loading');
  try {
    const result = await api('/api/capture', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url, fresh})});
    rememberArchive(result);
    if (version !== routeVersion) return;
    await showSnapshot(result.id, version);
    if (version === routeVersion) history[replace ? 'replaceState' : 'pushState'](null, '', snapshotPath(current.url));
  } catch (error) { if (version === routeVersion) fail(error); }
}
async function route() {
  const version = ++routeVersion;
  const path = location.pathname;
  if (path !== '/admin/recently-archived') lockAdmin();
  try {
    if (path === '/') {
      screen('home'); document.title = 'Voicesite — A quieter place for the web';
      snapshots = localArchive(); renderLibrary();
    } else if (path === '/admin/recently-archived') {
      screen('admin'); document.title = 'Global recently archived — Voicesite';
      await loadAdmin(version);
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
function lockAdmin() {
  adminSnapshots = [];
  $('admin-list').replaceChildren();
  $('admin-library').hidden = $('admin-logout').hidden = $('admin-count').hidden = true;
  $('admin-login').hidden = false;
}
async function loadAdmin(version = routeVersion) {
  lockAdmin(); $('admin-message').textContent = '';
  try {
    const rows = await api('/api/admin/snapshots');
    if (version !== routeVersion) return;
    adminSnapshots = rows;
    $('admin-login').hidden = true;
    $('admin-library').hidden = $('admin-logout').hidden = $('admin-count').hidden = false;
    renderLibrary(true);
  } catch (error) { if (version === routeVersion) $('admin-message').textContent = error.message; }
}
$('admin-login').onsubmit = async e => {
  e.preventDefault();
  const version = routeVersion;
  const button = e.target.querySelector('button'); button.disabled = true;
  try {
    await api('/api/admin/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: $('admin-password').value})});
    if (version === routeVersion) await loadAdmin(version);
  } catch (error) { if (version === routeVersion) $('admin-message').textContent = error.message; }
  finally { $('admin-password').value = ''; button.disabled = false; }
};
$('admin-logout').onclick = async () => {
  try { await api('/api/admin/logout', {method: 'POST'}); lockAdmin(); $('admin-message').textContent = 'Signed out.'; }
  catch (error) { $('admin-message').textContent = error.message; }
};
$('admin-search').addEventListener('input', () => renderLibrary(true));
window.addEventListener('storage', e => { if ((!e.key || e.key === LOCAL_ARCHIVE_KEY) && location.pathname === '/') { snapshots = localArchive(); renderLibrary(); } });
$('domain').textContent = location.host;
$('capture-form').addEventListener('submit', e => { e.preventDefault(); saveUrl($('url-input').value); });
$('search').addEventListener('input', () => renderLibrary());
let switchingView = false;
$('reader-mode').onclick = async () => {
  if (switchingView) return;
  switchingView = true;
  const page = current;
  try {
    await player.capturePosition();
    if (page === current) setMode(mode === 'reader' ? 'original' : 'reader');
  } finally { switchingView = false; }
};
function closeUrlEditor(focus = false) {
  $('header-url-form').hidden = true;
  $('header-title').hidden = false;
  $('header-title').setAttribute('aria-expanded','false');
  document.querySelector('.archive-header').classList.remove('editing-url');
  if (focus) $('header-title').focus();
}
$('header-title').onclick = () => {
  $('header-title').hidden = true;
  $('header-title').setAttribute('aria-expanded','true');
  $('header-url-form').hidden = false;
  document.querySelector('.archive-header').classList.add('editing-url');
  $('header-url').value = current?.url || '';
  $('header-url').focus(); $('header-url').select();
};
$('header-url-form').onsubmit = event => {
  event.preventDefault();
  const url = $('header-url').value.trim();
  if (!url) { $('header-url').focus(); return; }
  closeUrlEditor(); saveUrl(url);
};
$('header-url').onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); closeUrlEditor(true); }
};
$('header-url-form').addEventListener('focusout', event => {
  if (!$('header-url-form').contains(event.relatedTarget)) closeUrlEditor();
});
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
    rememberArchive(result);
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
$('dismiss-error').onclick = () => navigate('/');
window.addEventListener('popstate', route);
document.addEventListener('click', e => { const a = e.target.closest('a'); if (a && a.origin === location.origin && !a.target && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0 && (!a.hash || a.hash.startsWith('#snapshot='))) { e.preventDefault(); navigate(a.pathname + a.search + a.hash); window.scrollTo(0,0); } });
route();
