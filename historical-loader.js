/**
 * historical-loader.js  —  Deep Pagination Historical Candle Loader
 *
 * Fetches historical candle data from market-qx.trade API endpoints
 * and stores them in CandleStore (IndexedDB) for instant future access.
 *
 * Uses XHR interception + API endpoint discovery to pull 30-day history
 * for all active pairs.  Runs in background after page load.
 */

const HistoricalLoader = (() => {
  'use strict';

  let _loading = false;
  let _progress = { loaded: 0, total: 0, currentPair: '' };

  // ── Known API patterns for market-qx.trade ─────────────────────────
  // The platform typically exposes candle data via REST endpoints.
  // We discover these via XHR interception (page-hook.js posts xhr_load events).
  const API_PATTERNS = [
    /\/api\/candles/,           // Direct candle endpoint
    /\/api\/quote/,             // Quote data
    /\/api\/history/,           // History endpoint
    /\/api\/chart/,             // Chart data
    /candles/,                  // Generic
    /history/,                  // Generic
  ];

  let _discoveredEndpoints = {};

  // ── Discover API endpoints from intercepted XHR ────────────────────
  function discoverFromXHR(xhrEvent) {
    try {
      if (!xhrEvent.url || !xhrEvent.response) return;

      for (const pattern of API_PATTERNS) {
        if (pattern.test(xhrEvent.url)) {
          _discoveredEndpoints[xhrEvent.url] = {
            url: xhrEvent.url,
            method: xhrEvent.method,
            status: xhrEvent.status,
            sampleResponse: xhrEvent.response.substring(0, 2000),
            discoveredAt: Date.now()
          };
          MF.log('info', 'HistoricalLoader: Discovered endpoint:', xhrEvent.url);
          break;
        }
      }
    } catch (e) {
      // Silent
    }
  }

  // ── Parse candles from API response ────────────────────────────────
  function parseCandlesFromResponse(data, pair) {
    try {
      let parsed = data;

      if (typeof data === 'string') {
        try { parsed = JSON.parse(data); } catch (_) { return []; }
      }

      // Handle various response formats
      let candleArray = null;

      if (Array.isArray(parsed)) {
        candleArray = parsed;
      } else if (parsed.data && Array.isArray(parsed.data)) {
        candleArray = parsed.data;
      } else if (parsed.candles && Array.isArray(parsed.candles)) {
        candleArray = parsed.candles;
      } else if (parsed.result && Array.isArray(parsed.result)) {
        candleArray = parsed.result;
      } else if (parsed.history && Array.isArray(parsed.history)) {
        candleArray = parsed.history;
      }

      if (!candleArray) return [];

      return candleArray.map(c => {
        // Normalize candle format
        if (Array.isArray(c)) {
          // [time, open, high, low, close, volume]
          return {
            id: `${pair}_${c[0]}`,
            pair,
            time: c[0],
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5] || 0),
          };
        }
        // Object format
        return {
          id: `${pair}_${c.time || c.t || c.timestamp || c.id || 0}`,
          pair,
          time: c.time || c.t || c.timestamp || c.id || 0,
          open: parseFloat(c.open || c.o || 0),
          high: parseFloat(c.high || c.h || 0),
          low: parseFloat(c.low || c.l || 0),
          close: parseFloat(c.close || c.c || 0),
          volume: parseFloat(c.volume || c.v || 0),
        };
      }).filter(c => c.time > 0 && c.open > 0);

    } catch (e) {
      return [];
    }
  }

  // ── Fetch candles from a discovered endpoint ───────────────────────
  async function fetchFromEndpoint(endpoint, pair, fromTime, toTime) {
    try {
      let url = endpoint.url;

      // Try to add pair and time range parameters
      if (url.includes('?')) {
        url += `&pair=${encodeURIComponent(pair)}`;
      } else {
        url += `?pair=${encodeURIComponent(pair)}`;
      }

      if (fromTime) url += `&from=${Math.floor(fromTime)}`;
      if (toTime) url += `&to=${Math.floor(toTime)}`;

      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) return [];

      const data = await response.text();
      return parseCandlesFromResponse(data, pair);
    } catch (e) {
      return [];
    }
  }

  // ── Load history for a single pair using all discovered endpoints ──
  async function loadPairHistory(pair) {
    const days = MF.getConfig('candleHistoryDays') || 30;
    const toTime = Date.now() / 1000;
    const fromTime = toTime - (days * 86400);
    const maxPerPair = MF.getConfig('candleMaxPerPair') || 43200;

    // Check if we already have enough data
    const existingCount = await CandleStore.getCandleCount(pair);
    if (existingCount >= maxPerPair * 0.9) {
      MF.log('info', `HistoricalLoader: ${pair} already has ${existingCount} candles, skipping`);
      return existingCount;
    }

    let allCandles = [];

    // Try each discovered endpoint
    for (const endpoint of Object.values(_discoveredEndpoints)) {
      const candles = await fetchFromEndpoint(endpoint, pair, fromTime, toTime);
      if (candles.length > 0) {
        allCandles = allCandles.concat(candles);
      }
    }

    // Also try known platform-specific endpoints
    const knownUrls = [
      `https://market-qx.trade/api/candles?pair=${encodeURIComponent(pair)}&from=${Math.floor(fromTime)}&to=${Math.floor(toTime)}`,
      `https://market-qx.trade/api/quote/${encodeURIComponent(pair)}/candles?from=${Math.floor(fromTime)}&to=${Math.floor(toTime)}`,
      `https://market-qx.trade/api/history?pair=${encodeURIComponent(pair)}&period=60&from=${Math.floor(fromTime)}&to=${Math.floor(toTime)}`,
    ];

    for (const url of knownUrls) {
      try {
        const response = await fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        if (response.ok) {
          const data = await response.text();
          const candles = parseCandlesFromResponse(data, pair);
          if (candles.length > 0) {
            allCandles = allCandles.concat(candles);
          }
        }
      } catch (_) {
        // Continue to next URL
      }
    }

    // Deduplicate by time
    if (allCandles.length > 0) {
      const seen = new Set();
      allCandles = allCandles.filter(c => {
        const key = `${c.pair}_${c.time}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Sort by time
      allCandles.sort((a, b) => a.time - b.time);

      // Store
      await CandleStore.putCandles(allCandles);

      // Cleanup old candles
      const maxAge = days * 86400;
      await CandleStore.cleanupOldCandles(pair, maxAge);

      MF.log('info', `HistoricalLoader: Stored ${allCandles.length} candles for ${pair}`);
    }

    return allCandles.length;
  }

  // ── Load history for all pairs ─────────────────────────────────────
  async function loadAllPairs(pairs) {
    if (_loading) return _progress;
    _loading = true;

    const pairNames = Object.keys(pairs || MF.state.allPairs);
    _progress = { loaded: 0, total: pairNames.length, currentPair: '' };

    MF.log('info', `HistoricalLoader: Starting history load for ${pairNames.length} pairs`);
    MF.bus.emit('history:load:start', _progress);

    for (const pair of pairNames) {
      _progress.currentPair = pair;
      MF.bus.emit('history:load:progress', _progress);

      try {
        await loadPairHistory(pair);
      } catch (e) {
        MF.log('warn', `HistoricalLoader: Failed for ${pair}:`, e.message);
      }

      _progress.loaded++;

      // Rate limit — don't hammer the server
      await MF.sleep(500);
    }

    _loading = false;
    _progress.currentPair = '';
    MF.bus.emit('history:load:complete', _progress);
    MF.log('info', 'HistoricalLoader: History load complete');

    return _progress;
  }

  // ── Auto-load: triggered after scanner discovers pairs ──────────────
  function enableAutoLoad() {
    MF.bus.on('pairs:discovered', async (pairs) => {
      if (!_loading && Object.keys(pairs).length > 0) {
        MF.log('info', 'HistoricalLoader: Auto-load triggered');
        await MF.sleep(5000); // Wait for page to stabilize
        await loadAllPairs(pairs);
      }
    });

    // Also listen for XHR events to discover endpoints
    MF.bus.on('ws:xhr', (event) => {
      discoverFromXHR(event);
    });
  }

  // ── Get loading progress ───────────────────────────────────────────
  function getProgress() {
    return { ..._progress };
  }

  function isLoading() {
    return _loading;
  }

  // ── Public API ─────────────────────────────────────────────────────
  return {
    loadPairHistory,
    loadAllPairs,
    enableAutoLoad,
    discoverFromXHR,
    parseCandlesFromResponse,
    getProgress,
    isLoading,
  };
})();
