# MiCode

**A tiny, offline PowerShell & Base64 decoder for everyday SOC work.**

🔗 **Live app:** https://mahialjaber.github.io/MiCode/

MiCode is a simple alternative to CyberChef for the most common investigation task: decoding suspicious PowerShell `-EncodedCommand` strings and Base64 content. Paste, click **Decode**, read the result.

---

## Features

- **Base64 and PowerShell decoding.** Paste raw Base64 or a full command line, e.g.
  `powershell.exe -NoP -W Hidden -enc SQBFAFgA...`
- **Finds the payload for you.** Recognises every short form of `-EncodedCommand` (`-e`, `-ec`, `-enc`, …), `/` and Unicode-dash prefixes, and `[Convert]::FromBase64String('...')`.
- **Detects the text encoding automatically.** UTF-16LE (PowerShell's default), UTF-8/ASCII, UTF-16BE and Byte Order Marks.
- **Decompresses common payloads.** Gzip, Zlib and raw Deflate (as used by PowerShell `GzipStream` / `DeflateStream`), using the browser's built-in decompression.
- **Fixes minor input problems.** Extra spaces, line breaks, quotation marks, missing `=` padding and URL-safe Base64 (`-` `_`).
- **Partial decoding with clear warnings.** If the input is truncated or corrupted, MiCode decodes as much as it can and tells you exactly what it changed and why the output may be incomplete. It never silently invents or alters content.
- **Binary detection.** Non-text data (e.g. an `MZ` executable) is shown as a hex dump with a warning instead of garbled text.
- **Copy and Clear** buttons. Press **Ctrl + Enter** to decode.

## Privacy & safety

- 100% client-side: HTML, CSS and vanilla JavaScript. No backend, no API, no analytics, no external libraries.
- Your input is **never uploaded or transmitted**. A strict Content Security Policy (`connect-src 'none'`) blocks the page from sending data anywhere.
- Decoded output is displayed as **plain text only** and is **never executed**.
- Works **offline** after the first visit (cached by a service worker).

## How to use

1. Open https://mahialjaber.github.io/MiCode/ (once online; afterwards it also works offline).
2. Paste the Base64 text or PowerShell command into **Input**.
3. Click **Decode**.
4. Read the status box:
   - ✓ **green** – decoded cleanly.
   - ⚠ **yellow** – decoded, but the output may be incomplete or inaccurate (reasons are listed).
   - **red** – could not decode (reason is shown).
5. Click **Copy** to copy the output, or **Clear** to start over.

The status box also shows the detection chain, e.g.
`Detected: PowerShell -enc argument → Base64 (64 bytes) → UTF-16LE`.

> Invisible control characters in the output are displayed as `\xNN` (for example `\x00`) so nothing is hidden. This is always mentioned in the status box.

## Project structure

```
MiCode/
├── index.html          # The single page
├── css/style.css       # Styling (light and dark mode)
├── js/decoder.js       # Decoding logic (no DOM, no network)
├── js/app.js           # Buttons and display
├── sw.js               # Service worker for offline use
├── icon.svg            # App icon
└── tests/              # Automated tests for the decoder (Node.js)
```

## Run locally

No build step is required. Either open `index.html` directly in a browser, or serve the folder (needed for offline caching to work):

```bash
npx serve .
# or
python -m http.server 8000
```

## Run tests

Requires [Node.js](https://nodejs.org/) 18 or newer:

```bash
node --test tests/decoder.test.js
```

## Updating the app

After changing any file, increase `CACHE_VERSION` in `sw.js` (e.g. `micode-v1` → `micode-v2`) so browsers pick up the new version, then push to `main`. GitHub Pages redeploys automatically.

## License

[MIT](LICENSE)
