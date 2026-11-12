/*
 * MiCode decoder core.
 *
 * Pure decoding logic with no DOM access and no network access.
 * Works in the browser (exposed as window.MiCodeDecoder) and in Node.js
 * (module.exports) so it can be tested from the command line.
 *
 * Supported modes:
 *  - 'auto'   : Automatically detects Base64/PS, Base85, Obfuscated URL, or Hex
 *  - 'base64' : Base64 (standard & URL-safe) and PowerShell -EncodedCommand
 *  - 'base85' : Ascii85 (<~...~> or raw) and RFC 1924 / Python Base85
 *  - 'url'    : Percent-encoding, defanged URLs, redirect wrappers, obfuscated IPs
 *  - 'hex'    : Raw hex strings, 0x bytes, \xNN escapes, \uNNNN escapes
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

  // RFC 1924 / Python base64.b85encode alphabet (85 chars)
  const B85_RFC_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
  const B85_RFC_MAP = new Int16Array(128).fill(-1);
  for (let i = 0; i < B85_RFC_ALPHABET.length; i++) {
    B85_RFC_MAP[B85_RFC_ALPHABET.charCodeAt(i)] = i;
  }

  // Known URL shortener domains (offline advisory)
  const SHORTENER_DOMAINS = new Set([
    'bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'is.gd', 'v.gd',
    'rb.gy', 'cutt.ly', 'ow.ly', 'tiny.cc', 'shorturl.at', 'rebrand.ly',
    'bl.ink', 'buff.ly', 'lnkd.in', 'youtu.be', 'goo.gl', 's.id'
  ]);

  /* ------------------------------------------------------------------ */
  /* Shared utilities                                                   */
  /* ------------------------------------------------------------------ */

  function stripQuotes(s) {
    return s.replace(QUOTES, '');
  }

  function describeChar(ch) {
    const code = ch.codePointAt(0);
    if (code < 0x21 || code === 0x7f) return 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
    return '"' + ch + '"';
  }

  function concatBytes(chunks) {
    const total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

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
  /* Mode 1: Base64 & PowerShell                                        */
  /* ------------------------------------------------------------------ */

  function hasPowerShellHint(raw) {
    const tokens = raw.trim().split(/\s+/);
    for (let i = 0; i < tokens.length - 1; i++) {
      const tok = stripQuotes(tokens[i]);
      if (FLAG_PREFIX.test(tok) && PS_ENC_FLAG.test(tok.slice(1))) return true;
    }
    return /FromBase64String\s*\(/i.test(raw);
  }

  function extractBase64Payload(raw, ctx) {
    const input = raw.trim();

    // a) PowerShell command line: powershell.exe -nop -w hidden -enc <payload>
    const tokens = input.split(/\s+/);
    for (let i = 0; i < tokens.length - 1; i++) {
      const tok = stripQuotes(tokens[i]);
      if (FLAG_PREFIX.test(tok) && PS_ENC_FLAG.test(tok.slice(1))) {
        const parts = [stripQuotes(tokens[i + 1])];
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

  function base64ToBytes(payload, ctx) {
    let s = payload;

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

  async function runBase64Mode(raw, ctx) {
    const payload = extractBase64Payload(raw, ctx);
    const bytes = base64ToBytes(payload, ctx);
    ctx.steps.push('Base64 (' + bytes.length + ' bytes)');
    if (bytes.length === 0) {
      throw new Error('The input decoded to zero bytes. It is too short or not Base64.');
    }
    return bytesToOutput(bytes, ctx, 0);
  }

  /* ------------------------------------------------------------------ */
  /* Mode 2: Base85 (Ascii85 & RFC 1924 / Python Base85)                */
  /* ------------------------------------------------------------------ */

  function decodeAscii85Bytes(str, ctx) {
    const out = [];
    let tuple = 0;
    let count = 0;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const code = str.charCodeAt(i);

      if (ch === 'z' && count === 0) {
        out.push(0, 0, 0, 0);
        continue;
      }
      if (ch === 'y' && count === 0) {
        out.push(0x20, 0x20, 0x20, 0x20);
        continue;
      }
      if (code < 33 || code > 117) {
        throw new Error('Invalid Ascii85 character ' + describeChar(ch) + ' at position ' + (i + 1) + '.');
      }

      tuple = tuple * 85 + (code - 33);
      count++;
      if (count === 5) {
        if (tuple > 0xFFFFFFFF) {
          ctx.warnings.push('An Ascii85 5-character block exceeded the maximum 32-bit value (0xFFFFFFFF). The input may be corrupted.');
        }
        out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
        tuple = 0;
        count = 0;
      }
    }

    if (count === 1) {
      ctx.warnings.push('The Base85 input ended with 1 leftover character, which cannot form a byte and was ignored. The input may be truncated.');
    } else if (count > 1) {
      for (let p = count; p < 5; p++) tuple = tuple * 85 + 84; // pad with 'u' (84)
      for (let b = 0; b < count - 1; b++) {
        out.push((tuple >>> (24 - b * 8)) & 0xff);
      }
    }

    return new Uint8Array(out);
  }

  function decodeRfc1924Bytes(str, ctx) {
    const out = [];
    let tuple = 0;
    let count = 0;

    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      const val = code < 128 ? B85_RFC_MAP[code] : -1;
      if (val === -1) {
        throw new Error('Invalid Base85 (RFC 1924) character ' + describeChar(str[i]) + ' at position ' + (i + 1) + '.');
      }
      tuple = tuple * 85 + val;
      count++;
      if (count === 5) {
        if (tuple > 0xFFFFFFFF) {
          ctx.warnings.push('A Base85 5-character block exceeded the maximum 32-bit value (0xFFFFFFFF). The input may be corrupted.');
        }
        out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
        tuple = 0;
        count = 0;
      }
    }

    if (count === 1) {
      ctx.warnings.push('The Base85 input ended with 1 leftover character, which cannot form a byte and was ignored. The input may be truncated.');
    } else if (count > 1) {
      for (let p = count; p < 5; p++) tuple = tuple * 85 + 84; // pad with '~' (84)
      for (let b = 0; b < count - 1; b++) {
        out.push((tuple >>> (24 - b * 8)) & 0xff);
      }
    }

    return new Uint8Array(out);
  }

  async function runBase85Mode(raw, ctx) {
    let s = stripQuotes(raw.trim());
    if (s !== raw.trim()) {
      ctx.notes.push('Surrounding quotation marks were removed.');
    }

    // Check for Adobe Ascii85 <~ ... ~> wrapper
    const wrapped = s.match(/<~([\s\S]*?)~>/);
    let forceAscii85 = false;
    if (wrapped) {
      s = wrapped[1];
      forceAscii85 = true;
      ctx.notes.push('Ascii85 delimiters (<~ ... ~>) were detected and stripped.');
    } else if (s.startsWith('<~')) {
      s = s.slice(2);
      forceAscii85 = true;
      ctx.warnings.push('Opening "<~" delimiter found without a closing "~>" delimiter. The input may be truncated.');
    }

    if (/\s/.test(s)) {
      s = s.replace(/\s+/g, '');
      ctx.notes.push('Spaces and line breaks were removed from the Base85 text.');
    }

    if (s.length === 0) {
      throw new Error('No Base85 data found in the input.');
    }

    let bytes = null;
    let variant = '';

    if (forceAscii85) {
      bytes = decodeAscii85Bytes(s, ctx);
      variant = 'Ascii85';
    } else {
      // Try both Ascii85 and RFC 1924 / Python Base85 and pick the best match
      const subA = { steps: [], notes: [], warnings: [], hint: null };
      const subR = { steps: [], notes: [], warnings: [], hint: null };
      let bytesA = null;
      let bytesR = null;

      try { bytesA = decodeAscii85Bytes(s, subA); } catch (e) {}
      try { bytesR = decodeRfc1924Bytes(s, subR); } catch (e) {}

      if (bytesA && bytesR) {
        const textA = detectText(bytesA, { steps: [], notes: [], warnings: [], hint: null });
        const textR = detectText(bytesR, { steps: [], notes: [], warnings: [], hint: null });

        if (textR && !textA) {
          bytes = bytesR; variant = 'Base85 (RFC 1924 / Python)';
          ctx.warnings.push.apply(ctx.warnings, subR.warnings);
        } else if (textA && !textR) {
          bytes = bytesA; variant = 'Ascii85';
          ctx.warnings.push.apply(ctx.warnings, subA.warnings);
        } else {
          // Compare printable ratio
          const strA = tryDecode('utf-8', bytesA, false) || '';
          const strR = tryDecode('utf-8', bytesR, false) || '';
          if (printableRatio(strR) > printableRatio(strA)) {
            bytes = bytesR; variant = 'Base85 (RFC 1924 / Python)';
            ctx.warnings.push.apply(ctx.warnings, subR.warnings);
          } else {
            bytes = bytesA; variant = 'Ascii85';
            ctx.warnings.push.apply(ctx.warnings, subA.warnings);
          }
        }
      } else if (bytesA) {
        bytes = bytesA; variant = 'Ascii85';
        ctx.warnings.push.apply(ctx.warnings, subA.warnings);
      } else if (bytesR) {
        bytes = bytesR; variant = 'Base85 (RFC 1924 / Python)';
        ctx.warnings.push.apply(ctx.warnings, subR.warnings);
      } else {
        throw new Error('This input contains characters that are not valid in either Ascii85 or standard RFC 1924 Base85.');
      }
    }

    if (!bytes || bytes.length === 0) {
      throw new Error('The Base85 input decoded to zero bytes.');
    }

    ctx.steps.push(variant + ' (' + bytes.length + ' bytes)');
    return bytesToOutput(bytes, ctx, 0);
  }

  /* ------------------------------------------------------------------ */
  /* Mode 3: URL & Obfuscated URL Decoder                               */
  /* ------------------------------------------------------------------ */

  function decodeHtmlEntities(str) {
    return str
      .replace(/&#x([0-9a-fA-F]{1,6});?/g, function (_, hex) {
        return String.fromCodePoint(parseInt(hex, 16));
      })
      .replace(/&#([0-9]{1,7});?/g, function (_, dec) {
        return String.fromCodePoint(parseInt(dec, 10));
      })
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&colon;/gi, ':')
      .replace(/&sol;/gi, '/')
      .replace(/&period;/gi, '.');
  }

  function safePercentDecode(str, ctx) {
    // Handle non-standard %uXXXX Unicode escapes first
    let current = str.replace(/%u([0-9a-fA-F]{4})/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });

    try {
      return decodeURIComponent(current);
    } catch (e) {
      // Fallback: decode valid %XX sequences byte-by-byte so partial/broken URLs still decode
      ctx.warnings.push('The URL contains malformed percent-encoding or non-UTF8 bytes. Valid sequences were decoded partially.');
      const bytes = [];
      let out = '';
      const flushBytes = function () {
        if (bytes.length > 0) {
          out += new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
          bytes.length = 0;
        }
      };
      for (let i = 0; i < current.length; i++) {
        if (current[i] === '%' && i + 2 < current.length && /^[0-9a-fA-F]{2}$/.test(current.slice(i + 1, i + 3))) {
          bytes.push(parseInt(current.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          flushBytes();
          out += current[i];
        }
      }
      flushBytes();
      return out;
    }
  }

  function intToIpv4(num) {
    return [
      (num >>> 24) & 0xff,
      (num >>> 16) & 0xff,
      (num >>> 8) & 0xff,
      num & 0xff
    ].join('.');
  }

  // Convert obfuscated IPv4 hostnames (Hex, Octal, Decimal Dword) to standard dotted IPv4
  function deobfuscateHostIp(host) {
    const h = host.trim();
    if (!h) return null;

    // 1. Single 32-bit Hex integer: 0x7f000001
    if (/^0x[0-9a-f]{1,8}$/i.test(h)) {
      const val = parseInt(h, 16);
      if (val >= 0 && val <= 0xFFFFFFFF) {
        return { ip: intToIpv4(val >>> 0), type: 'Hexadecimal IP (' + h + ')' };
      }
    }

    // 2. Single 32-bit Decimal (Dword) integer: 2130706433
    if (/^[0-9]{7,10}$/.test(h) && !h.startsWith('0')) {
      const val = Number(h);
      if (val >= 0 && val <= 0xFFFFFFFF) {
        return { ip: intToIpv4(val >>> 0), type: 'Decimal / Dword IP (' + h + ')' };
      }
    }

    // 3. Single Octal integer: 017700000001
    if (/^0[0-7]{8,11}$/.test(h)) {
      const val = parseInt(h, 8);
      if (val >= 0 && val <= 0xFFFFFFFF) {
        return { ip: intToIpv4(val >>> 0), type: 'Octal IP (' + h + ')' };
      }
    }

    // 4. Dotted 4-part IP where at least one octet is Hex (0x..) or Octal (0177..)
    const parts = h.split('.');
    if (parts.length === 4) {
      let hasObfuscatedOctet = false;
      const octets = [];
      for (const p of parts) {
        if (/^0x[0-9a-f]{1,2}$/i.test(p)) {
          hasObfuscatedOctet = true;
          octets.push(parseInt(p, 16));
        } else if (/^0[0-7]{1,3}$/.test(p) && p !== '0') {
          hasObfuscatedOctet = true;
          const v = parseInt(p, 8);
          if (v > 255) return null;
          octets.push(v);
        } else if (/^(?:0|[1-9][0-9]{0,2})$/.test(p)) {
          const v = parseInt(p, 10);
          if (v > 255) return null;
          octets.push(v);
        } else {
          return null;
        }
      }
      if (hasObfuscatedOctet) {
        return { ip: octets.join('.'), type: 'Obfuscated dotted IP (' + h + ')' };
      }
    }

    return null;
  }

  // Unwrap Proofpoint URL Defense v2 & v3 links
  function unwrapProofpoint(urlStr) {
    // v3: https://urldefense.com/v3/__https://example.com/path__;!!...
    const v3 = urlStr.match(/urldefense(?:\.proofpoint)?\.com\/v3\/__(.+?)__/i);
    if (v3) {
      return v3[1].replace(/\*/g, '%');
    }
    // v2: https://urldefense.proofpoint.com/v2/url?u=http-3A__example.com_path&d=...
    const v2 = urlStr.match(/urldefense\.proofpoint\.com\/v2\/url\?[^#]*?\bu=([^&]+)/i);
    if (v2) {
      const rawU = v2[1].replace(/-/g, '%').replace(/_/g, '/');
      try { return decodeURIComponent(rawU); } catch (e) { return rawU; }
    }
    return null;
  }

  function runUrlMode(raw, ctx) {
    let s = stripQuotes(raw.trim());
    let changed = false;

    // 1. Re-fang defanged URLs & indicators
    const beforeRefang = s;
    s = s
      .replace(/\bhxxps\b/gi, 'https')
      .replace(/\bhxxp\b/gi, 'http')
      .replace(/\bfxp\b/gi, 'ftp')
      .replace(/\[\s*:\s*\]\/\/|\(\s*:\s*\)\/\//g, '://')
      .replace(/\[\s*:\/\/\s*\]/g, '://')
      .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|\[\s*dot\s*\]|\(\s*dot\s*\)/gi, '.')
      .replace(/\[\s*\/\s*\]/g, '/')
      .replace(/\[\s*:\s*\]/g, ':')
      .replace(/\[\s*@\s*\]|\[\s*at\s*\]|\(\s*at\s*\)/gi, '@');

    if (s !== beforeRefang) {
      changed = true;
      ctx.steps.push('Re-fanged indicators');
      ctx.notes.push('Defanged indicators (such as hxxp, [.], or [:]) were restored to standard URL format.');
    }

    // 2. Decode HTML entities
    if (/&#?[a-zA-Z0-9]+;/.test(s)) {
      const decHtml = decodeHtmlEntities(s);
      if (decHtml !== s) {
        s = decHtml;
        changed = true;
        ctx.steps.push('HTML entities decoded');
      }
    }

    // 3. Proofpoint unwrapping before general percent decoding
    const pp = unwrapProofpoint(s);
    if (pp) {
      ctx.steps.push('Proofpoint URL Defense unwrapped');
      ctx.notes.push('Extracted the target URL from a Proofpoint URL Defense wrapper.');
      s = pp;
      changed = true;
    }

    // 4. Multi-layer percent & %uXXXX decoding
    let layers = 0;
    while (layers < 5 && (/%[0-9a-fA-F]{2}/.test(s) || /%u[0-9a-fA-F]{4}/.test(s))) {
      const next = safePercentDecode(s, ctx);
      if (next === s) break;
      s = next;
      layers++;
      changed = true;
    }
    if (layers > 0) {
      ctx.steps.push('URL-decoded' + (layers > 1 ? ' (' + layers + ' layers)' : ''));
      if (layers > 1) {
        ctx.notes.push('Multi-layer percent-encoding was detected and decoded (' + layers + ' passes).');
      }
    }

    // 5. Inspect URL structure: redirect unwrapping, obfuscated IPs, @ spoofing, shorteners
    let unwrappedTarget = null;
    const decodedParams = [];

    // Check if s (or a bare obfuscated IP) can be parsed as a URL
    let urlCandidate = s;
    const rawHostMatch = s.match(/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^/@\s]+@)?([^/:?#\s]+)/);
    const rawHost = rawHostMatch ? rawHostMatch[1] : '';
    const bareIpCheck = deobfuscateHostIp(rawHost);
    if (bareIpCheck && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
      urlCandidate = 'http://' + s;
    }

    try {
      const parsed = new URL(urlCandidate);

      // a) Check for @ credential spoofing (e.g. https://microsoft.com@evil.com)
      if (parsed.username || parsed.password) {
        const fakeUser = decodeURIComponent(parsed.username + (parsed.password ? ':' + parsed.password : ''));
        ctx.warnings.push('Phishing "@" trick detected: "' + fakeUser +
          '" before the "@" is a username, NOT the domain! The actual destination host is "' + parsed.hostname + '".');
        changed = true;
      }

      // b) Check for Punycode / IDN homograph domain
      if (/(?:^|\.)xn--/i.test(parsed.hostname)) {
        ctx.warnings.push('Punycode domain detected ("' + parsed.hostname +
          '"). Attackers sometimes use internationalized lookalike characters to spoof trusted domains.');
        changed = true;
      }

      // c) De-obfuscate IP hostnames (Hex, Dword, Octal)
      // Note: WHATWG URL() normalizes hex/dword/octal IPs in parsed.hostname automatically,
      // so we inspect rawHost extracted before URL() normalization.
      const ipInfo = bareIpCheck || deobfuscateHostIp(parsed.hostname);
      if (ipInfo) {
        ctx.steps.push(ipInfo.type + ' \u2192 ' + ipInfo.ip);
        ctx.warnings.push('Obfuscated IP address detected in hostname: ' + ipInfo.type + ' resolves to IPv4 ' + ipInfo.ip + '.');
        s = s.replace(rawHost, ipInfo.ip);
        changed = true;
      }

      // d) Unwrap redirect wrappers (Outlook SafeLinks, Google, or redirect query params)
      const hostLower = parsed.hostname.toLowerCase();
      const REDIRECT_KEYS = ['url', 'u', 'q', 'redirect', 'redirect_uri', 'redirect_url', 'target', 'dest', 'destination', 'next', 'continue', 'returnto', 'goto', 'link'];

      for (const [key, val] of parsed.searchParams.entries()) {
        const cleanVal = val.trim();
        if (REDIRECT_KEYS.includes(key.toLowerCase()) && /^(?:https?|ftp):\/\//i.test(cleanVal)) {
          unwrappedTarget = cleanVal;
          if (hostLower.includes('safelinks.protection.outlook.com')) {
            ctx.steps.push('Outlook SafeLinks unwrapped');
            ctx.notes.push('Extracted destination URL from Microsoft Outlook SafeLinks wrapper.');
          } else {
            ctx.steps.push('Redirect wrapper unwrapped (' + parsed.hostname + ')');
            ctx.notes.push('Extracted destination URL from "' + key + '" redirect parameter on ' + parsed.hostname + '.');
          }
          changed = true;
        } else if (cleanVal.length >= 8 && /^[A-Za-z0-9+/=_-]+$/.test(cleanVal)) {
          // Check if query parameter value is Base64-encoded readable text
          try {
            const subCtx = { steps: [], notes: [], warnings: [], hint: null };
            const b = base64ToBytes(cleanVal, subCtx);
            const t = detectText(b, subCtx);
            if (t && b.length >= 4 && printableRatio(t.text) >= 0.9 && t.text !== cleanVal) {
              decodedParams.push(key + ' (Base64 ' + t.encoding + '): ' + revealControlChars(t.text, ctx));
            }
          } catch (e) {}
        }
      }

      // e) Check for known URL shorteners
      const baseHost = hostLower.replace(/^www\./, '');
      if (SHORTENER_DOMAINS.has(baseHost)) {
        ctx.steps.push('Shortened URL (' + baseHost + ')');
        ctx.warnings.push('Shortened URL detected (' + baseHost + '). Because MiCode runs 100% offline to protect your OPSEC, it never connects to external servers to follow live redirects. Inspect this link in an isolated sandbox or URL-expander service.');
        changed = true;
      }
    } catch (e) {
      // Not a full URL with scheme; could be a query string or path fragment
    }

    if (!changed && decodedParams.length === 0) {
      // If the user explicitly ran URL mode on a plain URL, still show a helpful breakdown
      if (/^(?:https?|ftp):\/\//i.test(s)) {
        ctx.steps.push('URL inspected (no encoding obfuscation found)');
        ctx.notes.push('This URL did not contain percent-encoding, defanged brackets, or redirect wrappers.');
      } else {
        throw new Error('No URL encoding (%XX), defanged indicators (hxxp, [.]), or obfuscated URL patterns were found in the input.');
      }
    }

    let finalOutput = unwrappedTarget ? unwrappedTarget : s;
    if (unwrappedTarget && unwrappedTarget !== s) {
      finalOutput = unwrappedTarget + '\n\n--- Original Wrapper URL ---\n' + s;
    }
    if (decodedParams.length > 0) {
      ctx.steps.push('Base64 query parameter(s) decoded');
      finalOutput += '\n\n--- Decoded Query Parameters ---\n' + decodedParams.join('\n');
    }

    return revealControlChars(finalOutput, ctx);
  }

  /* ------------------------------------------------------------------ */
  /* Mode 4: Hex & Escape Strings                                       */
  /* ------------------------------------------------------------------ */

  async function runHexMode(raw, ctx) {
    let s = stripQuotes(raw.trim());

    // 1. Check for \uXXXX or \u{XXXX} Unicode escapes (without \xNN)
    if (/\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/.test(s) && !/\\x[0-9a-fA-F]{2}/.test(s)) {
      ctx.steps.push('Unicode escapes (\\uNNNN)');
      const decoded = s
        .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
        .replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
      return revealControlChars(decoded, ctx);
    }

    // 2. Check for \xNN hex escapes
    if (/\\x[0-9a-fA-F]{2}/.test(s)) {
      ctx.steps.push('Hex escapes (\\xNN)');
      const hexPairs = [];
      const stripped = s.replace(/\\x([0-9a-fA-F]{2})/g, function (_, h) {
        hexPairs.push(parseInt(h, 16));
        return '';
      }).trim();
      if (stripped.length === 0) {
        const bytes = new Uint8Array(hexPairs);
        return bytesToOutput(bytes, ctx, 0);
      }
      // Mixed text and \xNN escapes
      const mixed = s.replace(/\\x([0-9a-fA-F]{2})/g, function (_, h) {
        return String.fromCharCode(parseInt(h, 16));
      });
      return revealControlChars(mixed, ctx);
    }

    // 3. Raw hex, 0x-prefixed hex, or space/colon/comma/dash separated hex bytes
    let cleaned = s
      .replace(/0x/gi, '')
      .replace(/[\s,:\-;]+/g, '');

    if (cleaned.length === 0) {
      throw new Error('No hexadecimal data found in the input.');
    }

    const invalid = cleaned.match(/[^0-9a-fA-F]/g) || [];
    if (invalid.length > 0) {
      const unique = [...new Set(invalid)].slice(0, 8).map(describeChar).join(', ');
      throw new Error('This does not look like valid hexadecimal data (found non-hex characters: ' + unique + ').');
    }

    if (cleaned.length % 2 === 1) {
      cleaned = cleaned.slice(0, -1);
      ctx.warnings.push('The hex input had an odd number of digits. The last digit was ignored; the input may be truncated.');
    }

    if (cleaned.length === 0) {
      throw new Error('The hex input is too short to form a byte.');
    }

    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }

    ctx.steps.push('Hexadecimal (' + bytes.length + ' bytes)');
    return bytesToOutput(bytes, ctx, 0);
  }

  /* ------------------------------------------------------------------ */
  /* Auto-Detection Router                                              */
  /* ------------------------------------------------------------------ */

  function detectAutoMode(raw) {
    const s = stripQuotes(raw.trim());

    // 1. PowerShell -enc / -EncodedCommand or FromBase64String is always Base64
    if (hasPowerShellHint(raw)) return 'base64';

    // 2. Ascii85 <~ ... ~> wrapper is always Base85
    if (/<~[\s\S]*~/.test(s)) return 'base85';

    // 3. URL / Defanged URL / Percent-encoded string
    if (
      /^(?:https?|hxxps?|ftp|fxp):\/\//i.test(s) ||
      /^(?:https?|hxxps?)\[\s*:\s*\]\/\//i.test(s) ||
      /\[\s*\.\s*\]|\(\s*\.\s*\)|\[\s*dot\s*\]/i.test(s) ||
      /urldefense(?:\.proofpoint)?\.com|safelinks\.protection\.outlook\.com/i.test(s) ||
      (/(?:%[0-9a-fA-F]{2}){2,}/.test(s) && !/\s/.test(s))
    ) {
      return 'url';
    }

    // 4. Explicit \xNN or \uNNNN escapes or 0x.. hex lists
    if (/^(?:\\x[0-9a-fA-F]{2})+$/i.test(s.replace(/\s+/g, '')) ||
        /\\u[0-9a-fA-F]{4}/.test(s) ||
        /^(?:0x[0-9a-fA-F]{2}[\s,]+)+0x[0-9a-fA-F]{2}$/i.test(s) ||
        /^(?:[0-9a-fA-F]{2}[:\-]){3,}[0-9a-fA-F]{2}$/.test(s)) {
      return 'hex';
    }

    // 5. Space-separated hex pairs (e.g. "48 65 6c 6c 6f")
    if (/^(?:[0-9a-fA-F]{2}\s+){2,}[0-9a-fA-F]{2}$/.test(s)) {
      return 'hex';
    }

    // 6. Continuous hex string (only 0-9a-fA-F, even length >= 8) where hex decodes cleanly to text
    //    and Base64 does not decode cleanly to text.
    const noSpace = s.replace(/\s+/g, '');
    if (noSpace.length >= 8 && noSpace.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(noSpace)) {
      const hexBytes = new Uint8Array(noSpace.length / 2);
      for (let i = 0; i < hexBytes.length; i++) {
        hexBytes[i] = parseInt(noSpace.slice(i * 2, i * 2 + 2), 16);
      }
      const hexText = detectText(hexBytes, { steps: [], notes: [], warnings: [], hint: null });
      if (hexText) {
        // Check if Base64 also produces clean text
        let b64Clean = false;
        try {
          const b64Bytes = base64ToBytes(noSpace, { steps: [], notes: [], warnings: [], hint: null });
          const b64Text = detectText(b64Bytes, { steps: [], notes: [], warnings: [], hint: null });
          if (b64Text) b64Clean = true;
        } catch (e) {}
        if (!b64Clean) return 'hex';
      }
    }

    // 7. Base85 without <~ ~>: contains >10% non-Base64 characters that belong to Base85 alphabets
    const nonB64 = noSpace.match(/[^A-Za-z0-9+/=_-]/g) || [];
    if (noSpace.length >= 4 && nonB64.length / noSpace.length > 0.1 && !/\s/.test(s.trim())) {
      const allAscii85 = [...noSpace].every(function (ch) {
        const c = ch.charCodeAt(0);
        return (c >= 33 && c <= 117) || ch === 'z' || ch === 'y';
      });
      const allRfc85 = [...noSpace].every(function (ch) {
        const c = ch.charCodeAt(0);
        return c < 128 && B85_RFC_MAP[c] !== -1;
      });
      if (allAscii85 || allRfc85) {
        return 'base85';
      }
    }

    // 8. Default to Base64
    return 'base64';
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Decode user input.
   * @param {string} raw - Input text to decode.
   * @param {string} [mode='auto'] - 'auto' | 'base64' | 'base85' | 'url' | 'hex'
   * @returns {Promise<{ok:boolean, output:string, steps:string[], notes:string[], warnings:string[], error:string|null, mode:string}>}
   */
  async function decode(raw, mode) {
    const selectedMode = (mode || 'auto').toLowerCase();
    const ctx = { steps: [], notes: [], warnings: [], hint: null };
    const result = function (ok, output, error, usedMode) {
      return {
        ok: ok,
        output: output,
        steps: ctx.steps,
        notes: ctx.notes,
        warnings: ctx.warnings,
        error: error,
        mode: usedMode || selectedMode
      };
    };

    if (typeof raw !== 'string' || raw.trim() === '') {
      return result(false, '', 'Please paste an encoded string, PowerShell command, or obfuscated URL first.', selectedMode);
    }

    const effectiveMode = selectedMode === 'auto' ? detectAutoMode(raw) : selectedMode;

    try {
      let output;
      if (effectiveMode === 'base85') {
        output = await runBase85Mode(raw, ctx);
      } else if (effectiveMode === 'url') {
        output = runUrlMode(raw, ctx);
      } else if (effectiveMode === 'hex') {
        output = await runHexMode(raw, ctx);
      } else {
        output = await runBase64Mode(raw, ctx);
      }
      return result(true, output, null, effectiveMode);
    } catch (e) {
      return result(false, '', e && e.message ? e.message : 'Decoding failed.', effectiveMode);
    }
  }

  const api = { decode: decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MiCodeDecoder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
