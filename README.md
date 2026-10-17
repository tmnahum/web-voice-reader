# Voicesite

A text-first web archive and reader. Save the words, HTML structure, and CSS of a public page; switch between a clean article view and the saved original formatting. Image URLs, including responsive and common lazy-loaded images, are retained and loaded directly from the original website in both views. CSS background images also use live URLs. Fonts, media, scripts, SVG icons, form controls, and their original styling are retained. Asset bytes other than CSS remain live-linked rather than duplicated in storage. Text and reader content are saved independently of those live assets.

## Run

Requires Node.js 24+ and pnpm.

```sh
pnpm install
pnpm dev
```

Open http://localhost:28767. For a network-accessible preview, run `HOST=0.0.0.0 pnpm start`. `PORT` overrides 28767; `ARCHIVE_DB` overrides `data/archive.sqlite3`. The existing legacy `data/library.sqlite3` and audio files are untouched. The previous Python service has been replaced by the Node service described below.

## Use

- Paste a public URL on the home page, or visit `http://localhost:28767/https://example.com/article?query=value`. A bare domain such as `/example.com/article` also works.
- The first visit saves a snapshot. Repeat visits open the latest saved copy; the header’s refresh button resaves the page. Identical captures update the latest snapshot’s timestamp and retain its URL; changed captures create a new version.
- The address bar retains the source URL: `/https://example.com/article?query=value`. The version dropdown and Copy link use `#snapshot=<id>` to select a specific version without consuming source query parameters. Existing `/archive/<id>` links still work and are replaced in the address bar with the source URL plus version fragment.
- Pages open in a wide **Original** view beneath a persistent 34px Voicesite / Saved page header, which shows the page title left-aligned and links to the live site. The header shows the saved date/time as a version dropdown, with a compact resave button beside it. Click the page title in the top bar to paste another URL; Enter or Go opens it, and Escape cancels. The **Reader** button in the top bar switches between original and reader views. The floating bottom bubble controls speech playback and voice selection. The speed number opens speed presets; the live-page link remains in the header.
- Older snapshots retain their earlier capture settings. Use the header’s refresh button to create a new snapshot with the current asset-preserving behavior.
- Reading extraction uses [Mozilla Readability](https://github.com/mozilla/readability), with a sanitized page-content fallback when no article is detected.

## Read aloud

Click a word in either view to read from that point, or press Play to start at the beginning. Choose Bella, Michael, Nicole, or Eric (Kokoro). The bottom bubble provides Play/Pause, voice selection, − / speed / + controls, and Generate speech. Words are always highlighted. Reading scrolls the active line into view near the bottom or top edge, leaving room for the controls; reduced-motion preferences are respected. Speed buttons adjust by 0.1×; clicking the speed number opens 0.25×–3× presets at 0.25× intervals. The bottom bar shows audio position / total duration (for example, `1:23 / 12:45`). Saved chunks use their actual durations; missing chunks are estimated at 180 words per minute and the total is marked `≈` until all durations are known. Earlier ungenerated chunks can also make the current position approximate when seeking ahead. This is an audio timeline: changing speed changes how fast the clock advances, not the total duration. Image readings are included. There is no options menu or separate playback status text. Images with alt text are read in document order and outlined while spoken; images without usable alt text receive local OCR or a brief local AI caption before speech is prepared. Modifier-click still follows links.

### Local image reading

Both views prepare visible images in document order. RapidOCR checks each image locally with English recognition, including images with alt text. High-confidence embedded text is introduced as “Text in image” and read aloud, even for short labels or sparse text in photos. Existing nonblank alt text takes priority for the description; otherwise photos get “Image” followed by a BLIP caption of at most 25 words. Text-heavy images are read directly from OCR. Image highlighting and click-to-read work for both. Explicitly hidden/presentation images are skipped. Images smaller than 32 pixels on either side are skipped only if OCR finds no confident text. Empty alt text is eligible for analysis unless the image is explicitly marked decorative.

Install once using Python 3.11+:

```sh
python3.11 -m venv .venv-images
.venv-images/bin/pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu
.venv-images/bin/pip install -r server/image-requirements.txt
.venv-images/bin/python server/setup-image-models.py
```

The setup downloads [BLIP base](https://huggingface.co/Salesforce/blip-image-captioning-base) weights and [RapidOCR](https://github.com/RapidAI/RapidOCR) resources. Inference runs on this server’s CPU, independently of Kokoro, and sends no images to an AI service. Images are fetched from their source with the same public-address/redirect protections as capture, or decoded from inline raster data. SVG and other unsupported formats fall back to “Image description unavailable.” Image input is limited to 6 MB and 20 million pixels; individual inference times out after 90 seconds.

`IMAGE_PYTHON` overrides `.venv-images/bin/python`; `IMAGE_CAPTION_MODEL` overrides `models/blip-image-captioning-base`. Successful results persist per snapshot/image URL in `data/image-reading` (`IMAGE_READING_DIR` overrides it), shared between views and voices. Back up this directory with saved speech. Changing model settings requires clearing this cache to regenerate descriptions. Source image bytes are not retained. Live images that change at the same URL keep their cached reading for that snapshot.

The controls show “Preparing images…” until visible images have been resolved, keeping saved speech boundaries stable. Failures are not cached; text playback remains available after preparation and switching views retries failed images. OCR classification uses text density and confidence to choose between text alone and a caption with text; complex columns, small lettering, and non-English text can be misread. OCR text is capped at 19,500 characters with an audible omission notice. Captions are generated descriptions and may be inaccurate.

Text is grouped at sentence and block boundaries, targeting at most 450 characters per chunk. Long sentences split at word boundaries. Chunks always start from the same page-wide boundaries: clicking a word seeks to its Kokoro timestamp within its existing chunk instead of splitting and regenerating text from that word. Playback generates missing chunks as needed and queues two ahead. A word click prioritizes that chunk and the next two over earlier background chunks and stale lookahead. The latest click takes priority; any inference already running finishes before the prioritized work starts. Both playback-triggered and full-page generation update the same Saving button. Partially saved pages show their saved count and still allow Generate speech to finish the remainder.

**Generate speech** saves the entire current view, from top to bottom, in the selected voice. Progress changes to **Speech saved** when complete. This server job continues after you pause or close the browser; interrupted jobs resume when the server starts. A failed job can be retried without losing completed clips. Each voice has its own audio. Playback speed is applied in the browser and does not regenerate anything.

Saved rendition manifests and audio/timing clips live in `data/speech` (`SPEECH_DIR` overrides this directory). Include this directory in backups. There is no expiration or automatic eviction of these files. Manifests identify the saved snapshot, view, voice, and rendered word sequence; identical text/voice clips are shared across manifests. Original and reader views can contain different text, so they have distinct manifests. Original scripts that change the visible text may create a different rendition; existing clips remain reusable. Restarting the service or clearing browser data does not delete saved speech.

`POST /api/snapshots/:id/speech-renditions` registers `{voice, view, words}` and returns a stable rendition ID and saved-chunk status. `POST /api/speech-renditions/:id/prioritize` accepts `{index}` and prioritizes three playback chunks, `POST /api/speech-renditions/:id/generate` starts/resumes full generation, `GET /api/speech-renditions/:id` reports progress, and `POST /api/speech-renditions/:id/chunks/:index` returns saved audio and timestamps or generates a missing chunk. Concurrent requests for the same clip share inference.

Configure `KOKORO_PYTHON` with a Python environment containing Kokoro, torch, numpy, soundfile, espeakng-loader and phonemizer; set `KOKORO_MODELS` to the local model directory containing `config.json`, `kokoro-v1_0.pth`, and the four voice `.pt` files under `voices/`. The server loads `.env` at startup. `POST /api/speech` accepts `{ "text": "…", "voice": "af_bella" }` (600-character maximum) and returns WAV audio as base64 plus Kokoro word timestamps. Timings are mapped to source words; unmatched tokens are left unhighlighted rather than assigned invented timing.

Original-view reading uses an injected message bridge inside the opaque-origin sandbox; the parent never accesses the frame DOM. The bridge indexes visible text on load or view selection. Source scripts that later replace content may invalidate those ranges; toggling views rebuilds them. Highlighting uses the browser CSS Custom Highlight API. The curated voices are English voices.

`GET /api/snapshots/:id` returns article HTML, plain article text, and whole-page `blocks`. Each block includes text, tag type, and an ID that maps to `data-read-id` on the archived original element. Speech reads the rendered DOM, including image alt text, rather than using these static block references.

`POST /api/capture` accepts `{ "url": "https://example.com", "fresh": false }`. `GET /api/admin/snapshots` lists the latest 100 snapshots after admin sign-in. The unfiltered legacy `GET /api/snapshots` also requires admin authentication; `GET /api/snapshots?url=...` remains public and returns versions for an exact source URL. `/snapshots/:id/original` serves the saved original HTML in an opaque-origin sandbox. Original scripts, styles, fonts, images, media, and embeds may load from their original locations. The frame can run scripts and forms but cannot read the parent app DOM, cookies, or storage. Reader HTML is separately sanitized before insertion into the app. External assets depend on source availability, CORS/embedding policy, and hotlink permissions.

## Server capture security

Captures use a dedicated server HTTP client, not a personal browser profile. It sends only its own User-Agent and Accept headers, explicitly omits credentials, and has no cookie jar. Incoming browser cookies, authorization headers, and source Set-Cookie responses are not forwarded to archived sites. Source JavaScript is stored for browser replay but never executed during server capture; jsdom resource loading is disabled.

Every HTML/CSS fetch and redirect validates the destination and all DNS answers, rejects private/reserved addresses and URL credentials, and pins the connection to validated addresses. Redirect chains are limited to six requests and a 45-second overall fetch budget, with individual request timeouts. Declared and decoded response sizes are bounded, and connections are destroyed on completion or failure. Database writes use bound parameters rather than interpolating page content into SQL.

Browser replay intentionally permits source JavaScript and live resources, including interactions such as dismissing subscription popups. The existing opaque-origin sandbox separates the source page from Voicesite; reader HTML is sanitized. These server protections do not make an untrusted source site safe to visit. Source URLs and query strings are saved verbatim, so URL-embedded tokens become part of the shared snapshot.

## Capture limits

Capture saves server-returned HTML and CSS; it does not run a browser during capture. Original replay loads source scripts and live assets. Login-only content, anti-bot pages, JavaScript-rendered articles, and dynamically loaded comments may be inaccessible or incomplete. Only the requested page is captured; links open the live destination. Original mode retains visual markup and source behavior, but is not a transparent proxy of the original origin. Login, cookies/local storage, origin-dependent API calls, some embedded frames, and JavaScript-only initial content may not work. The persistent reader text remains usable when live assets or services disappear. Objects requiring browser plugins are not enabled.

HTML is limited to 5 MB, stylesheets to 2 MB each, 80 stylesheet resources / roughly 25 MB per capture, with a 45-second resource scheduling budget and 12-second individual request timeout. Stylesheets that fail to save (including parsing, size, and time limits) retain their live URL and are reported in the viewer. Nested CSS imports are saved up to four levels; CSS font/image URLs and image-set candidates are resolved to their original stylesheet location; inline data assets and SVG fragment references are retained. Integrity hashes are removed from rewritten stylesheet links so the browser accepts the saved CSS. Two different captures can run concurrently; duplicate in-flight requests share a capture.

Data lives in `data/archive.sqlite3` (SQLite WAL). Back up the data directory while the app is stopped or use SQLite's backup API. No migration of the legacy Python database is performed. Snapshot storage is shared, without accounts or quotas. The home page’s “You recently archived” list stores up to 100 snapshot summaries in this browser’s localStorage. Successful archive requests (including reuse and resave) add to it; simply viewing a shared snapshot does not. Clearing browser data clears the local list, not the saved snapshots. Existing global history is not imported into personal lists.

## Verification

```sh
pnpm test
node --check web/app.js
```

Tests cover extraction, text references, asset skipping, CSS imports, reader sanitization, original control/SVG/script preservation, CSS live fallback, public-IP filtering, persistent versions, API reuse/recapture, sandbox response headers, responsive/live image URL handling, and versioned frontend asset delivery. The capture client validates public destinations and redirects and pins resolved addresses to the connection.

## Deployment

Public URL: https://voicesite.remoth.net

The user systemd unit `voicesite.service` runs Node in production mode on `127.0.0.1:28767`, starts automatically, and restarts on failure. Its definition is in `deploy/voicesite.service`. The existing remotely managed Cloudflare tunnel `tgl` routes this hostname to `http://localhost:28767`; the proxied DNS record targets that tunnel. Other tunnel routes are preserved.

```sh
systemctl --user status voicesite
systemctl --user restart voicesite
journalctl --user -u voicesite -f
```

To reinstall the service on this machine:

```sh
cp deploy/voicesite.service ~/.config/systemd/user/voicesite.service
systemctl --user daemon-reload
systemctl --user enable --now voicesite
```

The global recent list is available at `/admin/recently-archived`, linked from the home page footer. Set `ADMIN_PASSWORD` in the environment or the untracked `.env` file, then restart the service. The server loads `.env` on startup; environment variables take precedence. If no password is configured, admin access stays locked. Sign-in creates an HttpOnly, SameSite=Strict session cookie (Secure over HTTPS), expiring after eight hours. Sign-out and service restarts revoke sessions. Failed sign-ins are limited to ten per connection IP per 15 minutes (behind the tunnel this limit may be shared). Passwords are never stored in browser storage. Snapshot links and exact-URL version lookups remain public; the password protects the global listing. Existing saved data is preserved.

Frontend CSS and JavaScript are served from content-hashed `/assets/<hash>/...` URLs with immutable caching; HTML uses `Cache-Control: no-store`. This prevents Cloudflare or browser caches from pairing a new page with an older app bundle.

Resave comparison checks the complete captured document (including original HTML, saved CSS, reader output, and metadata), ignoring capture timestamps, download bookkeeping, CSP nonce attributes, and Cloudflare’s known per-request challenge script (Ray ID/timestamp). That script remains in replay HTML; only the comparison excludes it. All other original scripts, CSS, markup, and article content still participate in comparison. It compares against the latest snapshot for the same source URL, not older history. Live-linked asset bytes are not downloaded or compared; changing remote image/script bytes at the same URL is not detectable unless the captured document also changes.
