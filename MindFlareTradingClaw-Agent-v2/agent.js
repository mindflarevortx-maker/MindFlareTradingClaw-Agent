/**
 * agent.js  —  Autonomous Trading Brain for MindFlare TradingClaw
 *
 * Self-contained IIFE assigned to global `Agent`.  Orchestrates the entire
 * signal pipeline, auto-pilot loop, martingale system, rapid pair
 * switching, 22 chat tools, and a backtesting engine.
 *
 * Globals used: MF, TechnicalEngine, StrategyEngine, DomClaw,
 *               LLMClaw, SelfImprovement, Scanner, CandleStore
 */

const Agent = (() => {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  //  INTERNAL STATE
  // ══════════════════════════════════════════════════════════════════

  let _autoPilotRunning = false;
  let _autoPilotAbort   = false;   // set true to break the loop
  let _busy             = false;   // true while a trade is in flight
  let _lastSignal       = null;    // most recent combined signal
  let _lastAnalysis     = null;    // most recent TechnicalEngine output
  let _lastStrategySig  = null;    // most recent StrategyEngine output
  let _llmSignalCache   = null;    // most recent LLM signal
  let _llmSignalTime    = 0;       // timestamp of last LLM call

  const CONFIDENCE_THRESHOLD = 65;  // only trade if confidence > this
  const AUTOPILOT_POLL_MS    = 5000; // 5-second poll interval
  const LLM_CACHE_TTL_MS    = 30000; // cache LLM signal for 30 s

  // ══════════════════════════════════════════════════════════════════
  //  SIGNAL PIPELINE
  // ══════════════════════════════════════════════════════════════════

  /**
   * Collect data from Scanner / CandleStore, run TechnicalEngine,
   * StrategyEngine, optionally LLMClaw, and produce a combined signal.
   *
   * @param {string} [pair]  – pair name; defaults to MF.state.activePair
   * @returns {Object} { direction, confidence, reasons, sources, pair,
   *                     technical, strategy, llm }
   */
  async function getSignal(pair) {
    try {
      pair = pair || MF.state.activePair;
      if (!pair) {
        return _noSignal('No active pair');
      }

      // 1. Gather candles from CandleStore or in-memory state
      let candles = [];
      try {
        if (typeof CandleStore !== 'undefined' && CandleStore.isReady()) {
          candles = await CandleStore.getLatestCandles(pair, 300);
        }
      } catch (_) { /* fall through */ }
      if (!candles || candles.length < 5) {
        candles = MF.state.candles[pair] || [];
      }
      if (!candles || candles.length < 5) {
        return _noSignal('Not enough candles for ' + pair);
      }

      // 2. Run TechnicalEngine.analyze()
      let analysis = null;
      try {
        analysis = TechnicalEngine.analyze(pair, candles);
      } catch (e) {
        MF.log('warn', 'Agent: TechnicalEngine error:', e.message);
      }
      if (!analysis) {
        return _noSignal('TechnicalEngine returned no analysis');
      }
      _lastAnalysis = analysis;

      // 3. Run StrategyEngine.evaluate()
      let strategySig = null;
      try {
        strategySig = StrategyEngine.evaluate(pair, candles, analysis);
      } catch (e) {
        MF.log('warn', 'Agent: StrategyEngine error:', e.message);
      }
      if (!strategySig) {
        strategySig = { direction: 'NEUTRAL', confidence: 0, strategy: 'NONE', reasons: [] };
      }
      _lastStrategySig = strategySig;

      // 4. Optionally get LLM signal (cached for LLM_CACHE_TTL_MS)
      let llmSig = null;
      try {
        if (typeof LLMClaw !== 'undefined' && LLMClaw.isAvailable()) {
          if (_llmSignalCache && (Date.now() - _llmSignalTime) < LLM_CACHE_TTL_MS) {
            llmSig = _llmSignalCache;
          } else {
            llmSig = await LLMClaw.getSignal(pair, candles, analysis);
            _llmSignalCache = llmSig;
            _llmSignalTime  = Date.now();
          }
        }
      } catch (e) {
        MF.log('warn', 'Agent: LLMClaw error:', e.message);
      }
      if (llmSig) {
        MF.state.llmSignal = llmSig;  // StrategyEngine COMPOSITE_AI reads this
      }

      // 5. Combine all signals into a final decision
      const combined = _combineSignals(analysis, strategySig, llmSig, pair);

      _lastSignal = combined;
      MF.state.lastAnalysis = analysis;
      MF.bus.emit('agent:signal', combined);

      return combined;
    } catch (e) {
      MF.log('error', 'Agent: getSignal error:', e.message);
      return _noSignal('Error: ' + e.message);
    }
  }

  /** Weighted combination of technical, strategy, and LLM signals. */
  function _combineSignals(analysis, strategySig, llmSig, pair) {
    const techSig  = analysis.signal || { direction: 'NEUTRAL', confidence: 0 };
    const reasons  = [];
    let callWeight = 0, putWeight = 0, totalWeight = 0;

    // Technical signal — weight 0.40
    const techW = 0.40;
    totalWeight += techW;
    if (techSig.direction === 'CALL')  { callWeight += techSig.confidence * techW; reasons.push('Tech: CALL ' + techSig.confidence + '%'); }
    if (techSig.direction === 'PUT')   { putWeight  += techSig.confidence * techW; reasons.push('Tech: PUT '  + techSig.confidence + '%'); }

    // Strategy signal — weight 0.35
    const stratW = 0.35;
    totalWeight += stratW;
    if (strategySig.direction === 'CALL') { callWeight += strategySig.confidence * stratW; reasons.push('Strategy(' + (strategySig.strategy || '?') + '): CALL ' + strategySig.confidence + '%'); }
    if (strategySig.direction === 'PUT')  { putWeight  += strategySig.confidence * stratW; reasons.push('Strategy(' + (strategySig.strategy || '?') + '): PUT '  + strategySig.confidence + '%'); }

    // LLM signal — weight 0.25 (if available)
    if (llmSig && llmSig.direction && llmSig.direction !== 'NEUTRAL') {
      const llmW = 0.25;
      totalWeight += llmW;
      if (llmSig.direction === 'CALL') { callWeight += (llmSig.confidence || 50) * llmW; reasons.push('LLM: CALL ' + (llmSig.confidence || 0) + '%'); }
      if (llmSig.direction === 'PUT')  { putWeight  += (llmSig.confidence || 50) * llmW; reasons.push('LLM: PUT '  + (llmSig.confidence || 0) + '%'); }
    }

    // Determine final direction & confidence
    let direction, confidence;
    if (callWeight > putWeight && callWeight > 0) {
      direction  = 'CALL';
      confidence = MF.clamp(Math.round((callWeight / (totalWeight || 1)) * 100), 0, 100);
    } else if (putWeight > callWeight && putWeight > 0) {
      direction  = 'PUT';
      confidence = MF.clamp(Math.round((putWeight / (totalWeight || 1)) * 100), 0, 100);
    } else {
      direction  = 'NEUTRAL';
      confidence = 0;
    }

    return {
      direction,
      confidence,
      reasons,
      sources: {
        technical: techSig,
        strategy:  strategySig,
        llm:       llmSig,
      },
      pair,
      timestamp: Date.now(),
    };
  }

  function _noSignal(reason) {
    return { direction: 'NEUTRAL', confidence: 0, reasons: [reason], sources: {}, pair: null, timestamp: Date.now() };
  }

  // ══════════════════════════════════════════════════════════════════
  //  EXECUTE A SINGLE TRADE
  // ══════════════════════════════════════════════════════════════════

  /**
   * Execute a single trade via DomClaw.
   * @param {string}  direction – 'CALL' | 'PUT'
   * @param {string}  [pair]    – pair to trade on; switches if needed
   * @param {number}  [investment] – override investment amount
   * @returns {Promise<Object>} { success, result, profit, trade }
   */
  async function execute(direction, pair, investment) {
    if (_busy) {
      return { success: false, error: 'Agent busy — another trade in progress' };
    }

    _busy = true;
    MF.state.isTrading = true;

    try {
      pair       = pair || MF.state.activePair;
      investment = typeof investment === 'number' && investment > 0
        ? investment
        : MF.state.currentInvestment || MF.getConfig('baseInvestment');

      // Cap at maxInvestment
      const maxInv = MF.getConfig('maxInvestment') || 100;
      investment   = Math.min(investment, maxInv);

      if (!direction || (direction !== 'CALL' && direction !== 'PUT')) {
        return { success: false, error: 'Invalid direction: ' + direction };
      }

      MF.log('info', 'Agent: executing', direction, 'on', pair, 'investment:', investment);

      // Switch pair if needed
      const currentPair = DomClaw.getActivePair();
      if (pair && currentPair && currentPair !== pair) {
        const switched = DomClaw.selectAsset(pair);
        if (switched) {
          await MF.sleep(800); // let DOM settle
        }
      }

      // Set investment
      DomClaw.setInvestment(investment);
      await MF.sleep(300);

      // Set trade duration
      const duration = MF.getConfig('tradeDuration') || 60;
      DomClaw.setTradeDuration(duration);
      await MF.sleep(300);

      // Click the direction button
      const clicked = direction === 'CALL' ? DomClaw.clickUp() : DomClaw.clickDown();
      if (!clicked) {
        MF.bus.emit('agent:trade-failed', { direction, pair, reason: 'Button click failed' });
        return { success: false, error: 'Could not click ' + direction + ' button' };
      }

      MF.bus.emit('agent:trade-placed', { direction, pair, investment, timestamp: Date.now() });

      // Wait for trade result
      const result = await DomClaw.waitForTradeResult(
        (duration + 30) * 1000  // duration + 30 s buffer
      );

      // Calculate profit
      const payout = DomClaw.getPayout() || MF.state.activePairPayout || 75;
      let profit = 0;
      if (result === 'WIN') {
        profit = +(investment * payout / 100).toFixed(2);
      } else if (result === 'LOSS') {
        profit = -investment;
      }

      // Record trade
      const trade = {
        pair,
        direction,
        investment,
        result: result || 'UNKNOWN',
        profit,
        payout,
        strategy: _lastStrategySig ? _lastStrategySig.strategy : 'UNKNOWN',
        confidence: _lastSignal ? _lastSignal.confidence : 0,
        indicators: _lastAnalysis ? { trend: (_lastAnalysis.trend || {}).direction } : {},
        martingaleStep: MF.state.martingaleStep || 0,
        timestamp: Date.now(),
      };

      try { SelfImprovement.recordTrade(trade); } catch (_) {}

      // Apply martingale logic
      _applyMartingale(result);

      MF.state.currentTrade = null;
      MF.bus.emit('agent:trade-complete', trade);

      return { success: true, result, profit, trade };
    } catch (e) {
      MF.log('error', 'Agent: execute error:', e.message);
      MF.bus.emit('agent:trade-error', { error: e.message });
      return { success: false, error: e.message };
    } finally {
      _busy = false;
      MF.state.isTrading = false;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  MARTINGALE SYSTEM
  // ══════════════════════════════════════════════════════════════════

  function _applyMartingale(result) {
    if (!MF.getConfig('martingaleEnabled')) return;

    const baseInv   = MF.getConfig('baseInvestment') || 1;
    const maxSteps  = MF.getConfig('martingaleSteps') || 3;
    const multiplier = MF.getConfig('martingaleMultiplier') || 2.0;
    const maxInv    = MF.getConfig('maxInvestment') || 100;

    if (result === 'WIN') {
      // WIN → reset to base investment, reset step counter
      MF.state.martingaleStep   = 0;
      MF.state.currentInvestment = baseInv;
      MF.log('info', 'Agent: WIN — martingale reset to base', baseInv);
    } else if (result === 'LOSS') {
      // LOSS → multiply investment, increment step
      MF.state.martingaleStep = (MF.state.martingaleStep || 0) + 1;

      if (MF.state.martingaleStep > maxSteps) {
        MF.log('warn', 'Agent: Martingale steps exceeded (' + MF.state.martingaleStep + '/' + maxSteps + ') — resetting');
        MF.state.martingaleStep   = 0;
        MF.state.currentInvestment = baseInv;
      } else {
        const next = +(MF.state.currentInvestment * multiplier).toFixed(2);
        MF.state.currentInvestment = Math.min(next, maxInv);
        MF.log('info', 'Agent: LOSS — martingale step', MF.state.martingaleStep, 'next investment:', MF.state.currentInvestment);
      }
    }

    MF.saveState();
  }

  /** Reset martingale state to base. */
  function resetMartingale() {
    MF.state.martingaleStep   = 0;
    MF.state.currentInvestment = MF.getConfig('baseInvestment') || 1;
    MF.saveState();
    MF.log('info', 'Agent: Martingale reset');
    MF.bus.emit('agent:martingale-reset');
  }

  // ══════════════════════════════════════════════════════════════════
  //  RAPID PAIR SWITCHING
  // ══════════════════════════════════════════════════════════════════

  /**
   * Find the highest-payout available pair and switch to it if better
   * than the current pair's payout.
   * @returns {string|null} The new pair name, or null if no switch.
   */
  function switchToBestPair() {
    try {
      const highPairs  = MF.state.highPayoutPairs || [];
      const currentPay = MF.state.activePairPayout || 0;
      const minPayout  = MF.getConfig('minPayout') || 70;

      if (highPairs.length === 0) return null;

      // The first in the list is the highest payout (Scanner sorts desc)
      const bestPair   = highPairs[0];
      const bestPayout = (MF.state.allPairs[bestPair] || {}).payout || 0;

      if (bestPair && bestPayout > currentPay && bestPayout >= minPayout) {
        const switched = DomClaw.selectAsset(bestPair);
        if (switched) {
          MF.log('info', 'Agent: switched to', bestPair, 'payout', bestPayout + '%');
          MF.bus.emit('agent:pair-switched', { from: MF.state.activePair, to: bestPair, payout: bestPayout });
          return bestPair;
        }
      }
      return null;
    } catch (e) {
      MF.log('warn', 'Agent: switchToBestPair error:', e.message);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  AUTO-PILOT MODE
  // ══════════════════════════════════════════════════════════════════

  /**
   * Start autonomous trading loop.
   * Checks MF.getConfig('autoPilot') before each trade.
   */
  async function startAutoPilot() {
    if (_autoPilotRunning) {
      MF.log('warn', 'Agent: auto-pilot already running');
      return;
    }

    _autoPilotRunning = true;
    _autoPilotAbort   = false;
    MF.setConfig('autoPilot', true);
    MF.log('info', 'Agent: auto-pilot STARTED');
    MF.bus.emit('agent:autopilot-start');

    while (_autoPilotRunning && !_autoPilotAbort) {
      try {
        // Gate: check the config flag (can be toggled from UI)
        if (!MF.getConfig('autoPilot')) {
          MF.log('info', 'Agent: autoPilot config turned off — stopping');
          break;
        }

        // Don't trade while busy
        if (_busy) {
          await MF.sleep(AUTOPILOT_POLL_MS);
          continue;
        }

        // Step A: Switch to best-payout pair
        switchToBestPair();

        // Step B: Wait briefly for data to settle after possible pair switch
        await MF.sleep(1500);

        // Step C: Get signal
        const signal = await getSignal();
        if (!signal || signal.direction === 'NEUTRAL' || signal.confidence <= CONFIDENCE_THRESHOLD) {
          MF.log('debug', 'Agent: no actionable signal (', (signal && signal.direction), '@', (signal && signal.confidence), ') — waiting');
          await MF.sleep(AUTOPILOT_POLL_MS);
          continue;
        }

        // Step D: Execute the trade
        MF.log('info', 'Agent: auto-pilot signal', signal.direction, '@', signal.confidence + '%', 'on', signal.pair);
        const outcome = await execute(signal.direction, signal.pair);

        if (outcome.success) {
          MF.log('info', 'Agent: auto-pilot trade result:', outcome.result, 'profit:', outcome.profit);
        } else {
          MF.log('warn', 'Agent: auto-pilot trade failed:', outcome.error);
        }

        // Step E: Brief pause before next cycle
        await MF.sleep(2000);

      } catch (e) {
        MF.log('error', 'Agent: auto-pilot loop error:', e.message);
        await MF.sleep(AUTOPILOT_POLL_MS);
      }
    }

    _autoPilotRunning = false;
    MF.setConfig('autoPilot', false);
    MF.log('info', 'Agent: auto-pilot STOPPED');
    MF.bus.emit('agent:autopilot-stop');
  }

  /** Stop the auto-pilot loop. */
  function stopAutoPilot() {
    _autoPilotAbort = true;
    MF.setConfig('autoPilot', false);
    MF.log('info', 'Agent: auto-pilot stop requested');
  }

  // ══════════════════════════════════════════════════════════════════
  //  BACKTESTING ENGINE
  // ══════════════════════════════════════════════════════════════════

  /**
   * Run historical simulation on a set of candles using a named strategy.
   *
   * @param {string} pair     – pair name
   * @param {Array}  candles  – historical candle array
   * @param {string} strategy – strategy name (e.g. 'RSI_REVERSAL')
   * @returns {Object} { totalTrades, wins, losses, winRate, totalProfit, maxDrawdown }
   */
  function runBacktest(pair, candles, strategy) {
    try {
      if (!Array.isArray(candles) || candles.length < 50) {
        return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalProfit: 0, maxDrawdown: 0, error: 'Not enough candles' };
      }

      const minCandles = 60; // need enough history for indicators
      let wins = 0, losses = 0, totalProfit = 0;
      let peak = 0, maxDrawdown = 0;
      const baseInvestment = MF.getConfig('baseInvestment') || 1;

      MF.state.backtestRunning = true;
      MF.bus.emit('agent:backtest-start', { pair, strategy });

      // Walk forward through candles, trading at each step
      for (let i = minCandles; i < candles.length - 1; i++) {
        const slice     = candles.slice(0, i + 1);
        const nextCandle = candles[i + 1]; // the candle we're predicting

        let analysis;
        try {
          analysis = TechnicalEngine.analyze(pair, slice);
        } catch (_) { continue; }
        if (!analysis) continue;

        let signal;
        if (strategy && strategy !== 'COMPOSITE_AI') {
          try { signal = StrategyEngine.evaluateStrategy(strategy, slice, analysis); }
          catch (_) { continue; }
        } else {
          try { signal = StrategyEngine.evaluate(pair, slice, analysis); }
          catch (_) { continue; }
        }

        if (!signal || signal.direction === 'NEUTRAL' || signal.confidence <= CONFIDENCE_THRESHOLD) {
          continue;
        }

        // Determine outcome: did the direction match the next candle?
        const wentUp   = nextCandle.close > nextCandle.open;
        const isCall   = signal.direction === 'CALL';
        const isWin    = (isCall && wentUp) || (!isCall && !wentUp);

        if (isWin) {
          wins++;
          const payout   = 80; // assume average 80% payout for backtest
          const profit   = baseInvestment * payout / 100;
          totalProfit   += profit;
        } else {
          losses++;
          totalProfit -= baseInvestment;
        }

        // Track drawdown
        if (totalProfit > peak) peak = totalProfit;
        const dd = peak - totalProfit;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }

      const totalTrades = wins + losses;
      const winRate     = totalTrades ? +(wins / totalTrades).toFixed(3) : 0;

      const result = {
        pair,
        strategy,
        totalTrades,
        wins,
        losses,
        winRate,
        totalProfit: +totalProfit.toFixed(2),
        maxDrawdown: +maxDrawdown.toFixed(2),
      };

      MF.state.backtestRunning = false;
      MF.state.backtestResults = result;
      MF.bus.emit('agent:backtest-complete', result);

      return result;
    } catch (e) {
      MF.state.backtestRunning = false;
      MF.log('error', 'Agent: runBacktest error:', e.message);
      return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalProfit: 0, maxDrawdown: 0, error: e.message };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  AGENT STATUS
  // ══════════════════════════════════════════════════════════════════

  function getStatus() {
    return {
      busy: _busy,
      autoPilot: _autoPilotRunning,
      autoPilotConfig: MF.getConfig('autoPilot'),
      activePair: MF.state.activePair,
      activePairPayout: MF.state.activePairPayout,
      currentInvestment: MF.state.currentInvestment,
      martingaleStep: MF.state.martingaleStep,
      lastSignal: _lastSignal ? {
        direction: _lastSignal.direction,
        confidence: _lastSignal.confidence,
        pair: _lastSignal.pair,
      } : null,
      tradeHistoryCount: MF.state.tradeHistory.length,
      wsConnected: MF.state.wsConnected,
      domReady: MF.state.domReady,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  22 AGENT TOOLS (for chat interface)
  // ══════════════════════════════════════════════════════════════════

  const TOOLS = {

    /** Run full signal pipeline and return the combined signal. */
    async analyze(args) {
      try {
        const pair = (args && args.pair) || MF.state.activePair;
        const sig  = await getSignal(pair);
        return { ok: true, direction: sig.direction, confidence: sig.confidence, reasons: sig.reasons, pair: sig.pair };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Rescan the DOM and WS for data. */
    async scan() {
      try {
        if (typeof Scanner !== 'undefined') Scanner.rescan();
        return { ok: true, message: 'Scanner rescan triggered' };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Execute a single trade. */
    async trade(args) {
      try {
        const dir   = (args && args.direction) || 'CALL';
        const pair  = (args && args.pair) || undefined;
        const inv   = (args && args.investment) || undefined;
        const result = await execute(dir, pair, inv);
        return result;
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Stop auto-pilot trading. */
    async stop() {
      try {
        stopAutoPilot();
        return { ok: true, message: 'Auto-pilot stopped' };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Get current agent status. */
    async status() {
      try { return { ok: true, ...getStatus() }; }
      catch (e) { return { ok: false, error: e.message }; }
    },

    /** List available trading pairs and payouts. */
    async pairs() {
      try {
        const all = MF.state.allPairs || {};
        const list = Object.entries(all).map(([name, info]) => ({
          name, payout: info.payout || 0, active: !!info.active,
        }));
        list.sort((a, b) => b.payout - a.payout);
        return { ok: true, pairs: list, count: list.length };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Show recent trade history. */
    async history(args) {
      try {
        const limit = (args && args.limit) || 20;
        const trades = MF.state.tradeHistory.slice(-limit);
        return { ok: true, trades, count: trades.length };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Run a backtest on historical data. */
    async backtest(args) {
      try {
        const pair     = (args && args.pair) || MF.state.activePair;
        const strategy = (args && args.strategy) || 'COMPOSITE_AI';
        let candles    = [];
        try {
          if (typeof CandleStore !== 'undefined' && CandleStore.isReady()) {
            candles = await CandleStore.getLatestCandles(pair, 500);
          }
        } catch (_) {}
        if (!candles || candles.length < 50) {
          candles = MF.state.candles[pair] || [];
        }
        const result = runBacktest(pair, candles, strategy);
        return { ok: true, ...result };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Set a config value. */
    async set_config(args) {
      try {
        const key = args && args.key;
        const val = args && args.value;
        if (!key) return { ok: false, error: 'key is required' };
        MF.setConfig(key, val);
        return { ok: true, key, value: val };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Get a config value or all config. */
    async get_config(args) {
      try {
        if (args && args.key) {
          return { ok: true, key: args.key, value: MF.getConfig(args.key) };
        }
        return { ok: true, config: MF.config };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** List current indicator values for the active pair. */
    async indicators() {
      try {
        if (!_lastAnalysis) return { ok: false, error: 'No analysis available — run analyze first' };
        return { ok: true, pair: _lastAnalysis.pair, indicators: _lastAnalysis.indicators, trend: _lastAnalysis.trend };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Show strategy stats and weights for a pair. */
    async strategy(args) {
      try {
        const pair = (args && args.pair) || MF.state.activePair;
        if (!pair) return { ok: false, error: 'No active pair' };
        const stats   = StrategyEngine.getStrategyStats(pair);
        const weights = StrategyEngine.getStrategyWeights(pair);
        const all     = StrategyEngine.getAllStrategies();
        return { ok: true, pair, strategies: all, stats, weights };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Show martingale state. */
    async martingale() {
      try {
        return {
          ok: true,
          enabled: MF.getConfig('martingaleEnabled'),
          step: MF.state.martingaleStep,
          currentInvestment: MF.state.currentInvestment,
          baseInvestment: MF.getConfig('baseInvestment'),
          maxSteps: MF.getConfig('martingaleSteps'),
          multiplier: MF.getConfig('martingaleMultiplier'),
          maxInvestment: MF.getConfig('maxInvestment'),
        };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Ask the LLM a free-form question. */
    async llm_ask(args) {
      try {
        const question = args && args.question;
        if (!question) return { ok: false, error: 'question is required' };
        if (typeof LLMClaw === 'undefined' || !LLMClaw.isAvailable()) {
          return { ok: false, error: 'LLM not available — configure a provider' };
        }
        const result = await LLMClaw.chat([
          { role: 'system', content: 'You are MindFlare TradingClaw AI assistant. Be concise and trading-focused.' },
          { role: 'user', content: question },
        ]);
        return { ok: true, text: result.text, provider: result.provider, model: result.model };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Get an LLM trading signal directly. */
    async llm_signal(args) {
      try {
        const pair = (args && args.pair) || MF.state.activePair;
        if (!pair) return { ok: false, error: 'No active pair' };
        if (typeof LLMClaw === 'undefined' || !LLMClaw.isAvailable()) {
          return { ok: false, error: 'LLM not available' };
        }
        const candles   = MF.state.candles[pair] || [];
        const analysis  = _lastAnalysis || {};
        const signal    = await LLMClaw.getSignal(pair, candles, analysis);
        return { ok: true, direction: signal.direction, confidence: signal.confidence, reasoning: signal.reasoning };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Fetch candle history for a pair. */
    async candle_history(args) {
      try {
        const pair  = (args && args.pair) || MF.state.activePair;
        const count = (args && args.count) || 50;
        let candles = [];
        try {
          if (typeof CandleStore !== 'undefined' && CandleStore.isReady()) {
            candles = await CandleStore.getLatestCandles(pair, count);
          }
        } catch (_) {}
        if (!candles || candles.length === 0) {
          candles = (MF.state.candles[pair] || []).slice(-count);
        }
        return { ok: true, pair, count: candles.length, candles: candles.slice(-20) }; // return last 20 to keep payload manageable
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Export trade history and config as JSON. */
    async export_data() {
      try {
        const data = {
          version: MF.VERSION,
          config: MF.config,
          tradeHistory: MF.state.tradeHistory,
          martingaleStep: MF.state.martingaleStep,
          currentInvestment: MF.state.currentInvestment,
          exportedAt: new Date().toISOString(),
        };
        return { ok: true, data };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Import trade history and config from JSON. */
    async import_data(args) {
      try {
        const data = args && args.data;
        if (!data) return { ok: false, error: 'data is required' };
        if (data.config) {
          for (const [k, v] of Object.entries(data.config)) {
            MF.setConfig(k, v);
          }
        }
        if (Array.isArray(data.tradeHistory)) {
          MF.state.tradeHistory = data.tradeHistory;
          MF.saveState();
        }
        if (typeof data.martingaleStep === 'number') MF.state.martingaleStep = data.martingaleStep;
        if (typeof data.currentInvestment === 'number') MF.state.currentInvestment = data.currentInvestment;
        return { ok: true, message: 'Data imported' };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Clear all trade history. */
    async clear_history() {
      try {
        MF.state.tradeHistory = [];
        MF.saveState();
        MF.bus.emit('agent:history-cleared');
        return { ok: true, message: 'Trade history cleared' };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Reset martingale state. */
    async reset_martingale() {
      try {
        resetMartingale();
        return { ok: true, message: 'Martingale reset to base investment' };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Debug dump of internal state. */
    async debug() {
      try {
        return {
          ok: true,
          busy: _busy,
          autoPilotRunning: _autoPilotRunning,
          autoPilotAbort: _autoPilotAbort,
          lastSignal: _lastSignal,
          lastAnalysis: _lastAnalysis ? { pair: _lastAnalysis.pair, trend: _lastAnalysis.trend, signal: _lastAnalysis.signal } : null,
          lastStrategySig: _lastStrategySig,
          llmSignalCache: _llmSignalCache,
          state: {
            activePair: MF.state.activePair,
            martingaleStep: MF.state.martingaleStep,
            currentInvestment: MF.state.currentInvestment,
            isTrading: MF.state.isTrading,
            wsConnected: MF.state.wsConnected,
            domReady: MF.state.domReady,
            tradeHistoryLength: MF.state.tradeHistory.length,
            highPayoutPairs: MF.state.highPayoutPairs,
          },
          scanner: typeof Scanner !== 'undefined' ? Scanner.getDiagnostics() : 'N/A',
        };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** Show help — list all tools and their descriptions. */
    async help() {
      return {
        ok: true,
        tools: [
          { name: 'analyze',           desc: 'Run full signal pipeline for a pair', args: 'pair?' },
          { name: 'scan',              desc: 'Rescan DOM and WS for data' },
          { name: 'trade',             desc: 'Execute a trade', args: 'direction, pair?, investment?' },
          { name: 'stop',              desc: 'Stop auto-pilot trading' },
          { name: 'status',            desc: 'Get current agent status' },
          { name: 'pairs',             desc: 'List available trading pairs and payouts' },
          { name: 'history',           desc: 'Show recent trade history', args: 'limit?' },
          { name: 'backtest',          desc: 'Run historical simulation', args: 'pair?, strategy?' },
          { name: 'set_config',        desc: 'Set a config value', args: 'key, value' },
          { name: 'get_config',        desc: 'Get a config value or all config', args: 'key?' },
          { name: 'indicators',        desc: 'List current indicator values' },
          { name: 'strategy',          desc: 'Show strategy stats and weights', args: 'pair?' },
          { name: 'martingale',        desc: 'Show martingale state' },
          { name: 'llm_ask',           desc: 'Ask the LLM a question', args: 'question' },
          { name: 'llm_signal',        desc: 'Get an LLM trading signal', args: 'pair?' },
          { name: 'candle_history',    desc: 'Fetch candle history', args: 'pair?, count?' },
          { name: 'export_data',       desc: 'Export trade history and config as JSON' },
          { name: 'import_data',       desc: 'Import data from JSON', args: 'data' },
          { name: 'clear_history',     desc: 'Clear all trade history' },
          { name: 'reset_martingale',  desc: 'Reset martingale to base investment' },
          { name: 'debug',             desc: 'Debug dump of internal state' },
          { name: 'help',              desc: 'Show this help' },
        ],
      };
    },
  };

  /** Dispatch a tool call by name with optional args. */
  async function callTool(name, args) {
    try {
      const fn = TOOLS[name];
      if (!fn) return { ok: false, error: 'Unknown tool: ' + name };
      return await fn(args || {});
    } catch (e) {
      MF.log('error', 'Agent: callTool error:', name, e.message);
      return { ok: false, error: e.message };
    }
  }

  /** Get the list of available tool names. */
  function getToolNames() {
    return Object.keys(TOOLS);
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT LISTENERS
  // ══════════════════════════════════════════════════════════════════

  // Sync autoPilot config changes (e.g. from UI toggle)
  MF.bus.on('config:change', (key, value) => {
    try {
      if (key === 'autoPilot') {
        if (value && !_autoPilotRunning) {
          startAutoPilot();  // fire-and-forget loop
        } else if (!value && _autoPilotRunning) {
          _autoPilotAbort = true;
        }
      }
    } catch (e) {
      MF.log('warn', 'Agent: config:change handler error:', e.message);
    }
  });

  // Re-invalidate LLM cache when pair changes
  MF.bus.on('pair:changed', () => {
    _llmSignalCache = null;
    _llmSignalTime  = 0;
  });

  // ══════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ══════════════════════════════════════════════════════════════════

  (function _init() {
    try {
      // Restore martingale state from MF.state
      if (typeof MF.state.currentInvestment !== 'number' || MF.state.currentInvestment <= 0) {
        MF.state.currentInvestment = MF.getConfig('baseInvestment') || 1;
      }
      if (typeof MF.state.martingaleStep !== 'number') {
        MF.state.martingaleStep = 0;
      }

      MF.log('info', 'Agent: initialized (22 tools, confidence threshold:', CONFIDENCE_THRESHOLD + ')');
      MF.bus.emit('agent:ready');
    } catch (e) {
      MF.log('error', 'Agent: init error:', e.message);
    }
  })();

  // ══════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════════

  return {
    // Main functions
    execute,
    getSignal,
    getStatus,

    // Auto-pilot
    startAutoPilot,
    stopAutoPilot,

    // Martingale
    resetMartingale,

    // Backtesting
    runBacktest,

    // Tools
    callTool,
    getToolNames,
    TOOLS,

    // Pair switching
    switchToBestPair,
  };

})();
