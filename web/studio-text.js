// Small, deliberately limited notation: *emphasis*, [link text], and ALL CAPS.
// Never interpreted as HTML. Offsets refer to the editable source.
export function studioWords(source) {
  const words = [];
  let italic = false, link = false, text = '', start = 0, marks = {};
  function flush(end) {
    if (!text) return;
    const letters = text.match(/\p{L}/gu) || [];
    words.push({text, italic:!!marks.italic, link:!!marks.link, caps:letters.length > 1 && text === text.toUpperCase() && text !== text.toLowerCase(), start, end});
    text = ''; marks = {};
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (/\s/u.test(c)) flush(i);
    else if (c === '*') italic = !italic;
    else if (c === '[') link = true;
    else if (c === ']') link = false;
    else {
      if (!text) start = i;
      text += c; marks.italic ||= italic; marks.link ||= link;
    }
  }
  flush(source.length);
  return words;
}
export const presets = {
  gentle: {italic:{enabled:true,pitch:1,gain:1,stretch:1.06,echo:0},caps:{enabled:true,pitch:0,gain:2,stretch:1.04,echo:0},link:{enabled:true,pitch:0,gain:0,stretch:1,echo:.2}},
  expressive: {italic:{enabled:true,pitch:1.8,gain:1.5,stretch:1.12,echo:0},caps:{enabled:true,pitch:.5,gain:3,stretch:1.08,echo:0},link:{enabled:true,pitch:0,gain:0,stretch:1,echo:.35}},
  obvious: {italic:{enabled:true,pitch:3,gain:2,stretch:1.25,echo:0},caps:{enabled:true,pitch:1,gain:5,stretch:1.15,echo:0},link:{enabled:true,pitch:0,gain:0,stretch:1,echo:.55}},
};
