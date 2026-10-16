import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export function createStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, url TEXT NOT NULL, captured_at TEXT NOT NULL, document TEXT NOT NULL); CREATE INDEX IF NOT EXISTS snapshots_url ON snapshots(url, captured_at);');
  const summary = row => { const d = JSON.parse(row.document); const {originalHtml, readerHtml, blocks, text, ...meta} = d; return {id: row.id, ...meta}; };
  return {
    save(doc) { const id = randomUUID(); db.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?)').run(id, doc.url, doc.capturedAt, JSON.stringify(doc)); return {id, ...doc}; },
    get(id) { const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id); return row ? {id, ...JSON.parse(row.document)} : null; },
    list(url) { const rows = url ? db.prepare('SELECT * FROM snapshots WHERE url = ? ORDER BY captured_at DESC').all(url) : db.prepare('SELECT * FROM snapshots ORDER BY captured_at DESC LIMIT 100').all(); return rows.map(summary); },
    close() { db.close(); }
  };
}
