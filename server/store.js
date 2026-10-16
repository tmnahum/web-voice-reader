import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
// Timing and download bookkeeping are not changes to the captured page.
export function comparableHtml(html) {
  return html
    // Cloudflare adds a per-request challenge, not page content. Keep it in
    // replay HTML, but don't create versions for its Ray ID or timestamp.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, script => {
      const challenge = /\bwindow\.__CF\$cv\$params\s*=/.test(script) && script.includes('/cdn-cgi/challenge-platform/');
      const external = /^<script\b[^>]*\bsrc=["'][^"']*\/cdn-cgi\/challenge-platform\//i.test(script);
      return challenge || external ? '' : script;
    })
    // CSP nonces authorize a response; they aren't content changes.
    .replace(/<(?:script|style)\b[^>]*>/gi, tag => tag.replace(/\snonce=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''));
}
function content(doc) {
  const { capturedAt, assets, ...page } = doc;
  return {...page, originalHtml: comparableHtml(page.originalHtml)};
}
export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, url TEXT NOT NULL, captured_at TEXT NOT NULL, document TEXT NOT NULL); CREATE INDEX IF NOT EXISTS snapshots_url ON snapshots(url, captured_at);');
  const summary = row => { const d = JSON.parse(row.document); const {originalHtml, readerHtml, blocks, text, ...meta} = d; return {id: row.id, ...meta}; };
  return {
    save(doc) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const latest = db.prepare('SELECT * FROM snapshots WHERE url = ? ORDER BY captured_at DESC, rowid DESC LIMIT 1').get(doc.url);
        const unchanged = !!latest && isDeepStrictEqual(content(JSON.parse(latest.document)), content(doc));
        const id = unchanged ? latest.id : randomUUID();
        if (unchanged) db.prepare('UPDATE snapshots SET captured_at = ?, document = ? WHERE id = ?').run(doc.capturedAt, JSON.stringify(doc), id);
        else db.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?)').run(id, doc.url, doc.capturedAt, JSON.stringify(doc));
        db.exec('COMMIT');
        return {id, ...doc, unchanged};
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    get(id) { const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id); return row ? {id, ...JSON.parse(row.document)} : null; },
    list(url) { const rows = url ? db.prepare('SELECT * FROM snapshots WHERE url = ? ORDER BY captured_at DESC, rowid DESC').all(url) : db.prepare('SELECT * FROM snapshots ORDER BY captured_at DESC, rowid DESC LIMIT 100').all(); return rows.map(summary); },
    close() { db.close(); }
  };
}
