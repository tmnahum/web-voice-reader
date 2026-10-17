const siteIcon = '/favicon.svg';
let generation = 0, controller;
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

// A PNG keeps the source image self-contained and works with ICO and SVG inputs.
export async function setFavicon(snapshotId) {
  const token = ++generation;
  controller?.abort();
  controller = new AbortController();
  const link = document.getElementById('favicon');
  link.type = 'image/svg+xml'; link.href = siteIcon;
  if (!snapshotId) return;
  try {
    const response = await fetch(`/api/snapshots/${encodeURIComponent(snapshotId)}/favicons`, {signal:controller.signal});
    if (!response.ok) return;
    const {icons} = await response.json();
    const badge = await loadImage(siteIcon);
    for (const src of icons) {
      if (token !== generation) return;
      try {
        const original = await loadImage(src);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const scale = Math.min(64 / original.naturalWidth, 64 / original.naturalHeight);
        const width = original.naturalWidth * scale, height = original.naturalHeight * scale;
        ctx.drawImage(original, (64 - width) / 2, (64 - height) / 2, width, height);
        // A light outline separates the badge from both dark and light site icons.
        ctx.fillStyle = '#f7f8f2'; ctx.beginPath(); ctx.roundRect(34, 34, 30, 30, 7); ctx.fill();
        ctx.drawImage(badge, 36, 36, 28, 28);
        const href = canvas.toDataURL('image/png');
        if (token !== generation) return;
        link.type = 'image/png'; link.href = href;
        return;
      } catch { /* Try the next declared icon if decoding fails. */ }
    }
  } catch { /* Keep the Voicesite icon when the source is unavailable. */ }
}
