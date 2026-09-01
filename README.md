# Anything to Anything

A file converter. Upload a file, pick a target format, download the result.
Conversions run on the server, one at a time, behind a live queue.

- **Frontend:** Angular 22 single-page app (`src/`)
- **Backend:** Express 5 (`src/server/`) — serves the built app and the `/api` routes
- **Deploy:** Render web service — `npm ci && npm run build`, then `npm start`

---

## What it converts

The converter detects the file's group from its extension and offers the valid
targets for that group (the source format itself is never offered).

### Images

| | |
|---|---|
| **Accepts** | JPG, JPEG, PNG, WebP, GIF, TIFF, AVIF, HEIC, HEIF, SVG |
| **Converts to** | PNG, JPG, WebP, AVIF, GIF, TIFF |

- Animated GIFs also convert to **MP4** and **WebM** (via ffmpeg).
- Every other image conversion uses the first frame only, so an animated GIF →
  PNG/JPG/etc. produces a still.

### Audio

| | |
|---|---|
| **Accepts** | MP3, WAV, FLAC, OGG, OPUS, M4A, AAC, WMA, AIFF |
| **Converts to** | MP3, WAV, FLAC, OGG, Opus, M4A |

### Video

| | |
|---|---|
| **Accepts** | MP4, MOV, WebM, MKV, AVI, M4V, FLV, WMV |
| **Converts to** | MP4, WebM, MOV, GIF, MP3 (extract the audio track) |

### Documents

| | |
|---|---|
| **Accepts** | TXT, MD, HTML, DOCX, PDF |
| **Converts to** | TXT, MD, HTML, DOCX, PDF |

- **PDF is read-only** — it only converts to TXT (text extraction; layout is not preserved).
- **DOC** (legacy binary Word) is not supported — that needs LibreOffice.
- DOCX → PDF goes through HTML, so complex Word formatting is simplified.

### Spreadsheets

| | |
|---|---|
| **Accepts** | CSV, TSV, XLSX, XLS |
| **Converts to** | CSV, TSV, XLSX, XLS |

- CSV/TSV hold one sheet. A multi-sheet workbook flattens to its first sheet,
  and the download is named `<file> (<SheetName>).csv`.
- `→ CSV/TSV` drops formulas, formatting, extra sheets, and charts.

### Archives

| | |
|---|---|
| **Accepts** | ZIP, 7Z, RAR, TAR, GZ, TGZ / TAR.GZ |
| **Converts to** | ZIP, 7Z, TAR, TAR.GZ, GZ |

- Conversion = extract the file tree and repack it in the new format.
- **RAR is extract-only** — creating RAR needs a licence from RARLAB.
- `GZ` of a multi-file archive falls back to `TAR.GZ` (gzip is a single stream).
- Extraction is capped: ≤ 500 MB uncompressed, ≤ 5,000 files; path-traversal
  entries, symlinks, and password-protected archives are rejected.

### Not yet supported

- **DOC**, and high-fidelity DOCX ↔ PDF/ODT/RTF — needs LibreOffice (Docker).
- **Presentations** (PPTX, PPT).
- **PDF → editable formats** (DOCX/HTML with layout).

---

## Libraries

### Conversion engines

| Package | What it does |
|---|---|
| [`sharp`](https://sharp.pixelplumbing.com/) | Image decode / encode / resize (libvips). Handles every image conversion. |
| [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) | Bundled `ffmpeg` binary. Drives all audio and video transcoding, plus video → GIF and audio extraction. |
| [`marked`](https://marked.js.org/) | Markdown → HTML. |
| [`turndown`](https://github.com/mixmark-io/turndown) | HTML → Markdown. |
| [`mammoth`](https://github.com/mwilliamson/mammoth.js) | DOCX → HTML (extracts content; drops complex styling). |
| [`html-to-docx`](https://github.com/privateOmega/html-to-docx) | HTML → DOCX. |
| [`html-to-text`](https://github.com/html-to-text/node-html-to-text) | HTML → plain text. |
| [`pdf-parse`](https://github.com/mehmet-kozan/pdf-parse) | Extracts text from a PDF. |
| [`puppeteer`](https://pptr.dev/) | Headless Chrome. Renders HTML → PDF (all external requests are blocked during render). |
| [`xlsx`](https://sheetjs.com/) (SheetJS) | Reads and writes CSV, TSV, XLSX, and legacy XLS. |
| [`7zip-bin`](https://github.com/develar/7zip-bin) | Bundled `7za` binary. Extracts and creates ZIP, 7Z, TAR, and GZIP. |
| [`node-unrar-js`](https://github.com/YuJianrong/node-unrar-js) | WASM build of unrar. Extracts RAR archives. |

HTML is the pivot format for documents: every document conversion goes
`source → HTML → target`.

### Server

| Package | What it does |
|---|---|
| [`express`](https://expressjs.com/) | HTTP server and routing; also serves the built Angular app. |
| [`multer`](https://github.com/expressjs/multer) | Parses `multipart/form-data` uploads and streams them to a temp file. |
| [`cors`](https://github.com/expressjs/cors) | Cross-origin response headers for the `/api` routes. |

### Frontend

| Package | What it does |
|---|---|
| [`@angular/core`](https://angular.dev/), `@angular/common`, `@angular/platform-browser`, `@angular/forms` | The Angular framework and runtime. |
| `@angular/material`, `@angular/cdk` | UI components (used for layout accents like the divider). |
| `@angular/cli`, `@angular/build` *(dev)* | Build toolchain (`ng build`). |

---

## How a conversion flows

1. **Upload** — `POST /api/convert` with the file and target format. Multer
   streams the upload to a temp file; the server creates a job, adds it to the
   queue, and immediately returns `{ jobId }`.
2. **Queue** — one conversion runs at a time (strict FIFO; override with
   `CONVERT_CONCURRENCY`). Everyone else waits.
3. **Poll** — the client calls `GET /api/jobs/:id` about once a second. It shows
   the queue position (`1st in queue`, `2nd in queue`, …) then a progress bar
   while converting. Polling also acts as a heartbeat: a queued job whose client
   stops polling for 30 s is dropped so the line moves up.
4. **Download** — `GET /api/jobs/:id/download` streams the converted file.
   Finished jobs and their temp files are cleaned up after 10 minutes.

The queue is in-memory, so the server must run as a **single process**. Scaling
to multiple instances would need a shared queue (e.g. Redis / BullMQ).

### API

| Route | Purpose |
|---|---|
| `GET /api/formats?filename=<name>` | Returns `{ kind, targets }` for a filename. |
| `POST /api/convert` | Accepts `file` + `format`, returns `{ jobId }` (202). |
| `GET /api/jobs/:id` | Job status: `queued` / `processing` / `done` / `error` / `cancelled`, plus position and progress. |
| `GET /api/jobs/:id/download` | Streams the converted file. |

---

## Running locally

```bash
npm install
npm run build      # compile the Angular app into dist/
npm start          # start the Express server on http://localhost:3000
```

For frontend work with live reload, run the Angular dev server separately:

```bash
npm run dev        # ng serve on http://localhost:4200
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port (Render sets this). |
| `CONVERT_CONCURRENCY` | `1` | How many conversions run at once. |
| `MAX_UPLOAD_MB` | `200` | Upload size limit. |

### Deploy notes

- **Node ≥ 24.15.0** (pinned in `.node-version`) — Angular CLI 22's minimum.
- `sharp`, `ffmpeg-static`, `7zip-bin`, and `node-unrar-js` all ship platform
  binaries via npm, so `npm ci` on Render's Linux builder gets the right ones.
- `puppeteer` downloads Chromium on install (kept in `./.cache` via
  `.puppeteerrc.cjs`). On Render's native runtime it may still need extra shared
  libraries; if `→ PDF` fails there, use a Dockerfile or `@sparticuz/chromium`.
