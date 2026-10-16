// Process the worker's PCM WAV locally so saved speech also gets link cues.
// Keep its length intact: seeking, playback speed and word timings still match.
export function addLinkEcho(bytes, timings, words, offset = 0) {
  const ranges = [];
  let lastIndex = -2;
  for (const word of [...timings].sort((a, b) => a.index - b.index)) {
    if (!words[offset + word.index]?.link || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) continue;
    if (word.index === lastIndex + 1) ranges.at(-1).end = Math.max(ranges.at(-1).end, word.end);
    else ranges.push({start: word.start, end: word.end});
    lastIndex = word.index;
  }
  if (!ranges.length || bytes.length < 44) return bytes;
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return bytes;
  let channels, rate, data, size;
  for (let at = 12; at + 8 <= bytes.length;) {
    const length = input.getUint32(at + 4, true), start = at + 8;
    if (start + length > bytes.length) return bytes;
    if (tag(at) === 'fmt ') {
      if (length < 16 || input.getUint16(start, true) !== 1 || input.getUint16(start + 14, true) !== 16) return bytes;
      channels = input.getUint16(start + 2, true);
      rate = input.getUint32(start + 4, true);
    }
    if (tag(at) === 'data') { data = start; size = length; }
    at = start + length + (length % 2);
  }
  if (!channels || !rate || data === undefined) return bytes;
  const output = bytes.slice(), view = new DataView(output.buffer);
  const frames = Math.floor(size / (channels * 2));
  const taps = [[.035, .22], [.065, .14], [.100, .09]].map(([delay, gain]) => [Math.max(1, Math.round(delay * rate)), gain]);
  const fade = Math.max(1, Math.round(rate * .008));
  for (const range of ranges) {
    const start = Math.max(0, Math.floor(range.start * rate));
    const end = Math.min(frames, Math.ceil(range.end * rate));
    for (let frame = start; frame < end; frame++) {
      const wet = Math.min(1, (frame - start) / fade, (end - 1 - frame) / fade);
      for (let channel = 0; channel < channels; channel++) {
        const at = data + (frame * channels + channel) * 2;
        const dry = input.getInt16(at, true);
        let echo = 0;
        for (const [delay, gain] of taps) {
          if (frame - delay >= start) echo += input.getInt16(at - delay * channels * 2, true) * gain;
        }
        // The dry signal stays prominent, with headroom for the reflections.
        view.setInt16(at, Math.round(dry * (1 - .45 * wet) + echo * wet), true);
      }
    }
  }
  return output;
}
