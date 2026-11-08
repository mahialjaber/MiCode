/*
 * MiCode decoder core.
 *
 * Pure decoding logic with no DOM access and no network access.
 * Works in the browser (exposed as window.MiCodeDecoder) and in Node.js
 * (module.exports) so it can be tested from the command line.
 *
 * Design rules:
 *  - Decoded content is only ever returned as a string. It is never evaluated.
 *  - Any change made to the input (cleanup, padding, removed characters) is
 *    reported back as a note or a warning. Nothing is changed silently.
 */
(function (root) {
  'use strict';

  // Every accepted abbreviation of PowerShell's -EncodedCommand parameter.
  const PS_ENC_FLAG = /^(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/i;
  // PowerShell accepts '-', '/', and Unicode dashes as parameter prefixes.
  const FLAG_PREFIX = /^[-/\u2013\u2014\u2015]/;
  const QUOTES = /^["'`\u201C\u201D\u2018\u2019]+|["'`\u201C\u201D\u2018\u2019]+$/g;
  const BASE64_TOKEN = /^[A-Za-z0-9+/=_-]+$/;

  const MAX_HEX_BYTES = 8192;

  /* ------------------------------------------------------------------ */
  /* Step 1: find the Base64 payload inside the raw input               */
  /* ------------------------------------------------------------------ */

  function stripQuotes(s) {
    return s.replace(QUOTES, '');
  }

  function extractPayload(raw, ctx) {
    const input = raw.trim();

    // a) PowerShell command line: powershell.exe -nop -w hidden -enc <payload>
    const tokens = input.split(/\s+/);
    for (let i = 0; i < tokens.length - 1; i++) {
      const tok = stripQuotes(tokens[i]);
      if (FLAG_PREFIX.test(tok) && PS_ENC_FLAG.test(tok.slice(1))) {
        const parts = [stripQuotes(tokens[i + 1])];
        // Some logs wrap long commands over several lines. Join following
        // tokens only while they look like Base64 and the previous part
        // did not already end with padding.
        for (let j = i + 2; j < tokens.length; j++) {
          const next = stripQuotes(tokens[j]);
          const prev = parts[parts.length - 1];
          if (prev.endsWith('=') || next.startsWith('-') || !BASE64_TOKEN.test(next)) break;
          parts.push(next);
        }
        ctx.steps.push('PowerShell ' + tok + ' argument');
        ctx.hint = 'utf-16le';
        if (parts.length > 1) {
          ctx.warnings.push('The encoded argument appeared to be split into ' + parts.length +
            ' pieces (e.g. line-wrapped). They were joined together. If the output looks wrong at the end, check that no unrelated text was included.');
        }
        return parts.join('');
      }
    }

    // b) [Convert]::FromBase64String('<payload>')
    const re = /FromBase64String\s*\(\s*["'\u201C\u201D\u2018\u2019]([^"'\u201C\u201D\u2018\u2019]+)["'\u201C\u201D\u2018\u2019]\s*\)/gi;
    const matches = [...input.matchAll(re)];
    if (matches.length > 0) {
      ctx.steps.push('FromBase64String(...) argument');
      if (matches.length > 1) {
        ctx.notes.push('Found ' + matches.length + ' FromBase64String(...) calls. Only the first one was decoded. Paste the others separately to decode them.');
      }
      return matches[0][1];
    }

    // c) Treat the whole input as Base64.
    const unquoted = stripQuotes(input);
    if (unquoted !== input) ctx.notes.push('Surrounding quotation marks were removed.');
    return unquoted;
  }

  /* ------------------------------------------------------------------ */
  /* Step 2: clean the Base64 text and turn it into bytes               */
  /* ------------------------------------------------------------------ */

  function describeChar(ch) {
    const code = ch.codePointAt(0);
    if (code < 0x21 || code === 0x7f) return 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
    return '"' + ch + '"';
  }

  function base64ToBytes(payload, ctx) {
    let s = payload;

    // Several space-separated words on one line suggest ordinary text,
    // not line-wrapped Base64. Used later to give a clearer error.
    ctx.looksLikeWords = s.split('\n').some(function (line) {
      return line.trim().split(/[ \t]+/).length >= 4;
    });

    if (/\s/.test(s)) {
      s = s.replace(/\s+/g, '');
      ctx.notes.push('Spaces and line breaks were removed from the Base64 text.');
    }

    // URL-safe Base64 uses '-' and '_' instead of '+' and '/'.
    if (/[-_]/.test(s)) {
      if (/[+/]/.test(s)) {
        ctx.warnings.push('The input mixes standard (+ /) and URL-safe (- _) Base64 characters. "-" and "_" were treated as "+" and "/". Output may be inaccurate.');
      } else {
        ctx.notes.push('URL-safe Base64 detected ("-" and "_"); converted to the standard alphabet.');
      }
      s = s.replace(/-/g, '+').replace(/_/g, '/');
    }

    // Characters that can never appear in Base64.
    const invalid = s.match(/[^A-Za-z0-9+/=]/gu) || [];
    if (invalid.length > 0) {
      const ratio = invalid.length / [...s].length;
      if (ratio > 0.1) {
        throw new Error('This does not look like Base64: ' + invalid.length +
          ' characters are not valid Base64. Paste only the encoded text or a PowerShell command containing -EncodedCommand / -enc.');
      }
      const unique = [...new Set(invalid)].slice(0, 10).map(describeChar).join(', ');
      ctx.warnings.push(invalid.length + ' invalid character(s) were removed before decoding (' + unique +
        '). The input may be corrupted; the output may be incomplete or inaccurate.');
      s = s.replace(/[^A-Za-z0-9+/=]/gu, '');
    }

    // '=' is padding and should only appear at the end. Padding in the
    // middle usually means several Base64 strings were glued together.
    const segments = s.split(/=+/).filter(Boolean);
    if (segments.length === 0) throw new Error('No Base64 data found in the input.');
    if (segments.length > 1) {
      ctx.warnings.push('Padding ("=") was found in the middle of the data, which usually means several Base64 strings were joined. Each part was decoded separately and the results combined. Verify the output.');
    }

    const endsWithPadding = s.endsWith('=');
    const chunks = [];
    segments.forEach(function (seg, idx) {
      const isLast = idx === segments.length - 1;
      let part = seg;
      const rem = part.length % 4;
      if (rem === 1) {
        part = part.slice(0, -1);
        ctx.warnings.push('The Base64 length is invalid (one extra character' +
          (segments.length > 1 ? ' in part ' + (idx + 1) : '') +
          '). The last character was ignored. The input is probably truncated or corrupted, so the end of the output may be missing or wrong.');
      } else if (rem !== 0) {
        part += rem === 2 ? '==' : '=';
        if (isLast && !endsWithPadding) {
          ctx.notes.push('Missing Base64 padding ("=") was added automatically.');
        }
      }
      if (part.length === 0) return;
      const bin = atob(part);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      chunks.push(bytes);
    });

    return concatBytes(chunks);
  }

  function concatBytes(chunks) {
    const total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Step 3: work out what the bytes are                                */
  /* ------------------------------------------------------------------ */

  // Share of characters that are normal readable text.
  function printableRatio(str) {
    let total = 0;
    let bad = 0;
    for (const ch of str) {
      total++;
      const c = ch.codePointAt(0);
      if (c === 0xfffd || (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c < 0xa0)) bad++;
    }
    return total === 0 ? 1 : 1 - bad / total;
  }

  function countReplacement(str) {
    let n = 0;
    for (const ch of str) if (ch === '\uFFFD') n++;
    return n;
  }

  function tryDecode(encoding, bytes, fatal) {
    try {
      return new TextDecoder(encoding, { fatal: fatal, ignoreBOM: false }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  // Decode as UTF-16 and report odd lengths / invalid sequences.
  function decodeUtf16(bytes, enc, label, ctx) {
    let data = bytes;
    if (data.length % 2 === 1) {
      data = data.subarray(0, data.length - 1);
      ctx.warnings.push('The decoded data has an odd number of bytes, which is not valid ' + label +
        '. The last byte was ignored; the input may be truncated.');
    }
    const text = tryDecode(enc, data, false);
    const bad = countReplacement(text);
    if (bad > 0) {
      ctx.warnings.push(bad + ' invalid ' + label + ' sequence(s) were shown as "\uFFFD". The output may be incomplete or inaccurate.');
    }
    return { text: text, encoding: label };
  }

  // Returns {text, encoding} when the bytes are confidently text, else null.
  function detectText(bytes, ctx) {
    const b = bytes;

    // Byte Order Marks
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
      const text = tryDecode('utf-8', b, false);
      const bad = countReplacement(text);
      if (bad > 0) ctx.warnings.push(bad + ' invalid UTF-8 sequence(s) were shown as "\uFFFD". The output may be incomplete or inaccurate.');
      return { text: text, encoding: 'UTF-8 (with BOM)' };
    }
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return decodeUtf16(b, 'utf-16le', 'UTF-16LE', ctx);
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return decodeUtf16(b, 'utf-16be', 'UTF-16BE', ctx);

    // UTF-16 without BOM: ASCII text in UTF-16LE has a zero in every odd byte.
    if (b.length >= 2) {
      const pairs = Math.floor(b.length / 2);
      let zeroEven = 0;
      let zeroOdd = 0;
      for (let i = 0; i < pairs * 2; i += 2) {
        if (b[i] === 0) zeroEven++;
        if (b[i + 1] === 0) zeroOdd++;
      }
      if (zeroOdd / pairs >= 0.25 && zeroEven / pairs <= 0.05) return decodeUtf16(b, 'utf-16le', 'UTF-16LE', ctx);
      if (zeroEven / pairs >= 0.25 && zeroOdd / pairs <= 0.05) return decodeUtf16(b, 'utf-16be', 'UTF-16BE', ctx);
    }

    // -EncodedCommand is always UTF-16LE, even for non-Latin text.
    if (ctx.hint === 'utf-16le' && b.length % 2 === 0) {
      const t = tryDecode('utf-16le', b, true);
      if (t !== null && printableRatio(t) >= 0.95) return { text: t, encoding: 'UTF-16LE' };
    }

    // Strict UTF-8 (plain ASCII is a subset of UTF-8).
    const utf8 = tryDecode('utf-8', b, true);
    if (utf8 !== null && printableRatio(utf8) >= 0.85) {
      const ascii = b.every(function (x) { return x < 0x80; });
      if (ctx.hint === 'utf-16le') {
        ctx.notes.push('PowerShell -EncodedCommand normally uses UTF-16LE, but this content decodes as ' + (ascii ? 'ASCII' : 'UTF-8') + '.');
      }
      return { text: utf8, encoding: ascii ? 'ASCII / UTF-8' : 'UTF-8' };
    }

    return null;
  }

  // Decompress with the browser's built-in DecompressionStream.
  // Returns {bytes, error}; on error, bytes holds whatever was recovered.
  async function inflate(bytes, format) {
    if (typeof DecompressionStream === 'undefined') return { bytes: new Uint8Array(0), error: new Error('unsupported') };
    const chunks = [];
    let error = null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      const reader = stream.getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
      }
    } catch (e) {
      error = e;
    }
    return { bytes: concatBytes(chunks), error: error };
  }

  function isZlibHeader(b) {
    return b.length >= 2 && (b[0] & 0x0f) === 8 && (b[0] >> 4) <= 7 && ((b[0] << 8) | b[1]) % 31 === 0;
  }

  function knownSignature(b) {
    const startsWith = function (arr) { return arr.every(function (v, i) { return b[i] === v; }); };
    if (startsWith([0x4d, 0x5a])) return 'a Windows executable or DLL (starts with "MZ")';
    if (startsWith([0x50, 0x4b, 0x03, 0x04])) return 'a ZIP archive (or Office document / JAR)';
    if (startsWith([0x25, 0x50, 0x44, 0x46])) return 'a PDF document';
    if (startsWith([0x7f, 0x45, 0x4c, 0x46])) return 'a Linux executable (ELF)';
    if (startsWith([0xd0, 0xcf, 0x11, 0xe0])) return 'a legacy Office document (OLE)';
    if (startsWith([0x89, 0x50, 0x4e, 0x47])) return 'a PNG image';
    if (startsWith([0xff, 0xd8, 0xff])) return 'a JPEG image';
    return null;
  }

  function hexDump(bytes) {
    const lines = [];
    const n = Math.min(bytes.length, MAX_HEX_BYTES);
    for (let off = 0; off < n; off += 16) {
      const row = bytes.subarray(off, Math.min(off + 16, n));
      let hex = '';
      let asc = '';
      for (let i = 0; i < 16; i++) {
        if (i < row.length) {
          hex += row[i].toString(16).padStart(2, '0') + ' ';
          asc += row[i] >= 0x20 && row[i] < 0x7f ? String.fromCharCode(row[i]) : '.';
        } else {
          hex += '   ';
        }
        if (i === 7) hex += ' ';
      }
      lines.push(off.toString(16).padStart(8, '0') + '  ' + hex + ' |' + asc + '|');
    }
    return lines.join('\n');
  }

  // Make invisible control characters visible so nothing is hidden.
  function revealControlChars(text, ctx) {
    let count = 0;
    const out = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, function (ch) {
      count++;
      return '\\x' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    });
    if (count > 0) {
      ctx.notes.push(count + ' invisible control character(s) are shown as \\xNN (for example \\x00) so they are not hidden.');
    }
    return out;
  }

  async function bytesToOutput(bytes, ctx, depth) {
    // 1. Readable text?
    const found = detectText(bytes, ctx);
    if (found) {
      ctx.steps.push(found.encoding);
      return revealControlChars(found.text, ctx);
    }

    // 2. Compressed data (common in PowerShell: GzipStream / DeflateStream)?
    if (depth === 0) {
      let format = null;
      let label = null;
      if (bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08) {
        format = 'gzip'; label = 'Gzip';
      } else if (isZlibHeader(bytes)) {
        format = 'deflate'; label = 'Zlib';
      }

      if (format) {
        const r = await inflate(bytes, format);
        if (r.bytes.length > 0) {
          ctx.steps.push(label + ' decompressed');
          if (r.error) {
            ctx.warnings.push('The ' + label + ' data is incomplete or corrupted. Only the part that could be decompressed is shown; the end of the output is probably missing.');
          }
          return bytesToOutput(r.bytes, ctx, depth + 1);
        }
        ctx.warnings.push('The data looks ' + label + '-compressed but could not be decompressed. It may be corrupted.');
      } else {
        // Raw Deflate has no header; only accept a clean result that is text.
        const r = await inflate(bytes, 'deflate-raw');
        if (!r.error && r.bytes.length > 0) {
          const sub = { steps: [], notes: [], warnings: [], hint: null };
          const t = detectText(r.bytes, sub);
          if (t && sub.warnings.length === 0) {
            ctx.steps.push('Raw Deflate decompressed', t.encoding);
            ctx.notes.push.apply(ctx.notes, sub.notes);
            return revealControlChars(t.text, ctx);
          }
        }
      }
    }

    // 3. Mostly text, but with some invalid bytes -> partial decode.
    const lenient = tryDecode('utf-8', bytes, false);
    if (printableRatio(lenient) >= 0.75) {
      ctx.steps.push('UTF-8 (partial)');
      ctx.warnings.push('The data is not fully valid text. ' + countReplacement(lenient) +
        ' unreadable byte sequence(s) are shown as "\uFFFD". The output may be incomplete or inaccurate.');
      return revealControlChars(lenient, ctx);
    }

    // 4. Binary -> hex dump.
    ctx.steps.push('Binary data (hex view)');
    const sig = knownSignature(bytes);
    if (!sig && ctx.looksLikeWords) {
      throw new Error('This does not look like Base64 (it decodes to random bytes, and the input contains several words separated by spaces). Paste only the encoded text or a PowerShell command containing -EncodedCommand / -enc.');
    }
    ctx.warnings.push('The decoded data is binary, not text' + (sig ? ' \u2014 it looks like ' + sig : '') +
      '. It is shown as a hex dump. Handle with care; it was not executed or saved.');
    if (bytes.length > MAX_HEX_BYTES) {
      ctx.warnings.push('Only the first ' + MAX_HEX_BYTES + ' of ' + bytes.length + ' bytes are shown in the hex view.');
    }
    return hexDump(bytes);
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Decode user input.
   * @param {string} raw - Base64 text or a PowerShell command line.
   * @returns {Promise<{ok:boolean, output:string, steps:string[], notes:string[], warnings:string[], error:string|null}>}
   */
  async function decode(raw) {
    const ctx = { steps: [], notes: [], warnings: [], hint: null };
    const result = function (ok, output, error) {
      return { ok: ok, output: output, steps: ctx.steps, notes: ctx.notes, warnings: ctx.warnings, error: error };
    };

    if (typeof raw !== 'string' || raw.trim() === '') {
      return result(false, '', 'Please paste some Base64 text or a PowerShell command first.');
    }

    try {
      const payload = extractPayload(raw, ctx);
      const bytes = base64ToBytes(payload, ctx);
      ctx.steps.push('Base64 (' + bytes.length + ' bytes)');
      if (bytes.length === 0) {
        return result(false, '', 'The input decoded to zero bytes. It is too short or not Base64.');
      }
      const output = await bytesToOutput(bytes, ctx, 0);
      return result(true, output, null);
    } catch (e) {
      return result(false, '', e && e.message ? e.message : 'Decoding failed.');
    }
  }

  const api = { decode: decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MiCodeDecoder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
