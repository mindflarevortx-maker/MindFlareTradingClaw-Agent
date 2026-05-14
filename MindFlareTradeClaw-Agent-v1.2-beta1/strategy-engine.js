/**
 * strategy-engine.js  —  Strategy Engine & Pattern Registry
 *
 * Implements 7 trading strategies and a per-pair adaptive weight registry
 * for MindFlare TradingClaw.  Reads analysis from TechnicalEngine and
 * learns which strategies perform best for each pair over time.
 *
 * Globals used: MF (config/state/logging/event bus), TechnicalEngine
 */

const StrategyEngine = (() => {
  'use strict';

  // ── Strategy names ──────────────────────────────────────────────
  const STRATEGIES = [
    'RSI_REVERSAL',
    'MACD_CROSSOVER',
    'BOLLINGER_BOUNCE',
    'EMA_TREND',
    'STOCHASTIC_MOMENTUM',
    'SMC_ICT',
    'COMPOSITE_AI',
  ];

  // ── In-memory pattern registry { pair: { strategy: { wins, losses } } }
  let _registry = {};

  // ── Persistence helpers ─────────────────────────────────────────
  const STORAGE_KEY = 'mf_strategy_registry';

  async function _loadRegistry() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      if (stored[STORAGE_KEY]) _registry = stored[STORAGE_KEY];
    } catch (e) {
      MF.log('warn', 'StrategyEngine: failed to load registry:', e.message);
    }
  }

  async function _saveRegistry() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: _registry });
    } catch (e) {
      MF.log('warn', 'StrategyEngine: failed to save registry:', e.message);
    }
  }

  // Load on script init
  _loadRegistry();

  // ── Signal constructor ──────────────────────────────────────────
  function _signal(direction, confidence, strategy, reasons, indicators) {
    return {
      direction: direction,        // 'CALL' | 'PUT' | 'NEUTRAL'
      confidence: MF.clamp(Math.round(confidence), 0, 100),
      strategy: strategy,
      reasons: reasons || [],
      indicators: indicators || {},
    };
  }

  function _neutral(strategy, reasons) {
    return _signal('NEUTRAL', 0, strategy, reasons || ['No trigger'], {});
  }

  // ── 1. RSI Reversal ─────────────────────────────────────────────
  function _rsiReversal(candles, analysis) {
    const rsi = analysis.indicators.rsi;
    if (rsi == null) return _neutral('RSI_REVERSAL', ['RSI unavailable']);
    const reasons = [], ind = { rsi };
    if (rsi < 30) {
      reasons.push('RSI oversold (' + rsi.toFixed(1) + ')');
      const conf = MF.clamp((30 - rsi) / 30 * 80 + 20, 20, 90);
      return _signal('CALL', conf, 'RSI_REVERSAL', reasons, ind);
    }
    if (rsi > 70) {
      reasons.push('RSI overbought (' + rsi.toFixed(1) + ')');
      const conf = MF.clamp((rsi - 70) / 30 * 80 + 20, 20, 90);
      return _signal('PUT', conf, 'RSI_REVERSAL', reasons, ind);
    }
    return _neutral('RSI_REVERSAL', ['RSI in neutral zone (' + rsi.toFixed(1) + ')']);
  }

  // ── 2. MACD Crossover ───────────────────────────────────────────
  function _macdCrossover(candles, analysis) {
    const macd = analysis.indicators.macd;
    if (!macd) return _neutral('MACD_CROSSOVER', ['MACD unavailable']);
    const ind = { macd: macd.macd, signal: macd.signal, histogram: macd.histogram };
    if (macd.histogram > 0) {
      return _signal('CALL', MF.clamp(50 + Math.abs(macd.histogram) * 200, 30, 85),
        'MACD_CROSSOVER', ['MACD above signal (bullish)'], ind);
    }
    if (macd.histogram < 0) {
      return _signal('PUT', MF.clamp(50 + Math.abs(macd.histogram) * 200, 30, 85),
        'MACD_CROSSOVER', ['MACD below signal (bearish)'], ind);
    }
    return _neutral('MACD_CROSSOVER', ['MACD aligned with signal']);
  }

  // ── 3. Bollinger Bounce ─────────────────────────────────────────
  function _bollingerBounce(candles, analysis) {
    const bb = analysis.indicators.bollinger;
    if (!bb) return _neutral('BOLLINGER_BOUNCE', ['Bollinger unavailable']);
    const price = candles.length ? candles[candles.length - 1].close : 0;
    const ind = { percentB: bb.percentB, lower: bb.lower, upper: bb.upper };
    if (price <= bb.lower) {
      return _signal('CALL', MF.clamp((1 - bb.percentB) * 80 + 20, 25, 88),
        'BOLLINGER_BOUNCE', ['Price touching lower band'], ind);
    }
    if (price >= bb.upper) {
      return _signal('PUT', MF.clamp(bb.percentB * 80 + 20, 25, 88),
        'BOLLINGER_BOUNCE', ['Price touching upper band'], ind);
    }
    return _neutral('BOLLINGER_BOUNCE', ['Price within bands']);
  }

  // ── 4. EMA Trend ────────────────────────────────────────────────
  function _emaTrend(candles, analysis) {
    const ema = analysis.indicators.ema;
    if (!ema || ema.ema9 == null || ema.ema21 == null) {
      return _neutral('EMA_TREND', ['EMA unavailable']);
    }
    const ind = { ema9: ema.ema9, ema21: ema.ema21 };
    if (ema.ema9 > ema.ema21) {
      const gap = ((ema.ema9 - ema.ema21) / ema.ema21) * 100;
      return _signal('CALL', MF.clamp(45 + gap * 30, 30, 85),
        'EMA_TREND', ['EMA9 crossed above EMA21'], ind);
    }
    if (ema.ema9 < ema.ema21) {
      const gap = ((ema.ema21 - ema.ema9) / ema.ema21) * 100;
      return _signal('PUT', MF.clamp(45 + gap * 30, 30, 85),
        'EMA_TREND', ['EMA9 crossed below EMA21'], ind);
    }
    return _neutral('EMA_TREND', ['EMAs converged']);
  }

  // ── 5. Stochastic Momentum ──────────────────────────────────────
  function _stochasticMomentum(candles, analysis) {
    const stoch = analysis.indicators.stochastic;
    if (!stoch) return _neutral('STOCHASTIC_MOMENTUM', ['Stochastic unavailable']);
    const ind = { k: stoch.k, d: stoch.d };
    if (stoch.k < 20 && stoch.k > stoch.d) {
      return _signal('CALL', MF.clamp(55 + (20 - stoch.k), 35, 88),
        'STOCHASTIC_MOMENTUM', ['%K crossed %D in oversold zone'], ind);
    }
    if (stoch.k > 80 && stoch.k < stoch.d) {
      return _signal('PUT', MF.clamp(55 + (stoch.k - 80), 35, 88),
        'STOCHASTIC_MOMENTUM', ['%K crossed %D in overbought zone'], ind);
    }
    return _neutral('STOCHASTIC_MOMENTUM', ['No oversold/overbought crossover']);
  }

  // ── 6. SMC / ICT ────────────────────────────────────────────────
  function _smcIct(candles, analysis) {
    const smc = analysis.smc;
    if (!smc) return _neutral('SMC_ICT', ['SMC data unavailable']);
    let bullScore = 0, bearScore = 0;
    const reasons = [], ind = {};

    // Order blocks — price near bullish OB → CALL, bearish OB → PUT
    const lastClose = candles.length ? candles[candles.length - 1].close : 0;
    for (const ob of (smc.orderBlocks || [])) {
      if (ob.type === 'bullish' && lastClose >= ob.low && lastClose <= ob.high) {
        bullScore += 20; reasons.push('Price at bullish OB'); ind.bullishOB = true;
      }
      if (ob.type === 'bearish' && lastClose >= ob.low && lastClose <= ob.high) {
        bearScore += 20; reasons.push('Price at bearish OB'); ind.bearishOB = true;
      }
    }

    // FVGs
    for (const fvg of (smc.fvgs || [])) {
      if (fvg.type === 'bullish' && lastClose >= fvg.bottom && lastClose <= fvg.top) {
        bullScore += 15; reasons.push('Price in bullish FVG'); ind.bullishFVG = true;
      }
      if (fvg.type === 'bearish' && lastClose >= fvg.bottom && lastClose <= fvg.top) {
        bearScore += 15; reasons.push('Price in bearish FVG'); ind.bearishFVG = true;
      }
    }

    // BOS / CHOCH
    const lastBOS = (smc.bos || []).slice(-1)[0];
    const lastCHOCH = (smc.choch || []).slice(-1)[0];
    if (lastBOS && lastBOS.type === 'bullish') { bullScore += 15; reasons.push('Bullish BOS'); ind.bullishBOS = true; }
    if (lastBOS && lastBOS.type === 'bearish') { bearScore += 15; reasons.push('Bearish BOS'); ind.bearishBOS = true; }
    if (lastCHOCH && lastCHOCH.type === 'bullish') { bullScore += 20; reasons.push('Bullish CHOCH'); ind.bullishCHOCH = true; }
    if (lastCHOCH && lastCHOCH.type === 'bearish') { bearScore += 20; reasons.push('Bearish CHOCH'); ind.bearishCHOCH = true; }

    // Killzone alignment
    const kz = smc.killzone || {};
    const kzActive = (kz.london && kz.london.active) || (kz.newyork && kz.newyork.active);
    if (kzActive) { bullScore += 5; bearScore += 5; reasons.push('Killzone active'); ind.killzone = true; }

    if (bullScore > bearScore && bullScore >= 25) {
      return _signal('CALL', MF.clamp(bullScore * 1.5, 25, 92), 'SMC_ICT', reasons, ind);
    }
    if (bearScore > bullScore && bearScore >= 25) {
      return _signal('PUT', MF.clamp(bearScore * 1.5, 25, 92), 'SMC_ICT', reasons, ind);
    }
    return _neutral('SMC_ICT', ['No clear SMC setup']);
  }

  // ── 7. Composite AI ─────────────────────────────────────────────
  function _compositeAI(candles, analysis) {
    let callWeight = 0, putWeight = 0, totalWeight = 0;
    const reasons = [], ind = {};

    // Weighted contribution from each strategy
    const weights = { RSI_REVERSAL: 1.0, MACD_CROSSOVER: 1.2, BOLLINGER_BOUNCE: 0.9,
      EMA_TREND: 1.1, STOCHASTIC_MOMENTUM: 0.8, SMC_ICT: 1.3 };
    const subStrategies = [_rsiReversal, _macdCrossover, _bollingerBounce,
      _emaTrend, _stochasticMomentum, _smcIct];
    const names = ['RSI_REVERSAL', 'MACD_CROSSOVER', 'BOLLINGER_BOUNCE',
      'EMA_TREND', 'STOCHASTIC_MOMENTUM', 'SMC_ICT'];

    for (let i = 0; i < subStrategies.length; i++) {
      const sig = subStrategies[i](candles, analysis);
      const w = weights[names[i]] || 1;
      totalWeight += w;
      if (sig.direction === 'CALL') { callWeight += sig.confidence * w; ind[names[i]] = 'CALL'; }
      else if (sig.direction === 'PUT') { putWeight += sig.confidence * w; ind[names[i]] = 'PUT'; }
    }

    // LLM signal (if available on MF.state)
    const llmSignal = MF.state && MF.state.llmSignal;
    if (llmSignal && llmSignal.direction) {
      const lw = 1.5;
      totalWeight += lw;
      if (llmSignal.direction === 'CALL') { callWeight += (llmSignal.confidence || 50) * lw; reasons.push('LLM: CALL'); }
      else if (llmSignal.direction === 'PUT') { putWeight += (llmSignal.confidence || 50) * lw; reasons.push('LLM: PUT'); }
      ind.llm = llmSignal.direction;
    }

    const callPct = totalWeight ? (callWeight / totalWeight) : 0;
    const putPct  = totalWeight ? (putWeight / totalWeight) : 0;

    if (callPct > putPct && callPct > 40) {
      reasons.unshift('Composite bullish (' + callPct.toFixed(0) + '%)');
      return _signal('CALL', MF.clamp(callPct, 30, 95), 'COMPOSITE_AI', reasons, ind);
    }
    if (putPct > callPct && putPct > 40) {
      reasons.unshift('Composite bearish (' + putPct.toFixed(0) + '%)');
      return _signal('PUT', MF.clamp(putPct, 30, 95), 'COMPOSITE_AI', reasons, ind);
    }
    return _neutral('COMPOSITE_AI', ['No composite edge']);
  }

  // ── Strategy dispatch ───────────────────────────────────────────
  const _dispatch = {
    RSI_REVERSAL: _rsiReversal,
    MACD_CROSSOVER: _macdCrossover,
    BOLLINGER_BOUNCE: _bollingerBounce,
    EMA_TREND: _emaTrend,
    STOCHASTIC_MOMENTUM: _stochasticMomentum,
    SMC_ICT: _smcIct,
    COMPOSITE_AI: _compositeAI,
  };

  // ── Weight calculation from registry ────────────────────────────
  function _winRate(pair, strategy) {
    const entry = _registry[pair] && _registry[pair][strategy];
    if (!entry || (!entry.wins && !entry.losses)) return 0.5;  // default weight
    const total = entry.wins + entry.losses;
    return total ? entry.wins / total : 0.5;
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Run all strategies, return the best weighted signal. */
  function evaluate(pair, candles, analysis) {
    if (!Array.isArray(candles) || candles.length < 5 || !analysis) {
      return _neutral('NONE', ['Insufficient data']);
    }

    const weights = getStrategyWeights(pair);
    let best = null, bestScore = -1;

    for (const name of STRATEGIES) {
      try {
        const sig = evaluateStrategy(name, candles, analysis);
        const w = weights[name] || 1;
        const score = sig.direction !== 'NEUTRAL' ? sig.confidence * w : 0;
        if (score > bestScore) { bestScore = score; best = sig; }
      } catch (e) {
        MF.log('warn', 'StrategyEngine: error in', name, e.message);
      }
    }

    return best || _neutral('NONE', ['All strategies neutral']);
  }

  /** Run a single named strategy. */
  function evaluateStrategy(strategyName, candles, analysis) {
    const fn = _dispatch[strategyName];
    if (!fn) return _neutral(strategyName, ['Unknown strategy: ' + strategyName]);
    if (!Array.isArray(candles) || candles.length < 5 || !analysis) {
      return _neutral(strategyName, ['Insufficient data']);
    }
    return fn(candles, analysis);
  }

  /** Record a WIN/LOSS outcome for learning. */
  function recordOutcome(pair, strategy, direction, result) {
    if (!pair || !strategy) return;
    if (!_registry[pair]) _registry[pair] = {};
    if (!_registry[pair][strategy]) _registry[pair][strategy] = { wins: 0, losses: 0 };
    if (result === 'WIN') _registry[pair][strategy].wins++;
    else if (result === 'LOSS') _registry[pair][strategy].losses++;
    _saveRegistry();
    MF.bus.emit('strategy:outcome', { pair, strategy, direction, result });
  }

  /** Get current adaptive weights for a pair (0.5–2.0 range). */
  function getStrategyWeights(pair) {
    const weights = {};
    for (const name of STRATEGIES) {
      const wr = _winRate(pair, name);
      // Map win rate 0–1 to weight 0.5–2.0 (below 50% → penalised, above → boosted)
      weights[name] = 0.5 + wr * 1.5;
    }
    return weights;
  }

  /** Return list of strategy names. */
  function getAllStrategies() {
    return STRATEGIES.slice();
  }

  /** Return win/loss stats per strategy for a pair. */
  function getStrategyStats(pair) {
    const stats = {};
    for (const name of STRATEGIES) {
      const entry = _registry[pair] && _registry[pair][name];
      stats[name] = entry ? { wins: entry.wins, losses: entry.losses,
        winRate: (entry.wins + entry.losses) ? +(entry.wins / (entry.wins + entry.losses)).toFixed(3) : null }
        : { wins: 0, losses: 0, winRate: null };
    }
    return stats;
  }

  return {
    evaluate,
    evaluateStrategy,
    recordOutcome,
    getStrategyWeights,
    getAllStrategies,
    getStrategyStats,
  };

})();
