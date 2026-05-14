/**
 * scanner.js  —  Market Data Scanner for MindFlareClaw Agent v2.0
 *
 * Bridges the page-hook WebSocket interception to the rest of the extension.
 * Handles BOTH raw WS frames ('ws_msg') AND pre-decoded Socket.IO frames ('ws_sio')
 * from page-hook.js, decodes ticks/candles, aggregates 1m candles, discovers pairs,
 * and falls back to DOM polling when WS data is absent.
 *
 * Globals used:
 *   MF           — core.js (MF.state, MF.bus, MF.getConfig, MF.log, MF.clamp)
 *   CandleStore  — candle-store.js
 */

const Scanner = (() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  //  CONSTANTS
  // ═══════════════════════════════════════════════════════════════════════

  /** Known Socket.IO event names for market-qx.trade */
  const TICK_EVENTS = new Set([
    'tick', 'quote', 'price', 'price-update', 'spot', 'tickData',
    'priceChange', 'updatePrice', 'trade', 'quotes', 'quoteUpdate',
    'instrument_price', 'spotPrice', 'instrument_price_changed',
    'priceChanged', 'update',
    // market-qx.trade specific: quotes/stream carries real-time price ticks
    'quotes/stream', 'quote'
  ]);

  const CANDLE_EVENTS = new Set([
    'candle', 'candles', 'candleUpdate', 'ohlcv', 'ohlc',
    'candleData', 'kline', 'bar', 'candlesData', 'chartData',
    'chart', 'instrument_candles', 'candleChanged', 'candleClosed',
    // market-qx.trade specific: history/list/v2 returns candle arrays
    'history/list/v2', 'history/list'
  ]);

  const ASSET_EVENTS = new Set([
    'asset', 'assets', 'instruments', 'pairs', 'symbols',
    'underlying', 'instrumentsList', 'assetList', 'instrumentsUpdated',
    'instrument_list', 'assetsUpdated', 'assetChanged',
    'instrument_update', 'balances',
    // market-qx.trade specific
    'instruments/list', 'instruments/update'
  ]);

  /** market-qx.trade specific events that carry balance/trade data */
  const BALANCE_EVENTS = new Set([
    's_balance/list', 'balance/list', 'balance'
  ]);

  const ORDER_EVENTS = new Set([
    'orders/opened/list', 'orders/closed/list', 'pending/list',
    'order', 'trade', 's_authorization'
  ]);

  const DEPTH_EVENTS = new Set([
    'depth/change', 'depth/follow'
  ]);

  /** Engine.IO packet types */
  const EIO_OPEN    = '0';
  const EIO_CLOSE   = '1';
  const EIO_PING    = '2';
  const EIO_PONG    = '3';
  const EIO_MESSAGE = '4';
  const EIO_UPGRADE = '5';
  const EIO_NOOP    = '6';

  /** Socket.IO packet types (after Engine.IO 4 prefix) */
  const SIO_CONNECT      = '0';
  const SIO_DISCONNECT   = '1';
  const SIO_EVENT        = '2';
  const SIO_ACK          = '3';
  const SIO_CONNECT_ERR  = '4';
  const SIO_BINARY_EVENT = '5';
  const SIO_BINARY_ACK   = '6';

  /** 1-minute candle aggregation */
  const CANDLE_INTERVAL_MS = 60_000;

  /** DOM selectors for market-qx.trade */
  const DOM_SELECTORS = {
    PRICE: [
      '.current-price', '.price-value', '.price-display',
      '[class*="price"]', '[class*="Price"]', '[data-price]',
      '.bet-current-price', '.quote-price', '.spot-price'
    ],
    PAIR: [
      '.current-asset', '.asset-name', '.active-asset',
      '[class*="asset"]', '[class*="instrument"]', '[class*="symbol"]',
      '.selected-pair', '[class*="pair"]', '.bet-asset'
    ],
    PAYOUT: [
      '.payout-value', '.payout-percent', '.profit-percent',
      '[class*="payout"]', '[class*="Payout"]',
      '[class*="profit"]', '[class*="Profit"]',
      '.bet-profit', '.bet-payout'
    ]
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  INTERNAL STATE
  // ═══════════════════════════════════════════════════════════════════════

  let _running   = false;
  let _wsAlive   = false;
  let _wsUrl     = null;
  let _wsLastTs  = 0;

  /** Pending ticks for 1m candle aggregation: Map< pairCode, { open, high, low, close, volume, tickCount, minuteTs } > */
  const _pendingCandles = new Map();

  /** Last completed candle minute per pair to avoid duplicates */
  const _lastCompletedMinute = new Map();

  /** DOM polling timer id */
  let _domPollTimer  = null;

  /** Health-check timer id */
  let _healthTimer   = null;

  /** Window message handler ref (for cleanup) */
  let _msgHandler    = null;

  /** Diagnostics accumulator */
  const _diag = {
    wsMsgCount:      0,
    wsSioCount:      0,
    wsOpenCount:     0,
    wsCloseCount:    0,
    wsErrorCount:    0,
    ticksProcessed:  0,
    candlesCompleted:0,
    candlesFromSio:  0,
    domPollCycles:   0,
    domPriceReads:   0,
    sioFramesDecoded:0,
    sioParseErrors:  0,
    lastTickTs:      0,
    lastCandleTs:    0,
    lastDomPollTs:   0,
    wsEventsSeen:    new Set(),
    startedAt:       0,
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  SOCKET.IO FRAME DECODER
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Decode a complete Socket.IO v3/v4 frame string.
   * Handles:
   *   - Engine.IO control packets (0-6)
   *   - Socket.IO event packets (42[eventName, ...data])
   *   - Namespace support (/chat,42[...])
   *   - Batched frames (multiple packets in one string delimited by delimiter)
   *   - Acknowledgement packets
   *
   * Returns array of { type, event?, data?, namespace? } or empty array on failure.
   */
  function decodeSioFrames(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return [];

    const results = [];

    // Handle batched frames: Socket.IO may concatenate frames.
    // We split on boundary where a new Engine.IO packet starts.
    const frames = splitBatchedFrames(raw);

    for (const frame of frames) {
      const decoded = decodeSingleFrame(frame);
      if (decoded) {
        if (Array.isArray(decoded)) {
          results.push(...decoded);
        } else {
          results.push(decoded);
        }
      }
    }

    return results;
  }

  /**
   * Split a potentially batched raw string into individual Socket.IO frames.
   * Batched frames occur when the server sends multiple packets in one WS message.
   * Each frame starts with an Engine.IO packet type byte (0-6).
   */
  function splitBatchedFrames(raw) {
    if (raw.length <= 1) return [raw];

    const frames = [];
    let i = 0;

    while (i < raw.length) {
      const ch = raw[i];

      // Engine.IO packet type must be 0-6
      if (ch >= '0' && ch <= '6') {
        // Try to find the boundary of this frame
        let end = raw.length;

        // If this is an Engine.IO MESSAGE (4), the payload follows
        if (ch === EIO_MESSAGE && i + 1 < raw.length) {
          // Socket.IO packet type follows the '4'
          const sioType = raw[i + 1];

          if (sioType === SIO_EVENT || sioType === SIO_ACK ||
              sioType === SIO_BINARY_EVENT || sioType === SIO_BINARY_ACK ||
              sioType === SIO_CONNECT || sioType === SIO_DISCONNECT ||
              sioType === SIO_CONNECT_ERR) {
            // Find JSON payload — scan for balanced brackets
            const jsonStart = findJsonStart(raw, i + 2);
            if (jsonStart !== -1) {
              const jsonEnd = findJsonEnd(raw, jsonStart);
              if (jsonEnd !== -1) {
                end = jsonEnd + 1;
              }
            }
          }
        }
        // For control packets (0,1,2,3,5,6), the payload may be JSON after the type byte
        else if (ch === EIO_OPEN && i + 1 < raw.length && raw[i + 1] === '{') {
          const jsonEnd = findJsonEnd(raw, i + 1);
          if (jsonEnd !== -1) end = jsonEnd + 1;
        }

        // Look ahead for the next Engine.IO frame
        // (a digit 0-6 that is NOT inside a JSON string)
        if (end < raw.length) {
          let nextStart = findNextFrameStart(raw, end);
          if (nextStart > i) {
            frames.push(raw.substring(i, nextStart));
            i = nextStart;
            continue;
          }
        }

        frames.push(raw.substring(i));
        break;
      } else {
        // Doesn't start with Engine.IO type — treat entire string as one frame
        frames.push(raw);
        break;
      }
    }

    return frames.length > 0 ? frames : [raw];
  }

  /**
   * Find the start of a JSON structure ({ or [) starting from `fromIndex`.
   */
  function findJsonStart(str, fromIndex) {
    for (let i = fromIndex; i < str.length; i++) {
      if (str[i] === '{' || str[i] === '[') return i;
    }
    return -1;
  }

  /**
   * Find the end of a JSON structure starting at `startIndex`.
   * Handles nested brackets and string escapes.
   */
  function findJsonEnd(str, startIndex) {
    const openCh = str[startIndex];
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIndex; i < str.length; i++) {
      const ch = str[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) return i;
      }
    }

    return -1;
  }

  /**
   * Find the start of the next Engine.IO frame after `fromIndex`.
   * Skips over JSON content to avoid false positives inside strings.
   */
  function findNextFrameStart(str, fromIndex) {
    let inString = false;
    let escape = false;
    let depth = 0;

    for (let i = fromIndex; i < str.length; i++) {
      const ch = str[i];

      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; }

      // A digit 0-6 at the top level could be a new frame start
      if (depth <= 0 && ch >= '0' && ch <= '6' && i > fromIndex) {
        return i;
      }
    }

    return str.length;
  }

  /**
   * Decode a single Socket.IO frame (already split from batch).
   *
   * Returns decoded object or null.
   */
  function decodeSingleFrame(frame) {
    if (!frame || frame.length === 0) return null;

    const eioType = frame[0];

    // ── Engine.IO control packets ──────────────────────────────────
    if (eioType === EIO_OPEN) {
      let data = null;
      if (frame.length > 1) {
        try { data = JSON.parse(frame.substring(1)); } catch (_) {}
      }
      return { type: 'eio_open', data };
    }

    if (eioType === EIO_CLOSE) {
      return { type: 'eio_close', data: null };
    }

    if (eioType === EIO_PING) {
      return { type: 'eio_ping', data: null };
    }

    if (eioType === EIO_PONG) {
      return { type: 'eio_pong', data: null };
    }

    if (eioType === EIO_UPGRADE) {
      return { type: 'eio_upgrade', data: null };
    }

    if (eioType === EIO_NOOP) {
      return { type: 'eio_noop', data: null };
    }

    // ── Engine.IO MESSAGE (Socket.IO packets follow) ──────────────
    if (eioType !== EIO_MESSAGE) return null;

    // Minimum: "40" (connect) — need at least 2 chars
    if (frame.length < 2) return null;

    const sioType = frame[1];
    let rest = frame.substring(2);

    // ── Namespace extraction ───────────────────────────────────────
    // Socket.IO namespaces: "/chat,42[...]" or just default "/"
    let namespace = '/';

    // If rest starts with '/', we have a namespace prefix
    if (rest.length > 0 && rest[0] === '/') {
      const commaIdx = rest.indexOf(',');
      if (commaIdx !== -1) {
        namespace = rest.substring(0, commaIdx);
        rest = rest.substring(commaIdx + 1);
      } else {
        // Namespace without comma — might be end of packet
        namespace = rest;
        rest = '';
      }
    }

    // ── Socket.IO CONNECT (40 or 40/namespace) ────────────────────
    if (sioType === SIO_CONNECT) {
      let data = null;
      if (rest.length > 0) {
        try { data = JSON.parse(rest); } catch (_) { data = rest; }
      }
      return { type: 'sio_connect', namespace, data };
    }

    // ── Socket.IO DISCONNECT (41) ─────────────────────────────────
    if (sioType === SIO_DISCONNECT) {
      return { type: 'sio_disconnect', namespace, data: null };
    }

    // ── Socket.IO EVENT (42) ──────────────────────────────────────
    if (sioType === SIO_EVENT) {
      _diag.sioFramesDecoded++;
      if (rest.length === 0) return { type: 'sio_event', namespace, event: null, data: null };
      try {
        const arr = JSON.parse(rest);
        if (Array.isArray(arr) && arr.length >= 1) {
          const event = String(arr[0] ?? '');
          _diag.wsEventsSeen.add(event);
          const data = arr.length === 2 ? arr[1] : arr.slice(1);
          return { type: 'sio_event', namespace, event, data };
        }
        return { type: 'sio_event', namespace, event: 'raw', data: arr };
      } catch (_) {
        _diag.sioParseErrors++;
        return { type: 'sio_event', namespace, event: null, data: rest };
      }
    }

    // ── Socket.IO ACK (43) ────────────────────────────────────────
    if (sioType === SIO_ACK) {
      let data = null;
      if (rest.length > 0) {
        try { data = JSON.parse(rest); } catch (_) { data = rest; }
      }
      return { type: 'sio_ack', namespace, data };
    }

    // ── Socket.IO CONNECT_ERROR (44) ──────────────────────────────
    if (sioType === SIO_CONNECT_ERR) {
      let data = null;
      if (rest.length > 0) {
        try { data = JSON.parse(rest); } catch (_) { data = rest; }
      }
      return { type: 'sio_connect_error', namespace, data };
    }

    // ── Socket.IO BINARY_EVENT (45) or BINARY_ACK (46) ────────────
    // Binary events have an attachment count after the type digit.
    // Format: 451-namespace[data]  (1 attachment, separated later)
    // In our case, page-hook decodes binary before posting, so we
    // still try to parse the JSON payload.
    if (sioType === SIO_BINARY_EVENT || sioType === SIO_BINARY_ACK) {
      // Strip attachment count: "451-[...]" → strip "1-"
      const attachmentMatch = rest.match(/^(\d+)-?/);
      if (attachmentMatch) {
        rest = rest.substring(attachmentMatch[0].length);
      }

      _diag.sioFramesDecoded++;
      if (rest.length === 0) {
        return {
          type: sioType === SIO_BINARY_EVENT ? 'sio_binary_event' : 'sio_binary_ack',
          namespace, event: null, data: null
        };
      }

      try {
        const arr = JSON.parse(rest);
        if (Array.isArray(arr) && arr.length >= 1) {
          const event = String(arr[0] ?? '');
          _diag.wsEventsSeen.add(event);
          const data = arr.length === 2 ? arr[1] : arr.slice(1);
          return {
            type: sioType === SIO_BINARY_EVENT ? 'sio_binary_event' : 'sio_binary_ack',
            namespace, event, data
          };
        }
        return {
          type: sioType === SIO_BINARY_EVENT ? 'sio_binary_event' : 'sio_binary_ack',
          namespace, event: 'raw', data: arr
        };
      } catch (_) {
        _diag.sioParseErrors++;
        return {
          type: sioType === SIO_BINARY_EVENT ? 'sio_binary_event' : 'sio_binary_ack',
          namespace, event: null, data: rest
        };
      }
    }

    // Unknown SIO type — try raw JSON
    if (rest.length > 0) {
      try {
        const j = JSON.parse(rest);
        return { type: 'sio_unknown', namespace, event: 'raw', data: j };
      } catch (_) {}
    }

    return { type: 'sio_unknown', namespace, event: null, data: rest || null };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PRICE / CANDLE EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Try to extract a numeric price from a tick event payload.
   * Handles many shapes: {price}, {tick:{price}}, {data:{price}}, etc.
   */
  function extractPrice(payload) {
    if (payload == null) return null;

    // Direct number
    if (typeof payload === 'number' && isFinite(payload) && payload > 0) return payload;

    // String that looks like a number
    if (typeof payload === 'string') {
      const n = parseFloat(payload);
      if (isFinite(n) && n > 0) return n;
    }

    // Array — first element might be price or an object
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const p = extractPrice(item);
        if (p !== null) return p;
      }
      return null;
    }

    // Object — try common price keys
    if (typeof payload === 'object') {
      const priceKeys = [
        'price', 'value', 'last', 'close', 'spot', 'currentPrice',
        'bid', 'ask', 'mid', 'midPrice', 'rate', 'quote', 'tick',
        'lastPrice', 'markPrice', 'indexPrice'
      ];

      for (const key of priceKeys) {
        if (payload[key] != null) {
          const p = extractPrice(payload[key]);
          if (p !== null) return p;
        }
      }

      // Nested objects: data, tick, quote, instrument
      const nestedKeys = ['data', 'tick', 'quote', 'instrument', 'payload', 'body', 'result'];
      for (const key of nestedKeys) {
        if (payload[key] != null && typeof payload[key] === 'object') {
          const p = extractPrice(payload[key]);
          if (p !== null) return p;
        }
      }
    }

    return null;
  }

  /**
   * Try to extract a pair/instrument name from a tick or asset event payload.
   */
  function extractPair(payload) {
    if (payload == null) return null;
    if (typeof payload === 'string') return payload;

    if (typeof payload === 'object') {
      const pairKeys = [
        'pair', 'symbol', 'instrument', 'asset', 'name', 'code',
        'active', 'activeId', 'instrumentId', 'symbolId',
        'ticker', 'contract', 'underlying'
      ];

      for (const key of pairKeys) {
        const val = payload[key];
        if (typeof val === 'string' && val.length > 0) return val;
        if (typeof val === 'number') return String(val);
      }

      // Nested
      const nestedKeys = ['data', 'instrument', 'quote', 'payload', 'body', 'result'];
      for (const key of nestedKeys) {
        if (payload[key] != null && typeof payload[key] === 'object') {
          const p = extractPair(payload[key]);
          if (p !== null) return p;
        }
      }
    }

    return null;
  }

  /**
   * Extract OHLCV candle data from a candle event payload.
   * Returns { o, h, l, c, v, ts } or null.
   */
  function extractCandle(payload) {
    if (payload == null) return null;

    // Direct object
    if (typeof payload === 'object' && !Array.isArray(payload)) {
      return extractCandleFromObj(payload);
    }

    // Array of candles — return the last one (most recent)
    if (Array.isArray(payload)) {
      if (payload.length === 0) return null;
      // If it's an array of candle objects, take the last
      if (typeof payload[payload.length - 1] === 'object') {
        return extractCandleFromObj(payload[payload.length - 1]);
      }
      // If it's [o, h, l, c, v, ts] format
      if (payload.length >= 4 && payload.slice(0, 4).every(v => typeof v === 'number')) {
        return {
          o: payload[0],
          h: payload[1],
          l: payload[2],
          c: payload[3],
          v: payload[4] ?? 0,
          ts: payload[5] ?? Date.now()
        };
      }
    }

    return null;
  }

  /**
   * Extract OHLCV from a single candle object.
   */
  function extractCandleFromObj(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // Try standard key mappings
    const maps = [
      { o: ['open', 'o', 'Open', 'O'],  h: ['high', 'h', 'High', 'H'],  l: ['low', 'l', 'Low', 'L'],  c: ['close', 'c', 'Close', 'C'],  v: ['volume', 'vol', 'v', 'Volume', 'Vol'] },
    ];

    for (const m of maps) {
      const o = firstNum(obj, m.o);
      const h = firstNum(obj, m.h);
      const l = firstNum(obj, m.l);
      const c = firstNum(obj, m.c);
      const v = firstNum(obj, m.v);

      if (o !== null && h !== null && l !== null && c !== null) {
        const ts = extractTimestamp(obj);
        return { o, h, l, c, v: v ?? 0, ts };
      }
    }

    // Nested under 'data', 'candle', 'kline', 'bar'
    const nestedKeys = ['data', 'candle', 'kline', 'bar', 'ohlcv', 'ohlc'];
    for (const key of nestedKeys) {
      if (obj[key] != null) {
        const c = extractCandleFromObj(obj[key]);
        if (c) return c;
      }
    }

    return null;
  }

  /**
   * Get the first numeric value from `obj` matching any of the `keys`.
   */
  function firstNum(obj, keys) {
    for (const k of keys) {
      const v = obj[k];
      if (v != null) {
        const n = typeof v === 'number' ? v : parseFloat(v);
        if (isFinite(n)) return n;
      }
    }
    return null;
  }

  /**
   * Extract a timestamp from an object (various key names / formats).
   */
  function extractTimestamp(obj) {
    const tsKeys = [
      'ts', 'time', 'timestamp', 't', 'date', 'datetime',
      'openTime', 'closeTime', 'startTime', 'endTime', 'period'
    ];

    for (const k of tsKeys) {
      const v = obj[k];
      if (v == null) continue;

      // Unix seconds
      if (typeof v === 'number') {
        if (v > 1e12) return v;            // already ms
        if (v > 1e9)  return v * 1000;     // seconds → ms
        return v;
      }

      // String
      if (typeof v === 'string') {
        const n = Number(v);
        if (isFinite(n)) {
          if (n > 1e12) return n;
          if (n > 1e9) return n * 1000;
          return n;
        }
        // ISO date string
        const d = Date.parse(v);
        if (isFinite(d)) return d;
      }
    }

    return Date.now();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  1-MINUTE CANDLE AGGREGATION FROM TICKS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Compute the minute-aligned timestamp (floor to minute boundary).
   */
  function minuteTs(ts) {
    return Math.floor(ts / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
  }

  /**
   * Process a tick (price update) and aggregate into a 1m candle.
   * @param {number}  price    - The tick price
   * @param {string}  pairCode - Normalized pair code (e.g. "EURUSD")
   * @param {number}  ts       - Timestamp in ms
   */
  function processTick(price, pairCode, ts) {
    if (!price || !pairCode || !ts) return;

    _diag.ticksProcessed++;
    _diag.lastTickTs = ts;

    const mTs = minuteTs(ts);
    const key = pairCode;

    let pending = _pendingCandles.get(key);

    // If the minute boundary changed, finalize the previous candle
    if (pending && pending.minuteTs !== mTs) {
      finalizeCandle(key, pending);
      pending = null;
    }

    // Create or update the pending candle
    if (!pending) {
      pending = {
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        tickCount: 1,
        minuteTs: mTs,
        pairCode: key
      };
      _pendingCandles.set(key, pending);
    } else {
      pending.high = Math.max(pending.high, price);
      pending.low  = Math.min(pending.low, price);
      pending.close = price;
      pending.tickCount++;
    }

    // Update MF.state with latest tick info
    MF.state.activePair = pairCode;
    if (!MF.state.candles[pairCode]) {
      MF.state.candles[pairCode] = [];
    }

    // Emit tick event
    MF.bus.emit('scanner:tick', { pairCode, price, ts });
  }

  /**
   * Finalize a 1m candle from aggregated ticks and persist it.
   */
  function finalizeCandle(pairCode, candle) {
    if (!candle || candle.tickCount === 0) return;

    const completedCandle = {
      pairCode,
      t:  candle.minuteTs,
      o:  candle.open,
      h:  candle.high,
      l:  candle.low,
      c:  candle.close,
      v:  candle.volume,
      tickCount: candle.tickCount
    };

    // Avoid completing the same minute twice
    if (_lastCompletedMinute.get(pairCode) === candle.minuteTs) {
      return;
    }
    _lastCompletedMinute.set(pairCode, candle.minuteTs);

    // Remove from pending
    _pendingCandles.delete(pairCode);

    // Add to in-memory store
    if (!MF.state.candles[pairCode]) {
      MF.state.candles[pairCode] = [];
    }
    MF.state.candles[pairCode].push(completedCandle);

    // Trim to max candles
    const maxCandles = MF.getConfig('maxCandlesPerPair') || 100000;
    if (MF.state.candles[pairCode].length > maxCandles) {
      MF.state.candles[pairCode] = MF.state.candles[pairCode].slice(-maxCandles);
    }

    // Persist via CandleStore
    persistCandle(pairCode, completedCandle);

    _diag.candlesCompleted++;
    _diag.lastCandleTs = Date.now();

    // Update MF.state.currentCandle
    MF.state.currentCandle = completedCandle;

    // Emit candle event
    MF.bus.emit('scanner:candle', completedCandle);
    MF.bus.emit(`scanner:candle:${pairCode}`, completedCandle);
  }

  /**
   * Process a candle that came directly from a Socket.IO candle event
   * (not from tick aggregation).
   */
  function processSioCandle(candleData, pairCode) {
    if (!candleData) return;

    const c = extractCandle(candleData);
    if (!c) return;

    // Determine pairCode from the candle data itself if not provided
    if (!pairCode) {
      pairCode = extractPair(candleData);
    }
    if (!pairCode) {
      pairCode = MF.state.activePair || 'UNKNOWN';
    }

    // Normalize timestamp
    const mTs = minuteTs(c.ts);

    // Check if this is a candle close event
    const isClosed = CANDLE_EVENTS.has('candleClosed') &&
      (candleData.closed === true || candleData.isClosed === true ||
       candleData.complete === true || candleData.final === true);

    const completedCandle = {
      pairCode,
      t:  mTs,
      o:  c.o,
      h:  c.h,
      l:  c.l,
      c:  c.c,
      v:  c.v ?? 0,
      tickCount: 0,  // came directly, not from ticks
      sioCandle: true
    };

    // If it's a closed candle, finalize and persist
    if (isClosed) {
      if (_lastCompletedMinute.get(pairCode) === mTs) return;
      _lastCompletedMinute.set(pairCode, mTs);

      if (!MF.state.candles[pairCode]) {
        MF.state.candles[pairCode] = [];
      }
      MF.state.candles[pairCode].push(completedCandle);

      const maxCandles = MF.getConfig('maxCandlesPerPair') || 100000;
      if (MF.state.candles[pairCode].length > maxCandles) {
        MF.state.candles[pairCode] = MF.state.candles[pairCode].slice(-maxCandles);
      }

      persistCandle(pairCode, completedCandle);
      _diag.candlesCompleted++;
      _diag.candlesFromSio++;
      _diag.lastCandleTs = Date.now();
      MF.state.currentCandle = completedCandle;
      MF.bus.emit('scanner:candle', completedCandle);
      MF.bus.emit(`scanner:candle:${pairCode}`, completedCandle);
    } else {
      // Updating the current (in-progress) candle
      MF.state.currentCandle = completedCandle;
      MF.bus.emit('scanner:candleUpdate', completedCandle);
      MF.bus.emit(`scanner:candleUpdate:${pairCode}`, completedCandle);

      // Also update the pending candle for this pair if we're tracking it
      const pending = _pendingCandles.get(pairCode);
      if (pending && pending.minuteTs === mTs) {
        // Merge SIO candle data into the pending aggregated candle
        // Use SIO candle OHLC as ground truth but keep tick count
        pending.open  = c.o;
        pending.high  = c.h;
        pending.low   = c.l;
        pending.close = c.c;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ASSET / PAYOUT DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Process an asset event payload to discover trading pairs and payouts.
   */
  function processAssetEvent(payload) {
    if (payload == null) return;

    let items = null;

    // Direct array of assets
    if (Array.isArray(payload)) {
      items = payload;
    }
    // Nested array
    else if (typeof payload === 'object') {
      const arrayKeys = ['assets', 'instruments', 'pairs', 'symbols', 'list', 'data', 'items', 'result'];
      for (const k of arrayKeys) {
        if (Array.isArray(payload[k])) {
          items = payload[k];
          break;
        }
      }
    }

    if (!items || items.length === 0) return;

    const minPayout = MF.getConfig('minPayout') || 70;
    const highPayoutPairs = [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;

      const pair = extractPair(item);
      if (!pair) continue;

      const code = MF.codeFromPair(pair);

      // Extract payout percentage
      let payout = null;
      const payoutKeys = [
        'payout', 'profit', 'profitPercent', 'payoutPercent',
        'payout1m', 'profit1m', 'payout_1m', 'payout1', 'p'
      ];
      for (const k of payoutKeys) {
        if (item[k] != null) {
          const n = typeof item[k] === 'number' ? item[k] : parseFloat(item[k]);
          if (isFinite(n)) { payout = n; break; }
        }
      }

      // Check for nested payout
      if (payout === null && item.payouts) {
        if (typeof item.payouts === 'object') {
          payout = item.payouts['1'] ?? item.payouts['1m'] ?? item.payouts['60'] ?? null;
        }
      }

      // Skip OTC if configured
      if (MF.getConfig('excludeOTC') && /\(OTC\)/i.test(pair)) continue;

      // Register the pair
      MF.state.allPairs[code] = {
        pair,
        code,
        payout: payout ?? 0,
        otc: /\(OTC\)/i.test(pair),
      };

      // Track high payout pairs
      if (payout !== null && payout >= minPayout) {
        highPayoutPairs.push({ pair, code, payout });
      }
    }

    // Sort by payout descending
    highPayoutPairs.sort((a, b) => b.payout - a.payout);
    MF.state.highPayoutPairs = highPayoutPairs;

    MF.bus.emit('scanner:assets', MF.state.allPairs);
    MF.bus.emit('scanner:highPayout', highPayoutPairs);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  DOM POLLING FALLBACK
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Read price from the page DOM using known selectors.
   */
  function domReadPrice() {
    for (const sel of DOM_SELECTORS.PRICE) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const txt = el.textContent || el.value || el.getAttribute('data-price') || '';
        const clean = txt.replace(/[^\d.\-]/g, '');
        const n = parseFloat(clean);
        if (isFinite(n) && n > 0) return n;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Read current pair name from the page DOM.
   */
  function domReadPair() {
    for (const sel of DOM_SELECTORS.PAIR) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const txt = (el.textContent || el.value || '').trim();
        if (txt.length > 1 && txt.length < 80) return txt;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Read payout percentage from the page DOM.
   */
  function domReadPayout() {
    for (const sel of DOM_SELECTORS.PAYOUT) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const txt = el.textContent || el.value || '';
        const clean = txt.replace(/[^\d.\-]/g, '');
        const n = parseFloat(clean);
        if (isFinite(n) && n > 0 && n <= 100) return n;
      } catch (_) {}
    }
    return null;
  }

  /**
   * One cycle of DOM polling — reads price, pair, payout from DOM
   * and feeds into the scanner pipeline.
   */
  function domPollCycle() {
    _diag.domPollCycles++;
    _diag.lastDomPollTs = Date.now();

    const price = domReadPrice();
    const pair  = domReadPair();
    const payout = domReadPayout();

    if (price !== null) {
      _diag.domPriceReads++;
      const pairCode = pair ? MF.codeFromPair(pair) : (MF.state.activePair || 'DOM');
      processTick(price, pairCode, Date.now());
    }

    if (pair) {
      const code = MF.codeFromPair(pair);
      MF.state.activePair = code;

      if (!MF.state.allPairs[code]) {
        MF.state.allPairs[code] = {
          pair,
          code,
          payout: payout ?? 0,
          otc: /\(OTC\)/i.test(pair),
        };
        MF.bus.emit('scanner:assets', MF.state.allPairs);
      }

      if (payout !== null) {
        MF.state.allPairs[code].payout = payout;
        MF.state.activePairPayout = payout;
      }
    }
  }

  /**
   * Start the DOM polling fallback.
   */
  function startDomPolling() {
    if (_domPollTimer) return;
    const interval = MF.getConfig('scanInterval') || 2000;
    _domPollTimer = setInterval(domPollCycle, interval);
    MF.log('info', '[Scanner] DOM polling started (interval:', interval, 'ms)');
  }

  /**
   * Stop the DOM polling fallback.
   */
  function stopDomPolling() {
    if (_domPollTimer) {
      clearInterval(_domPollTimer);
      _domPollTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  XHR / FETCH RESPONSE HANDLERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Handle HTTP response data from page-hook XHR/Fetch interception.
   * These may contain asset lists, candle data, etc.
   */
  function handleHttpResponse(type, msg) {
    const { url, response } = msg;
    if (!response || typeof response !== 'string') return;

    // Try to parse as JSON
    let data;
    try {
      data = JSON.parse(response);
    } catch (_) { return; }

    // Detect asset/instrument lists
    if (url && (url.includes('/instruments') || url.includes('/assets') ||
                url.includes('/pairs') || url.includes('/symbols') ||
                url.includes('/underlying'))) {
      processAssetEvent(data);
      return;
    }

    // Detect candle/OHLCV data
    if (url && (url.includes('/candles') || url.includes('/ohlcv') ||
                url.includes('/ohlc') || url.includes('/kline') ||
                url.includes('/chart') || url.includes('/history'))) {
      // Might be an array of candles
      if (Array.isArray(data)) {
        for (const c of data) {
          const pair = extractPairFromUrl(url) || MF.state.activePair;
          processSioCandle(c, pair);
        }
      } else if (typeof data === 'object') {
        const candles = data.candles || data.data || data.result || data.items;
        if (Array.isArray(candles)) {
          const pair = extractPairFromUrl(url) || MF.state.activePair;
          for (const c of candles) {
            processSioCandle(c, pair);
          }
        }
      }
      return;
    }

    // Generic: try to detect arrays of assets in any response
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
      // Heuristic: if first item has pair/asset/symbol key, treat as assets
      const sample = data[0];
      if (sample.pair || sample.symbol || sample.instrument || sample.asset || sample.activeId) {
        processAssetEvent(data);
      }
    }
  }

  /**
   * Try to extract a pair code from a URL path like /api/candles/EURUSD/1m
   */
  function extractPairFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    // Common patterns: /candles/EURUSD, /instruments/EURUSD, /pair/EUR-USD
    const patterns = [
      /\/candles\/([A-Z]{3,6}[A-Z]?[-_]?[A-Z]{3,6})/i,
      /\/instruments\/([A-Z]{3,6}[A-Z]?[-_]?[A-Z]{3,6})/i,
      /\/pairs?\/([A-Z]{3,6}[A-Z]?[-_]?[A-Z]{3,6})/i,
      /\/symbol\/([A-Z]{3,6}[A-Z]?[-_]?[A-Z]{3,6})/i,
      /\/ohlcv\/([A-Z]{3,6}[A-Z]?[-_]?[A-Z]{3,6})/i,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return MF.codeFromPair(m[1]);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PERSISTENCE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Persist a completed candle via CandleStore (IndexedDB).
   * Non-blocking — errors are logged but don't break the pipeline.
   */
  function persistCandle(pairCode, candle) {
    if (typeof CandleStore === 'undefined' || !CandleStore) {
      // CandleStore not loaded yet — skip silently
      return;
    }

    try {
      if (typeof CandleStore.put === 'function') {
        CandleStore.put(pairCode, candle).catch(err => {
          MF.log('warn', '[Scanner] CandleStore.put failed:', err?.message || err);
        });
      } else if (typeof CandleStore.saveCandle === 'function') {
        CandleStore.saveCandle(pairCode, candle).catch(err => {
          MF.log('warn', '[Scanner] CandleStore.saveCandle failed:', err?.message || err);
        });
      }
    } catch (err) {
      MF.log('warn', '[Scanner] CandleStore access error:', err?.message || err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  WINDOW MESSAGE HANDLER
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Central handler for all window.postMessage from page-hook.js.
   */
  function onWindowMessage(event) {
    // Only accept messages from the same window
    if (event.source !== window) return;

    // Must have the __mf marker
    const msg = event.data;
    if (!msg || !msg.__mf) return;

    const { type } = msg;

    switch (type) {
      // ── Hook Ready ───────────────────────────────────────────────
      case 'hook_ready':
        MF.state.hookReady = true;
        MF.log('info', '[Scanner] Page-hook is ready');
        MF.bus.emit('scanner:hookReady');
        break;

      // ── WebSocket Opened ─────────────────────────────────────────
      case 'ws_open':
        _wsAlive = true;
        _wsUrl = msg.url || null;
        _wsLastTs = msg.ts || Date.now();
        _diag.wsOpenCount++;
        MF.state.wsConnected = true;
        MF.state.wsUrl = _wsUrl;
        MF.log('info', '[Scanner] WS opened:', _wsUrl);
        MF.bus.emit('scanner:wsOpen', { url: _wsUrl });
        break;

      // ── WebSocket Closed ─────────────────────────────────────────
      case 'ws_close':
        _wsAlive = false;
        _wsUrl = null;
        _diag.wsCloseCount++;
        MF.state.wsConnected = false;
        MF.state.wsUrl = null;
        MF.log('info', '[Scanner] WS closed — code:', msg.code, 'reason:', msg.reason);
        MF.bus.emit('scanner:wsClose', { code: msg.code, reason: msg.reason });

        // Finalize any pending candles
        finalizeAllPending();

        // Start DOM fallback if enabled
        if (MF.getConfig('domPollFallback')) {
          startDomPolling();
        }
        break;

      // ── WebSocket Error ──────────────────────────────────────────
      case 'ws_error':
        _diag.wsErrorCount++;
        MF.state.wsConnected = false;
        MF.log('warn', '[Scanner] WS error:', msg.url);
        MF.bus.emit('scanner:wsError', { url: msg.url });
        break;

      // ── Raw WS Message (string data, already decoded from binary by page-hook) ──
      case 'ws_msg':
        handleWsMsg(msg);
        break;

      // ── Pre-decoded Socket.IO Frame (from page-hook) ────────────
      case 'ws_sio':
        handleWsSio(msg);
        break;

      // ── Outgoing WS Message ──────────────────────────────────────
      case 'ws_send':
        // Observe outgoing messages for subscription tracking, etc.
        MF.bus.emit('scanner:wsSend', { data: msg.data, url: msg.url });
        break;

      // ── XHR Response ─────────────────────────────────────────────
      case 'xhr_load':
        handleHttpResponse('xhr', msg);
        break;

      // ── Fetch Response ───────────────────────────────────────────
      case 'fetch_load':
        handleHttpResponse('fetch', msg);
        break;

      default:
        // Unknown message type — ignore
        break;
    }
  }

  /**
   * Handle a raw WebSocket message ('ws_msg' type).
   * This contains the raw string data from the WS frame.
   * We need to decode Socket.IO frames ourselves.
   */
  function handleWsMsg(msg) {
    _diag.wsMsgCount++;
    _wsLastTs = msg.ts || Date.now();

    const raw = msg.data;
    if (typeof raw !== 'string' || raw.length === 0) return;

    // Only process Engine.IO MESSAGE packets (type 4)
    // If the raw data starts with '4', it's a Socket.IO message
    // and we need to decode it. Other EIO types (0,1,2,3,5,6) are control.
    if (raw[0] === '4') {
      const frames = decodeSioFrames(raw);
      for (const frame of frames) {
        if (frame && frame.type === 'sio_event' && frame.event) {
          dispatchSioEvent(frame.event, frame.data, msg.url);
        }
      }
    }
    // Engine.IO PONG — just mark as alive
    else if (raw[0] === '3') {
      _wsAlive = true;
    }
  }

  /**
   * Handle a pre-decoded Socket.IO frame ('ws_sio' type).
   * The page-hook has already decoded the Engine.IO / Socket.IO framing
   * and extracted the event name and data. We use it directly, skipping
   * re-decoding.
   */
  function handleWsSio(msg) {
    _diag.wsSioCount++;
    _wsLastTs = msg.ts || Date.now();

    const { event, data, dir } = msg;

    // Only process incoming messages for market data
    if (dir === 'out') {
      MF.bus.emit('scanner:wsOut', { event, data });
      return;
    }

    // Dispatch directly — no need to re-decode
    if (event) {
      dispatchSioEvent(event, data, msg.url);
    }
  }

  /**
   * Dispatch a decoded Socket.IO event to the appropriate handler.
   * This is the shared path for both ws_msg (after decoding) and ws_sio.
   */
  function dispatchSioEvent(event, data, url) {
    // ── market-qx.trade specific: instruments/list ────────────────
    // The instruments/list event contains an array of instrument data.
    // Format from msgpack: [id, "SYMBOL", "Name", "type", ...payouts, ...]
    // We need to parse the array and extract pairs/payouts.
    if (event === 'instruments/list') {
      processInstrumentsList(data);
      MF.bus.emit('scanner:sioAsset', { event, data });
      return;
    }

    // ── market-qx.trade specific: quotes/stream ──────────────────
    // quotes/stream carries real-time price data for the active instrument.
    // The data is often a simple value (price number) or object with price info.
    if (event === 'quotes/stream') {
      const price = extractPriceFromStream(data);
      if (price !== null) {
        const pair = MF.state.activePair || 'ACTIVE';
        processTick(price, pair, Date.now());
      }
      MF.bus.emit('scanner:sioTick', { event, data });
      return;
    }

    // ── market-qx.trade specific: history/list/v2 ────────────────
    // Returns candle history for a pair. Data is typically an array of
    // [time, open, high, low, close, volume] or objects.
    if (event === 'history/list/v2' || event === 'history/list') {
      processHistoryData(data);
      MF.bus.emit('scanner:sioCandle', { event, data });
      return;
    }

    // ── market-qx.trade specific: s_balance/list ─────────────────
    if (BALANCE_EVENTS.has(event)) {
      processBalanceEvent(data);
      MF.bus.emit('scanner:sioBalance', { event, data });
      return;
    }

    // ── market-qx.trade specific: order events ───────────────────
    if (ORDER_EVENTS.has(event)) {
      processOrderEvent(event, data);
      MF.bus.emit('scanner:sioOrder', { event, data });
      return;
    }

    // ── market-qx.trade specific: depth/change ───────────────────
    if (DEPTH_EVENTS.has(event)) {
      MF.bus.emit('scanner:sioDepth', { event, data });
      return;
    }

    // ── market-qx.trade specific: instruments/update ─────────────
    // Sent when user switches instrument. Contains the new instrument ID.
    if (event === 'instruments/update') {
      processInstrumentUpdate(data);
      MF.bus.emit('scanner:sioAsset', { event, data });
      return;
    }

    // ── market-qx.trade specific: s_authorization ────────────────
    if (event === 's_authorization') {
      MF.log('info', '[Scanner] Authorization confirmed by server');
      MF.bus.emit('scanner:authorized', { event, data });
      return;
    }

    // ── Generic tick / price events ───────────────────────────────
    if (TICK_EVENTS.has(event)) {
      const price = extractPrice(data);
      if (price !== null) {
        const pair = extractPair(data) || MF.state.activePair || 'UNKNOWN';
        const code = MF.codeFromPair(pair);
        processTick(price, code, Date.now());
      }
      MF.bus.emit('scanner:sioTick', { event, data });
      return;
    }

    // ── Generic candle events ─────────────────────────────────────
    if (CANDLE_EVENTS.has(event)) {
      const pair = extractPair(data) || MF.state.activePair;
      const code = pair ? MF.codeFromPair(pair) : null;
      processSioCandle(data, code);
      MF.bus.emit('scanner:sioCandle', { event, data });
      return;
    }

    // ── Generic asset events ──────────────────────────────────────
    if (ASSET_EVENTS.has(event)) {
      processAssetEvent(data);
      MF.bus.emit('scanner:sioAsset', { event, data });
      return;
    }

    // Any other event — emit generically
    MF.bus.emit('scanner:sioEvent', { event, data, url });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  MARKET-QX.TRADE SPECIFIC EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Process instruments/list from market-qx.trade.
   * The data from msgpack decode is a large array of instrument entries.
   * Each entry is an array: [id, "SYMBOL", "DisplayName", "type",
   *   payout1m, payout5m?, ...expirationTimes, ..., ...more data]
   *
   * We extract pair name, payout, and OTC status.
   */
  function processInstrumentsList(data) {
    if (!data) return;

    // The data might be the direct array or nested under a key
    let items = data;
    if (typeof data === 'object' && !Array.isArray(data)) {
      // Try to find the array
      for (const key of ['data', 'instruments', 'list', 'items']) {
        if (Array.isArray(data[key])) {
          items = data[key];
          break;
        }
      }
    }

    if (!Array.isArray(items)) {
      // Maybe the data itself is a single instrument entry — try as generic asset event
      processAssetEvent(data);
      return;
    }

    // Check if this looks like market-qx.trade format
    // Each item: [id, symbol, name, type, payout_1m, ...]
    const minPayout = MF.getConfig('minPayout') || 70;
    const highPayoutPairs = [];

    for (const item of items) {
      if (!item) continue;

      // Array-format instrument (market-qx.trade msgpack format)
      if (Array.isArray(item) && item.length >= 4) {
        const id = item[0];
        const symbol = item[1];
        const name = item[2];
        const type = item[3];
        // Payout percentages are at various positions
        // Typically: [id, symbol, name, type, payout_1m, payout_5m?, ...]
        const payout1m = typeof item[4] === 'number' ? item[4] : null;

        if (typeof symbol === 'string' && symbol.length > 0) {
          const pair = name || symbol;
          const code = MF.codeFromPair(pair);
          const isOTC = /\(OTC\)/i.test(pair) || /\(OTC\)/i.test(symbol);

          MF.state.allPairs[code] = {
            pair,
            code,
            id,
            symbol,
            payout: payout1m ?? 0,
            otc: isOTC,
            type: type || 'unknown',
          };

          if (payout1m !== null && payout1m >= minPayout) {
            highPayoutPairs.push({ pair, code, payout: payout1m });
          }
        }
      }
      // Object-format instrument
      else if (typeof item === 'object' && !Array.isArray(item)) {
        const pair = extractPair(item);
        if (pair) {
          const code = MF.codeFromPair(pair);
          let payout = null;
          const payoutKeys = ['payout', 'profit', 'profitPercent', 'payoutPercent', 'p'];
          for (const k of payoutKeys) {
            if (item[k] != null) {
              const n = typeof item[k] === 'number' ? item[k] : parseFloat(item[k]);
              if (isFinite(n)) { payout = n; break; }
            }
          }

          MF.state.allPairs[code] = {
            pair,
            code,
            payout: payout ?? 0,
            otc: /\(OTC\)/i.test(pair),
          };

          if (payout !== null && payout >= minPayout) {
            highPayoutPairs.push({ pair, code, payout });
          }
        }
      }
    }

    highPayoutPairs.sort((a, b) => b.payout - a.payout);
    MF.state.highPayoutPairs = highPayoutPairs;

    MF.log('info', `[Scanner] instruments/list: ${Object.keys(MF.state.allPairs).length} pairs found, ${highPayoutPairs.length} high-payout`);
    MF.bus.emit('scanner:assets', MF.state.allPairs);
    MF.bus.emit('scanner:highPayout', highPayoutPairs);
  }

  /**
   * Extract price from quotes/stream data.
   * The market-qx.trade quotes/stream data can be:
   *   - A simple number (the price)
   *   - An object with price fields
   *   - An array [price] or [pair, price]
   */
  function extractPriceFromStream(data) {
    if (data == null) return null;

    // Simple number
    if (typeof data === 'number' && isFinite(data) && data > 0) return data;

    // String that looks like a number
    if (typeof data === 'string') {
      const n = parseFloat(data);
      if (isFinite(n) && n > 0) return n;
    }

    // Array — last numeric element might be price
    if (Array.isArray(data)) {
      // Try last element that looks like a price
      for (let i = data.length - 1; i >= 0; i--) {
        const n = typeof data[i] === 'number' ? data[i] : parseFloat(data[i]);
        if (isFinite(n) && n > 0) return n;
      }
    }

    // Object — try common price keys
    if (typeof data === 'object' && !Array.isArray(data)) {
      return extractPrice(data);
    }

    return null;
  }

  /**
   * Process history/list/v2 data from market-qx.trade.
   * Contains candle data for backfilling.
   */
  function processHistoryData(data) {
    if (!data) return;

    let candles = null;

    if (Array.isArray(data)) {
      candles = data;
    } else if (typeof data === 'object') {
      // Try to find candle array
      for (const key of ['candles', 'data', 'list', 'items', 'result']) {
        if (Array.isArray(data[key])) {
          candles = data[key];
          break;
        }
      }
    }

    if (!candles || !Array.isArray(candles)) return;

    const pairCode = MF.state.activePair || 'HISTORY';

    for (const c of candles) {
      if (!c) continue;

      // Array format: [time, open, high, low, close, volume?]
      if (Array.isArray(c) && c.length >= 4) {
        const ts = typeof c[0] === 'number' ? (c[0] > 1e12 ? c[0] : c[0] * 1000) : Date.now();
        const candle = {
          pairCode,
          t: minuteTs(ts),
          o: Number(c[1]) || 0,
          h: Number(c[2]) || 0,
          l: Number(c[3]) || 0,
          c: Number(c[4]) || 0,
          v: Number(c[5]) || 0,
          tickCount: 0,
          sioCandle: true,
        };
        if (candle.o > 0 && candle.c > 0) {
          if (!MF.state.candles[pairCode]) MF.state.candles[pairCode] = [];
          MF.state.candles[pairCode].push(candle);
          persistCandle(pairCode, candle);
        }
      }
      // Object format
      else if (typeof c === 'object') {
        processSioCandle(c, pairCode);
      }
    }

    MF.log('info', `[Scanner] history/list/v2: ${candles.length} candles for ${pairCode}`);
  }

  /**
   * Process s_balance/list event from market-qx.trade.
   */
  function processBalanceEvent(data) {
    if (!data || typeof data !== 'object') return;

    try {
      // Extract balance info
      if (data.liveBalance !== undefined) MF.state.liveBalance = Number(data.liveBalance) || 0;
      if (data.demoBalance !== undefined) MF.state.demoBalance = Number(data.demoBalance) || 0;
      MF.bus.emit('scanner:balance', data);
    } catch (_) {}
  }

  /**
   * Process order events from market-qx.trade.
   */
  function processOrderEvent(event, data) {
    if (!data) return;

    try {
      if (event === 'orders/closed/list' && Array.isArray(data)) {
        // Record closed trades for self-improvement
        for (const order of data) {
          if (order && typeof order === 'object') {
            MF.bus.emit('scanner:orderClosed', order);
          }
        }
      }
      MF.bus.emit('scanner:orders', { event, data });
    } catch (_) {}
  }

  /**
   * Process instruments/update event (user switched instrument).
   */
  function processInstrumentUpdate(data) {
    if (!data) return;

    try {
      // data typically contains {asset: "SYMBOL", period: 60}
      let pairCode = null;
      if (typeof data === 'object') {
        const asset = data.asset || data.symbol || data.instrument || data.pair;
        if (asset) {
          pairCode = MF.codeFromPair(asset);
        }
      } else if (typeof data === 'string') {
        pairCode = MF.codeFromPair(data);
      }

      if (pairCode) {
        MF.state.activePair = pairCode;
        MF.log('info', '[Scanner] Instrument switched to:', pairCode);
        MF.bus.emit('scanner:pairChanged', { pairCode, data });
      }
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  HEALTH CHECK & CANDLE FINALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Periodic health check:
   *  - Finalize any pending candles that have exceeded the current minute
   *  - Detect stale WS connection
   *  - Start DOM fallback if WS is stale
   */
  function healthCheck() {
    const now = Date.now();

    // Finalize pending candles whose minute has elapsed
    for (const [pairCode, candle] of _pendingCandles.entries()) {
      if (candle.minuteTs < minuteTs(now)) {
        finalizeCandle(pairCode, candle);
      }
    }

    // Check WS staleness (no data for 30 seconds)
    if (_wsAlive && (now - _wsLastTs) > 30_000) {
      _wsAlive = false;
      MF.state.wsConnected = false;
      MF.log('warn', '[Scanner] WS stale — no data for 30s');
      MF.bus.emit('scanner:wsStale');

      if (MF.getConfig('domPollFallback')) {
        startDomPolling();
      }
    }
  }

  /**
   * Finalize all pending candles (e.g. on WS close or scanner stop).
   */
  function finalizeAllPending() {
    for (const [pairCode, candle] of _pendingCandles.entries()) {
      finalizeCandle(pairCode, candle);
    }
    _pendingCandles.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Start the scanner: attach message listener, start health check, etc.
   */
  function start() {
    if (_running) return;
    _running = true;
    _diag.startedAt = Date.now();

    // Drain the message queue from page-hook.js (posted before scanner was ready)
    const queue = window.__MFC_MSG_QUEUE || [];
    if (queue.length > 0) {
      MF.log('info', '[Scanner] Draining message queue:', queue.length, 'messages');
      for (const msg of queue) {
        onWindowMessage({ data: msg, source: window });
      }
      queue.length = 0; // Clear the queue
    }

    // Attach live window message handler
    _msgHandler = onWindowMessage;
    window.addEventListener('message', _msgHandler);

    // Start health check (every 5 seconds)
    _healthTimer = setInterval(healthCheck, 5_000);

    // If WS is not alive, start DOM polling immediately
    if (!_wsAlive && MF.getConfig('domPollFallback')) {
      startDomPolling();
    }

    MF.log('info', '[Scanner] Started');
    MF.bus.emit('scanner:started');
  }

  /**
   * Stop the scanner: detach listeners, finalize pending, stop timers.
   */
  function stop() {
    if (!_running) return;
    _running = false;

    // Detach message handler
    if (_msgHandler) {
      window.removeEventListener('message', _msgHandler);
      _msgHandler = null;
    }

    // Stop timers
    if (_healthTimer) {
      clearInterval(_healthTimer);
      _healthTimer = null;
    }

    stopDomPolling();

    // Finalize any remaining pending candles
    finalizeAllPending();

    MF.log('info', '[Scanner] Stopped');
    MF.bus.emit('scanner:stopped');
  }

  /**
   * Is the scanner running?
   */
  function isRunning() {
    return _running;
  }

  /**
   * Is the WebSocket connection alive (receiving data)?
   */
  function isWsAlive() {
    return _wsAlive;
  }

  /**
   * Get the current WebSocket URL, if any.
   */
  function getWsUrl() {
    return _wsUrl;
  }

  /**
   * Force a rescan of DOM elements and re-check WS state.
   */
  function rescan() {
    MF.log('info', '[Scanner] Rescanning...');

    // Immediate DOM poll
    domPollCycle();

    // Reset WS staleness check
    _wsLastTs = Date.now();

    // Re-emit current state
    MF.bus.emit('scanner:rescan', {
      wsAlive: _wsAlive,
      wsUrl: _wsUrl,
      activePair: MF.state.activePair,
      pairCount: Object.keys(MF.state.allPairs).length,
    });
  }

  /**
   * Get diagnostics info.
   */
  function getDiagnostics() {
    return {
      running:            _running,
      wsAlive:            _wsAlive,
      wsUrl:              _wsUrl,
      wsLastTs:           _wsLastTs,
      pendingCandles:     _pendingCandles.size,
      wsMsgCount:         _diag.wsMsgCount,
      wsSioCount:         _diag.wsSioCount,
      wsOpenCount:        _diag.wsOpenCount,
      wsCloseCount:       _diag.wsCloseCount,
      wsErrorCount:       _diag.wsErrorCount,
      ticksProcessed:     _diag.ticksProcessed,
      candlesCompleted:   _diag.candlesCompleted,
      candlesFromSio:     _diag.candlesFromSio,
      domPollCycles:      _diag.domPollCycles,
      domPriceReads:      _diag.domPriceReads,
      sioFramesDecoded:   _diag.sioFramesDecoded,
      sioParseErrors:     _diag.sioParseErrors,
      lastTickTs:         _diag.lastTickTs,
      lastCandleTs:       _diag.lastCandleTs,
      lastDomPollTs:      _diag.lastDomPollTs,
      wsEventsSeen:       [..._diag.wsEventsSeen],
      startedAt:          _diag.startedAt,
      uptimeMs:           _running ? Date.now() - _diag.startedAt : 0,
      pairCount:          Object.keys(MF.state.allPairs).length,
      activePair:         MF.state.activePair,
      highPayoutCount:    MF.state.highPayoutPairs.length,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  // Auto-start when DOM is ready and MF is available
  // (The scanner is started by bootstrap.js, but we also listen for
  //  the hook_ready message to auto-start if not already running.)
  MF.bus.on('scanner:start', () => start());
  MF.bus.on('scanner:stop',  () => stop());

  // Return public API
  return {
    start,
    stop,
    isRunning,
    isWsAlive,
    getWsUrl,
    rescan,
    getDiagnostics,
  };
})();
