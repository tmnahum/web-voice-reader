import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { capture } from './capture.js';
import { normalizeUrl } from './fetch.js';
import { createStore } from './store.js';

export function createApp({store = createStore(process.env.ARCHIVE_DB || 'data/archive.sqlite3'), capturePage = capture} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({limit: '16kb'}));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  const active = new Map();
  app.get('/api/snapshots', (req, res) => { res.json(store.list(req.query.url ? normalizeUrl(req.query.url) : undefined)); });
  app.post('/api/capture', async (req, res) => {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin))) return res.status(403).json({error: 'Cross-origin captures are not allowed.'});
    let url;
    try { url = normalizeUrl(req.body?.url); } catch (error) { return res.status(400).json({error: error.message}); }
    if (!req.body.fresh) { const existing = store.list(url)[0]; if (existing) return res.json(existing); }
    if (!active.has(url) && active.size >= 2) return res.status(429).json({error: 'Two captures are already in progress. Please try again shortly.'});
    if (!active.has(url)) {
      const pending = capturePage(url).then(doc => store.save(doc)).finally(() => active.delete(url));
      active.set(url, pending);
    }
    try { const doc = await active.get(url); res.json({id: doc.id, unchanged: doc.unchanged, capturedAt: doc.capturedAt}); }
    catch (error) { res.status(422).json({error: error.message || 'This page could not be captured.'}); }
  });
  app.get('/api/snapshots/:id', (req, res) => {
    const doc = store.get(req.params.id); if (!doc) return res.status(404).json({error: 'Snapshot not found.'});
    const {originalHtml, ...data} = doc; res.json(data);
  });
  app.get('/snapshots/:id/original', (req, res) => {
    const doc = store.get(req.params.id); if (!doc) return res.status(404).send('Snapshot not found.');
    res.set('Content-Security-Policy', "default-src https: http: data: blob:; script-src https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; style-src https: http: data: 'unsafe-inline'; img-src https: http: data: blob:; font-src https: http: data:; connect-src https: http: wss: ws:; object-src 'none'; base-uri https: http:; form-action https: http:; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads");
    res.set('Cache-Control', 'no-store');
    res.type('html').send(doc.originalHtml);
  });
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  // Content-addressed URLs prevent a CDN from mixing an old app bundle with new HTML.
  const assets = ['app.js', 'style.css'].map(name => ({name, body: readFileSync(resolve(web, name))}));
  const revision = createHash('sha256').update(Buffer.concat(assets.map(a => a.body))).digest('hex').slice(0, 16);
  let shell = readFileSync(resolve(web, 'index.html'), 'utf8');
  for (const asset of assets) {
    const path = `/assets/${revision}/${asset.name}`;
    shell = shell.replace(`"/${asset.name}"`, `"${path}"`);
    app.get(path, (req, res) => res.set('Cache-Control', 'public, max-age=31536000, immutable').type(asset.name.endsWith('.js') ? 'js' : 'css').send(asset.body));
  }
  const sendShell = (req, res) => res.set('Cache-Control', 'no-store').type('html').send(shell);
  app.get(['/', '/index.html'], sendShell);
  app.use(express.static(web, {index: false, setHeaders: res => res.set('Cache-Control', 'no-cache')}));
  app.get('/assets/{*path}', (req, res) => res.status(404).send('Asset not found. Reload the page.'));
  app.get('/api/{*path}', (req, res) => res.status(404).json({error: 'Not found.'}));
  app.get('/{*path}', sendShell);
  app.use((error, req, res, next) => res.status(400).json({error: error.message || 'Invalid request.'}));
  return app;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 28767);
  createApp().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Voicesite is running at http://localhost:${port}`));
}
