import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { voices } from './speech.js';
import { splitReading } from '../web/reading.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function save(path, value) { writeFileSync(`${path}.tmp`, JSON.stringify(value)); renameSync(`${path}.tmp`, path); }

// Manifests belong to an immutable snapshot/view/voice/text sequence. Clips are
// content-addressed so repeated text is shared across renditions and restarts.
export function createRenditions({speech, directory = process.env.SPEECH_DIR || 'data/speech', resume = true}) {
  const root = resolve(directory), manifests = join(root, 'renditions'), clips = join(root, 'clips');
  mkdirSync(manifests, {recursive:true}); mkdirSync(clips, {recursive:true});
  const jobs = new Map(), pending = new Map(), durations = new Map();
  let pumping = false, closed = false, lastJob, priority = 0;
  const manifestPath = id => join(manifests, `${id}.json`);
  const clipPath = id => join(clips, `${id}.json`);
  const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
  function get(id) {
    if (!validId(id) || !existsSync(manifestPath(id))) throw new Error('Saved speech not found.');
    if (!jobs.has(id)) jobs.set(id, read(manifestPath(id)));
    return jobs.get(id);
  }
  function describe(job) {
    const chunks = job.chunks.map(c => {
      const ready = existsSync(clipPath(c.key));
      if (ready && !durations.has(c.key)) {
        const duration = read(clipPath(c.key)).duration;
        durations.set(c.key, Number.isFinite(duration) && duration >= 0 ? duration : null);
      }
      return {start:c.start, ready, duration:ready ? durations.get(c.key) : null};
    });
    const ready = chunks.filter(c => c.ready).length;
    return {id:job.id, voice:job.voice, view:job.view, chunks, ready, total:chunks.length,
      fullGeneration:job.generateAll, status:ready === chunks.length ? 'complete' : job.error ? 'error' : job.generateAll || job.chunks.some(c => pending.has(c.key)) ? 'generating' : 'idle', error:job.error || null};
  }
  async function chunk(id, index, priority = 0) {
    const job = get(id), part = job.chunks[index];
    if (!Number.isInteger(index) || !part) throw new Error('Speech chunk not found.');
    if (existsSync(clipPath(part.key))) return read(clipPath(part.key));
    const input = {voice:job.voice,text:part.text};
    if (priority) speech.prioritize?.(input, priority);
    if (!pending.has(part.key)) {
      const work = speech.generate(input, undefined, priority).then(result => {
        if (!result.audio || !Array.isArray(result.words)) throw new Error('Kokoro returned invalid speech.');
        save(clipPath(part.key), result); return result;
      }).finally(() => pending.delete(part.key));
      pending.set(part.key, work);
    }
    return pending.get(part.key);
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (!closed) {
        const available = [...jobs.values()].filter(j => j.generateAll && !j.error);
        if (!available.length) break;
        const job = available[(available.findIndex(j => j.id === lastJob) + 1) % available.length];
        lastJob = job.id;
        const index = job.chunks.findIndex(c => !existsSync(clipPath(c.key)));
        if (index < 0) { job.generateAll = false; save(manifestPath(job.id), job); continue; }
        try { await chunk(job.id, index); }
        catch (error) { job.error = error.message; job.generateAll = false; save(manifestPath(job.id), job); }
      }
    } finally { pumping = false; }
  }
  for (const file of readdirSync(manifests).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
    const job = read(join(manifests, file));
    if (resume && job.generateAll) jobs.set(job.id, job);
  }
  // Resume explicitly requested full-page work after a server restart.
  queueMicrotask(pump);
  return {
    ensure(snapshot, {voice, view, words}) {
      if (!voices.includes(voice) || !['reader','original'].includes(view) || !Array.isArray(words) || !words.length || words.length > 100000 || words.some(w => typeof w?.text !== 'string' || !w.text.trim() || /\s/u.test(w.text) || w.text.length > 600 || !Number.isInteger(w.sentence))) throw new Error('Invalid page text or voice.');
      words = words.map(({text,sentence}) => ({text,sentence}));
      const id = hash({version:1,snapshot,voice,view,words});
      if (!existsSync(manifestPath(id))) {
        const chunks = splitReading(words).map(c => ({...c,key:hash({version:1,voice,text:c.text})}));
        const job = {id,snapshot,voice,view,chunks,generateAll:false};
        save(manifestPath(id),job); jobs.set(id,job);
      }
      return describe(get(id));
    },
    status(id) { return describe(get(id)); },
    generate(id) {
      const job = get(id); job.generateAll = true; delete job.error;
      save(manifestPath(id),job); void pump(); return describe(job);
    },
    prioritize(id, index) {
      const job = get(id);
      if (!Number.isInteger(index) || !job.chunks[index]) throw new Error('Speech chunk not found.');
      delete job.error;
      const batch = ++priority * 4;
      // Latest seek wins over stale lookahead and background work. A running
      // inference finishes normally; the selected chunk runs next.
      for (let n = index; n < Math.min(index + 3, job.chunks.length); n++) {
        void chunk(id,n,batch + 3 - (n - index)).catch(error => { job.error = error.message; });
      }
      return describe(job);
    },
    chunk,
    close() { closed = true; },
  };
}

export function installRenditions(app, store, renditions) {
  const sameOrigin = (req,res,next) => {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && ![`http://${req.headers.host}`,`https://${req.headers.host}`].includes(req.headers.origin))) return res.status(403).json({error:'Cross-origin speech is not allowed.'});
    next();
  };
  app.post('/api/snapshots/:id/speech-renditions', sameOrigin, (req,res) => {
    if (!store.get(req.params.id)) return res.status(404).json({error:'Snapshot not found.'});
    try { res.json(renditions.ensure(req.params.id, req.body || {})); }
    catch (error) { res.status(400).json({error:error.message}); }
  });
  app.get('/api/speech-renditions/:id', (req,res) => {
    try { res.set('Cache-Control','no-store').json(renditions.status(req.params.id)); }
    catch (error) { res.status(404).json({error:error.message}); }
  });
  app.post('/api/speech-renditions/:id/prioritize', sameOrigin, (req,res) => {
    try { res.json(renditions.prioritize(req.params.id, req.body?.index)); }
    catch (error) { res.status(400).json({error:error.message}); }
  });
  app.post('/api/speech-renditions/:id/generate', sameOrigin, (req,res) => {
    try { res.json(renditions.generate(req.params.id)); }
    catch (error) { res.status(404).json({error:error.message}); }
  });
  app.post('/api/speech-renditions/:id/chunks/:index', sameOrigin, async (req,res) => {
    try { res.json(await renditions.chunk(req.params.id, Number(req.params.index))); }
    catch (error) { res.status(422).json({error:error.message}); }
  });
}
