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
  const modeGroup = document.getElementById('mode-group');
  const modeBtns = modeGroup ? Array.from(modeGroup.querySelectorAll('.mode-btn')) : [];

  let currentMode = 'auto';

  const PLACEHOLDERS = {
    auto: 'Paste Base64, PowerShell -enc, Base85, Obfuscated URL, or Hex, e.g.\npowershell.exe -NoP -W Hidden -enc SQBFAFgAIAAoACcAaABlAGwAbABvACcAKQA=',
    base64: 'Paste Base64 text or a PowerShell command, e.g.\npowershell.exe -NoP -W Hidden -enc SQBFAFgAIAAoACcAaABlAGwAbABvACcAKQA=',
    base85: 'Paste Ascii85 (<~...~>) or RFC 1924 / Python Base85, e.g.\n<~87cURD]i,"Ebo7~>  or  NM&qnZy;B1a%^NF',
    url: 'Paste an obfuscated, percent-encoded, defanged, or wrapped URL, e.g.\nhxxps[:]//evil[.]example[.]com/login%3Fuser%3Dadmin',
    hex: 'Paste hex bytes, 0x values, or \\xNN / \\uNNNN escapes, e.g.\n48 65 6c 6c 6f 20 53 4f 43  or  \\x77\\x68\\x6f\\x61\\x6d\\x69'
  };

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
      const result = await window.MiCodeDecoder.decode(input.value, currentMode);
      output.value = result.output;
      showStatus(result);
    } finally {
      decodeBtn.disabled = false;
    }
  }

  function setMode(mode) {
    currentMode = mode;
    modeBtns.forEach(function (btn) {
      const isSelected = btn.getAttribute('data-mode') === mode;
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
    if (PLACEHOLDERS[mode]) {
      input.placeholder = PLACEHOLDERS[mode];
    }
    if (input.value.trim() !== '') {
      runDecode();
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
  modeBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setMode(btn.getAttribute('data-mode') || 'auto');
    });
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runDecode();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Hanging Light Switch Pull Cord & Theme Management                  */
  /* ------------------------------------------------------------------ */
  function initThemeAndPullCord() {
    const fixture = document.getElementById("theme-cord-container");
    const area = document.getElementById("cord-interactive-area");
    const stem = document.getElementById("rope-stem");
    const handle = document.getElementById("cord-handle");
    const bulb = document.getElementById("bulb-indicator");
    const tooltip = document.getElementById("cord-tooltip");
    const cue = document.getElementById("pull-cue");

    // Default to dark theme or saved preference
    let currentTheme = 'dark';
    try {
      const saved = localStorage.getItem("micode-theme");
      if (saved) currentTheme = saved;
    } catch (e) {}

    function applyTheme(theme) {
      document.documentElement.setAttribute("data-theme", theme);
      try {
        localStorage.setItem("micode-theme", theme);
      } catch (e) {}

      const isDark = theme === "dark";
      if (bulb) {
        bulb.className = isDark ? "cord-indicator-bulb bulb-off" : "cord-indicator-bulb bulb-lit";
      }
      if (tooltip) {
        tooltip.textContent = isDark ? "Pull for Lights ON (Light Mode)" : "Pull for Lights OFF (Dark Mode)";
      }
    }

    applyTheme(currentTheme);

    if (!fixture || !area || !stem || !handle) return;

    const BASE_HEIGHT = 32;
    const MAX_PULL = 36;
    const PULL_THRESHOLD = 18;

    let isDragging = false;
    let startY = 0;
    let currentStretch = 0;
    let dragStartTime = 0;

    function playTactileClick() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(160, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.05);

        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start();
        osc.stop(ctx.currentTime + 0.05);
      } catch (e) {
        // audio disabled or blocked
      }
    }

    function toggleTheme() {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      const newTheme = current === "light" ? "dark" : "light";
      applyTheme(newTheme);
    }

    function snapBack(shouldToggle, finalStretch) {
      fixture.classList.remove("cord-snapping");
      const releaseHeight = BASE_HEIGHT + finalStretch;
      stem.style.setProperty("--release-height", releaseHeight + "px");
      handle.style.setProperty("--release-y", finalStretch + "px");

      stem.style.height = "";
      handle.style.transform = "";

      void fixture.offsetWidth; // force reflow
      fixture.classList.add("cord-snapping");

      if (shouldToggle) {
        toggleTheme();
        playTactileClick();
      }

      if (cue) {
        cue.style.background = "transparent";
        cue.style.boxShadow = "none";
      }

      setTimeout(function () {
        fixture.classList.remove("cord-snapping");
        stem.style.height = BASE_HEIGHT + "px";
        handle.style.transform = "translateY(0px)";
      }, 550);
    }

    area.addEventListener("pointerdown", function (e) {
      isDragging = true;
      startY = e.clientY;
      currentStretch = 0;
      dragStartTime = Date.now();
      fixture.classList.remove("cord-snapping");
      try { area.setPointerCapture(e.pointerId); } catch (err) {}
    });

    area.addEventListener("pointermove", function (e) {
      if (!isDragging) return;
      const rawDeltaY = e.clientY - startY;
      if (rawDeltaY > 0) {
        currentStretch = Math.min(MAX_PULL, Math.pow(rawDeltaY, 0.85) * 1.3);
      } else {
        currentStretch = 0;
      }
      stem.style.height = (BASE_HEIGHT + currentStretch) + "px";
      handle.style.transform = "translateY(" + currentStretch + "px)";

      if (cue) {
        if (currentStretch >= PULL_THRESHOLD) {
          cue.style.background = "#c48b54";
          cue.style.boxShadow = "0 0 8px #c48b54";
        } else {
          cue.style.background = "transparent";
          cue.style.boxShadow = "none";
        }
      }
    });

    function finishPull(e) {
      if (!isDragging) return;
      isDragging = false;
      try { area.releasePointerCapture(e.pointerId); } catch (err) {}

      const duration = Date.now() - dragStartTime;
      const finalStretch = currentStretch;
      const isQuickTap = duration < 240 && finalStretch < 8;

      if (finalStretch >= PULL_THRESHOLD || isQuickTap) {
        snapBack(true, isQuickTap ? 24 : finalStretch);
      } else {
        snapBack(false, finalStretch);
      }
    }

    area.addEventListener("pointerup", finishPull);
    area.addEventListener("pointercancel", function (e) {
      if (!isDragging) return;
      isDragging = false;
      try { area.releasePointerCapture(e.pointerId); } catch (err) {}
      snapBack(false, currentStretch);
    });

    fixture.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        snapBack(true, 24);
      }
    });
  }

  initThemeAndPullCord();

  // Offline support: cache the app files after the first visit.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline caching unavailable */ });
    });
  }
})();
