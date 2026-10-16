# Voicesite

A self-hosted reading and listening app, separate from Readroom. Speech uses **Kokoro only**, on the server.

## Start

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock
cp .env.example .env
# Set your Kokoro Python and model directory in .env.
./scripts/start.sh
```

Open http://localhost:28766. On the development machine, the ignored `.env` points to the existing Kokoro runtime and model files in `../voice`; no Readroom code, service, or library is modified. Voicesite has its own server environment, database, audio cache, and source code. The model weights and inference Python environment are currently shared read-only.

For a separate machine, install Kokoro and its English pronunciation dependencies in an inference environment (`kokoro`, `soundfile`, `numpy`, `torch`, `espeakng-loader`, and the English spaCy model required by Misaki). Download `config.json`, `kokoro-v1_0.pth`, and the four voice files (`af_bella`, `am_michael`, `af_nicole`, `am_eric`) from [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), preserving the `voices/` directory. Set the two paths in `.env`. A reproducible dedicated inference installer is still on the roadmap. Inference disables Hugging Face network access; installing dependencies and obtaining weights requires network access.

## This first version

- Save a public HTML page to a persistent SQLite library.
- Preserve text across the whole page, including comments and author labels present in the HTML; retain detected reply indentation.
- Keep link destinations and text offsets, plus stable references to original page elements.
- Switch between a quiet reader and a sandboxed saved original page.
- Choose article plus comments, article only, comments only, or all page text.
- Read passages with four Kokoro English voices (Bella, Michael, Nicole, Eric), playback speed, and cached WAV audio. Click a passage to start there.
- A built-in sample demonstrates comments and nested replies without fetching a website.

## Honest capture limits

This is a **static HTML capture**, not yet full Internet Archive-style browser recording. It saves up to 40 image and stylesheet resources (2 MB each, main HTML 4 MB). Scripts, embedded frames, forms, remote fonts, and CSS background assets are not replayed. CSS external requests are blocked. JavaScript-loaded comments, pagination, authentication, and “load more” require the browser-capture stage below. Every saved document displays these limits. Missing assets are counted.

Comment detection currently uses common HTML markers such as `comments`, `reply`, and `discussion`; site-specific layouts may be misclassified. All captured text remains available under “All page text.” Reader mode preserves content order but does not yet reconstruct complex tables. Image alt text is retained; OCR and generated image descriptions are not implemented. CSS-hidden text can still enter the reading list. Original-view positioning follows the current playback passage, not arbitrary manual scrolling.

Kokoro generates one passage per subprocess, with a single concurrency lock, a 180-second timeout, and persistent audio caching. This initial version reloads the model per uncached passage; a persistent worker, prefetching, recoverable queue, and cancellation are follow-ups. Stopping the player stops playback; a submitted server generation can finish and cache its audio. Word timings are saved, but word highlighting and link effects are not yet connected to the player.

## Data and access

`data/library.sqlite3` contains saved HTML and reading blocks. `data/audio/` contains generated speech and timing metadata. Back up `data/` to preserve the library. `.env`, data, models, and environments are Git-ignored.

The service binds to loopback by default. There is no account system; add authentication before exposing a shared deployment. URL captures reject private addresses, validate redirects, and pin DNS. Saved pages have scripts removed, sandboxed frames, and a restrictive content security policy. Cross-origin writes are rejected. Capture requests contact source websites; listening uses local models. No external fonts, analytics, or cloud AI services are used by the app.

## Checks

```bash
.venv/bin/python -m pytest -q
node --check static/app.js
```

## Next

1. Browser-based capture and replay, including loaded comment threads, better capture completeness reporting, and full asset preservation.
2. Persistent Kokoro worker, prefetch, queue/cancel controls, saved reading positions, word highlighting, and configurable link audio effects.
3. Evaluate locally runnable image description and OCR models against the server hardware; attach results to image blocks and avoid duplicate narration.
4. Better comment/reply attribution, site adapters, tables, accessibility structure, and original/reader scroll synchronization.
5. Standalone installation, pinned inference dependencies, authentication, and deployment packaging.

## Initial validation

10 automated checks pass for comment/reply preservation, repeated-link offsets, source anchors, active-content removal, URL restrictions, persistence, and API validation. A real public-page capture and real Kokoro WAV generation with timing metadata succeeded on the development machine. JavaScript syntax was checked. The collaborative browser returned connection refused for this machine’s loopback URL, so visual/browser interaction testing remains pending.

## Deployment

Public URL: https://voicesite.remoth.net

The `voicesite.service` user service runs the app on `127.0.0.1:28766`, starts automatically, and restarts on failure. The existing remotely managed Cloudflare tunnel `tgl` routes the public hostname to `http://localhost:28766`. Its proxied DNS record targets the same tunnel. Other tunnel routes are preserved.

```bash
./scripts/install_service.sh
systemctl --user status voicesite
systemctl --user restart voicesite
journalctl --user -u voicesite -f
```

The initial voices are Bella (default), Michael, Nicole, and Eric. The public deployment currently has no login; anyone with the URL can access the library and request speech.
