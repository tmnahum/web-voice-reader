import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPublic } from './fetch.js';

// One local inference at a time; concurrent callers share successful results.
export function createImageReading({directory = process.env.IMAGE_READING_DIR || 'data/image-reading', fetchImage = fetchPublic, analyze, spawnWorker = spawn} = {}) {
  const pending = new Map();
  let tail = Promise.resolve(), worker, active;
  function localAnalyze(body) {
    return new Promise((resolve, reject) => {
      if (!worker) {
        const child = spawnWorker(process.env.IMAGE_PYTHON || '.venv-images/bin/python', [fileURLToPath(new URL('./image-worker.py', import.meta.url))], {stdio:['pipe','pipe','inherit']});
        worker = child;
        const fail = () => {
          if (worker !== child) return;
          worker = null;
          if (active) { clearTimeout(active.timer); active.reject(new Error('Local image analysis is unavailable.')); active = null; }
        };
        child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
        createInterface({input:child.stdout}).on('line', line => {
          if (!active || worker !== child) return;
          const job = active; active = null; clearTimeout(job.timer);
          try { const result = JSON.parse(line); if (result.error) throw new Error(result.error); job.resolve(result); }
          catch (error) { job.reject(error); }
        });
      }
      active = {resolve, reject, timer:setTimeout(() => worker?.kill(), 90000)};
      worker.stdin.write(JSON.stringify({image:body.toString('base64')}) + '\n');
    });
  }
  return {
    read(snapshot, url) {
      if (typeof url !== 'string' || url.length > 8_000_000) return Promise.reject(new Error('Invalid image URL.'));
      const key = createHash('sha256').update(JSON.stringify(['v2', snapshot, url])).digest('hex');
      if (pending.has(key)) return pending.get(key);
      if (pending.size >= 64) return Promise.reject(new Error('Image queue is full. Try again shortly.'));
      const task = tail.then(async () => {
        const path = resolve(directory, `${key}.json`);
        try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        let body;
        if (url.startsWith('data:')) {
          const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([a-z\d+/=\s]+)$/i.exec(url);
          if (!match) throw new Error('Unsupported inline image.');
          body = Buffer.from(match[1], 'base64');
        } else {
          const result = await fetchImage(url, 6_000_000);
          if (!/^image\/(png|jpeg|webp|gif|bmp|tiff)(?:;|$)/i.test(result.type)) throw new Error('Unsupported image format.');
          body = result.body;
        }
        if (!body.length || body.length > 6_000_000) throw new Error('Image is too large or empty.');
        const result = await (analyze || localAnalyze)(body);
        if (!['ocr','caption','decorative'].includes(result.kind) || typeof result.text !== 'string' || result.text.length > 20000) throw new Error('Invalid image analysis.');
        if (result.ocrText !== undefined && (typeof result.ocrText !== 'string' || result.ocrText.length > 20000)) throw new Error('Invalid image analysis.');
        await mkdir(directory, {recursive:true});
        await writeFile(`${path}.tmp`, JSON.stringify(result));
        await rename(`${path}.tmp`, path);
        return result;
      });
      tail = task.catch(() => {});
      pending.set(key, task);
      task.finally(() => pending.delete(key)).catch(() => {});
      return task;
    },
    close() { worker?.kill(); },
  };
}
