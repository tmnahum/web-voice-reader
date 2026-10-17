import { studioWords, presets } from './studio-text.js';
const $ = id => document.getElementById(id);
const script = $('script'), example = script.value;
let settings = structuredClone(presets.gentle), revision = 0, rendered, urls = [], frame, activeAudio;
const players = ['original','processed'];
const fields = [['pitch','Pitch lift',-4,4,.1,' st'],['gain','Volume',-6,6,.5,' dB'],['stretch','Word length',1,1.4,.01,'%'],['echo','Echo',0,.6,.05,'%']];
const titles = {italic:['Italics','a little emphasis'],caps:['ALL CAPS','more intensity'],link:['Links','a sense of space']};
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function persist() { try { localStorage.setItem('voicesite-studio', JSON.stringify({text:script.value,settings,voice:$('voice').value})); } catch {} }
function stop() { players.forEach(k => $(`${k}-audio`).pause()); cancelAnimationFrame(frame); document.querySelectorAll('.speaking').forEach(n => n.classList.remove('speaking')); }
function invalidate() {
  revision++; stop(); rendered = null;
  for (const k of players) { const a = $(`${k}-audio`); a.removeAttribute('src'); a.load(); $(`${k}-download`).hidden = true; $(`${k}-duration`).textContent = k === 'original' ? 'Untouched delivery' : 'Your interpretation'; }
  urls.forEach(URL.revokeObjectURL); urls = [];
  status('Changes ready. Render to hear this version.'); persist();
}
function preview() {
  const words = studioWords(script.value), count = words.map(w => w.text).join(' ').length;
  $('count').textContent = `${count} / 600`;
  $('count').style.color = count > 600 ? '#ac483a' : '';
  $('reading').replaceChildren(...words.map((w, i) => {
    const b = document.createElement('button'); b.textContent = w.text;
    b.className = ['italic','caps','link'].filter(k => w[k]).join(' '); b.dataset.index = i;
    b.title = 'Seek to this word';
    b.onclick = () => {
      if (!rendered) return;
      const kind = activeAudio === $('original-audio') ? 'original' : 'processed';
      const word = rendered[kind].words.find(w => w.index === i);
      if (word) { const audio = $(`${kind}-audio`); audio.currentTime = word.start; audio.play().catch(e => status(e.message,true)); }
    };
    return b;
  }).flatMap(b => [b, document.createTextNode(' ')]));
}
function display(key, value) { return key === 'stretch' || key === 'echo' ? `${Math.round(value*100)}%` : `${value > 0 ? '+' : ''}${value.toFixed(1)}${key === 'pitch' ? ' st' : ' dB'}`; }
function controls() {
  $('effects').replaceChildren();
  for (const kind of Object.keys(titles)) {
    const section = document.createElement('section'); section.className = 'effect'; section.dataset.kind = kind;
    section.innerHTML = `<div class="effect-title"><div><strong>${titles[kind][0]}</strong><small>${titles[kind][1]}</small></div><label><input type="checkbox" aria-label="Enable ${titles[kind][0]}"> On</label></div><div class="sliders"></div>`;
    const enabled = section.querySelector('input'); enabled.checked = settings[kind].enabled;
    enabled.onchange = () => { settings[kind].enabled = enabled.checked; section.querySelectorAll('[type=range]').forEach(i => i.disabled = !enabled.checked); custom(); invalidate(); };
    for (const [key, name, min, max, step] of fields) {
      const label = document.createElement('label');
      label.innerHTML = `<span class="slider-label"><span>${name}</span><output></output></span><input type="range" min="${min}" max="${max}" step="${step}" aria-label="${titles[kind][0]} ${name}">`;
      const input = label.querySelector('input'), output = label.querySelector('output');
      input.value = settings[kind][key]; input.disabled = !enabled.checked; output.textContent = display(key, settings[kind][key]);
      input.oninput = () => { settings[kind][key] = Number(input.value); output.textContent = display(key, Number(input.value)); custom(); invalidate(); };
      section.querySelector('.sliders').append(label);
    }
    $('effects').append(section);
  }
}
function custom(name) { document.querySelectorAll('[data-preset]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.preset === name))); }
function preset(name) { settings = structuredClone(presets[name]); custom(name); controls(); invalidate(); }
try {
  const saved = JSON.parse(localStorage.getItem('voicesite-studio'));
  if (typeof saved?.text === 'string') script.value = saved.text;
  if (saved?.settings && Object.keys(presets.gentle).every(k => typeof saved.settings[k]?.enabled === 'boolean' && fields.every(([key,,min,max]) => Number.isFinite(saved.settings[k][key]) && saved.settings[k][key] >= min && saved.settings[k][key] <= max))) { settings = saved.settings; custom(); }
  if ([...$('voice').options].some(o => o.value === saved?.voice)) $('voice').value = saved.voice;
} catch {}
controls(); preview();
script.oninput = () => { preview(); invalidate(); };
$('voice').onchange = invalidate;
document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => preset(b.dataset.preset));
$('reset').onclick = () => preset('gentle');
$('example').onclick = () => { script.value = example; preview(); invalidate(); };
document.querySelectorAll('[data-mark]').forEach(b => b.onclick = () => {
  const start = script.selectionStart, end = script.selectionEnd;
  if (start === end) { status('Select some words in your script, then choose a mark.'); script.focus(); return; }
  const text = script.value.slice(start,end), mark = b.dataset.mark;
  const replacement = mark === 'caps' ? text.toUpperCase() : mark === 'italic' ? `*${text}*` : `[${text}]`;
  script.setRangeText(replacement,start,end,'select'); script.focus(); preview(); invalidate();
});
function tick() {
  if (!rendered || !activeAudio) return;
  const kind = activeAudio.id.startsWith('original') ? 'original' : 'processed';
  const word = rendered[kind].words.find(w => activeAudio.currentTime >= w.start && activeAudio.currentTime < w.end);
  $('reading').querySelectorAll('button').forEach(b => b.classList.toggle('speaking',Number(b.dataset.index) === word?.index));
  if (!activeAudio.paused) frame = requestAnimationFrame(tick);
}
for (const kind of players) {
  const audio = $(`${kind}-audio`);
  audio.onplay = () => { players.filter(k => k !== kind).forEach(k => $(`${k}-audio`).pause()); activeAudio = audio; cancelAnimationFrame(frame); tick(); };
  audio.onseeked = () => { activeAudio = audio; cancelAnimationFrame(frame); tick(); };
  audio.onended = () => { cancelAnimationFrame(frame); document.querySelectorAll('.speaking').forEach(n => n.classList.remove('speaking')); };
}
$('speed').onchange = () => players.forEach(k => $(`${k}-audio`).playbackRate = Number($('speed').value));
$('render').onclick = async () => {
  const words = studioWords(script.value);
  if (!words.length || words.map(w => w.text).join(' ').length > 600) { status('Enter between 1 and 600 spoken characters.',true); return; }
  const token = revision;
  $('render').disabled = true; $('render').textContent = 'Rendering…'; stop();
  status('Generating speech and shaping the delivery. The first render may take a little longer.');
  try {
    const response = await fetch('/api/effect-studio/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({words,settings,voice:$('voice').value})});
    const result = await response.json();
    if (token !== revision) return;
    if (!response.ok) throw new Error(result.error || 'Could not render audio.');
    rendered = result;
    urls.forEach(URL.revokeObjectURL); urls = [];
    for (const kind of players) {
      const bytes = Uint8Array.from(atob(result[kind].audio), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})); urls.push(url);
      const audio = $(`${kind}-audio`); audio.src = url; audio.playbackRate = Number($('speed').value);
      $(`${kind}-download`).href = url; $(`${kind}-download`).hidden = false;
      $(`${kind}-duration`).textContent = `${result[kind].duration.toFixed(2)} seconds`;
    }
    const delta = result.processed.duration-result.original.duration;
    status(`Ready to compare. Effects ${delta >= 0 ? 'add' : 'remove'} ${Math.abs(delta).toFixed(2)} seconds. Both versions have their own word timings.`);
  } catch (error) { if (token === revision) status(error.message,true); }
  finally { $('render').disabled = false; $('render').textContent = 'Render comparison →'; }
};
$('save-settings').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({version:1,voice:$('voice').value,text:script.value,settings},null,2)],{type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'voicesite-effects.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
};
