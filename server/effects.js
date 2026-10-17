import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function validateEffects(body) {
  if (!Array.isArray(body?.words) || !body.words.length || body.words.length > 300) throw new Error('Enter some text (up to 600 characters).');
  const words = body.words.map(w => {
    if (typeof w?.text !== 'string' || !w.text || /\s/u.test(w.text)) throw new Error('Invalid word.');
    return {text:w.text, italic:w.italic === true, caps:w.caps === true, link:w.link === true};
  });
  if (words.map(w => w.text).join(' ').length > 600) throw new Error('Keep this listening sample to 600 characters.');
  const settings = {};
  for (const kind of ['italic','caps','link']) {
    const value = body.settings?.[kind];
    if (!value || typeof value.enabled !== 'boolean') throw new Error('Invalid effect settings.');
    settings[kind] = {enabled:value.enabled};
    for (const [key, min, max] of [['pitch',-4,4],['gain',-6,6],['stretch',1,1.4],['echo',0,.6]]) {
      if (!Number.isFinite(value[key]) || value[key] < min || value[key] > max) throw new Error(`Invalid ${key} setting.`);
      settings[kind][key] = value[key];
    }
  }
  return {words, settings, voice:body.voice};
}

export function renderEffects(input) {
  return new Promise((resolve, reject) => {
    const python = process.env.EFFECTS_PYTHON || fileURLToPath(new URL('../.venv-effects/bin/python', import.meta.url));
    const child = spawn(python, [fileURLToPath(new URL('./effects-worker.py', import.meta.url))], {stdio:['pipe','pipe','pipe']});
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Audio processing timed out.')); }, 30000);
    child.stdout.on('data', data => { output += data; if (output.length > 20_000_000) child.kill(); });
    child.stderr.on('data', data => { error = (error+data).slice(-2000); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Effect processor unavailable. Install server/effects-requirements.txt in .venv-effects.')); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (code || result.error) throw new Error(result.error || error || 'Audio processing failed.');
        resolve(result);
      } catch (e) { reject(new Error(e.message || 'Audio processing failed.')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function installEffects(app, speech, render = renderEffects) {
  let active = 0;
  app.post('/api/effect-studio/render', async (req, res) => {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin))) return res.status(403).json({error:'Cross-origin processing is not allowed.'});
    let input;
    try { input = validateEffects(req.body); }
    catch (error) { return res.status(400).json({error:error.message}); }
    if (active >= 2) return res.status(429).json({error:'The studio is busy. Try again in a moment.'});
    active++;
    try {
      const source = await speech.generate({text:input.words.map(w => w.text).join(' '), voice:input.voice});
      const processed = await render({...input, source});
      res.set('Cache-Control','no-store').json({original:source, processed});
    } catch (error) { res.status(422).json({error:error.message}); }
    finally { active--; }
  });
}
