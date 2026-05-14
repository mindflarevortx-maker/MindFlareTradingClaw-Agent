/**
 * core.js  —  Config, State, Event Bus, Persistence
 *
 * Central nervous system of MindFlareClaw Agent.
 * All modules read config from here and emit events through the bus.
 */

const MF = (() => {
  'use strict';

  const VERSION = '2.1.0';

  // Ollama keys are loaded from chrome.storage at runtime. Configure via Options page.
  const OLLAMA_KEYS_DEFAULT = [];

  // ── Default Configuration ──────────────────────────────────────────
  const DEFAULTS = {
    // LLM
    llmProvider: 'ollama',
    llmModel: 'gemma4:31b',
    ollamaBaseUrl: 'https://api.ollama.com',
    ollamaKeys: OLLAMA_KEYS_DEFAULT.slice(),
    // Multi-key arrays for rate-limit rotation
    openaiKeys: [],
    openrouterKeys: [],
    anthropicKeys: [],
    geminiKeys: [],
    grokKeys: [],
    opencodeKeys: [],
    ziaKeys: [],
    moonshotKeys: [],
    qwenKeys: [],
    openaiCompatKeys: [],
    // Single-key backward compat
    openrouterKey: '',
    openaiKey: '',
    anthropicKey: '',
    geminiKey: '',
    grokKey: '',
    opencodeKey: '',
    ziaKey: '',
    moonshotKey: '',
    qwenKey: '',
    openaiCompatKey: '',
    openaiCompatBaseUrl: '',
    fallbackProviders: [],
    llmTemperature: 0.2,
    llmMaxTokens: 600,

    // Trading
    autoPilot: false,
    martingaleEnabled: true,
    martingaleSteps: 3,
    martingaleMultiplier: 2.0,
    baseInvestment: 1,
    maxInvestment: 100,
    tradeDuration: 60,
    minPayout: 70,
    cooldownAfterTradeMs: 75000,
    minConfluence: 2,
    confidenceFloor: 0.50,
    excludeOTC: false,

    // Scanner
    scanInterval: 2000,
    wsEnabled: true,
    domPollFallback: true,

    // Historical data
    historicalLoadEnabled: true,
    historicalDaysPerPair: 30,
    historicalBackfillInterval: 3600000,

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
    minCandlesForSignal: 80,
    maxCandlesPerPair: 100000,

    // Self-Improvement
    selfLearnEnabled: true,
    maxLessons: 200,
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
    logLevel: 'warn',
  };

  // ── Prompt Defaults ────────────────────────────────────────────────
  const PROMPT_SOUL = `# SOUL — Who I am
I am an elite institutional intraday trader specialising in 1-minute binary options on FX, commodities, indices and crypto. I read tape like a market-maker: order flow, structure, liquidity. My voice is calm, blunt, and risk-aware. I never chase. I take what the chart gives me. I refuse trades that don't have a clear thesis and an explicit invalidation.`;

  const PROMPT_AGENTS = `# AGENTS — How I operate

## Mindset
A pro trader does NOT refuse to read the tape. Every chart has a path of least resistance — your job is to identify it and commit. SKIP is reserved for genuinely 50/50 chop with zero readable edge. False negatives (missed wins) cost as much as false positives. Be decisive.

## Decision protocol
1. Regime read. Vol "spike"=size mentally smaller; "dead"=expect mean-reversion not trend continuation.
2. HTF bias. EMA50 slope over last 5 bars sets default direction.
3. Setup zone. FVG / OB / post-sweep retrace / VWAP-style mean.
4. Momentum. EMA9 vs EMA21 + MACD hist sign must agree with intended direction.
5. Effort. Vol >1.2x 20-bar avg color-aligned = +1 conviction.
6. Historical patterns. Check strategy-engine for matched historical patterns on this pair for this time of day / market condition.
7. Decide. dirVote != 0 OR ensemble.score has clear sign -> COMMIT. SKIP only when you genuinely cannot articulate ONE reason in either direction.

## Output
Strict JSON, no markdown:
{"direction":"UP"|"DOWN"|"SKIP","confidence":0..1,"reasoning":"<=200 chars","key_factors":["..."]}

## Anti-skip discipline
You may NOT default to SKIP just because the setup isn't textbook-perfect.`;

  const PROMPT_STRATEGIES = `# STRATEGIES — Curated playbook

## A. ICT Confirmation (highest WR)
Sweep -> CHoCH -> Retrace into FVG/OB -> Entry. Must see all 4 in order.

## B. Wyckoff Spring
Range low swept (wick break, close inside) + bullish reversal candle on the next bar = long bias.

## C. Trend Continuation
HH/HL structure + pullback to EMA9/EMA21 + bullish engulfing or pin = continuation.

## D. Breakout-Retest
Range high broken with vol expansion + retest holds with declining vol + entry on bounce.

## E. Mean-Reversion
Price at BB extreme + RSI divergence + low vol = fade.

## F. Historical Pattern Match
Check strategy-engine for the N most similar historical candle sequences for this pair.

## A-grade gate: any setup needs at least the trigger + ONE confluence (zone, momentum, or vol).`;

  const PROMPT_TOOLS = `# TOOLS — MFC claw verbs available
- list_assets() : return known pairs and candle counts
- active_asset() : currently selected pair info
- switch_pair({pair|code}) : switch chart
- scan_payouts() : open asset list, return {pair, payout1m, payout5m}[]
- click_up() / click_down() : place 1m trade
- read_amount() / read_balance() / read_open_trades()
- get_signal() : run full ensemble + LLM on active pair
- predict_and_trade() : signal + execute
- candles({n,code}) : recent OHLC
- indicators / smc / confluence / ensemble
- historical_data({code, days}) : fetch loaded historical candles
- patterns({code}) : matched historical patterns for current setup
- strategies : known strategy playbook
- stats / last_signals / lessons / weights / set_weight
- config / set_config (whitelisted)
- start_autopilot / stop_autopilot
- ask(query) : free-form LLM query`;

  const PROMPT_USER = `# USER — preferences
- Stake: do NOT change. Click only UP / DOWN.
- Time: 1-minute binaries.
- Payout filter: only pairs with 1-min payout 80-94%.
- Conservatism: prefer SKIP over a forced trade — but do NOT default to SKIP.
- Confirmation: require zone interaction OR strong momentum + vol.
- Logging: terse, factual.`;

  // ── Runtime State ──────────────────────────────────────────────────
  const state = {
    // Connection
    wsConnected: false,
    wsUrl: null,
    hookReady: false,

    // Pairs
    activePair: null,
    activePairPayout: 0,
    allPairs: {},
    highPayoutPairs: [],

    // Candles
    currentCandle: null,
    candles: {},

    // Trading
    isTrading: false,
    currentTrade: null,
    tradeHistory: [],
    martingaleStep: 0,
    currentInvestment: DEFAULTS.baseInvestment,

    // Analysis
    signals: [],
    lastAnalysis: null,
    lastSignal: null,
    winRate: { wins: 0, losses: 0, total: 0 },
    lessons: [],
    patterns: {},

    // Backtest
    backtestRunning: false,
    backtestResults: null,

    // Agent
    agentBusy: false,
    chatMessages: [],

    // Historical
    historicalStatus: {},

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

  function codeFromPair(pair) {
    const otc = /\(OTC\)/i.test(pair);
    return pair.replace(/\s|\/|\(OTC\)/gi, '').toUpperCase() + (otc ? '_OTC' : '');
  }

  // ── Public API ─────────────────────────────────────────────────────
  return {
    VERSION,
    DEFAULTS,
    OLLAMA_KEYS_DEFAULT,
    PROMPT_SOUL,
    PROMPT_AGENTS,
    PROMPT_STRATEGIES,
    PROMPT_TOOLS,
    PROMPT_USER,
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
    codeFromPair,
  };
})();
