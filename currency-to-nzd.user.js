// ==UserScript==
// @name         Currency Converter (to NZD)
// @namespace    https://github.com/local/currency-to-nzd
// @version      2.0.0
// @description  Detects foreign currency prices on any page and shows a clean conversion badge next to them, using live exchange rates. Configurable target currency, flags, and per-site exclusions.
// @author       you
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      open.er-api.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ----------------------------------------------------------------
   * CONSTANTS
   * ---------------------------------------------------------------- */

  const RATE_API_URL = 'https://open.er-api.com/v6/latest/USD';
  const RATE_CACHE_KEY = 'nzdconv_rates_cache';
  const RATE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;     // refetch after 1 hour
  const RATE_STALE_WARN_MS = 24 * 60 * 60 * 1000;   // warn badge if older than 24h
  const SETTINGS_KEY = 'nzdconv_settings_v2';

  const BADGE_CLASS = 'nzdconv-badge';
  const BADGE_STALE_CLASS = 'nzdconv-badge-stale';
  const PROCESSED_ATTR = 'data-nzdconv-done';

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
    'OPTION', 'CODE', 'PRE', 'IFRAME', 'SVG'
  ]);

  // Symbols, most-specific first so "NZ$" / "A$" win over bare "$".
  const SYMBOL_MAP = [
    { re: 'NZ\\$', code: 'NZD' },
    { re: 'US\\$', code: 'USD' },
    { re: 'AU\\$', code: 'AUD' },
    { re: 'A\\$', code: 'AUD' },
    { re: 'CA\\$', code: 'CAD' },
    { re: 'C\\$', code: 'CAD' },
    { re: 'HK\\$', code: 'HKD' },
    { re: 'S\\$', code: 'SGD' },
    { re: 'R\\$', code: 'BRL' },
    { re: '€', code: 'EUR' },
    { re: '£', code: 'GBP' },
    { re: '¥', code: 'JPY' },
    { re: '₹', code: 'INR' },
    { re: '₩', code: 'KRW' },
    { re: '\\$', code: '$AMBIGUOUS' } // resolved at runtime via resolveBareDollar()
  ];

  const CODE_LIST = [
    'USD', 'AUD', 'CAD', 'GBP', 'EUR', 'JPY', 'CNY', 'INR', 'KRW', 'CHF',
    'SEK', 'NOK', 'DKK', 'MXN', 'ZAR', 'HKD', 'SGD', 'THB', 'AED', 'PHP',
    'IDR', 'MYR', 'VND', 'BRL', 'PLN', 'TRY', 'ILS', 'NZD'
  ];

  const FLAGS = {
    USD: '🇺🇸', AUD: '🇦🇺', CAD: '🇨🇦', GBP: '🇬🇧', EUR: '🇪🇺', JPY: '🇯🇵',
    CNY: '🇨🇳', INR: '🇮🇳', KRW: '🇰🇷', CHF: '🇨🇭', SEK: '🇸🇪', NOK: '🇳🇴',
    DKK: '🇩🇰', MXN: '🇲🇽', ZAR: '🇿🇦', HKD: '🇭🇰', SGD: '🇸🇬', THB: '🇹🇭',
    AED: '🇦🇪', PHP: '🇵🇭', IDR: '🇮🇩', MYR: '🇲🇾', VND: '🇻🇳', BRL: '🇧🇷',
    PLN: '🇵🇱', TRY: '🇹🇷', ILS: '🇮🇱', NZD: '🇳🇿'
  };

  const CURRENCY_SYMBOLS_FOR_TARGET = {
    NZD: 'NZ$', USD: '$', AUD: 'A$', CAD: 'C$', GBP: '£', EUR: '€',
    JPY: '¥', CNY: '¥', INR: '₹', KRW: '₩', CHF: 'CHF', SGD: 'S$', HKD: 'HK$'
  };

  // Matches any digit blob with optional separators; interpretation of which
  // separator is "decimal" vs "thousands" happens in parseAmount().
  const NUMBER = '\\d(?:[\\d,.]*\\d)?';

  /* ----------------------------------------------------------------
   * SETTINGS
   * ---------------------------------------------------------------- */

  const DEFAULT_SETTINGS = {
    enabled: true,
    targetCurrency: 'NZD',
    showFlags: false,
    excludedHosts: []
  };

  function loadSettings() {
    try {
      const raw = GM_getValue(SETTINGS_KEY, null);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
  }

  let settings = loadSettings();

  /* ----------------------------------------------------------------
   * STYLES
   * ---------------------------------------------------------------- */

  GM_addStyle(`
    .${BADGE_CLASS} {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-left: 5px;
      padding: 1px 8px;
      font-size: 0.76em;
      font-weight: 600;
      line-height: 1.5;
      border-radius: 999px;
      background: linear-gradient(180deg, #eef6ff, #e2eefe);
      color: #1a4d8f;
      border: 1px solid #bcdcff;
      vertical-align: middle;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.2s ease;
      box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    }
    .${BADGE_CLASS}:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 5px rgba(0,0,0,0.12);
      background: linear-gradient(180deg, #e2eefe, #d3e6fd);
    }
    .${BADGE_CLASS}:active {
      transform: translateY(0);
    }
    .${BADGE_STALE_CLASS} {
      background: linear-gradient(180deg, #fff7e6, #fef0cf);
      border-color: #f0d78c;
      color: #8a6100;
    }
    @media (prefers-color-scheme: dark) {
      .${BADGE_CLASS} {
        background: linear-gradient(180deg, #1c2a3d, #16233355);
        color: #9cc7ff;
        border-color: #2c4a6e;
        box-shadow: 0 1px 2px rgba(0,0,0,0.4);
      }
      .${BADGE_CLASS}:hover {
        background: linear-gradient(180deg, #223751, #1a2b40);
      }
      .${BADGE_STALE_CLASS} {
        background: linear-gradient(180deg, #3a2f14, #2e2510);
        color: #e8c15a;
        border-color: #6b551f;
      }
    }

    #nzdconv-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    #nzdconv-dialog {
      background: #ffffff;
      color: #1a1a1a;
      width: 340px;
      max-width: 90vw;
      border-radius: 14px;
      padding: 22px 22px 18px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.25);
    }
    #nzdconv-dialog h2 {
      margin: 0 0 14px;
      font-size: 17px;
      font-weight: 700;
    }
    #nzdconv-dialog label.nzdconv-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 12px 0;
      font-size: 14px;
    }
    #nzdconv-dialog select {
      font-size: 14px;
      padding: 4px 6px;
      border-radius: 6px;
      border: 1px solid #ccc;
    }
    #nzdconv-dialog input[type="checkbox"] {
      width: 17px;
      height: 17px;
    }
    #nzdconv-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 18px;
    }
    #nzdconv-actions button {
      font-size: 13.5px;
      font-weight: 600;
      padding: 7px 14px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
    }
    #nzdconv-cancel {
      background: #eee;
      color: #333;
    }
    #nzdconv-save {
      background: #1a6dd8;
      color: white;
    }
    #nzdconv-hint {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
    }

    .nzdconv-tooltip {
      position: fixed;
      z-index: 2147483647;
      background: #1f2937;
      color: #f3f4f6;
      font-size: 12.5px;
      line-height: 1.6;
      padding: 9px 12px;
      border-radius: 9px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      max-width: 270px;
      pointer-events: none;
      white-space: normal;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }
    .nzdconv-tooltip strong {
      color: #93c5fd;
    }
    .nzdconv-tooltip .nzdconv-tt-warn {
      color: #fbbf24;
      display: block;
      margin-top: 4px;
    }
    .nzdconv-tooltip .nzdconv-tt-hint {
      color: #9ca3af;
      display: block;
      margin-top: 4px;
      font-size: 11.5px;
    }
  `);

  /* ----------------------------------------------------------------
   * MENU COMMANDS
   * ---------------------------------------------------------------- */

  const currentHost = location.hostname;
  const siteExcluded = settings.excludedHosts.includes(currentHost);

  GM_registerMenuCommand(
    settings.enabled ? '🟢 Currency conversion: ON (click to turn off)' : '⚪ Currency conversion: OFF (click to turn on)',
    () => {
      settings.enabled = !settings.enabled;
      saveSettings(settings);
      location.reload();
    }
  );

  GM_registerMenuCommand(
    siteExcluded ? `✅ Re-enable on ${currentHost}` : `🚫 Disable on ${currentHost}`,
    () => {
      if (siteExcluded) {
        settings.excludedHosts = settings.excludedHosts.filter(h => h !== currentHost);
      } else {
        settings.excludedHosts.push(currentHost);
      }
      saveSettings(settings);
      location.reload();
    }
  );

  GM_registerMenuCommand('⚙️ Settings (target currency, flags...)', openSettingsDialog);

  GM_registerMenuCommand('🔄 Refresh exchange rates now', () => {
    GM_setValue(RATE_CACHE_KEY, '');
    location.reload();
  });

  function openSettingsDialog() {
    const existing = document.getElementById('nzdconv-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'nzdconv-overlay';

    const currencyOptions = Object.keys(FLAGS)
      .sort()
      .map(code => `<option value="${code}" ${code === settings.targetCurrency ? 'selected' : ''}>${FLAGS[code]} ${code}</option>`)
      .join('');

    overlay.innerHTML = `
      <div id="nzdconv-dialog">
        <h2>Currency Converter Settings</h2>

        <label class="nzdconv-row">
          Convert prices to
          <select id="nzdconv-target">${currencyOptions}</select>
        </label>

        <label class="nzdconv-row">
          Show country flags on badges
          <input type="checkbox" id="nzdconv-flags" ${settings.showFlags ? 'checked' : ''} />
        </label>

        <div id="nzdconv-hint">Click any conversion badge on a page to copy the converted amount.</div>

        <div id="nzdconv-actions">
          <button id="nzdconv-cancel">Cancel</button>
          <button id="nzdconv-save">Save &amp; Reload</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.getElementById('nzdconv-cancel').addEventListener('click', () => overlay.remove());
    document.getElementById('nzdconv-save').addEventListener('click', () => {
      settings.targetCurrency = document.getElementById('nzdconv-target').value;
      settings.showFlags = document.getElementById('nzdconv-flags').checked;
      saveSettings(settings);
      location.reload();
    });
  }

  if (!settings.enabled || siteExcluded) {
    console.log(`[NZDConv] not running (enabled=${settings.enabled}, excludedOnThisSite=${siteExcluded})`);
    return;
  }

  /* ----------------------------------------------------------------
   * REGEX BUILD (depends on target currency, so build after settings load)
   * ---------------------------------------------------------------- */

  const symbolAlt = SYMBOL_MAP.map(s => s.re).join('|');
  const codeAlt = CODE_LIST.join('|');

  const MASTER_REGEX = new RegExp(
    `(?:(${symbolAlt})\\s?(${NUMBER}))` +
    `|(?:(${NUMBER})\\s?(${codeAlt})\\b)` +
    `|(?:\\b(${codeAlt})\\s?(${NUMBER}))`,
    'g'
  );

  /* ----------------------------------------------------------------
   * STATE
   * ---------------------------------------------------------------- */

  let rates = null;
  let ratesFetchedAtMs = null;
  let ratesTimestampUtc = null;

  /* ----------------------------------------------------------------
   * RATES
   * ---------------------------------------------------------------- */

  function fetchRates() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: RATE_API_URL,
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText);
            if (data && data.result === 'success' && data.rates) {
              console.log('[NZDConv] rates fetched OK');
              resolve({ rates: data.rates, time: data.time_last_update_utc });
            } else {
              console.error('[NZDConv] rate API responded with unexpected payload:', data);
              reject(new Error('Bad rate API response'));
            }
          } catch (e) {
            console.error('[NZDConv] failed to parse rate API response:', e);
            reject(e);
          }
        },
        onerror: (err) => {
          console.error('[NZDConv] network error fetching rates:', err);
          reject(err);
        }
      });
    });
  }

  async function loadRates() {
    const cachedRaw = GM_getValue(RATE_CACHE_KEY, null);
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw);
        if (Date.now() - cached.fetchedAt < RATE_CACHE_MAX_AGE_MS) {
          rates = cached.rates;
          ratesTimestampUtc = cached.time;
          ratesFetchedAtMs = cached.fetchedAt;
          return;
        }
      } catch (e) { /* fall through to refetch */ }
    }

    try {
      const { rates: freshRates, time } = await fetchRates();
      rates = freshRates;
      ratesTimestampUtc = time;
      ratesFetchedAtMs = Date.now();
      GM_setValue(RATE_CACHE_KEY, JSON.stringify({ rates: freshRates, time, fetchedAt: ratesFetchedAtMs }));
    } catch (e) {
      if (cachedRaw) {
        try {
          const cached = JSON.parse(cachedRaw);
          rates = cached.rates;
          ratesTimestampUtc = cached.time;
          ratesFetchedAtMs = cached.fetchedAt;
          console.log('[NZDConv] using stale cached rates as fallback');
        } catch (e2) { /* nothing usable */ }
      }
    }

    if (!rates) console.error('[NZDConv] no rates available — will not scan the page.');
  }

  /* ----------------------------------------------------------------
   * CURRENCY HELPERS
   * ---------------------------------------------------------------- */

  function resolveBareDollar() {
    const host = location.hostname;
    if (host.endsWith('.au') || host.includes('.com.au')) return 'AUD';
    if (host.endsWith('.ca')) return 'CAD';
    if (host.endsWith('.sg')) return 'SGD';
    if (host.endsWith('.hk')) return 'HKD';
    if (host.endsWith('.nz')) return 'NZD';
    return 'USD';
  }

  // Handles both "1,299.00" (US) and "1.299,00" (EU) style numbers.
  function parseAmount(str) {
    str = str.trim();
    const lastComma = str.lastIndexOf(',');
    const lastDot = str.lastIndexOf('.');
    let decimalSep = null;

    if (lastComma > lastDot) decimalSep = ',';
    else if (lastDot > lastComma) decimalSep = '.';

    if (decimalSep) {
      const afterSep = str.slice(str.lastIndexOf(decimalSep) + 1);
      if (afterSep.length > 2) decimalSep = null; // 3+ digits after => thousands grouping, not decimal
    }

    let normalized;
    if (decimalSep === ',') normalized = str.replace(/\./g, '').replace(',', '.');
    else if (decimalSep === '.') normalized = str.replace(/,/g, '');
    else normalized = str.replace(/[.,]/g, '');

    return parseFloat(normalized);
  }

  function convertToTarget(amount, fromCode) {
    if (!rates || !rates[fromCode] || !rates[settings.targetCurrency]) return null;
    const usdAmount = amount / rates[fromCode];
    return usdAmount * rates[settings.targetCurrency];
  }

  function formatTarget(value) {
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* ----------------------------------------------------------------
   * HOVER TOOLTIP
   * ---------------------------------------------------------------- */

  let activeTooltip = null;

  function removeTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  window.addEventListener('scroll', removeTooltip, true);

  function showTooltip(badgeEl, html) {
    removeTooltip();
    const tip = document.createElement('div');
    tip.className = 'nzdconv-tooltip';
    tip.innerHTML = html;
    document.body.appendChild(tip);

    const badgeRect = badgeEl.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    let top = badgeRect.top - tipRect.height - 8;
    if (top < 8) top = badgeRect.bottom + 8; // flip below if no room above

    let left = badgeRect.left + badgeRect.width / 2 - tipRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));

    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    activeTooltip = tip;
  }

  /* ----------------------------------------------------------------
   * DOM SCANNING
   * ---------------------------------------------------------------- */

  function shouldSkipElement(el) {
    if (!el) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest(`.${BADGE_CLASS}`)) return true;
    return false;
  }

  function makeBadge(targetValue, originalText, fromCode, fromAmount, wasGuessed) {
    const span = document.createElement('span');
    span.className = BADGE_CLASS;

    const isStale = ratesFetchedAtMs && (Date.now() - ratesFetchedAtMs > RATE_STALE_WARN_MS);
    if (isStale) span.classList.add(BADGE_STALE_CLASS);

    const symbol = CURRENCY_SYMBOLS_FOR_TARGET[settings.targetCurrency] || (settings.targetCurrency + ' ');
    const flag = settings.showFlags ? (FLAGS[settings.targetCurrency] || '') + ' ' : '';
    span.textContent = `≈ ${flag}${symbol}${formatTarget(targetValue)}`;

    const ratePerUnit = rates[settings.targetCurrency] / rates[fromCode];
    const ageLabel = ratesTimestampUtc ? `Rates as of ${ratesTimestampUtc}` : 'Rate timestamp unavailable';
    const staleWarn = isStale
      ? `<span class="nzdconv-tt-warn">⚠ Rates may be outdated — use "Refresh exchange rates now" in the Tampermonkey menu.</span>`
      : '';
    const guessWarn = wasGuessed
      ? `<span class="nzdconv-tt-warn">⚠ The site only showed "$" with no currency code — ${fromCode} was guessed from the site's domain. Double-check against the site if unsure.</span>`
      : '';

    const tooltipHtml =
      `Detected currency: <strong>${fromCode}</strong> (${originalText.trim()})<br>` +
      `Rate used: 1 ${fromCode} = ${ratePerUnit.toFixed(4)} ${settings.targetCurrency}<br>` +
      `${ageLabel}` +
      guessWarn +
      staleWarn +
      `<span class="nzdconv-tt-hint">Click badge to copy ${formatTarget(targetValue)}</span>`;

    span.addEventListener('mouseenter', () => showTooltip(span, tooltipHtml));
    span.addEventListener('mouseleave', removeTooltip);

    span.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTooltip();
      const plain = formatTarget(targetValue);
      try {
        GM_setClipboard(plain);
        const original = span.textContent;
        span.textContent = '✓ Copied!';
        setTimeout(() => { span.textContent = original; }, 900);
      } catch (err) { /* clipboard not available, ignore */ }
    });

    return span;
  }

  function processTextNode(node) {
    const text = node.nodeValue;
    if (!text || text.length < 2) return;

    MASTER_REGEX.lastIndex = 0;
    if (!MASTER_REGEX.test(text)) return;
    MASTER_REGEX.lastIndex = 0;

    const parent = node.parentNode;
    if (!parent || shouldSkipElement(parent)) return;
    if (parent.getAttribute && parent.getAttribute(PROCESSED_ATTR)) return;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    let foundAny = false;

    while ((match = MASTER_REGEX.exec(text)) !== null) {
      const [full, symA, numA, numB, codeB, codeC, numC] = match;

      let code, amountStr, wasGuessed = false;
      let matchedFull = full;
      if (symA !== undefined) {
        const symDef = SYMBOL_MAP.find(s => new RegExp('^(?:' + s.re + ')$').test(symA));
        amountStr = numA;
        if (symDef.code === '$AMBIGUOUS') {
          // Before guessing from the domain, check if the site spells out the
          // code right after the number, e.g. "$24.99 CAD".
          const trailing = text.slice(match.index + full.length, match.index + full.length + 6);
          const trailingCodeMatch = trailing.match(/^\s?([A-Z]{3})\b/);
          if (trailingCodeMatch && CODE_LIST.includes(trailingCodeMatch[1])) {
            code = trailingCodeMatch[1];
            matchedFull = full + trailingCodeMatch[0];
          } else {
            code = resolveBareDollar();
            wasGuessed = true;
          }
        } else {
          code = symDef.code;
        }
      } else if (codeB !== undefined) {
        code = codeB;
        amountStr = numB;
      } else {
        code = codeC;
        amountStr = numC;
      }

      // Skip if this position was already consumed as part of an extended
      // match above (e.g. the "CAD" we just folded into the previous price).
      if (match.index < lastIndex) continue;

      if (code === settings.targetCurrency) continue;

      // If the page already shows its own conversion to the target currency
      // right after this price (e.g. "$400 (NZ$342 billed up front)"), don't
      // pile a second, differently-calculated conversion on top of it.
      const lookaheadWindow = text.slice(match.index + matchedFull.length, match.index + matchedFull.length + 40);
      const targetSymbol = CURRENCY_SYMBOLS_FOR_TARGET[settings.targetCurrency] || '';
      const alreadyShowsTarget =
        (targetSymbol && lookaheadWindow.includes(targetSymbol)) ||
        lookaheadWindow.toUpperCase().includes(settings.targetCurrency);
      if (alreadyShowsTarget) continue;

      const amount = parseAmount(amountStr);
      if (isNaN(amount) || amount <= 0) continue;

      const converted = convertToTarget(amount, code);
      if (converted === null) continue;

      frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      frag.appendChild(document.createTextNode(matchedFull));
      frag.appendChild(makeBadge(converted, matchedFull, code, amount, wasGuessed));

      lastIndex = match.index + matchedFull.length;
      foundAny = true;
    }

    if (!foundAny) return;

    frag.appendChild(document.createTextNode(text.slice(lastIndex)));

    const wrapper = document.createElement('span');
    wrapper.setAttribute(PROCESSED_ATTR, '1');
    wrapper.appendChild(frag);
    node.parentNode.replaceChild(wrapper, node);
  }

  function scan(root) {
    if (!rates) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (shouldSkipElement(n.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(processTextNode);
  }

  /* ----------------------------------------------------------------
   * OBSERVE DYNAMIC CONTENT
   * ---------------------------------------------------------------- */

  let debounceTimer = null;
  function scheduleScan(root) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => scan(root), 400);
  }

  function observeMutations() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          scheduleScan(document.body);
          break;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ----------------------------------------------------------------
   * INIT
   * ---------------------------------------------------------------- */

  (async function init() {
    await loadRates();
    if (!rates) return;
    scan(document.body);
    observeMutations();
  })();
})();
