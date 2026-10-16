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
- The first visit saves a snapshot. Repeat visits open the latest saved copy; **Save again** creates a new dated version.
- Each snapshot has a permanent `/archive/<id>` URL. The snapshot selector lets you reopen older versions.
- Pages open in a wide **Original** view beneath a persistent 34px Voicesite / Saved page header, which identifies the source and links to the live site. A compact floating bubble at the bottom switches **Original / Reader**. Its **•••** menu contains versions, Save again, Copy link, the live-page link, and reader text sizing.
- Older snapshots retain their earlier capture settings. Use **Save again** to create a new snapshot with the current asset-preserving behavior.
- Reading extraction uses [Mozilla Readability](https://github.com/mozilla/readability), with a sanitized page-content fallback when no article is detected.

## Text and future speech integration

`GET /api/snapshots/:id` returns article HTML, plain article text, and whole-page `blocks`. Each block includes text, tag type, and an ID that maps to `data-read-id` on the archived original element. Multiple text runs can share an element. This retains a foundation for reading/highlighting text in original formatting without forcing article-only extraction. Speech playback is not implemented in this step. CSS-hidden content may still appear in the block list; a future speech integration should check rendered visibility. The original frame has an opaque origin: future highlighting must use an explicit message bridge, not direct parent DOM access. Source scripts may change element IDs during replay.

`POST /api/capture` accepts `{ "url": "https://example.com", "fresh": false }`. `GET /api/snapshots` lists the latest 100 snapshots; `?url=...` returns all versions for a source. `/snapshots/:id/original` serves the saved original HTML in an opaque-origin sandbox. Original scripts, styles, fonts, images, media, and embeds may load from their original locations. The frame can run scripts and forms but cannot read the parent app DOM, cookies, or storage. Reader HTML is separately sanitized before insertion into the app. External assets depend on source availability, CORS/embedding policy, and hotlink permissions.

## Capture limits

Capture saves server-returned HTML and CSS; it does not run a browser during capture. Original replay loads source scripts and live assets. Login-only content, anti-bot pages, JavaScript-rendered articles, and dynamically loaded comments may be inaccessible or incomplete. Only the requested page is captured; links open the live destination. Original mode retains visual markup and source behavior, but is not a transparent proxy of the original origin. Login, cookies/local storage, origin-dependent API calls, some embedded frames, and JavaScript-only initial content may not work. The persistent reader text remains usable when live assets or services disappear. Objects requiring browser plugins are not enabled.

HTML is limited to 5 MB, stylesheets to 2 MB each, 80 stylesheet resources / roughly 25 MB per capture, with a 45-second resource scheduling budget and 12-second individual request timeout. Stylesheets that fail to save (including parsing, size, and time limits) retain their live URL and are reported in the viewer. Nested CSS imports are saved up to four levels; CSS font/image URLs and image-set candidates are resolved to their original stylesheet location; inline data assets and SVG fragment references are retained. Integrity hashes are removed from rewritten stylesheet links so the browser accepts the saved CSS. Two different captures can run concurrently; duplicate in-flight requests share a capture.

Data lives in `data/archive.sqlite3` (SQLite WAL). Back up the data directory while the app is stopped or use SQLite's backup API. No migration of the legacy Python database is performed. The app has a shared library without accounts or quotas; the deployed instance is a shared prototype, not a multi-user archive service.

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

The public deployment has a shared library without authentication. Existing saved data is preserved.

Frontend CSS and JavaScript are served from content-hashed `/assets/<hash>/...` URLs with immutable caching; HTML uses `Cache-Control: no-store`. This prevents Cloudflare or browser caches from pairing a new page with an older app bundle.
