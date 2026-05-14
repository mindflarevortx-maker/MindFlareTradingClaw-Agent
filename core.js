/**
 * core.js  —  Config, State, Event Bus, Persistence
 *
 * Central nervous system of MindFlare TradingClaw.
 * All modules read config from here and emit events through the bus.
 */

const MF = (() => {
  'use strict';

  // ── Version ────────────────────────────────────────────────────────
  const VERSION = '1.4.0';

  // ── Default Configuration ──────────────────────────────────────────
  const DEFAULTS = {
    // Trading
    autoPilot: false,
    martingaleEnabled: true,
    martingaleSteps: 3,
    martingaleMultiplier: 2.0,
    baseInvestment: 1,
    maxInvestment: 100,
    tradeDuration: 60,          // seconds
    minPayout: 70,              // minimum payout % to consider

    // Scanner
    scanInterval: 2000,         // ms between DOM polls
    wsEnabled: true,            // use WebSocket interception
    domPollFallback: true,      // fall back to DOM polling if WS fails

    // Technical Analysis
    rsiPeriod: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bollingerPeriod: 20,
    bollingerStdDev: 2,
    emaPeriods: [9, 21, 50, 200],
    atrPeriod: 14,
    stochasticK: 14,
    stochasticD: 3,

    // Candle Store
    candleHistoryDays: 30,      // days of history to store per pair
    candleMaxPerPair: 43200,    // ~30 days of 1-min candles

    // LLM
    llmProvider: 'ollama',
    llmModel: 'llama3',
    ollamaBaseUrl: 'http://localhost:11434',
    openrouterKey: '',
    groqKey: '',
    togetherKey: '',
    deepinfraKey: '',
    mistralKey: '',
    openaiKey: '',
    anthropicKey: '',
    cohereKey: '',
    fireworksKey: '',
    perplexityKey: '',
    customEndpoint: '',
    customKey: '',
    llmTemperature: 0.3,
    llmMaxTokens: 2048,

    // Self-Improvement
    learningEnabled: true,
    maxTradeHistory: 5000,

    // UI
    overlayVisible: true,
    overlayPosition: { x: 20, y: 80 },
    overlaySize: { w: 380, h: 520 },
    overlayMinimized: false,
    overlayOpacity: 0.95,
    activeTab: 'scanner',

    // Debug
    debugMode: false,
    logLevel: 'warn',           // debug | info | warn | error
  };

  // ── Runtime State ──────────────────────────────────────────────────
  const state = {
    // Connection
    wsConnected: false,
    wsUrl: null,
    hookReady: false,

    // Pairs
    activePair: null,
    activePairPayout: 0,
    allPairs: {},               // { pairName: { payout, active, lastTick } }
    highPayoutPairs: [],        // pairs above minPayout threshold

    // Candles
    currentCandle: null,        // building candle from ticks
    candles: {},                // { pairName: [candle, ...] }

    // Trading
    isTrading: false,
    currentTrade: null,
    tradeHistory: [],
    martingaleStep: 0,
    currentInvestment: DEFAULTS.baseInvestment,

    // Analysis
    signals: [],
    lastAnalysis: null,

    // Backtest
    backtestRunning: false,
    backtestResults: null,

    // Agent
    agentBusy: false,
    chatMessages: [],

    // DOM
    domReady: false,
    tradeSidebar: null,

    // Errors
    errors: [],
  };

  // ── Event Bus ──────────────────────────────────────────────────────
  const _listeners = {};

  const bus = {
    on(event, fn) {
      if (!_listeners[event]) _listeners[event] = [];
      _listeners[event].push(fn);
      return () => {
        _listeners[event] = _listeners[event].filter(f => f !== fn);
      };
    },

    once(event, fn) {
      const wrapper = (...args) => {
        bus.off(event, wrapper);
        fn(...args);
      };
      bus.on(event, wrapper);
    },

    off(event, fn) {
      if (_listeners[event]) {
        _listeners[event] = _listeners[event].filter(f => f !== fn);
      }
    },

    emit(event, ...args) {
      if (_listeners[event]) {
        for (const fn of _listeners[event]) {
          try { fn(...args); } catch (e) {
            log('error', `Event handler error [${event}]:`, e);
          }
        }
      }
    },
  };

  // ── Logger ─────────────────────────────────────────────────────────
  function log(level, ...args) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const configLevel = levels[config.logLevel] ?? 2;
    const msgLevel = levels[level] ?? 2;
    if (msgLevel < configLevel && level !== 'error') return;

    const prefix = `[MindFlare v${VERSION}]`;
    const fn = level === 'error' ? console.error
             : level === 'warn'  ? console.warn
             : level === 'info'  ? console.info
             :                      console.log;

    fn(prefix, ...args);
  }

  // ── Config (with persistence) ──────────────────────────────────────
  let config = { ...DEFAULTS };

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get('mf_config');
      if (stored.mf_config) {
        config = { ...DEFAULTS, ...stored.mf_config };
      }
    } catch (e) {
      log('warn', 'Failed to load config:', e.message);
    }
  }

  async function saveConfig() {
    try {
      await chrome.storage.local.set({ mf_config: config });
    } catch (e) {
      log('warn', 'Failed to save config:', e.message);
    }
  }

  function setConfig(key, value) {
    config[key] = value;
    saveConfig();
    bus.emit('config:change', key, value);
  }

  function getConfig(key) {
    return config[key] ?? DEFAULTS[key];
  }

  // ── State Persistence ──────────────────────────────────────────────
  async function saveState() {
    try {
      const serializable = { ...state };
      // Remove non-serializable fields
      delete serializable.tradeSidebar;
      delete serializable.domReady;
      await chrome.storage.local.set({ mf_state: serializable });
    } catch (e) {
      log('warn', 'Failed to save state:', e.message);
    }
  }

  async function loadState() {
    try {
      const stored = await chrome.storage.local.get('mf_state');
      if (stored.mf_state) {
        Object.assign(state, stored.mf_state);
        // Reset runtime-only state
        state.wsConnected = false;
        state.hookReady = false;
        state.isTrading = false;
        state.agentBusy = false;
        state.domReady = false;
        state.tradeSidebar = null;
      }
    } catch (e) {
      log('warn', 'Failed to load state:', e.message);
    }
  }

  // ── Utility Functions ──────────────────────────────────────────────
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function pctChange(oldVal, newVal) {
    if (!oldVal) return 0;
    return ((newVal - oldVal) / oldVal) * 100;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Public API ─────────────────────────────────────────────────────
  return {
    VERSION,
    DEFAULTS,
    config,
    state,
    bus,
    log,
    loadConfig,
    saveConfig,
    setConfig,
    getConfig,
    saveState,
    loadState,
    uid,
    clamp,
    pctChange,
    sleep,
  };
})();
