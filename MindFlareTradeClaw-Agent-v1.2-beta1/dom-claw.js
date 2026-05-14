/**
 * dom-claw.js — DOM Interaction Module for MindFlare TradingClaw
 * Handles ALL DOM interactions with the market-qx.trade trading page.
 * Self-contained IIFE assigned to global DomClaw. Depends on global MF.
 */
/* global MF */
const DomClaw = (() => {
  'use strict';

  // ── Selector Fallbacks ────────────────────────────────────────────────
  // The site may change class names, so we try multiple selectors per target.
  const SEL = {
    tradeSidebar: [
      'div.IytlQ.xpiuY', 'div.IytlQ', 'div.xpiuY',
      '[class*="trade-sidebar"]', '[class*="tradeSidebar"]',
      '[class*="trade_panel"]', '[class*="tradePanel"]',
      '[data-testid="trade-sidebar"]',
      'div[class*="sidebar"][class*="trade"]',
    ],
    tradeControls: [
      'div.n9Sjl', '[class*="trade-controls"]', '[class*="tradeControls"]',
      '[class*="trade_controls"]', '[data-testid="trade-controls"]',
      'div[class*="controls"][class*="trade"]',
    ],
    upButton: [
      'button[class*="up" i]', 'button[class*="call" i]',
      'button[class*="higher" i]', '[class*="btn-up" i]',
      '[class*="btnUp" i]', '[class*="button-up" i]',
      '[data-direction="up"]', '[data-direction="call"]',
      '[data-testid="btn-up"]', '[data-testid="btn-call"]',
    ],
    downButton: [
      'button[class*="down" i]', 'button[class*="put" i]',
      'button[class*="lower" i]', '[class*="btn-down" i]',
      '[class*="btnDown" i]', '[class*="button-down" i]',
      '[data-direction="down"]', '[data-direction="put"]',
      '[data-testid="btn-down"]', '[data-testid="btn-put"]',
    ],
    investmentInput: [
      'input[class*="investment" i]', 'input[class*="amount" i]',
      'input[class*="stake" i]', 'input[name*="investment" i]',
      'input[name*="amount" i]', 'input[name*="stake" i]',
      'input[placeholder*="investment" i]', 'input[placeholder*="amount" i]',
      'input[placeholder*="stake" i]', 'input[type="number"]',
    ],
    durationInput: [
      'input[class*="duration" i]', 'input[class*="time" i]',
      'input[name*="duration" i]', 'input[name*="time" i]',
      'input[placeholder*="duration" i]', 'input[placeholder*="seconds" i]',
      'input[placeholder*="time" i]',
    ],
    durationPlus: [
      '[class*="duration-plus" i]', '[class*="durationPlus" i]',
      '[data-action="duration-plus"]', '[data-testid="duration-plus"]',
    ],
    durationMinus: [
      '[class*="duration-minus" i]', '[class*="durationMinus" i]',
      '[data-action="duration-minus"]', '[data-testid="duration-minus"]',
    ],
    assetSelector: [
      '[class*="asset-selector" i]', '[class*="assetSelector" i]',
      '[class*="asset_selector" i]', '[class*="pair-selector" i]',
      '[class*="pairSelector" i]', '[data-testid="asset-selector"]',
      '[data-testid="pair-selector"]', '[class*="current-pair" i]',
      '[class*="currentPair" i]', '[class*="active-pair" i]',
    ],
    assetDropdown: [
      '[class*="asset-list" i]', '[class*="assetList" i]',
      '[class*="pair-list" i]', '[class*="pairList" i]',
      '[data-testid="asset-list"]', '[data-testid="pair-list"]',
      '[class*="dropdown"][class*="asset"]', '[class*="dropdown"][class*="pair"]',
    ],
    activePair: [
      '[class*="active-pair" i]', '[class*="activePair" i]',
      '[class*="current-pair" i]', '[class*="currentPair" i]',
      '[class*="selected-pair" i]', '[class*="selectedPair" i]',
      '[class*="asset-selector"] [class*="name"]',
      '[data-testid="active-pair"]',
    ],
    currentPrice: [
      '[class*="current-price" i]', '[class*="currentPrice" i]',
      '[class*="price-current" i]', '[class*="priceCurrent" i]',
      '[class*="last-price" i]', '[class*="lastPrice" i]',
      '[class*="tick-price" i]', '[class*="tickPrice" i]',
      '[data-testid="current-price"]', '[data-testid="price"]',
    ],
    payout: [
      '[class*="payout" i]', '[class*="profit" i]',
      '[class*="return" i]', '[data-testid="payout"]',
      '[data-testid="profit"]',
    ],
    winIndicator: [
      '[class*="win" i]', '[class*="profit-positive" i]',
      '[class*="profitPositive" i]', '[class*="result-win" i]',
      '[data-testid="result-win"]',
    ],
    lossIndicator: [
      '[class*="loss" i]', '[class*="profit-negative" i]',
      '[class*="profitNegative" i]', '[class*="result-loss" i]',
      '[data-testid="result-loss"]',
    ],
  };

  // ── Internal State ────────────────────────────────────────────────────
  let _lastResult = null;
  let _cachedSidebar = null;
  let _healthInterval = null;

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Try multiple CSS selectors in order, return first match or null. */
  function queryFirst(selectors, root) {
    if (!root) root = document;
    for (const sel of selectors) {
      try { const el = root.querySelector(sel); if (el) return el; }
      catch (_e) { /* invalid selector, skip */ }
    }
    return null;
  }

  /** Search within root for elements whose textContent matches a regex. */
  function findByText(root, regex, tag) {
    if (!root) return null;
    tag = tag || 'button';
    try {
      const els = root.getElementsByTagName(tag);
      for (const el of els) { if (regex.test(el.textContent || '')) return el; }
    } catch (_e) { /* ignore */ }
    return null;
  }

  /** Click via .click() AND dispatched MouseEvent. Returns true if el existed. */
  function safeClick(el) {
    if (!el) return false;
    try { el.click(); } catch (_e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
    catch (_e) { /* ignore */ }
    return true;
  }

  /** Set an input's value using native setter + dispatch input/change events. */
  function safeSetInputValue(el, value) {
    if (!el) return false;
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      if (setter) setter.call(el, String(value)); else el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_e) {
      try {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (_e2) { return false; }
    }
  }

  /** Parse a numeric value from element textContent. */
  function extractNumber(el) {
    if (!el) return null;
    try {
      const raw = (el.textContent || '').replace(/[^\d.\-]/g, '');
      const num = parseFloat(raw);
      return isNaN(num) ? null : num;
    } catch (_e) { return null; }
  }

  // ── 1. findTradeSidebar ───────────────────────────────────────────────
  function findTradeSidebar() {
    try {
      if (_cachedSidebar && _cachedSidebar.isConnected) return _cachedSidebar;
      const el = queryFirst(SEL.tradeSidebar);
      if (el) {
        _cachedSidebar = el;
        MF.state.tradeSidebar = el;
        MF.bus.emit('dom:sidebar-found', el);
      }
      return el;
    } catch (e) { MF.log('error', '[DomClaw] findTradeSidebar:', e.message); return null; }
  }

  // ── 2. findTradeControls ──────────────────────────────────────────────
  function findTradeControls() {
    try {
      const direct = queryFirst(SEL.tradeControls);
      if (direct) return direct;
      const sidebar = findTradeSidebar();
      if (sidebar) {
        for (const sel of SEL.tradeControls) {
          try { const el = sidebar.querySelector(sel); if (el) return el; }
          catch (_e) { /* skip */ }
        }
      }
      return null;
    } catch (e) { MF.log('error', '[DomClaw] findTradeControls:', e.message); return null; }
  }

  // ── 3. clickUp ────────────────────────────────────────────────────────
  function clickUp() {
    try {
      const controls = findTradeControls();
      const root = controls || document;

      // Strategy 1: selector-based
      if (safeClick(queryFirst(SEL.upButton, root))) {
        MF.log('info', '[DomClaw] clickUp: selector');
        MF.bus.emit('dom:click-up'); return true;
      }

      // Strategy 2: text-content search
      const re = /\b(UP|CALL|Higher|HIGHER|Rise|RISE)\b/i;
      const byText = findByText(root, re, 'button') || findByText(root, re, 'div');
      if (safeClick(byText)) {
        MF.log('info', '[DomClaw] clickUp: text match');
        MF.bus.emit('dom:click-up'); return true;
      }

      // Strategy 3: green-colored button heuristic
      if (controls) {
        const btns = controls.querySelectorAll('button, [role="button"]');
        for (const btn of btns) {
          try {
            const bg = window.getComputedStyle(btn).backgroundColor || '';
            if (/0, 1[2-9]\d|0, 17|34, 139|46, 204|76, 175|0, 188/.test(bg)) {
              if (safeClick(btn)) {
                MF.log('info', '[DomClaw] clickUp: green heuristic');
                MF.bus.emit('dom:click-up'); return true;
              }
            }
          } catch (_e) { /* skip */ }
        }
      }

      MF.log('warn', '[DomClaw] clickUp: no UP button found');
      return false;
    } catch (e) { MF.log('error', '[DomClaw] clickUp:', e.message); return false; }
  }

  // ── 4. clickDown ──────────────────────────────────────────────────────
  function clickDown() {
    try {
      const controls = findTradeControls();
      const root = controls || document;

      if (safeClick(queryFirst(SEL.downButton, root))) {
        MF.log('info', '[DomClaw] clickDown: selector');
        MF.bus.emit('dom:click-down'); return true;
      }

      const re = /\b(DOWN|PUT|Lower|LOWER|Fall|FALL)\b/i;
      const byText = findByText(root, re, 'button') || findByText(root, re, 'div');
      if (safeClick(byText)) {
        MF.log('info', '[DomClaw] clickDown: text match');
        MF.bus.emit('dom:click-down'); return true;
      }

      // Red-colored button heuristic
      if (controls) {
        const btns = controls.querySelectorAll('button, [role="button"]');
        for (const btn of btns) {
          try {
            const bg = window.getComputedStyle(btn).backgroundColor || '';
            if (/220, 20|255, 0|231, 76|244, 67|211, 47|183, 28/.test(bg)) {
              if (safeClick(btn)) {
                MF.log('info', '[DomClaw] clickDown: red heuristic');
                MF.bus.emit('dom:click-down'); return true;
              }
            }
          } catch (_e) { /* skip */ }
        }
      }

      MF.log('warn', '[DomClaw] clickDown: no DOWN button found');
      return false;
    } catch (e) { MF.log('error', '[DomClaw] clickDown:', e.message); return false; }
  }

  // ── 5. setInvestment ──────────────────────────────────────────────────
  function setInvestment(amount) {
    try {
      if (typeof amount !== 'number' || isNaN(amount) || amount <= 0) {
        MF.log('warn', '[DomClaw] setInvestment: invalid amount', amount);
        return false;
      }

      const controls = findTradeControls();
      const root = controls || findTradeSidebar() || document;
      let input = queryFirst(SEL.investmentInput, root);

      // Strategy 2: find input by associated label
      if (!input) {
        const labels = root.querySelectorAll('label');
        for (const lbl of labels) {
          const txt = (lbl.textContent || '').toLowerCase();
          if (/investment|amount|stake|bet/.test(txt)) {
            try {
              const forId = lbl.getAttribute('for');
              input = forId ? document.getElementById(forId) : null;
              if (!input) input = lbl.querySelector('input');
            } catch (_e) { /* skip */ }
            if (input) break;
          }
        }
      }

      // Strategy 3: any number/text input with matching attrs in controls
      if (!input && controls) {
        const inputs = controls.querySelectorAll('input[type="number"], input[type="text"]');
        for (const inp of inputs) {
          try {
            const p = ((inp.placeholder || '') + ' ' + (inp.className || '') + ' ' + (inp.name || '')).toLowerCase();
            if (/amount|stake|investment|bet|sum/.test(p)) { input = inp; break; }
          } catch (_e) { /* skip */ }
        }
      }

      if (!input) { MF.log('warn', '[DomClaw] setInvestment: no input found'); return false; }

      try { input.focus(); } catch (_e) { /* ignore */ }
      const ok = safeSetInputValue(input, amount);
      try { input.blur(); } catch (_e) { /* ignore */ }

      if (ok) { MF.log('info', '[DomClaw] setInvestment:', amount); MF.bus.emit('dom:investment-set', amount); }
      else { MF.log('warn', '[DomClaw] setInvestment: failed'); }
      return ok;
    } catch (e) { MF.log('error', '[DomClaw] setInvestment:', e.message); return false; }
  }

  // ── 6. setTradeDuration ───────────────────────────────────────────────
  function setTradeDuration(seconds) {
    try {
      if (typeof seconds !== 'number' || isNaN(seconds) || seconds <= 0) {
        MF.log('warn', '[DomClaw] setTradeDuration: invalid seconds', seconds);
        return false;
      }

      const controls = findTradeControls();
      const root = controls || findTradeSidebar() || document;

      // Strategy 1: direct duration input
      const durInput = queryFirst(SEL.durationInput, root);
      if (durInput) {
        try { durInput.focus(); } catch (_e) { /* ignore */ }
        const ok = safeSetInputValue(durInput, seconds);
        try { durInput.blur(); } catch (_e) { /* ignore */ }
        if (ok) { MF.log('info', '[DomClaw] setTradeDuration:', seconds, 's'); MF.bus.emit('dom:duration-set', seconds); return true; }
      }

      // Strategy 2: +/- buttons
      const plusBtn = queryFirst(SEL.durationPlus, root);
      const minusBtn = queryFirst(SEL.durationMinus, root);
      if (durInput && (plusBtn || minusBtn)) {
        const current = parseInt(durInput.value, 10) || 0;
        const diff = seconds - current;
        const btn = diff > 0 ? plusBtn : minusBtn;
        const clicks = Math.min(Math.abs(diff), 300);
        if (btn && clicks > 0) {
          for (let i = 0; i < clicks; i++) safeClick(btn);
          MF.log('info', '[DomClaw] setTradeDuration: adjusted via +/- button');
          MF.bus.emit('dom:duration-set', seconds);
          return true;
        }
      }

      // Strategy 3: find by label
      const labels = root.querySelectorAll('label');
      for (const lbl of labels) {
        const txt = (lbl.textContent || '').toLowerCase();
        if (/duration|time|expiry|expiration|seconds/.test(txt)) {
          try {
            const forId = lbl.getAttribute('for');
            let inp = forId ? document.getElementById(forId) : null;
            if (!inp) inp = lbl.querySelector('input');
            if (inp) {
              try { inp.focus(); } catch (_e2) { /* ignore */ }
              const ok = safeSetInputValue(inp, seconds);
              try { inp.blur(); } catch (_e2) { /* ignore */ }
              if (ok) { MF.log('info', '[DomClaw] setTradeDuration: via label'); MF.bus.emit('dom:duration-set', seconds); return true; }
            }
          } catch (_e) { /* skip */ }
        }
      }

      MF.log('warn', '[DomClaw] setTradeDuration: no control found');
      return false;
    } catch (e) { MF.log('error', '[DomClaw] setTradeDuration:', e.message); return false; }
  }

  // ── 7. selectAsset ────────────────────────────────────────────────────
  function selectAsset(pairName) {
    try {
      if (!pairName || typeof pairName !== 'string') { MF.log('warn', '[DomClaw] selectAsset: invalid'); return false; }

      // Step 1: Open the asset selector dropdown
      const selector = queryFirst(SEL.assetSelector);
      if (!safeClick(selector)) {
        if (!safeClick(queryFirst(SEL.activePair))) {
          MF.log('warn', '[DomClaw] selectAsset: cannot open selector'); return false;
        }
      }

      const normalizedName = pairName.replace(/[^A-Z/]/gi, '').toUpperCase();
      const dropdown = queryFirst(SEL.assetDropdown);
      const searchRoot = dropdown || document;

      // Strategy 1: exact text match
      const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pairRe = new RegExp('\\b' + escaped + '\\b');
      const pairEl = findByText(searchRoot, pairRe, 'div')
                  || findByText(searchRoot, pairRe, 'span')
                  || findByText(searchRoot, pairRe, 'li')
                  || findByText(searchRoot, pairRe, 'button');
      if (safeClick(pairEl)) {
        MF.log('info', '[DomClaw] selectAsset:', pairName);
        MF.bus.emit('dom:asset-selected', pairName); return true;
      }

      // Strategy 2: partial match (e.g. "EURUSD" → "EUR/USD")
      const stripped = normalizedName.replace(/[^A-Z]/g, '');
      if (stripped.length >= 6) {
        const partialRe = new RegExp(stripped.substring(0, 3) + '[/\\s-]?' + stripped.substring(3, 6), 'i');
        const partialEl = findByText(searchRoot, partialRe, 'div')
                       || findByText(searchRoot, partialRe, 'span')
                       || findByText(searchRoot, partialRe, 'li')
                       || findByText(searchRoot, partialRe, 'button');
        if (safeClick(partialEl)) {
          MF.log('info', '[DomClaw] selectAsset: partial match', pairName);
          MF.bus.emit('dom:asset-selected', pairName); return true;
        }
      }

      // Strategy 3: search/filter input
      const searchInput = searchRoot.querySelector('input[type="text"], input[type="search"]');
      if (searchInput) {
        safeSetInputValue(searchInput, pairName);
        const filtered = findByText(searchRoot, pairRe, 'div')
                      || findByText(searchRoot, pairRe, 'span')
                      || findByText(searchRoot, pairRe, 'li');
        if (safeClick(filtered)) {
          MF.log('info', '[DomClaw] selectAsset: via search');
          MF.bus.emit('dom:asset-selected', pairName); return true;
        }
      }

      // Close dropdown on failure
      try { document.body.click(); } catch (_e) { /* ignore */ }
      MF.log('warn', '[DomClaw] selectAsset: pair not found', pairName);
      return false;
    } catch (e) { MF.log('error', '[DomClaw] selectAsset:', e.message); return false; }
  }

  // ── 8. getActivePair ──────────────────────────────────────────────────
  function getActivePair() {
    try {
      const el = queryFirst(SEL.activePair);
      if (el) { const t = (el.textContent || '').trim(); if (t) return t; }

      const selector = queryFirst(SEL.assetSelector);
      if (selector) {
        const t = (selector.textContent || '').trim();
        const m = t.match(/^([A-Z]{3}[/\s-]?[A-Z]{3})/);
        if (m) return m[1].replace(/\s/, '/');
        const otc = t.match(/^([A-Z]{3}[/\s-]?[A-Z]{3}\s*OTC)/i);
        if (otc) return otc[1].replace(/\s/, '/');
      }
      return null;
    } catch (e) { MF.log('error', '[DomClaw] getActivePair:', e.message); return null; }
  }

  // ── 9. getCurrentPrice ────────────────────────────────────────────────
  function getCurrentPrice() {
    try {
      // Strategy 1: dedicated price element
      const price = extractNumber(queryFirst(SEL.currentPrice));
      if (price !== null && price > 0) return price;

      // Strategy 2: multi-decimal number in chart area
      const chart = document.querySelector('[class*="chart" i], [data-testid="chart"]');
      if (chart) {
        const els = chart.querySelectorAll('span, div');
        for (const sp of els) {
          const val = extractNumber(sp);
          const txt = sp.textContent || '';
          if (val !== null && val > 0.001 && val < 999999 && txt.includes('.')) {
            const dec = (txt.match(/\.(\d+)/) || [])[1];
            if (dec && dec.length >= 2) return val;
          }
        }
      }

      // Strategy 3: data-price / data-value attribute
      const dataEl = document.querySelector('[data-price], [data-value]');
      if (dataEl) {
        const a = dataEl.getAttribute('data-price') || dataEl.getAttribute('data-value');
        if (a) { const n = parseFloat(a); if (!isNaN(n) && n > 0) return n; }
      }
      return null;
    } catch (e) { MF.log('error', '[DomClaw] getCurrentPrice:', e.message); return null; }
  }

  // ── 10. getPayout ─────────────────────────────────────────────────────
  function getPayout() {
    try {
      const payoutEl = queryFirst(SEL.payout);
      if (payoutEl) {
        const t = payoutEl.textContent || '';
        const m = t.match(/(\d+(?:\.\d+)?)\s*%/);
        if (m) return parseFloat(m[1]);
        const n = extractNumber(payoutEl);
        if (n !== null && n > 0 && n < 1000) return n;
      }

      // Strategy 2: scan sidebar for "N%" patterns
      const sidebar = findTradeSidebar();
      if (sidebar) {
        const els = sidebar.querySelectorAll('span, div, p, td');
        for (const el of els) {
          const m = (el.textContent || '').trim().match(/^(\d+(?:\.\d+)?)\s*%$/);
          if (m) { const v = parseFloat(m[1]); if (v >= 30 && v <= 200) return v; }
        }
      }

      // Strategy 3: regex on full text
      const allText = sidebar ? sidebar.textContent : document.body.textContent;
      const pm = (allText || '').match(/(?:payout|profit|return)\s*:?\s*(\d+(?:\.\d+)?)\s*%/i);
      if (pm) return parseFloat(pm[1]);
      return null;
    } catch (e) { MF.log('error', '[DomClaw] getPayout:', e.message); return null; }
  }

  // ── 11. getTradeResult ────────────────────────────────────────────────
  function getTradeResult() {
    try {
      const sidebar = findTradeSidebar();
      if (!sidebar) return null;

      // Strategy 1: dedicated indicator elements
      const winEl = queryFirst(SEL.winIndicator, sidebar);
      const lossEl = queryFirst(SEL.lossIndicator, sidebar);
      if (winEl && !lossEl) { _lastResult = 'WIN'; return 'WIN'; }
      if (lossEl && !winEl) { _lastResult = 'LOSS'; return 'LOSS'; }

      // Strategy 2: text-based detection
      const txt = sidebar.textContent || '';
      const hasWin = /\b(WIN|Won|Profit|Earned|Congratulations)\b/i.test(txt);
      const hasLoss = /\b(LOSS|Lost|You lost)\b/i.test(txt);
      if (hasWin && !hasLoss) { _lastResult = 'WIN'; return 'WIN'; }
      if (hasLoss && !hasWin) { _lastResult = 'LOSS'; return 'LOSS'; }

      // Strategy 3: color-based detection on result elements
      const candidates = sidebar.querySelectorAll(
        '[class*="result" i], [class*="outcome" i], [class*="trade-result" i]'
      );
      for (const el of candidates) {
        try {
          const c = (window.getComputedStyle(el).color || '') +
                    (window.getComputedStyle(el).backgroundColor || '');
          // Green: high G component
          if (/rgb\(\s*\d{1,3},\s*(1[5-9]\d|2\d\d),\s*\d{1,3}\)/.test(c))
            { _lastResult = 'WIN'; return 'WIN'; }
          // Red: high R component
          if (/rgb\(\s*(1[5-9]\d|2\d\d),\s*\d{1,3},\s*\d{1,3}\)/.test(c))
            { _lastResult = 'LOSS'; return 'LOSS'; }
        } catch (_e) { /* skip */ }
      }

      // Strategy 4: +/- profit values
      const profits = txt.match(/[+\-]\s*\$?\d+(?:\.\d+)?/g);
      if (profits && profits.length > 0) {
        const last = profits[profits.length - 1];
        if (last.startsWith('+')) { _lastResult = 'WIN'; return 'WIN'; }
        if (last.startsWith('-')) { _lastResult = 'LOSS'; return 'LOSS'; }
      }

      return null;
    } catch (e) { MF.log('error', '[DomClaw] getTradeResult:', e.message); return null; }
  }

  // ── 12. waitForTradeResult ────────────────────────────────────────────
  function waitForTradeResult(timeoutMs) {
    try {
      timeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 60000;
      const pollMs = 500;
      const start = Date.now();
      MF.log('info', '[DomClaw] waitForTradeResult: up to', timeoutMs, 'ms');

      return new Promise((resolve) => {
        function poll() {
          try {
            if (Date.now() - start >= timeoutMs) {
              MF.log('warn', '[DomClaw] waitForTradeResult: timed out');
              MF.bus.emit('dom:trade-result-timeout');
              resolve(null); return;
            }
            const result = getTradeResult();
            if (result === 'WIN' || result === 'LOSS') {
              MF.log('info', '[DomClaw] waitForTradeResult:', result);
              MF.bus.emit('dom:trade-result', result);
              resolve(result); return;
            }
            setTimeout(poll, pollMs);
          } catch (e) {
            MF.log('error', '[DomClaw] waitForTradeResult poll:', e.message);
            setTimeout(poll, pollMs); // keep trying
          }
        }
        setTimeout(poll, 1000); // initial delay for trade execution
      });
    } catch (e) {
      MF.log('error', '[DomClaw] waitForTradeResult:', e.message);
      return Promise.resolve(null);
    }
  }

  // ── 13. getAvailablePairs ─────────────────────────────────────────────
  function getAvailablePairs() {
    try {
      const pairs = [];

      // Strategy 1: open selector and read the dropdown
      const selector = queryFirst(SEL.assetSelector);
      if (selector) safeClick(selector);

      const dropdown = queryFirst(SEL.assetDropdown);
      if (dropdown) {
        const items = dropdown.querySelectorAll(
          '[class*="asset-item" i], [class*="pair-item" i], ' +
          '[class*="assetItem" i], [class*="pairItem" i], ' +
          '[role="option"], [class*="item"]'
        );
        const activeName = getActivePair();
        for (const item of items) {
          try {
            const t = (item.textContent || '').trim();
            if (!t) continue;
            const nm = t.match(/([A-Z]{3}[/\s-]?[A-Z]{3}(?:\s*OTC)?)/i);
            if (!nm) continue;
            const name = nm[1].replace(/\s/, '/');
            const pm = t.match(/(\d+(?:\.\d+)?)\s*%/);
            pairs.push({ name, payout: pm ? parseFloat(pm[1]) : 0, active: name === activeName });
          } catch (_e) { /* skip item */ }
        }
        try { document.body.click(); } catch (_e) { /* close dropdown */ }
      }

      // Strategy 2: fall back to MF.state.allPairs
      if (pairs.length === 0 && MF.state.allPairs) {
        for (const [name, data] of Object.entries(MF.state.allPairs)) {
          pairs.push({ name, payout: data.payout || 0, active: name === MF.state.activePair });
        }
      }

      // Strategy 3: scan page for pair links/buttons
      if (pairs.length === 0) {
        const pairEls = document.querySelectorAll(
          '[class*="pair"] a, [class*="pair"] button, ' +
          '[class*="asset"] a, [class*="asset"] button'
        );
        const seen = new Set();
        for (const el of pairEls) {
          try {
            const m = (el.textContent || '').match(/([A-Z]{3}[/\s-]?[A-Z]{3}(?:\s*OTC)?)/i);
            if (m && !seen.has(m[1])) {
              seen.add(m[1]);
              pairs.push({ name: m[1].replace(/\s/, '/'), payout: 0, active: false });
            }
          } catch (_e) { /* skip */ }
        }
      }

      MF.log('info', '[DomClaw] getAvailablePairs:', pairs.length, 'pairs');
      return pairs;
    } catch (e) { MF.log('error', '[DomClaw] getAvailablePairs:', e.message); return []; }
  }

  // ── 14. isPageReady ───────────────────────────────────────────────────
  function isPageReady() {
    try {
      if (document.readyState !== 'complete' && document.readyState !== 'interactive') return false;

      const sidebar = findTradeSidebar();
      if (!sidebar) return false;

      const controls = findTradeControls();
      if (!controls) {
        const btns = sidebar.querySelectorAll('button, [role="button"]');
        if (btns.length < 2) return false;
      }

      // Check for visible loading overlays
      const loaders = document.querySelectorAll(
        '[class*="loading" i], [class*="spinner" i], [class*="loader" i]'
      );
      for (const ol of loaders) {
        try {
          const s = window.getComputedStyle(ol);
          if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') return false;
        } catch (_e) { /* skip */ }
      }

      if (!queryFirst(SEL.assetSelector)) return false;

      MF.state.domReady = true;
      MF.bus.emit('dom:ready');
      return true;
    } catch (e) { MF.log('error', '[DomClaw] isPageReady:', e.message); return false; }
  }

  // ── Mutation Observer ──────────────────────────────────────────────────
  function _initObserver() {
    try {
      const sidebar = findTradeSidebar();
      if (!sidebar) return;
      const obs = new MutationObserver(() => {
        try {
          const result = getTradeResult();
          if (result && result !== _lastResult) {
            _lastResult = result;
            MF.bus.emit('dom:result-changed', result);
          }
        } catch (_e) { /* observer must not throw */ }
      });
      obs.observe(sidebar, { childList: true, subtree: true, characterData: true });
      MF.log('debug', '[DomClaw] MutationObserver attached');
    } catch (e) { MF.log('warn', '[DomClaw] Observer init failed:', e.message); }
  }

  // ── Periodic Health Check ──────────────────────────────────────────────
  function _startHealthCheck() {
    try {
      if (_healthInterval) return;
      _healthInterval = setInterval(() => {
        try {
          if (_cachedSidebar && !_cachedSidebar.isConnected) {
            _cachedSidebar = null;
            MF.state.tradeSidebar = null;
            MF.bus.emit('dom:sidebar-lost');
          }
          if (!_cachedSidebar && findTradeSidebar()) {
            _initObserver();
            MF.bus.emit('dom:sidebar-restored');
          }
          const ready = isPageReady();
          if (ready !== MF.state.domReady) {
            MF.state.domReady = ready;
            MF.bus.emit(ready ? 'dom:ready' : 'dom:not-ready');
          }
        } catch (_e) { /* health check must never throw */ }
      }, 3000);
    } catch (e) { MF.log('warn', '[DomClaw] Health check start failed:', e.message); }
  }

  // ── Auto-Initialize ───────────────────────────────────────────────────
  (function _autoInit() {
    try {
      const init = () => { _initObserver(); _startHealthCheck(); };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
      setTimeout(() => { try { init(); } catch (_e) { /* ignore */ } }, 2000);
      MF.log('info', '[DomClaw] initialized');
    } catch (e) { MF.log('error', '[DomClaw] auto-init:', e.message); }
  })();

  // ── Public API ────────────────────────────────────────────────────────
  return {
    findTradeSidebar,
    findTradeControls,
    clickUp,
    clickDown,
    setInvestment,
    setTradeDuration,
    selectAsset,
    getActivePair,
    getCurrentPrice,
    getPayout,
    getTradeResult,
    waitForTradeResult,
    getAvailablePairs,
    isPageReady,
  };
})();
