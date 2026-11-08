<p align="center">
  <img src="assets/banner.jpg" alt="MiCode banner" width="100%">
</p>

<h1 align="center">🔓 MiCode</h1>

<p align="center">
  <b>A tiny, offline PowerShell &amp; Base64 decoder for security analysts.</b><br>
  Paste a suspicious command → click <b>Decode</b> → read it safely as plain text.
</p>

<p align="center">
  <a href="https://mahialjaber.github.io/MiCode/"><img src="https://img.shields.io/badge/LIVE%20DEMO-Open%20MiCode-1f6feb?style=for-the-badge" alt="Live demo"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/HTML%20%2B%20CSS%20%2B%20JS-vanilla-f7df1e?style=flat-square" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/works-offline-2ea44f?style=flat-square" alt="Offline">
  <img src="https://img.shields.io/badge/data%20uploaded-none-2ea44f?style=flat-square" alt="No uploads">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license">
  <a href="https://github.com/mahialjaber"><img src="https://img.shields.io/badge/author-Mahi%20Al%20Jaber-orange?style=flat-square&logo=github" alt="Author"></a>
</p>

---

## 🤔 What is MiCode?

Attackers often hide PowerShell commands with Base64 (`powershell -enc SQBFAFgA...`). **MiCode** turns them back into readable text in one click — a lightweight alternative to CyberChef for everyday investigations.

```text
Input :  powershell.exe -NoP -W Hidden -enc SQBFAFgAIAAoACcAaABlAGwAbABvACcAKQA=
Output:  IEX ('hello')
Detected: PowerShell -enc argument → Base64 (26 bytes) → UTF-16LE
```

## ✨ Features

| Feature | What it does |
|---|---|
| 🔍 **Smart input** | Paste raw Base64 or a full command line — finds `-e`, `-enc`, `-EncodedCommand`, `FromBase64String('…')` |
| 🔤 **Auto-detects encoding** | UTF-16LE (PowerShell default), UTF-8 / ASCII, UTF-16BE |
| 🗜️ **Decompresses payloads** | Gzip, Zlib and raw Deflate (PowerShell `GzipStream` / `DeflateStream`) |
| 🧹 **Fixes messy input** | Extra spaces, line breaks, quotes, missing `=` padding, URL-safe Base64 |
| ⚠️ **Honest warnings** | Corrupted or truncated input is partially decoded with clear warnings — never silently altered |
| 🧱 **Binary detection** | Executables (`MZ`) and other binary data are shown as a hex dump |

## 🛡️ Privacy & Safety

- **100% local** — decoding happens in your browser. No backend, no API, no tracking.
- **Nothing is uploaded** — a strict Content Security Policy blocks all outgoing connections.
- **Nothing is executed** — decoded output is always displayed as plain text.
- **Works offline** — cached after your first visit.

## 🚀 How to Use

1. Open **[mahialjaber.github.io/MiCode](https://mahialjaber.github.io/MiCode/)**
2. Paste the encoded text or PowerShell command.
3. Click **Decode** (or press `Ctrl + Enter`).
4. Check the status: ✅ green = clean · ⚠️ yellow = may be incomplete · ❌ red = could not decode.
5. **Copy** the result or **Clear** to start again.

## 📁 Project Structure

```text
MiCode/
├── index.html        # The single page
├── css/style.css     # Styling (light & dark mode)
├── js/decoder.js     # Decoding logic (no DOM, no network)
├── js/app.js         # Buttons & display
├── sw.js             # Offline caching
└── tests/            # Decoder tests (Node.js)
```

## 💻 Run Locally

No build step needed — just serve the folder:

```bash
git clone https://github.com/mahialjaber/MiCode.git
cd MiCode
python -m http.server 8000      # then open http://localhost:8000
```

Run the tests (Node.js 18+): `node --test tests/decoder.test.js`

## 📄 License

[MIT](LICENSE) © [Mahi Al Jaber](https://github.com/mahialjaber)
