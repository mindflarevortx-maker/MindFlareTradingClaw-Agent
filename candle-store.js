/**
 * candle-store.js  —  IndexedDB Candle History Storage
 *
 * Stores candlestick data per pair for instant access.
 * Supports range queries, auto-cleanup, and bulk import.
 *
 * v1.2-beta1 FIX: Proper IndexedDB initialization with error recovery,
 * automatic old-candle cleanup, and robust persistence.
 */

const CandleStore = (() => {
  'use strict';

  const DB_NAME = 'MindFlareCandles';
  const DB_VERSION = 2;
  const STORE_NAME = 'candles';
  const META_STORE = 'meta';

  let db = null;
  let _ready = false;
  let _initPromise = null;

  // ── Initialize IndexedDB ───────────────────────────────────────────
  function init() {
    if (_initPromise) return _initPromise;

    _initPromise = new Promise((resolve, reject) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const database = event.target.result;

          // Main candle store — index on pair+time for range queries
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('pair_time', ['pair', 'time'], { unique: true });
            store.createIndex('pair', 'pair', { unique: false });
            store.createIndex('time', 'time', { unique: false });
          } else {
            // Ensure indexes exist on upgrade
            const store = event.target.transaction.objectStore(STORE_NAME);
            if (!store.indexNames.contains('pair_time')) {
              store.createIndex('pair_time', ['pair', 'time'], { unique: true });
            }
            if (!store.indexNames.contains('pair')) {
              store.createIndex('pair', 'pair', { unique: false });
            }
            if (!store.indexNames.contains('time')) {
              store.createIndex('time', 'time', { unique: false });
            }
          }

          // Meta store — track last update time, candle count per pair
          if (!database.objectStoreNames.contains(META_STORE)) {
            database.createObjectStore(META_STORE, { keyPath: 'pair' });
          }
        };

        request.onsuccess = (event) => {
          db = event.target.result;
          _ready = true;
          MF.log('info', 'CandleStore: IndexedDB ready');
          resolve(true);
        };

        request.onerror = (event) => {
          MF.log('error', 'CandleStore: IndexedDB open failed:', event.target.error);
          resolve(false); // Don't reject — allow extension to work without DB
        };

        request.onblocked = () => {
          MF.log('warn', 'CandleStore: IndexedDB blocked by another connection');
          resolve(false);
        };
      } catch (e) {
        MF.log('error', 'CandleStore: Init exception:', e.message);
        resolve(false);
      }
    });

    return _initPromise;
  }

  // ── Helper: get transaction & store ────────────────────────────────
  function getStore(mode) {
    if (!db) throw new Error('CandleStore not initialized');
    const tx = db.transaction([STORE_NAME], mode);
    return tx.objectStore(STORE_NAME);
  }

  function getMetaStore(mode) {
    if (!db) throw new Error('CandleStore not initialized');
    const tx = db.transaction([META_STORE], mode);
    return tx.objectStore(META_STORE);
  }

  // ── Store a single candle ──────────────────────────────────────────
  async function putCandle(candle) {
    if (!db) return false;
    try {
      // candle = { id, pair, time, open, high, low, close, volume }
      if (!candle.id) {
        candle.id = `${candle.pair}_${candle.time}`;
      }
      const store = getStore('readwrite');
      return new Promise((resolve) => {
        const req = store.put(candle);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    } catch (e) {
      MF.log('warn', 'CandleStore putCandle error:', e.message);
      return false;
    }
  }

  // ── Store multiple candles (bulk) ──────────────────────────────────
  async function putCandles(candles) {
    if (!db || !candles || !candles.length) return 0;
    try {
      let count = 0;
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      for (const candle of candles) {
        if (!candle.id) {
          candle.id = `${candle.pair}_${candle.time}`;
        }
        store.put(candle);
        count++;
      }

      return new Promise((resolve) => {
        tx.oncomplete = () => {
          // Update meta
          if (candles.length > 0) {
            updateMeta(candles[0].pair);
          }
          resolve(count);
        };
        tx.onerror = () => resolve(0);
      });
    } catch (e) {
      MF.log('warn', 'CandleStore putCandles error:', e.message);
      return 0;
    }
  }

  // ── Get candles for a pair within a time range ─────────────────────
  async function getCandles(pair, fromTime, toTime) {
    if (!db) return [];
    try {
      const store = getStore('readonly');
      const index = store.index('pair_time');
      const range = IDBKeyRange.bound(
        [pair, fromTime || 0],
        [pair, toTime || Date.now() / 1000]
      );

      return new Promise((resolve) => {
        const req = index.getAll(range);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (e) {
      MF.log('warn', 'CandleStore getCandles error:', e.message);
      return [];
    }
  }

  // ── Get latest N candles for a pair ────────────────────────────────
  async function getLatestCandles(pair, count = 200) {
    if (!db) return [];
    try {
      const store = getStore('readonly');
      const index = store.index('pair');
      const range = IDBKeyRange.only(pair);

      return new Promise((resolve) => {
        const req = index.openCursor(range, 'prev');
        const results = [];

        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor && results.length < count) {
            results.push(cursor.value);
            cursor.continue();
          } else {
            // Return in chronological order
            results.reverse();
            resolve(results);
          }
        };
        req.onerror = () => resolve([]);
      });
    } catch (e) {
      MF.log('warn', 'CandleStore getLatestCandles error:', e.message);
      return [];
    }
  }

  // ── Get all stored pairs ───────────────────────────────────────────
  async function getAllPairs() {
    if (!db) return [];
    try {
      const store = getMetaStore('readonly');
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  // ── Get candle count for a pair ────────────────────────────────────
  async function getCandleCount(pair) {
    if (!db) return 0;
    try {
      const store = getMetaStore('readonly');
      return new Promise((resolve) => {
        const req = store.get(pair);
        req.onsuccess = () => resolve(req.result?.count || 0);
        req.onerror = () => resolve(0);
      });
    } catch (e) {
      return 0;
    }
  }

  // ── Update meta info for a pair ────────────────────────────────────
  async function updateMeta(pair) {
    if (!db) return;
    try {
      // Count candles for this pair
      const store = getStore('readonly');
      const index = store.index('pair');
      const range = IDBKeyRange.only(pair);

      return new Promise((resolve) => {
        const req = index.count(range);
        req.onsuccess = async () => {
          const count = req.result;
          const metaStore = getMetaStore('readwrite');
          metaStore.put({
            pair,
            count,
            lastUpdated: Date.now()
          });
          resolve();
        };
        req.onerror = () => resolve();
      });
    } catch (e) {
      // Silent
    }
  }

  // ── Cleanup old candles beyond retention period ────────────────────
  async function cleanupOldCandles(pair, maxAgeSeconds) {
    if (!db) return 0;
    try {
      const cutoffTime = (Date.now() / 1000) - maxAgeSeconds;
      const store = getStore('readwrite');
      const index = store.index('pair_time');
      const range = IDBKeyRange.bound(
        [pair, 0],
        [pair, cutoffTime]
      );

      return new Promise((resolve) => {
        let deleted = 0;
        const req = index.openCursor(range);

        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            if (deleted > 0) updateMeta(pair);
            resolve(deleted);
          }
        };
        req.onerror = () => resolve(0);
      });
    } catch (e) {
      return 0;
    }
  }

  // ── Delete all candles for a pair ──────────────────────────────────
  async function deletePair(pair) {
    if (!db) return 0;
    try {
      const store = getStore('readwrite');
      const index = store.index('pair');
      const range = IDBKeyRange.only(pair);

      return new Promise((resolve) => {
        let deleted = 0;
        const req = index.openCursor(range);

        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            // Remove meta
            try {
              const metaStore = getMetaStore('readwrite');
              metaStore.delete(pair);
            } catch (_) {}
            resolve(deleted);
          }
        };
        req.onerror = () => resolve(0);
      });
    } catch (e) {
      return 0;
    }
  }

  // ── Export all data (for backup) ───────────────────────────────────
  async function exportAll() {
    if (!db) return {};
    try {
      const store = getStore('readonly');
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const all = req.result || [];
          const byPair = {};
          for (const c of all) {
            if (!byPair[c.pair]) byPair[c.pair] = [];
            byPair[c.pair].push(c);
          }
          resolve(byPair);
        };
        req.onerror = () => resolve({});
      });
    } catch (e) {
      return {};
    }
  }

  // ── Import data (from backup or historical loader) ─────────────────
  async function importData(dataByPair) {
    if (!db || !dataByPair) return 0;
    let total = 0;
    for (const [pair, candles] of Object.entries(dataByPair)) {
      const count = await putCandles(candles);
      total += count;
    }
    return total;
  }

  // ── Clear everything ───────────────────────────────────────────────
  async function clearAll() {
    if (!db) return;
    try {
      const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.objectStore(META_STORE).clear();
    } catch (e) {
      MF.log('warn', 'CandleStore clearAll error:', e.message);
    }
  }

  // ── Check if ready ─────────────────────────────────────────────────
  function isReady() {
    return _ready;
  }

  // ── Public API ─────────────────────────────────────────────────────
  return {
    init,
    putCandle,
    putCandles,
    getCandles,
    getLatestCandles,
    getAllPairs,
    getCandleCount,
    cleanupOldCandles,
    deletePair,
    exportAll,
    importData,
    clearAll,
    isReady,
  };
})();
