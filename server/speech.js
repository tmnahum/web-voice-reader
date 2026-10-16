import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const voices = ['af_bella', 'am_michael', 'af_nicole', 'am_eric'];
export function createSpeech({spawnWorker = spawn} = {}) {
  let worker, active;
  const queue = [], cache = new Map();
  function pump() {
    if (active || !queue.length) return;
    if (!worker) {
      worker = spawnWorker(process.env.KOKORO_PYTHON || 'python3', [fileURLToPath(new URL('./speech-worker.py', import.meta.url))], {stdio: ['pipe', 'pipe', 'inherit']});
      const child = worker;
      const fail = () => {
        if (worker !== child) return;
        worker = null;
        if (active) { clearTimeout(active.timer); active.reject(new Error('Kokoro is unavailable. Check the local model configuration.')); active = null; }
        for (const job of queue.splice(0)) job.reject(new Error('Kokoro worker stopped. Please retry.'));
      };
      child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
      createInterface({input: child.stdout}).on('line', line => {
        if (!active || worker !== child) return;
        const job = active; active = null; clearTimeout(job.timer);
        try {
          const result = JSON.parse(line);
          if (result.error) throw new Error(result.error);
          cache.set(job.key, result);
          while (cache.size > 20) cache.delete(cache.keys().next().value);
          job.resolve(result);
        } catch (error) { job.reject(error); }
        pump();
      });
    }
    active = queue.shift();
    active.timer = setTimeout(() => worker?.kill(), 120000);
    worker.stdin.write(JSON.stringify(active.input) + '\n');
  }
  return {
    generate(input, signal, priority = 0) {
      if (!voices.includes(input?.voice) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 600) return Promise.reject(new Error('Choose a curated voice and supply 1–600 characters.'));
      const key = JSON.stringify(input);
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      if (queue.length >= 12) return Promise.reject(new Error('Speech queue is full. Please retry shortly.'));
      return new Promise((resolve, reject) => {
        const job = {input, key, resolve, reject, priority};
        queue.push(job);
        queue.sort((a,b) => b.priority - a.priority);
        signal?.addEventListener('abort', () => { const index = queue.indexOf(job); if (index >= 0) { queue.splice(index, 1); reject(new Error('Cancelled')); } }, {once: true});
        pump();
      });
    },
    prioritize(input, priority) {
      const key = JSON.stringify(input);
      const job = queue.find(job => job.key === key);
      if (job) { job.priority = Math.max(job.priority, priority); queue.sort((a,b) => b.priority - a.priority); }
    },
    close() { worker?.kill(); },
  };
}
