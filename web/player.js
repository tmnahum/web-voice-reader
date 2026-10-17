import { readingSurface, readingProgress, formatReadingTime } from './reading.js';
import { addLinkEcho } from './link-audio.js';
const $ = id => document.getElementById(id);
async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Speech request failed. Please retry.');
  return value;
}
export function createPlayer() {
  let preparation = 0, preparing = false, position = null, completed = false;
  let snapshot, mode = 'original', surface, words = [], index = 0, generation = 0, context = 0;
  let running = false, paused = false, speed = 1, audio, frame, objectUrl, poll;
  let rendition, loadingRendition, clip = 0, currentWords = [], pending = new Map();
  function showError(text) {
    $('generate-speech').textContent = 'Retry speech';
    $('generate-speech').disabled = false;
    $('generate-speech').title = text;
    $('toast').textContent = text; $('toast').classList.add('visible');
    setTimeout(() => $('toast').classList.remove('visible'), 4000);
  }
  function highlight(i) {
    if (mode === 'reader') surface?.highlight(i, 'word');
    else $('original').contentWindow?.postMessage({voicesite:true,type:'highlight',index:i,mode:'word'}, '*');
  }
  function button() { $('play').textContent = running && !paused ? 'Ⅱ' : '▶'; $('play').setAttribute('aria-label', running && !paused ? 'Pause reading' : 'Read aloud'); }
  function renderReadTime() {
    const estimate = $('read-time');
    if (preparing || !words.length) {
      estimate.textContent = '0:00 / --:--';
      estimate.title = 'Preparing audio timeline';
      return;
    }
    const progress = readingProgress(words.length, rendition?.chunks, index, position, completed);
    const label = `${formatReadingTime(progress.current)} / ${progress.estimated ? '≈' : ''}${formatReadingTime(progress.total)}`;
    if (estimate.textContent !== label) estimate.textContent = label;
    estimate.title = progress.estimated
      ? 'Audio position / estimated total. Ungenerated chunks use 180 words per minute; earlier estimates may also affect the position.'
      : 'Audio position / total duration';
  }

  function renderSaved() {
    renderReadTime();
    $('play').disabled = preparing;
    if (preparing) { $('generate-speech').disabled = true; $('generate-speech').textContent = 'Preparing images…'; $('generate-speech').setAttribute('aria-busy', 'true'); return; }
    const state = rendition?.status;
    $('generate-speech').disabled = !words.length || rendition?.fullGeneration && state === 'generating' || state === 'complete';
    $('generate-speech').textContent = state === 'complete' ? '✓ Speech saved' : state === 'generating' ? `Saving ${rendition.ready}/${rendition.total}` : state === 'error' ? 'Retry generation' : rendition?.ready ? `Generate speech · ${rendition.ready}/${rendition.total}` : 'Generate speech';
    $('generate-speech').title = state === 'complete' ? 'Saved on the server for this page version and voice' : rendition?.error || 'Generate and save the entire page in this voice';
    $('generate-speech').setAttribute('aria-busy', String(state === 'generating'));
  }
  function watchSaved() {
    clearTimeout(poll);
    if (!rendition) return;
    const id = rendition.id, token = context;
    poll = setTimeout(async () => {
      try {
        const value = await api(`/api/speech-renditions/${id}`);
        if (token !== context || rendition?.id !== id) return;
        rendition = value; renderSaved();
        if (value.status === 'generating' || running) watchSaved();
      } catch { if (token === context) watchSaved(); }
    }, 1500);
  }
  async function ensure() {
    if (rendition) return rendition;
    if (preparing) throw new Error('Images are being prepared. Please try again shortly.');
    if (!snapshot || !words.length) throw new Error('Page is loading. Please try again shortly.');
    if (!loadingRendition) {
      const token = context;
      loadingRendition = api(`/api/snapshots/${encodeURIComponent(snapshot)}/speech-renditions`, {voice:$('voice').value,view:mode,words}).then(value => {
        if (token !== context) throw new Error('Reading view changed.');
        rendition = value; renderSaved(); watchSaved(); return value;
      }).finally(() => { if (token === context) loadingRendition = null; });
    }
    return loadingRendition;
  }
  function reset() {
    closeSpeeds(); generation++; audio?.pause(); audio = null; cancelAnimationFrame(frame); clearTimeout(poll);
    if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null;
    running = paused = false; pending.clear(); highlight(-1); button();
  }
  function invalidate() { position = null; completed = false; context++; rendition = loadingRendition = null; clearTimeout(poll); pending.clear(); }
  function acceptWords(value) {
    if (JSON.stringify(value) !== JSON.stringify(words)) { invalidate(); words = value; }
    renderSaved();
    const token = context;
    ensure().catch(error => { if (token === context) showError(error.message); });
  }
  async function prepareImages(urls, token) {
    if (token !== preparation) return;
    const page = snapshot, imageText = Object.create(null);
    let failed = 0, cursor = 0;
    // Bound browser concurrency; the server serializes local inference.
    await Promise.all(Array.from({length:2}, async () => {
      while (cursor < urls.length && token === preparation) {
        const url = urls[cursor++];
        try {
          const result = await api(`/api/snapshots/${encodeURIComponent(page)}/image-reading`, {url});
          imageText[url] = result;
        } catch { failed++; imageText[url] = 'Image description unavailable.'; }
        if (token === preparation) $('generate-speech').textContent = `Preparing images ${Object.keys(imageText).length}/${urls.length}…`;
      }
    }));
    if (token !== preparation) return;
    preparing = false;
    if (mode === 'reader') surface?.build(imageText);
    else $('original').contentWindow?.postMessage({voicesite:true,type:'build',imageText,token}, '*');
    renderSaved();
    if (failed) {
      $('toast').textContent = `${failed} image${failed === 1 ? '' : 's'} could not be read. Text playback is available; switch views to retry.`;
      $('toast').classList.add('visible');
      setTimeout(() => $('toast').classList.remove('visible'), 6000);
    }
  }
  function prepare() {
    if (!snapshot) return;
    const token = ++preparation;
    reset(); invalidate(); words = []; index = 0; preparing = true; renderSaved();
    if (mode === 'reader') {
      surface?.destroy(); surface = readingSurface($('reader'), acceptWords, start);
      prepareImages(surface.images(), token);
    } else $('original').contentWindow?.postMessage({voicesite:true,type:'images',token}, '*');
  }
  function request(n) {
    if (n >= rendition.chunks.length || pending.has(n)) return;
    const promise = api(`/api/speech-renditions/${rendition.id}/chunks/${n}`, {});
    promise.catch(() => {}); pending.set(n,promise);
  }
  function tick() {
    if (!audio || !running) return;
    const word = currentWords.find(w => audio.currentTime >= w.start && audio.currentTime < w.end);
    if (word) { index = rendition.chunks[clip].start + word.index; highlight(index); }
    else if (!paused) highlight(-1);
    position = {chunk:clip, time:audio.currentTime};
    renderReadTime();
    frame = requestAnimationFrame(tick);
  }
  async function playChunk(n, token, seekIndex) {
    if (token !== generation) return;
    if (n >= rendition.chunks.length) { reset(); completed = true; index = 0; renderSaved(); watchSaved(); return; }
    audio?.pause(); audio = null;
    clip = n;
    if (seekIndex === undefined) position = {chunk:n, time:0};
    renderReadTime();
    try {
      {
        if (!rendition.chunks[n].ready) {
          $('generate-speech').textContent = `Saving ${rendition.ready}/${rendition.total}`;
          $('generate-speech').setAttribute('aria-busy','true');
        }
        const value = await api(`/api/speech-renditions/${rendition.id}/prioritize`, {index:n});
        if (token !== generation) return;
        rendition = value; renderSaved(); watchSaved();
      }
      request(n); request(n + 1); request(n + 2);
      const result = await pending.get(n);
      if (token !== generation) return;
      pending.delete(n); rendition.chunks[n].ready = true;
      if (Number.isFinite(result.duration)) rendition.chunks[n].duration = result.duration;
      audio?.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const bytes = Uint8Array.from(atob(result.audio), c => c.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([addLinkEcho(bytes, result.words, words, rendition.chunks[n].start)], {type:'audio/wav'}));
      const nextAudio = new Audio(); audio = nextAudio; currentWords = result.words;
      await new Promise((resolve,reject) => { nextAudio.onloadedmetadata = resolve; nextAudio.onerror = () => reject(new Error('Saved audio could not load. Please retry.')); nextAudio.src = objectUrl; });
      if (token !== generation) return;
      rendition.chunks[n].duration = audio.duration;
      audio.playbackRate = speed;
      if (seekIndex !== undefined) {
        const local = seekIndex - rendition.chunks[n].start;
        const timing = result.words.find(w => w.index >= local);
        if (timing) audio.currentTime = timing.start;
      }
      audio.onended = () => { cancelAnimationFrame(frame); playChunk(n + 1,token); };
      audio.onerror = () => { if (token === generation) { reset(); showError('Audio could not play. Press Read to retry.'); } };
      if (!paused) {
        try { await audio.play(); }
        catch { if (token !== generation) return; paused = true; button(); showError('Press Read to play saved audio'); }
      }
      if (token !== generation) return;
      cancelAnimationFrame(frame); tick(); watchSaved();
    } catch (error) {
      if (token !== generation) return;
      reset(); showError(error.message || 'Speech failed. Please retry.');
    }
  }
  async function start(at = 0) {
    reset();
    completed = false; position = null; index = at; running = true; button(); highlight(at); renderReadTime();
    const token = generation;
    try {
      await ensure();
      if (token !== generation) return;
      let n = rendition.chunks.findIndex((c,i,all) => c.start <= at && (!all[i + 1] || all[i + 1].start > at));
      if (n < 0) n = 0;
      await playChunk(n,token,at);
    } catch (error) { if (token === generation) { reset(); showError(error.message); } }
  }
  $('play').onclick = async () => {
    if (!running) { start(index); return; }
    paused = !paused; button();
    if (paused) { audio?.pause(); }
    else if (audio?.src) { try { await audio.play(); } catch { paused = true; button(); showError('Press Read to resume audio.'); } }
  };
  $('generate-speech').onclick = async () => {
    const token = context;
    $('generate-speech').disabled = true;
    try {
      const saved = await ensure();
      if (token !== context) return;
      const value = await api(`/api/speech-renditions/${saved.id}/generate`, {});
      if (token !== context) return;
      rendition = value; renderSaved(); watchSaved();
    } catch (error) { if (token === context) { renderSaved(); showError(error.message); } }
  };
  $('voice').onchange = () => {
    const resume = running && !paused;
    reset(); invalidate(); renderSaved();
    if (resume) start(index); else { const token = context; ensure().catch(error => { if (token === context) showError(error.message); }); }
  };
  function closeSpeeds() { $('speed-presets').hidden = true; $('speed').setAttribute('aria-expanded','false'); }
  function setSpeed(value) {
    speed = Math.max(.25, Math.min(3, Math.round(value * 100) / 100));
    $('speed').textContent = `${speed}×`;
    $('speed').setAttribute('aria-label', `Reading speed ${speed}×. Choose a preset`);
    $('slower').disabled = speed <= .25; $('faster').disabled = speed >= 3;
    $('speed-presets').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(Number(button.dataset.speed) === speed)));
    if (audio) audio.playbackRate = speed;
    renderReadTime();
  }
  $('slower').onclick = () => setSpeed(speed - .1);
  $('faster').onclick = () => setSpeed(speed + .1);
  $('speed').onclick = () => {
    const open = $('speed-presets').hidden;
    $('speed-presets').hidden = !open; $('speed').setAttribute('aria-expanded',String(open));
    if (open) ($('speed-presets').querySelector('[aria-pressed="true"]') || $('speed-presets').querySelector('button')).focus();
  };
  $('speed-presets').onclick = event => {
    const button = event.target.closest('[data-speed]');
    if (button) { setSpeed(Number(button.dataset.speed)); closeSpeeds(); $('speed').focus(); }
  };
  document.addEventListener('click', event => { if (!event.target.closest('.speed-picker')) closeSpeeds(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('speed-presets').hidden) { closeSpeeds(); $('speed').focus(); } });
  window.addEventListener('blur', closeSpeeds);
  setSpeed(1);
  window.addEventListener('message', event => {
    if (event.source !== $('original').contentWindow || !event.data?.voicesite || mode !== 'original') return;
    if (event.data.type === 'ready') prepare();
    if (event.data.type === 'images' && event.data.token === preparation && Array.isArray(event.data.urls)) prepareImages([...new Set(event.data.urls.filter(url => typeof url === 'string'))], event.data.token);
    if (event.data.type === 'words' && event.data.token === preparation && Array.isArray(event.data.words)) acceptWords(event.data.words.filter(w => typeof w.text === 'string' && Number.isInteger(w.sentence)));
    if (event.data.type === 'read' && Number.isInteger(event.data.index) && words[event.data.index]) start(event.data.index);
  });
  $('original').addEventListener('load', () => { if (mode === 'original') prepare(); });
  return {reset, setSnapshot(id) { preparation++; preparing = false; snapshot = id; words = []; index = 0; invalidate(); }, setMode(next) { preparation++; preparing = false; mode = next; words = []; index = 0; invalidate(); renderSaved(); requestAnimationFrame(prepare); }};
}
