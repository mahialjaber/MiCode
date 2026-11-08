/*
 * MiCode user interface.
 * Output is only ever written with .value / .textContent (never innerHTML),
 * so decoded content can never run as code in the page.
 */
(function () {
  'use strict';

  const input = document.getElementById('input');
  const output = document.getElementById('output');
  const status = document.getElementById('status');
  const decodeBtn = document.getElementById('decode');
  const copyBtn = document.getElementById('copy');
  const clearBtn = document.getElementById('clear');
  const copyMsg = document.getElementById('copy-msg');

  function addList(items) {
    const ul = document.createElement('ul');
    items.forEach(function (text) {
      const li = document.createElement('li');
      li.textContent = text;
      ul.appendChild(li);
    });
    status.appendChild(ul);
  }

  function showStatus(result) {
    status.replaceChildren();
    status.className = 'status';

    const title = document.createElement('strong');
    if (!result.ok) {
      status.classList.add('error');
      title.textContent = 'Could not decode';
    } else if (result.warnings.length > 0) {
      status.classList.add('warn');
      title.textContent = '\u26A0 Decoded with warnings \u2014 the output may be incomplete or inaccurate';
    } else {
      title.textContent = '\u2713 Decoded successfully';
    }
    status.appendChild(title);

    // On failure, show only the reason to keep the message clear.
    if (!result.ok) {
      addList([result.error]);
      status.hidden = false;
      return;
    }

    if (result.steps.length > 0) {
      const steps = document.createElement('div');
      steps.className = 'steps';
      steps.textContent = 'Detected: ' + result.steps.join(' \u2192 ');
      status.appendChild(steps);
    }

    const messages = [];
    result.warnings.forEach(function (w) { messages.push('Warning: ' + w); });
    result.notes.forEach(function (n) { messages.push(n); });
    if (messages.length > 0) addList(messages);

    status.hidden = false;
  }

  async function runDecode() {
    decodeBtn.disabled = true;
    copyMsg.textContent = '';
    try {
      const result = await window.MiCodeDecoder.decode(input.value);
      output.value = result.output;
      showStatus(result);
    } finally {
      decodeBtn.disabled = false;
    }
  }

  async function copyOutput() {
    if (!output.value) {
      copyMsg.textContent = 'Nothing to copy.';
      return;
    }
    try {
      await navigator.clipboard.writeText(output.value);
      copyMsg.textContent = 'Copied.';
    } catch (e) {
      // Fallback for browsers that block the Clipboard API.
      output.focus();
      output.select();
      const ok = document.execCommand && document.execCommand('copy');
      copyMsg.textContent = ok ? 'Copied.' : 'Copy failed \u2014 select the text and press Ctrl+C.';
    }
  }

  function clearAll() {
    input.value = '';
    output.value = '';
    copyMsg.textContent = '';
    status.replaceChildren();
    status.hidden = true;
    input.focus();
  }

  decodeBtn.addEventListener('click', runDecode);
  copyBtn.addEventListener('click', copyOutput);
  clearBtn.addEventListener('click', clearAll);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runDecode();
    }
  });

  // Offline support: cache the app files after the first visit.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline caching unavailable */ });
    });
  }
})();
