import { archiveLinks } from '../web/archive-links.js';
import {closeCaptureBrowser} from './browser-capture.js';
import { installVerification } from './browser-verification.js';
import { captureDiagnostics } from './diagnostics.js';
import { installEffects } from './effects.js';
import { loadFavicons } from './favicons.js';
import express from 'express';
import { createImageReading } from './image-reading.js';
import { createRenditions, installRenditions } from './renditions.js';
import { createSpeech } from './speech.js';
import { readingSurface } from '../web/reading.js';
import { loadEnvFile } from 'node:process';
try { loadEnvFile(); } catch {}
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { capture } from './capture.js';
import { normalizeUrl } from './fetch.js';
import { createStore } from './store.js';
import { installAdmin } from './admin.js';

export function createApp({verificationManager, store = createStore(process.env.ARCHIVE_DB || 'data/archive.sqlite3'), capturePage = capture, faviconLoader = loadFavicons, adminPassword = process.env.ADMIN_PASSWORD, speech = createSpeech(), speechDirectory, resumeSpeech = false, imageReading = createImageReading()} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/snapshots/:id/speech-renditions', express.json({limit: '8mb'}));
  app.use('/api/snapshots/:id/image-reading', express.json({limit:'8mb'}));
  app.use('/api/effect-studio/render', express.json({limit:'64kb'}));
  app.use(express.json({limit: '16kb'}));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  const renditions = createRenditions({speech, directory:speechDirectory, resume:resumeSpeech});
  installRenditions(app, store, renditions);
  const active = new Map();
  app.post('/api/snapshots/:id/image-reading', async (req, res) => {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin))) return res.status(403).json({error:'Cross-origin image analysis is not allowed.'});
    if (!store.get(req.params.id)) return res.status(404).json({error:'Snapshot not found.'});
    try { res.json(await imageReading.read(req.params.id, req.body?.url)); }
    catch (error) { res.status(422).json({error:error.message}); }
  });
  app.post('/api/speech', async (req, res) => {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin))) return res.status(403).json({error: 'Cross-origin speech is not allowed.'});
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try { res.json(await speech.generate(req.body, controller.signal)); }
    catch (error) { if (!res.destroyed) res.status(422).json({error: error.message}); }
  });
  installEffects(app, speech);
  const requireAdmin = installAdmin(app, adminPassword);
  installVerification(app, requireAdmin, verificationManager);
  app.get('/api/admin/snapshots', requireAdmin, (req, res) => res.json(store.list()));
  app.get('/api/snapshots', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (typeof req.query.url === 'string' && req.query.url.trim()) return res.json(store.list(normalizeUrl(req.query.url)));
    requireAdmin(req, res, next);
  }, (req, res) => res.json(store.list()));
  app.post('/api/capture', async (req, res) => {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin))) return res.status(403).json({error: 'Cross-origin captures are not allowed.'});
    let url;
    try { url = normalizeUrl(req.body?.url); } catch (error) { return res.status(400).json({error: error.message}); }
    const mode = req.body.mode || 'auto';
    if (!['auto','html','browser'].includes(mode)) return res.status(400).json({error:'Invalid capture mode.'});
    if (!req.body.fresh && mode === 'auto') { const existing = store.list(url)[0]; if (existing?.wordCount > 0) return res.json(existing); }
    const key = `${mode}:${url}`;
    if (!active.has(key) && active.size >= 2) return res.status(429).json({error: 'Two captures are already in progress. Please try again shortly.'});
    if (!active.has(key)) {
      const pending = captureDiagnostics(url, async () => store.save(await capturePage(url, undefined, {mode}))).finally(() => active.delete(key));
      active.set(key, pending);
    }
    try { const doc = await active.get(key); res.json({id: doc.id, unchanged: doc.unchanged, capturedAt: doc.capturedAt, url: doc.url, finalUrl: doc.finalUrl, title: doc.title, wordCount: doc.wordCount}); }
    catch (error) { res.status(error.verificationId ? 409 : 422).json({error: error.message || 'This page could not be captured.', ...(error.verificationId ? {verificationId:error.verificationId} : {})}); }
  });
  app.get('/api/snapshots/:id/favicons', async (req, res) => {
    const doc = store.get(req.params.id);
    if (!doc) return res.status(404).json({error:'Snapshot not found.'});
    // Legacy snapshots never saved icon bytes. Recover once, without changing history.
    let icons = doc.favicons ?? store.recoveredFavicons(doc.id);
    if (!icons) {
      icons = await faviconLoader(doc);
      if (icons.length) store.saveRecoveredFavicons(doc.id, icons);
    }
    res.set('Cache-Control', 'private, max-age=3600').json({icons});
  });
  app.get('/api/snapshots/:id', (req, res) => {
    const doc = store.get(req.params.id); if (!doc) return res.status(404).json({error: 'Snapshot not found.'});
    const {originalHtml, favicons, ...data} = doc; res.json(data);
  });
  app.get('/snapshots/:id/original', (req, res) => {
    const doc = store.get(req.params.id); if (!doc) return res.status(404).send('Snapshot not found.');
    const nonce = randomBytes(18).toString('base64');
    const scripts = doc.scriptsDisabled ? `'nonce-${nonce}'` : "https: http: data: blob: 'unsafe-inline' 'unsafe-eval'";
    res.set('Content-Security-Policy', `default-src https: http: data: blob:; script-src ${scripts}; style-src https: http: data: 'unsafe-inline'; img-src https: http: data: blob:; font-src https: http: data:; connect-src https: http: wss: ws:; object-src 'none'; base-uri https: http:; form-action https: http:; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads`);
    res.set('Cache-Control', 'no-store');
    const bridge = `<script nonce="${nonce}">(() => {
      const send = (type, payload) => parent.postMessage({voicesite: true, type, ...payload}, '*');
      const themeStyle = document.createElement('style');
      themeStyle.textContent = \`
        :root { color-scheme: dark !important; background: #181c19 !important; }
        body, body *:not(img):not(video):not(canvas):not(svg):not(svg *) {
          background-color: #181c19 !important; color: #e0e5dc !important;
          border-color: #485146 !important; box-shadow: none !important; text-shadow: none !important;
        }
        body a, body a * { color: #b9d891 !important; }
        body input, body textarea, body select, body button, body pre, body code { background-color: #262d27 !important; }
        ::selection { background: #536b39 !important; color: #fff !important; }
      \`;
      // Theme messages must work even when the saved page cannot initialize speech.
      addEventListener('message', event => {
        if (event.source !== parent || !event.data?.voicesite || event.data.type !== 'theme') return;
        if (event.data.dark === true) document.head.append(themeStyle); else themeStyle.remove();
      });
      (${archiveLinks.toString()})(document, document.baseURI, location.origin, path => send('navigate', {path}));
      let buildToken;
      const surface = (${readingSurface.toString()})(document.body, words => send('words', {words, token:buildToken}), index => send('read', {index}), enabled => send('follow', {enabled}));
      addEventListener('message', event => {
        if (event.source !== parent || !event.data?.voicesite) return;
        if (event.data.type === 'images') send('images', {urls:surface.images(), token:event.data.token});
        if (event.data.type === 'build') { buildToken = event.data.token; surface.build(event.data.imageText); }
        if (event.data.type === 'anchor') send('anchor', {anchor:surface.anchor(), token:event.data.token});
        if (event.data.type === 'restore') surface.restore(event.data.anchor);
        if (event.data.type === 'highlight') surface.highlight(event.data.index, event.data.mode);
        if (event.data.type === 'follow') surface.setFollowing(event.data.enabled === true);
      });
      send('ready', {});
    })();</script>`;
    res.type('html').send(doc.originalHtml + bridge);
  });
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  // Content-addressed URLs prevent a CDN from mixing an old app bundle with new HTML.
  const assets = ['app.js', 'archive-links.js', 'style.css', 'reading.js', 'player.js', 'link-audio.js', 'favicon.js', 'favicon.png', 'favicon.svg', 'verification.js'].map(name => ({name, body: readFileSync(resolve(web, name))}));
  const revision = createHash('sha256').update(Buffer.concat(assets.map(a => a.body))).digest('hex').slice(0, 16);
  let shell = readFileSync(resolve(web, 'index.html'), 'utf8');
  for (const asset of assets) {
    const path = `/assets/${revision}/${asset.name}`;
    shell = shell.replace(`"/${asset.name}"`, `"${path}"`);
    app.get(path, (req, res) => res.set('Cache-Control', 'public, max-age=31536000, immutable').type(asset.name.split('.').pop()).send(asset.body));
  }
  const sendShell = (req, res) => res.set('Cache-Control', 'no-store').type('html').send(shell);
  app.get(['/', '/index.html'], sendShell);
  app.get(['/effect-studio', '/effect-studio/'], (req, res) => res.set('Cache-Control','no-store').sendFile(resolve(web, 'studio.html')));
  app.get('/favicon.ico', (req, res) => res.type('png').sendFile(resolve(web, 'favicon.png')));
  app.use(express.static(web, {index: false, setHeaders: res => res.set('Cache-Control', 'no-cache')}));
  app.get('/assets/{*path}', (req, res) => res.status(404).send('Asset not found. Reload the page.'));
  app.get('/api/{*path}', (req, res) => res.status(404).json({error: 'Not found.'}));
  app.get('/{*path}', sendShell);
  app.use((error, req, res, next) => res.status(400).json({error: error.message || 'Invalid request.'}));
  return app;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 28767);
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, async () => {
    await closeCaptureBrowser();
    process.exit(0);
  });
  createApp({resumeSpeech:true}).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Voicesite is running at http://localhost:${port}`));
}
