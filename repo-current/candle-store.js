/**
 * candle-store.js  —  IndexedDB-backed candle storage for MindFlareClaw Agent v2.0
 *
 * Provides unlimited historical candle storage per pair, bypassing
 * chrome.storage's 5 MB limit. Uses IndexedDB with a compound key
 * [code, t] for efficient per-pair range queries.
 *
 * Storage format:  { code, t, o, h, l, c, v }
 * Input  format:   { pair, time, open, high, low, close, volume }
 *
 * Global namespace: CandleStore  (IIFE — independent of MF but
 *                   optionally integrates via MF.state.candles)
 */

const CandleStore = (() => {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────
  const DB_NAME    = 'MindFlareClawDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'candles';

  // ── Internal references ───────────────────────────────────────────
  let _db = null; // cached IDBDatabase instance

  // ── Helpers ───────────────────────────────────────────────────────

  /** Normalize a candle from the public input format to the compact
   *  storage format used inside IndexedDB. */
  function _toRecord(candle) {
    return {
      code: candle.pair,  // pair code (already normalized by caller or raw pair string)
      t:    candle.time,  // unix timestamp (seconds or ms depending on source)
      o:    candle.open,
      h:    candle.high,
      l:    candle.low,
      c:    candle.close,
      v:    candle.volume,
    };
  }

  /** Expand a compact DB record back to the full candle shape. */
  function _fromRecord(rec) {
    return {
      pair:   rec.code,
      time:   rec.t,
      open:   rec.o,
      high:   rec.h,
      low:    rec.l,
      close:  rec.c,
      volume: rec.v,
    };
  }

  /** Safe logger — uses MF.log when available, falls back to console. */
  function _log(level, ...args) {
    if (typeof MF !== 'undefined' && MF.log) {
      MF.log(level, '[CandleStore]', ...args);
    } else {
      const fn = level === 'error' ? console.error
               : level === 'warn'  ? console.warn
               : level === 'info'  ? console.info
               :                      console.log;
      fn('[CandleStore]', ...args);
    }
  }

  // ── Database lifecycle ────────────────────────────────────────────

  /**
   * Open (or return cached) IDBDatabase connection.
   * Creates the 'candles' object store on first run (version 1).
   *
   * @returns {Promise<IDBDatabase>}
   */
  function openDB() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create object store with compound key [code, t]
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: ['code', 't'],
          });

          // Index on 'code' for fast per-pair queries
          store.createIndex('code', 'code', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        _db = event.target.result;

        // Handle unexpected connection closures
        _db.onclose = () => {
          _log('warn', 'Database connection closed unexpectedly');
          _db = null;
        };

        _db.onerror = (err) => {
          _log('error', 'Database error:', err);
        };

        resolve(_db);
      };

      request.onerror = (event) => {
        _log('error', 'Failed to open database:', event.target.error);
        reject(event.target.error);
      };

      request.onblocked = () => {
        _log('warn', 'Database upgrade blocked — close other tabs');
      };
    });
  }

  // ── Write operations ──────────────────────────────────────────────

  /**
   * Store a single candle.
   *
   * @param {Object} candle — { pair, time, open, high, low, close, volume }
   * @returns {Promise<void>}
   */
  async function putCandle(candle) {
    try {
      const db   = await openDB();
      const rec  = _toRecord(candle);

      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(rec);

        tx.oncomplete = () => resolve();
        tx.onerror    = () => {
          _log('error', 'putCandle transaction error:', tx.error);
          reject(tx.error);
        };
      });
    } catch (e) {
      _log('error', 'putCandle failed:', e);
      throw e;
    }
  }

  /**
   * Bulk store an array of candles.
   * Uses a single readwrite transaction for efficiency.
   *
   * @param {Object[]} candles — array of { pair, time, open, high, low, close, volume }
   * @returns {Promise<number>} — number of candles stored
   */
  async function putCandles(candles) {
    if (!candles || !candles.length) return 0;

    try {
      const db = await openDB();

      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        let count = 0;
        for (const candle of candles) {
          const rec = _toRecord(candle);
          store.put(rec);
          count++;
        }

        tx.oncomplete = () => {
          _log('debug', `putCandles: stored ${count} candles`);
          resolve(count);
        };

        tx.onerror = () => {
          _log('error', 'putCandles transaction error:', tx.error);
          reject(tx.error);
        };
      });
    } catch (e) {
      _log('error', 'putCandles failed:', e);
      throw e;
    }
  }

  // ── Read operations ───────────────────────────────────────────────

  /**
   * Load the most recent `limit` candles for a pair, returned in
   * chronological (ascending) order.
   *
   * Uses the 'code' index to open a cursor, iterates backwards from
   * the end, collects up to `limit` records, then reverses.
   *
   * @param {string} pairCode — normalized pair code (e.g. "EURUSD")
   * @param {number} [limit=5000] — max candles to return
   * @returns {Promise<Object[]>} — candles in { pair, time, open, … } format
   */
  async function getCandles(pairCode, limit = 5000) {
    try {
      const db = await openDB();

      return new Promise((resolve, reject) => {
        const tx       = db.transaction(STORE_NAME, 'readonly');
        const store    = tx.objectStore(STORE_NAME);
        const index    = store.index('code');
        const keyRange = IDBKeyRange.only(pairCode);

        const results = [];

        // Open a reverse cursor to get the most recent first
        const request = index.openCursor(keyRange, 'prev');

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor && results.length < limit) {
            results.push(_fromRecord(cursor.value));
            cursor.continue();
          }
          // else: cursor exhausted or limit reached — wait for tx.oncomplete
        };

        tx.oncomplete = () => {
          // results are newest-first; reverse to chronological order
          results.reverse();
          resolve(results);
        };

        tx.onerror = () => {
          _log('error', 'getCandles transaction error:', tx.error);
          reject(tx.error);
        };
      });
    } catch (e) {
      _log('error', 'getCandles failed:', e);
      throw e;
    }
  }

  /**
   * Get candles for a pair within a time range [fromTime, toTime]
   * (inclusive on both ends), in chronological order.
   *
   * Uses the compound key index with a bounded key range:
   *   [pairCode, fromTime] … [pairCode, toTime]
   *
   * @param {string} pairCode
   * @param {number} fromTime — start timestamp (inclusive)
   * @param {number} toTime   — end timestamp (inclusive)
   * @returns {Promise<Object[]>}
   */
  async function getCandleRange(pairCode, fromTime, toTime) {
    try {
      const db = await openDB();

      return new Promise((resolve, reject) => {
        const tx       = db.transaction(STORE_NAME, 'readonly');
        const store    = tx.objectStore(STORE_NAME);

        // Compound key range: [code, t] bounds
        const keyRange = IDBKeyRange.bound(
          [pairCode, fromTime],
          [pairCode, toTime]
        );

        const results = [];
        const request = store.openCursor(keyRange, 'next');

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            results.push(_fromRecord(cursor.value));
            cursor.continue();
          }
        };

        tx.oncomplete = () => resolve(results);

        tx.onerror = () => {
          _log('error', 'getCandleRange transaction error:', tx.error);
          reject(tx.error);
        };
      });
    } catch (e) {
      _log('error', 'getCandleRange failed:', e);
      throw e;
    }
  }

  /**
   * Count the total number of candles stored for a pair.
   *
   * @param {string} pairCode
   * @returns {Promise<number>}
   */
  async function countCandles(pairCode) {
    try {
      const db = await openDB();

      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('code');

        const request = index.count(IDBKeyRange.only(pairCode));

        request.onsuccess = () => resolve(request.result);

        tx.onerror = () => {
          _log('error', 'countCandles transaction error:', tx.error);
          reject(tx.error);
        };
      });
    } catch (e) {
      _log('error', 'countCandles failed:', e);
      throw e;
    }
  }

  /**
   * Get the timestamp of the oldest candle for a pair.
   *
   * @param {string} pairCode
   * @returns {Promise<number|null>} — timestamp or null if no candles exist
   */
  async function getOldestTime(pairCode) {
    try {
      const db = await openDB();

      return new Promise((resolve, reject) => {
        const tx       = db.transaction(STORE_NAME, 'readonly');
        const store    = tx.objectStore(STORE_NAME);
        const index    = store.index('code');
        const keyRange = IDBKeyRange.only(pairCode);

        // Open a forward cursor; first match is the oldest
        const request = index.openCursor(keyRange, 'next');

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            resolve(cursor.value.t);
          } else {
            resolve(null); // no candles for this pair
          }
        };

        tx.onerror = () => {
          _log('error', 'getOldestTime transaction error:', tx.error);
          reject(tx.error);
        };
      });
    } catch (e) {
      _log('error', 'getOldestTime failed:', e);
      throw e;
    }
  }

  /**
   * Get the timestamp of the latest (most recent) candle for a pair.
   *
   * @param {string} pairCode
   * @returns {Promise<number|null>} — timestamp or null if no candles exist
   */
  async function getLatestTime(pairCode) {
    try {
      const db = await openDB();

      return new Promise((resolve, reject) => {
        const tx       = db.transaction(STORE_NAME, 'readonly');
        const store    = tx.objectStore(STORE_NAME);
        const index    = store.index('code');
        const keyRange = IDBKeyRange.only(pairCode);

        // Open a reverse cursor; first match is the newest
        const request = index.openCursor(keyRange, 'prev');

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            resolve(cursor.value.t);
          } else {
            resolve(null); // no candles for this pair
          }
        };

        tx.onerror = () => {
          _log('error', 'getLatestTime transaction error:', tx.error);
          reject(tx.error);
        };
      });
    } catch (e) {
      _log('error', 'getLatestTime failed:', e);
      throw e;
    }
  }

  /**
   * Get candle counts for ALL pairs stored in the database.
   * Walks the 'code' index with a cursor, tallying per-code counts.
   *
   * @returns {Promise<Object>} — { pairCode: count, … }
   */
  async function getAllPairCounts() {
    try {
      const db = await openDB();

      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('code');

        const counts = {};
        const request = index.openCursor(null, 'next');

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            const code = cursor.value.code;
            counts[code] = (counts[code] || 0) + 1;
            cursor.continue();
          }
        };

        tx.oncomplete = () => resolve(counts);

        tx.onerror = () => {
          _log('error', 'getAllPairCounts transaction error:', tx.error);
          reject(tx.error);
        };
      });
    } catch (e) {
      _log('error', 'getAllPairCounts failed:', e);
      throw e;
    }
  }

  // ── Memory sync ───────────────────────────────────────────────────

  /**
   * Sync the most recent `limit` candles from IndexedDB into the
   * in-memory MF.state.candles[pairCode] array.
   *
   * This bridges the persistent store with the fast-access runtime
   * state used by analysis engines and the signal pipeline.
   *
   * @param {string} pairCode
   * @param {number} [limit=5000]
   * @returns {Promise<Object[]>} — the candles that were synced
   */
  async function syncToMemory(pairCode, limit = 5000) {
    try {
      const candles = await getCandles(pairCode, limit);

      // Only write to MF.state if the global namespace is available
      if (typeof MF !== 'undefined' && MF.state && MF.state.candles) {
        MF.state.candles[pairCode] = candles;
        _log('debug', `syncToMemory: ${pairCode} → ${candles.length} candles`);

        // Notify listeners that candles have been loaded
        if (MF.bus) {
          MF.bus.emit('candles:synced', pairCode, candles.length);
        }
      }

      return candles;
    } catch (e) {
      _log('error', 'syncToMemory failed:', e);
      throw e;
    }
  }

  // ── Housekeeping ──────────────────────────────────────────────────

  /**
   * Close the database connection (useful for clean shutdown or tests).
   */
  function close() {
    if (_db) {
      _db.close();
      _db = null;
      _log('debug', 'Database connection closed');
    }
  }

  /**
   * Delete ALL data in the candles store.  Destructive — use with care.
   *
   * @returns {Promise<void>}
   */
  async function clear() {
    try {
      const db = await openDB();

      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.clear();

        tx.oncomplete = () => {
          _log('info', 'Candle store cleared');
          resolve();
        };

        tx.onerror = () => {
          _log('error', 'clear transaction error:', tx.error);
          reject(tx.error);
        };
      });
    } catch (e) {
      _log('error', 'clear failed:', e);
      throw e;
    }
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    openDB,
    putCandle,
    putCandles,
    getCandles,
    getCandleRange,
    countCandles,
    getOldestTime,
    getLatestTime,
    getAllPairCounts,
    syncToMemory,
    close,
    clear,
  };
})();
