import { randomUUID } from 'node:crypto';
import { logEvent, logUrl } from './diagnostics.js';

export class VerificationRequired extends Error {
  constructor(id) {
    super('This site needs a quick browser verification before we can save it.');
    this.verificationId = id;
  }
}

// Live browser handles stay server-side; all viewing/control endpoints require admin access.
export function createVerifications() {
  const entries = new Map();
  function prune() {
    for (const [id, entry] of entries) if (entry.expiresAt <= Date.now()) entries.delete(id);
  }
  return {
    create(url, page, reason = 'verification') {
      prune();
      const entry = {id:randomUUID(), url:logUrl(url), page, reason, status:'waiting', expiresAt:Date.now() + 5 * 60_000};
      entries.set(entry.id, entry);
      logEvent('browser.verification_required', {url:entry.url, verificationId:entry.id});
      return entry;
    },
    get(id) { prune(); return entries.get(id); },
    finish(entry, status) {
      if (!entry) return;
      entry.page = null;
      entry.status = status;
      entry.expiresAt = Date.now() + 2 * 60_000;
      logEvent(`browser.verification_${status}`, {verificationId:entry.id});
    },
  };
}
export const verifications = createVerifications();

export function installVerification(app, requireAdmin, manager = verifications) {
  const base = '/api/admin/verifications/:id';
  app.use(base, requireAdmin, (req, res, next) => {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin))) return res.status(403).json({error:'Cross-origin verification requests are not allowed.'});
    const entry = manager.get(req.params.id);
    if (!entry) return res.status(404).json({error:'This verification session has expired. Try saving the page again.'});
    res.locals.verification = entry;
    next();
  });
  app.get(base, (_req, res) => {
    const {id, url, status, expiresAt, reason, error, captureRequested} = res.locals.verification;
    const viewport = res.locals.verification.page?.captureViewport || {width:1280,height:900};
    res.json({id, url, status, expiresAt, viewport, reason, error, captureRequested:!!captureRequested});
  });
  app.get(`${base}/image`, async (_req, res) => {
    const entry = res.locals.verification;
    if (!entry.page || entry.status !== 'waiting') return res.status(409).json({error:'Verification is no longer waiting.'});
    try { res.type('jpeg').send(await entry.page.screenshot({type:'jpeg', quality:75, timeout:4000})); }
    catch { res.status(409).json({error:'The browser is changing pages. Try again.'}); }
  });
  app.post(`${base}/capture`, (_req, res) => {
    const entry = res.locals.verification;
    if (!entry.page || entry.status !== 'waiting') return res.status(409).json({error:'This browser session is no longer waiting.'});
    entry.error = null;
    entry.captureRequested = true;
    res.json({ok:true});
  });
  app.post(`${base}/input`, async (req, res) => {
    const entry = res.locals.verification;
    if (!entry.page || entry.status !== 'waiting') return res.status(409).json({error:'Verification is no longer waiting.'});
    if (entry.busy) return res.status(429).json({error:'Wait for the previous action to finish.'});
    entry.busy = true;
    try {
      const {type, x, y, key, text, deltaY} = req.body || {};
      const {width,height} = entry.page.captureViewport || {width:1280,height:900};
      const pointer = ['click','move','down','up'].includes(type) && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x < width && y >= 0 && y < height;
      const validKey = type === 'key' && ['Tab','Enter','Space','Backspace','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key);
      const validText = type === 'text' && typeof text === 'string' && text.length <= 200;
      const scroll = type === 'scroll' && Number.isFinite(deltaY) && Math.abs(deltaY) <= 900;
      if (!(pointer || validKey || validText || scroll)) return res.status(400).json({error:'Invalid browser action.'});
      if (entry.page.nativeInput) await entry.page.nativeInput({type,x,y,key,text,deltaY});
      else if (type === 'click') await entry.page.mouse.click(x,y);
      else if (pointer) {
        await entry.page.mouse.move(x,y);
        if (type === 'down') await entry.page.mouse.down();
        if (type === 'up') await entry.page.mouse.up();
      } else if (validKey) await entry.page.keyboard.press(key);
      else if (validText) await entry.page.keyboard.insertText(text);
      else await entry.page.mouse.wheel(0,deltaY);
      res.json({ok:true});
    } catch { res.status(409).json({error:'The browser is changing pages. Try again.'}); }
    finally { entry.busy = false; }
  });
  app.post(`${base}/cancel`, async (_req, res) => {
    const entry = res.locals.verification;
    entry.status = 'cancelled';
    await entry.page?.close().catch(() => {});
    res.json({ok:true});
  });
}
