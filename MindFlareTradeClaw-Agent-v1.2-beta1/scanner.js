/**
 * scanner.js  —  Real-Time Data Pipeline & Pair Discovery
 *
 * The heart of MindFlare TradingClaw.  Connects the page-hook WebSocket
 * interception to the rest of the extension by:
 *   1. Listening for window.postMessage from page-hook.js
 *   2. Decoding Socket.IO v3/v4 frames into ticks and candles
 *   3. Aggregating ticks into 1-minute candles
 *   4. Falling back to DOM polling when WS data is absent
 *   5. Discovering trading pairs and payout percentages
 *   6. Persisting completed candles via CandleStore
 *
 * Globals used: MF, CandleStore, HistoricalLoader
 */

const Scanner = (() => {
  'use strict';

  // ── Internal state ────────────────────────────────────────────────
  let _running = false;
  let _wsAlive = false;
  let _lastWsTick = 0;
  let _domPollTimer = null;
  let _pairPollTimer = null;
  let _staleCheckTimer = null;
  let _wsUrl = null;

  // Candle aggregation bookkeeping: { pairName: { minuteKey, open, high, low, close, volume, tickCount } }
  const _buildingCandles = {};

  // Socket.IO engine.io packet type codes
  const SIO_OPEN = '0', SIO_CLOSE = '1', SIO_PING = '2', SIO_PONG = '3';
  const SIO_MSG = '4', SIO_UPGRADE = '5', SIO_NOOP = '6';

  // Known event name categories
  const TICK_EVENTS = new Set([
    'tick', 'quote', 'price', 'price-update', 'spot',
    'tickData', 'priceChange', 'updatePrice', 'trade',
  ]);
  const CANDLE_EVENTS = new Set([
    'candle', 'candles', 'candleUpdate', 'ohlcv', 'ohlc',
    'candleData', 'kline', 'bar',
  ]);
  const ASSET_EVENTS = new Set([
    'asset', 'assets', 'instruments', 'pairs', 'symbols',
    'underlying', 'instrumentsList', 'assetList',
  ]);

  // DOM selectors for fallback polling (ordered by specificity)
  const PRICE_SELECTORS = [
    '.current-price', '.price-value', '.price-display',
    '[class*="price"]', '[class*="Price"]', '[data-price]',
    '.bet-current-price', '.quote-price', '.spot-price',
  ];
  const PAIR_SELECTORS = [
    '.current-asset', '.asset-name', '.active-asset',
    '[class*="asset"]', '[class*="instrument"]', '[class*="symbol"]',
    '.selected-pair', '[class*="pair"]', '.bet-asset',
  ];
  const PAYOUT_SELECTORS = [
    '.payout-value', '.payout-percent', '.profit-percent',
    '[class*="payout"]', '[class*="Payout"]',
    '[class*="profit"]', '[class*="Profit"]', '.bet-profit', '.bet-payout',
  ];
  const PAIR_LIST_SELECTORS = [
    '.asset-list li', '.instruments-list li', '.pairs-list li',
    '.assets-dropdown li', '[class*="asset-list"] li',
    '[class*="instrument-list"] li', '.asset-item', '.instrument-item',
  ];

  // ── Socket.IO Frame Decoder ───────────────────────────────────────

  /** Decode a raw Socket.IO frame string into an array of parsed packets. */
  function decodeSioFrame(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    const results = [];
    let remaining = raw;

    while (remaining.length > 0) {
      const pkt = remaining.charAt(0);

      // Engine.IO control packets — skip them
      if (pkt === SIO_PING || pkt === SIO_PONG || pkt === SIO_OPEN ||
          pkt === SIO_CLOSE || pkt === SIO_NOOP || pkt === SIO_UPGRADE) {
        break;
      }
      // Must be SIO_MSG ("4")
      if (pkt !== SIO_MSG) break;

      // Parse optional namespace (e.g. "/chat,")
      let idx = 1, namespace = '/';
      if (remaining.charAt(idx) === '/') {
        const nsEnd = remaining.indexOf(',', idx);
        if (nsEnd === -1) break;
        namespace = remaining.substring(idx, nsEnd);
        idx = nsEnd + 1;
      }

      const subType = remaining.charAt(idx);
      let consumed = 0;

      if (subType === '2') {
        // EVENT packet: "42["event_name", ...data]"
        idx++;
        const arr = tryParseJSONArray(remaining, idx);
        if (arr) {
          consumed = idx + arr.consumed;
          if (Array.isArray(arr.data) && arr.data.length >= 1) {
            results.push({
              type: 'event', namespace,
              event: arr.data[0],
              eventData: arr.data.length > 1 ? arr.data[1] : null,
              data: arr.data,
            });
          }
        } else { break; }
      } else if (subType === '0') {
        // CONNECT "40" or "40/ns,"
        results.push({ type: 'connect', namespace, data: null });
        break;
      } else if (subType === '1') {
        results.push({ type: 'disconnect', namespace, data: null });
        break;
      } else if (subType === '3') {
        // ACK — skip
        break;
      } else if (subType === '4') {
        // CONNECT_ERROR — skip
        break;
      } else {
        // Unknown sub-type — try to parse rest as JSON (v2 compat)
        const parsed = tryParseJSON(remaining, idx);
        if (parsed !== undefined) {
          results.push({ type: 'event', namespace, event: null, eventData: parsed, data: [parsed] });
        }
        break;
      }

      // Advance for batched frames
      if (consumed > 0 && consumed < remaining.length) {
        remaining = remaining.substring(consumed);
      } else {
        break;
      }
    }
    return results;
  }

  /** Parse a JSON array starting at startIdx using bracket matching. Returns { data, consumed } or null. */
  function tryParseJSONArray(str, startIdx) {
    if (str.charAt(startIdx) !== '[') return null;
    let depth = 0, inStr = false, esc = false, i = startIdx;
    for (; i < str.length; i++) {
      const ch = str.charAt(i);
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try { return { data: JSON.parse(str.substring(startIdx, i + 1)), consumed: i + 1 - startIdx }; }
          catch (_) { return null; }
        }
      }
    }
    return null; // partial / unbalanced
  }

  /** Best-effort parse of any JSON value starting at startIdx. */
  function tryParseJSON(str, startIdx) {
    for (let end = str.length; end > startIdx; end--) {
      try { return JSON.parse(str.substring(startIdx, end)); } catch (_) {}
    }
    return undefined;
  }

  // ── Tick → Candle Aggregation ─────────────────────────────────────

  function minuteKey(ts) { return Math.floor(ts / 60000) * 60; }

  /** Feed a tick into the per-pair candle aggregator. Closes previous candle on minute rollover. */
  function aggregateTick(pair, price, ts, volume) {
    if (!pair || !price || price <= 0) return;
    const mk = minuteKey(ts);
    const vol = typeof volume === 'number' && volume > 0 ? volume : 0;

    if (!_buildingCandles[pair] || _buildingCandles[pair].minuteKey !== mk) {
      if (_buildingCandles[pair]) closeCandle(pair, _buildingCandles[pair]);
      _buildingCandles[pair] = { minuteKey: mk, open: price, high: price, low: price, close: price, volume: vol, tickCount: 1 };
    } else {
      const c = _buildingCandles[pair];
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
      c.volume += vol;
      c.tickCount++;
    }
    MF.state.currentCandle = { pair, ..._buildingCandles[pair] };
  }

  /** Close a completed candle: persist via CandleStore, emit ws:candle. */
  function closeCandle(pair, candle) {
    if (!candle || candle.tickCount < 1) return;
    const closed = {
      id: `${pair}_${candle.minuteKey}`, pair,
      time: candle.minuteKey, open: candle.open, high: candle.high,
      low: candle.low, close: candle.close, volume: candle.volume,
    };
    try { CandleStore.putCandle(closed).catch(() => {}); } catch (_) {}

    if (!MF.state.candles[pair]) MF.state.candles[pair] = [];
    MF.state.candles[pair].push(closed);
    if (MF.state.candles[pair].length > 500) MF.state.candles[pair] = MF.state.candles[pair].slice(-500);

    MF.bus.emit('ws:candle', { pair, candle: closed });
  }

  // ── WebSocket Message Handler ─────────────────────────────────────

  function handleWsMessage(rawData, url) {
    _wsAlive = true;
    _lastWsTick = Date.now();
    _wsUrl = url || _wsUrl;
    MF.state.wsConnected = true;

    // Try direct JSON first, then Socket.IO decode
    let parsed = null;
    try { parsed = JSON.parse(rawData); } catch (_) {}

    if (parsed !== null) {
      processParsedMessage(parsed, url);
    } else {
      const frames = decodeSioFrame(rawData);
      for (const frame of frames) {
        try { processSioFrame(frame, url); }
        catch (e) { MF.log('warn', 'Scanner: SIO frame error:', e.message); }
      }
    }
  }

  /** Process a directly-parsed JSON message. */
  function processParsedMessage(data, url) {
    try {
      if (!data || typeof data !== 'object') return;
      const pair = extractPair(data), price = extractPrice(data);
      const ts = extractTimestamp(data) || Date.now(), volume = extractVolume(data);

      if (pair && price) processTick(pair, price, ts, volume);

      // Candle arrays
      const candles = data.candles || (data.data && Array.isArray(data.data) &&
        data.data[0] && (data.data[0].open || data.data[0].o) ? data.data : null);
      if (candles && Array.isArray(candles)) processCandleArray(pair || 'unknown', candles);

      // Asset/pair lists
      const assets = data.assets || data.instruments || data.pairs;
      if (Array.isArray(assets)) processAssetList(assets);
    } catch (e) {
      MF.log('warn', 'Scanner: processParsedMessage error:', e.message);
    }
  }

  /** Process a decoded Socket.IO frame. */
  function processSioFrame(frame, url) {
    if (frame.type === 'connect') {
      MF.log('info', 'Scanner: Socket.IO connected, ns=' + frame.namespace);
      return;
    }
    if (frame.type !== 'event') return;

    const eventName = frame.event, eventData = frame.eventData;
    if (!eventName) { if (eventData) processParsedMessage(eventData, url); return; }

    // ── Tick events ──
    if (TICK_EVENTS.has(eventName)) {
      if (eventData && typeof eventData === 'object') {
        const pair = extractPair(eventData), price = extractPrice(eventData);
        const ts = extractTimestamp(eventData) || Date.now(), vol = extractVolume(eventData);
        if (pair && price) processTick(pair, price, ts, vol);
        else if (price) processTick(MF.state.activePair || 'unknown', price, ts, vol);
      } else if (typeof eventData === 'number' && eventData > 0) {
        processTick(MF.state.activePair || 'unknown', eventData, Date.now(), 0);
      }
      return;
    }

    // ── Candle events ──
    if (CANDLE_EVENTS.has(eventName)) {
      if (!eventData) return;
      const pair = extractPair(eventData) || MF.state.activePair || 'unknown';
      if (Array.isArray(eventData)) { processCandleArray(pair, eventData); }
      else if (typeof eventData === 'object') {
        const candle = normalizeCandle(eventData, pair);
        if (candle) { CandleStore.putCandle(candle).catch(() => {}); MF.bus.emit('ws:candle', { pair, candle }); }
      }
      return;
    }

    // ── Asset/pair events ──
    if (ASSET_EVENTS.has(eventName)) {
      if (!eventData) return;
      if (Array.isArray(eventData)) { processAssetList(eventData); }
      else if (typeof eventData === 'object') {
        const list = eventData.assets || eventData.instruments || eventData.pairs;
        if (Array.isArray(list)) processAssetList(list);
        else processAssetList([eventData]);
      }
      return;
    }

    // ── Unknown event — best-effort extraction ──
    if (eventData && typeof eventData === 'object') {
      const pair = extractPair(eventData), price = extractPrice(eventData);
      if (pair && price) processTick(pair, price, extractTimestamp(eventData) || Date.now(), extractVolume(eventData));
    }
  }

  // ── Data Extractors ───────────────────────────────────────────────

  function extractPair(d) {
    if (!d || typeof d !== 'object') return null;
    return d.pair || d.symbol || d.instrument || d.asset || d.name ||
           d.ticker || d.underlying || d.active_id || d.asset_id || d.s ||
           (d.instrumentId ? String(d.instrumentId) : null) || null;
  }

  function extractPrice(d) {
    if (!d || typeof d !== 'object') return null;
    const raw = d.price || d.value || d.last || d.lastPrice || d.close ||
                d.c || d.rate || d.quote || d.currentPrice || d.spot || d.p || null;
    if (raw === null) return null;
    const n = parseFloat(raw);
    return (isNaN(n) || n <= 0) ? null : n;
  }

  function extractTimestamp(d) {
    if (!d || typeof d !== 'object') return null;
    const raw = d.timestamp || d.time || d.t || d.ts || d.created_at || d.expired_at || d.date || null;
    if (raw === null) return null;
    const n = parseFloat(raw);
    if (isNaN(n)) return null;
    return n > 1e12 ? n : n * 1000; // auto-detect seconds vs milliseconds
  }

  function extractVolume(d) {
    if (!d || typeof d !== 'object') return 0;
    const n = parseFloat(d.volume || d.vol || d.v || d.quantity || 0);
    return isNaN(n) ? 0 : Math.max(0, n);
  }

  function extractPayout(d) {
    if (!d || typeof d !== 'object') return 0;
    const raw = d.payout || d.profit || d.profitPercent || d.payoutPercent ||
                d.yield || d.return || d.reward || d.payment || null;
    if (raw === null) return 0;
    const n = parseFloat(raw);
    return isNaN(n) ? 0 : n;
  }

  // ── High-Level Processors ─────────────────────────────────────────

  function processTick(pair, price, ts, volume) {
    if (!pair || !price) return;
    const cp = normalizePairName(pair);
    const tickTs = ts > 0 ? ts : Date.now();

    aggregateTick(cp, price, tickTs, volume);

    if (!MF.state.allPairs[cp]) MF.state.allPairs[cp] = { payout: 0, active: false, lastTick: 0 };
    MF.state.allPairs[cp].lastTick = tickTs;
    detectActivePair(cp);

    MF.bus.emit('ws:tick', { pair: cp, price, timestamp: tickTs });
    MF.bus.emit('price:update', { pair: cp, price, timestamp: tickTs });
  }

  function processCandleArray(pair, candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    const cp = normalizePairName(pair);
    const normalized = candles.map(c => normalizeCandle(c, cp)).filter(Boolean);
    if (normalized.length === 0) return;

    normalized.sort((a, b) => a.time - b.time);
    try { CandleStore.putCandles(normalized).catch(() => {}); } catch (_) {}

    if (!MF.state.candles[cp]) MF.state.candles[cp] = [];
    MF.state.candles[cp] = MF.state.candles[cp].concat(normalized);
    if (MF.state.candles[cp].length > 500) MF.state.candles[cp] = MF.state.candles[cp].slice(-500);

    MF.bus.emit('ws:candle', { pair: cp, candle: normalized[normalized.length - 1] });
  }

  function processAssetList(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    let changed = false;

    for (const item of list) {
      try {
        const pair = extractPair(item) || (typeof item === 'string' ? item : null);
        if (!pair) continue;
        const cp = normalizePairName(pair), payout = extractPayout(item);

        if (!MF.state.allPairs[cp]) { MF.state.allPairs[cp] = { payout: 0, active: false, lastTick: 0 }; changed = true; }
        if (payout > 0 && MF.state.allPairs[cp].payout !== payout) { MF.state.allPairs[cp].payout = payout; changed = true; }
        if (item.active || item.isActive || item.is_active || item.selected || item.current) {
          if (!MF.state.allPairs[cp].active) { MF.state.allPairs[cp].active = true; changed = true; }
        }
      } catch (_) {}
    }

    if (changed) { updateHighPayoutPairs(); MF.bus.emit('pairs:discovered', { ...MF.state.allPairs }); }
  }

  function normalizeCandle(raw, pair) {
    try {
      let time, open, high, low, close, volume;
      if (Array.isArray(raw)) {
        if (raw.length < 5) return null;
        time = parseFloat(raw[0]); open = parseFloat(raw[1]); high = parseFloat(raw[2]);
        low = parseFloat(raw[3]); close = parseFloat(raw[4]); volume = parseFloat(raw[5] || 0);
      } else if (typeof raw === 'object' && raw !== null) {
        time = parseFloat(raw.time || raw.t || raw.timestamp || raw.id || 0);
        open = parseFloat(raw.open || raw.o || 0); high = parseFloat(raw.high || raw.h || 0);
        low = parseFloat(raw.low || raw.l || 0); close = parseFloat(raw.close || raw.c || 0);
        volume = parseFloat(raw.volume || raw.v || 0);
      } else { return null; }

      if (isNaN(time) || time <= 0 || isNaN(open) || open <= 0 ||
          isNaN(high) || high <= 0 || isNaN(low) || low <= 0 || isNaN(close) || close <= 0) return null;

      const cp = normalizePairName(pair);
      return {
        id: `${cp}_${time}`, pair: cp, time,
        open, high: Math.max(open, close, high), low: Math.min(open, close, low),
        close, volume: isNaN(volume) ? 0 : Math.max(0, volume),
      };
    } catch (_) { return null; }
  }

  function normalizePairName(name) {
    if (typeof name !== 'string') name = String(name || 'unknown');
    return name.trim().toUpperCase().replace(/[\s\-_]+/g, '_');
  }

  // ── Active Pair Detection ─────────────────────────────────────────

  function detectActivePair(pair) {
    if (!pair) return;
    const prev = MF.state.activePair;

    if (!prev) {
      MF.state.activePair = pair;
      MF.state.activePairPayout = MF.state.allPairs[pair]?.payout || 0;
      MF.state.allPairs[pair] = MF.state.allPairs[pair] || { payout: 0, active: false, lastTick: 0 };
      MF.state.allPairs[pair].active = true;
      MF.bus.emit('pair:active', { pair, payout: MF.state.activePairPayout });
      return;
    }

    if (prev !== pair) {
      const prevTick = MF.state.allPairs[prev]?.lastTick || 0;
      const currTick = MF.state.allPairs[pair]?.lastTick || 0;
      if (currTick >= prevTick) {
        if (MF.state.allPairs[prev]) MF.state.allPairs[prev].active = false;
        MF.state.activePair = pair;
        MF.state.activePairPayout = MF.state.allPairs[pair]?.payout || 0;
        if (MF.state.allPairs[pair]) MF.state.allPairs[pair].active = true;
        MF.bus.emit('pair:changed', { oldPair: prev, newPair: pair });
        MF.bus.emit('pair:active', { pair, payout: MF.state.activePairPayout });
      }
    }
  }

  function updateHighPayoutPairs() {
    const minPayout = MF.getConfig('minPayout') || 70;
    const result = Object.entries(MF.state.allPairs)
      .filter(([, info]) => info.payout >= minPayout)
      .sort(([, a], [, b]) => b.payout - a.payout)
      .map(([name]) => name);
    MF.state.highPayoutPairs = result;
  }

  // ── window.postMessage Listener ───────────────────────────────────

  function _onWindowMessage(event) {
    try {
      if (!event.data || !event.data.__mf) return;
      const msg = event.data;

      switch (msg.type) {
        case 'ws_msg':
          if (typeof msg.data === 'string' && msg.data.length > 0) handleWsMessage(msg.data, msg.url);
          break;
        case 'ws_open':
          _wsAlive = true; _wsUrl = msg.url || _wsUrl;
          MF.state.wsConnected = true; MF.state.wsUrl = msg.url || null;
          MF.log('info', 'Scanner: WS opened', msg.url);
          MF.bus.emit('ws:connected', { url: msg.url });
          break;
        case 'ws_close':
          MF.state.wsConnected = false;
          MF.log('info', 'Scanner: WS closed', msg.code, msg.reason);
          MF.bus.emit('ws:disconnected', { code: msg.code, reason: msg.reason || '' });
          break;
        case 'ws_error':
          MF.state.wsConnected = false;
          MF.log('warn', 'Scanner: WS error', msg.url);
          MF.bus.emit('ws:disconnected', { error: true });
          break;
        case 'hook_ready':
          MF.state.hookReady = true;
          MF.log('info', 'Scanner: page-hook is ready');
          break;
        case 'xhr_load':
          handleXhrLoad(msg);
          break;
      }
    } catch (e) {
      MF.log('warn', 'Scanner: message handler error:', e.message);
    }
  }

  /** Handle XHR load events — forward to HistoricalLoader and parse candle/asset data. */
  function handleXhrLoad(msg) {
    try {
      if (typeof HistoricalLoader !== 'undefined' && HistoricalLoader.discoverFromXHR) {
        HistoricalLoader.discoverFromXHR(msg);
      }
      if (!msg.response || typeof msg.response !== 'string') return;
      let parsed; try { parsed = JSON.parse(msg.response); } catch (_) { return; }
      if (!parsed || typeof parsed !== 'object') return;

      const assets = parsed.assets || parsed.instruments || parsed.pairs || parsed.data;
      if (Array.isArray(assets)) processAssetList(assets);

      const candles = parsed.candles || parsed.history || parsed.result;
      if (Array.isArray(candles) && candles.length > 0) {
        processCandleArray(extractPair(parsed) || MF.state.activePair || 'unknown', candles);
      }
    } catch (_) {}
  }

  // ── DOM Polling Fallback ──────────────────────────────────────────

  /** Query the DOM for a text value using a prioritised selector list. */
  function queryDomText(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent) {
          const t = el.textContent.trim();
          if (t.length > 0 && t.length < 200) return t;
        }
      } catch (_) {}
    }
    return null;
  }

  function parseDomNumber(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^\d.\-]/g, '').replace(/,/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }

  /** One DOM poll cycle — fetch active pair, price, payout from the page. */
  function pollDomCycle() {
    try {
      // Active pair
      const pairText = queryDomText(PAIR_SELECTORS);
      if (pairText) {
        const cp = normalizePairName(pairText);
        if (cp && cp !== 'UNKNOWN') {
          const prev = MF.state.activePair;
          if (prev !== cp) {
            if (prev) MF.bus.emit('pair:changed', { oldPair: prev, newPair: cp });
            MF.state.activePair = cp;
            if (!MF.state.allPairs[cp]) MF.state.allPairs[cp] = { payout: 0, active: true, lastTick: 0 };
            MF.state.allPairs[cp].active = true;
            if (prev && MF.state.allPairs[prev]) MF.state.allPairs[prev].active = false;
          }
        }
      }

      // Current price
      const priceText = queryDomText(PRICE_SELECTORS);
      if (priceText) {
        const price = parseDomNumber(priceText);
        if (price && price > 0) {
          const pair = MF.state.activePair || 'unknown', ts = Date.now();
          aggregateTick(pair, price, ts, 0);
          MF.bus.emit('price:update', { pair, price, timestamp: ts });
          _lastWsTick = ts;
        }
      }

      // Payout percentage
      const payoutText = queryDomText(PAYOUT_SELECTORS);
      if (payoutText) {
        let payout = parseDomNumber(payoutText);
        if (payout !== null) {
          if (payout < 1 && payout > 0) payout *= 100;
          const pair = MF.state.activePair;
          if (pair && MF.state.allPairs[pair]) {
            MF.state.allPairs[pair].payout = payout;
            MF.state.activePairPayout = payout;
            updateHighPayoutPairs();
          }
        }
      }
    } catch (e) {
      MF.log('warn', 'Scanner: DOM poll error:', e.message);
    }
  }

  /** Discover available pairs from the DOM (asset lists, dropdowns). */
  function pollDomPairs() {
    try {
      let changed = false;
      for (const sel of PAIR_LIST_SELECTORS) {
        try {
          const items = document.querySelectorAll(sel);
          items.forEach((el) => {
            const text = (el.textContent || '').trim();
            if (!text || text.length > 100) return;
            const pair = normalizePairName(text);
            if (pair === 'UNKNOWN' || pair.length < 2) return;

            if (!MF.state.allPairs[pair]) { MF.state.allPairs[pair] = { payout: 0, active: false, lastTick: 0 }; changed = true; }

            // Look for payout info inside the element
            const payoutEl = el.querySelector('[class*="payout"], [class*="profit"], [class*="percent"]');
            if (payoutEl) {
              let payout = parseDomNumber((payoutEl.textContent || '').trim());
              if (payout !== null) {
                if (payout < 1 && payout > 0) payout *= 100;
                if (MF.state.allPairs[pair].payout !== payout) { MF.state.allPairs[pair].payout = payout; changed = true; }
              }
            }

            // Mark active if element has active/selected class
            if (el.classList.contains('active') || el.classList.contains('selected') || el.getAttribute('aria-selected') === 'true') {
              if (!MF.state.allPairs[pair].active) { MF.state.allPairs[pair].active = true; changed = true; }
            }
          });
        } catch (_) {}
      }
      if (changed) { updateHighPayoutPairs(); MF.bus.emit('pairs:discovered', { ...MF.state.allPairs }); }
    } catch (e) {
      MF.log('warn', 'Scanner: DOM pair poll error:', e.message);
    }
  }

  // ── WS Staleness Checker ──────────────────────────────────────────

  function checkWsStaleness() {
    try {
      if (_wsAlive && (Date.now() - _lastWsTick) > 5000) {
        if (!_domPollTimer && MF.getConfig('domPollFallback')) {
          MF.log('info', 'Scanner: WS data stale, starting DOM poll fallback');
          startDomPolling();
        }
      }
    } catch (_) {}
  }

  // ── Start / Stop Helpers ──────────────────────────────────────────

  function startDomPolling() {
    if (_domPollTimer) return;
    _domPollTimer = setInterval(pollDomCycle, MF.getConfig('scanInterval') || 2000);
  }
  function stopDomPolling() { if (_domPollTimer) { clearInterval(_domPollTimer); _domPollTimer = null; } }

  function startPairPolling() {
    if (_pairPollTimer) return;
    _pairPollTimer = setInterval(pollDomPairs, 10000);
    pollDomPairs();
  }
  function stopPairPolling() { if (_pairPollTimer) { clearInterval(_pairPollTimer); _pairPollTimer = null; } }

  function startStaleChecker() { if (!_staleCheckTimer) _staleCheckTimer = setInterval(checkWsStaleness, 3000); }
  function stopStaleChecker() { if (_staleCheckTimer) { clearInterval(_staleCheckTimer); _staleCheckTimer = null; } }

  function onConfigChange(key) {
    try {
      if (key === 'scanInterval' && _domPollTimer) { stopDomPolling(); startDomPolling(); }
      if (key === 'minPayout') updateHighPayoutPairs();
    } catch (_) {}
  }

  // ── Public API ────────────────────────────────────────────────────

  function start() {
    if (_running) return;
    _running = true;
    MF.log('info', 'Scanner: starting...');

    // 1. Listen for messages from page-hook
    window.addEventListener('message', _onWindowMessage);

    // 2. Start DOM polling (always runs for pair discovery + fallback)
    if (MF.getConfig('domPollFallback')) startDomPolling();

    // 3. Start pair discovery polling
    startPairPolling();

    // 4. Start WS staleness checker
    startStaleChecker();

    // 5. Listen for config changes
    MF.bus.on('config:change', onConfigChange);

    // 6. Trigger historical loading when pair becomes active
    MF.bus.on('pair:active', (info) => {
      try {
        if (info.pair && typeof HistoricalLoader !== 'undefined') {
          HistoricalLoader.loadPairHistory(info.pair).catch(() => {});
        }
      } catch (_) {}
    });

    // 7. Initial DOM scan + delayed re-scan (page may still be loading)
    pollDomCycle();
    pollDomPairs();
    setTimeout(() => { try { pollDomCycle(); pollDomPairs(); } catch (_) {} }, 5000);

    MF.log('info', 'Scanner: running');
  }

  function stop() {
    if (!_running) return;
    _running = false;
    MF.log('info', 'Scanner: stopping...');

    window.removeEventListener('message', _onWindowMessage);
    stopDomPolling();
    stopPairPolling();
    stopStaleChecker();

    // Close any building candles
    for (const [pair, candle] of Object.entries(_buildingCandles)) {
      try { closeCandle(pair, candle); } catch (_) {}
    }

    _wsAlive = false;
    _lastWsTick = 0;
    MF.log('info', 'Scanner: stopped');
  }

  function isRunning() { return _running; }
  function isWsAlive() { return _wsAlive && (Date.now() - _lastWsTick) < 10000; }
  function getWsUrl() { return _wsUrl; }

  /** Force a DOM rescan — useful when the page layout changes. */
  function rescan() { try { pollDomCycle(); pollDomPairs(); } catch (_) {} }

  /** Get diagnostic info about the scanner state. */
  function getDiagnostics() {
    return {
      running: _running, wsAlive: _wsAlive, wsUrl: _wsUrl,
      lastWsTick: _lastWsTick, domPollActive: !!_domPollTimer,
      pairPollActive: !!_pairPollTimer,
      buildingCandles: Object.keys(_buildingCandles).length,
      knownPairs: Object.keys(MF.state.allPairs).length,
      highPayoutCount: MF.state.highPayoutPairs.length,
      activePair: MF.state.activePair,
      activePairPayout: MF.state.activePairPayout,
    };
  }

  return { start, stop, isRunning, isWsAlive, getWsUrl, rescan, getDiagnostics };
})();
