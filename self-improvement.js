/**
 * self-improvement.js  —  Trade Recording, Mistake Analysis & Self-Improvement
 *
 * Records completed trades, detects recurring mistakes, extracts lessons,
 * and emits actionable suggestions so MindFlare TradingClaw adapts over time.
 *
 * Globals used: MF (config/state/logging/event bus), StrategyEngine
 */

const SelfImprovement = (() => {
  'use strict';

  const STORAGE_KEY = 'mf_self_improvement';
  let _data = { mistakes: {}, lessons: {}, suggestions: [] };

  async function _load() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      if (stored[STORAGE_KEY]) _data = stored[STORAGE_KEY];
    } catch (e) { MF.log('warn', 'SelfImprovement: load failed:', e.message); }
  }

  async function _save() {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: _data }); }
    catch (e) { MF.log('warn', 'SelfImprovement: save failed:', e.message); }
  }

  _load();

  // ── Mistake catalogue ────────────────────────────────────────────────
  const MISTAKES = {
    WRONG_DIRECTION_TREND: 'Traded against the prevailing trend',
    HIGH_MARTINGALE_STEP:  'Entered at martingale step >= 3',
    LOW_CONFIDENCE_ENTRY:  'Entered with strategy confidence < 40',
    LOW_PAYOUT_PAIR:       'Traded a pair with payout below minimum',
    OVERTRADING:           'Too many trades in short window',
    STRATEGY_MISMATCH:     'Strategy historically poor for this pair',
  };

  // ── 1. Trade Recording ───────────────────────────────────────────────

  function recordTrade(trade) {
    if (!trade || !trade.pair) return;
    const max = MF.getConfig('maxTradeHistory') || 5000;
    const entry = {
      id: MF.uid(), pair: trade.pair,
      direction: trade.direction || 'CALL',
      investment: trade.investment || 0,
      result: trade.result || 'LOSS',
      profit: trade.profit || 0,
      strategy: trade.strategy || 'UNKNOWN',
      indicators: trade.indicators || {},
      confidence: trade.confidence || 0,
      martingaleStep: trade.martingaleStep || 0,
      payout: trade.payout || 0,
      timestamp: trade.timestamp || Date.now(),
    };

    MF.state.tradeHistory.push(entry);
    if (MF.state.tradeHistory.length > max)
      MF.state.tradeHistory = MF.state.tradeHistory.slice(-max);

    MF.saveState();
    MF.bus.emit('improvement:trade-recorded', entry);
    if (MF.getConfig('learningEnabled')) analyzeOutcome(entry);
  }

  // ── 2. Outcome Analysis ──────────────────────────────────────────────

  function analyzeOutcome(trade) {
    if (!trade) return;
    const found = [];

    if (trade.indicators && trade.indicators.trend) {
      const t = trade.indicators.trend;
      if ((trade.direction === 'CALL' && t === 'down') || (trade.direction === 'PUT' && t === 'up'))
        found.push('WRONG_DIRECTION_TREND');
    }
    if (trade.martingaleStep >= 3) found.push('HIGH_MARTINGALE_STEP');
    if (trade.confidence < 40 && trade.result === 'LOSS') found.push('LOW_CONFIDENCE_ENTRY');
    if (trade.payout && trade.payout < (MF.getConfig('minPayout') || 70) && trade.result === 'LOSS')
      found.push('LOW_PAYOUT_PAIR');

    if (typeof StrategyEngine !== 'undefined' && trade.strategy && trade.pair) {
      const s = StrategyEngine.getStrategyStats(trade.pair)[trade.strategy];
      if (s && s.winRate !== null && s.winRate < 0.4 && (s.wins + s.losses) >= 5)
        found.push('STRATEGY_MISMATCH');
    }

    const recent = MF.state.tradeHistory.filter(
      t => t.pair === trade.pair && (trade.timestamp - t.timestamp) < 600000
    );
    if (recent.length >= 5) found.push('OVERTRADING');

    for (const type of found) {
      _recordMistake(trade.pair, type, trade);
      MF.bus.emit('improvement:mistake-detected', { pair: trade.pair, type, trade });
    }
    if (trade.result === 'LOSS' && found.length) _extractLesson(trade.pair, found, trade);

    if (typeof StrategyEngine !== 'undefined' && trade.strategy && trade.pair)
      StrategyEngine.recordOutcome(trade.pair, trade.strategy, trade.direction, trade.result);

    if (found.length) _generateSuggestions(trade, found);
    _save();
  }

  // ── 3. Mistake Tracking ──────────────────────────────────────────────

  function _recordMistake(pair, type, trade) {
    if (!_data.mistakes[pair]) _data.mistakes[pair] = [];
    let entry = _data.mistakes[pair].find(m => m.type === type);
    if (!entry) { entry = { type, count: 0, lastSeen: 0, example: null }; _data.mistakes[pair].push(entry); }
    entry.count++; entry.lastSeen = trade.timestamp;
    if (!entry.example) entry.example = trade.id;
  }

  function getCommonMistakes(pair) {
    return (_data.mistakes[pair] || [])
      .map(m => ({ type: m.type, description: MISTAKES[m.type] || m.type, count: m.count, lastSeen: m.lastSeen }))
      .sort((a, b) => b.count - a.count);
  }

  // ── 4. Lesson Extraction ─────────────────────────────────────────────

  function _extractLesson(pair, mistakes, trade) {
    if (!_data.lessons[pair]) _data.lessons[pair] = [];
    const text = 'Avoid ' + mistakes.map(t => MISTAKES[t] || t).join(' + ') + ' on ' + pair;
    let lesson = _data.lessons[pair].find(l => l.text === text);
    if (!lesson) { lesson = { text, count: 0, lastSeen: 0 }; _data.lessons[pair].push(lesson); }
    lesson.count++; lesson.lastSeen = trade.timestamp;
  }

  function getLessons(pair) {
    return (_data.lessons[pair] || [])
      .map(l => ({ text: l.text, count: l.count, lastSeen: l.lastSeen }))
      .sort((a, b) => (b.count * 0.6 + b.lastSeen * 0.4) - (a.count * 0.6 + a.lastSeen * 0.4));
  }

  // ── 5. Strategy Performance ──────────────────────────────────────────

  function getStrategyPerformance(strategy) {
    const trades = MF.state.tradeHistory.filter(t => t.strategy === strategy);
    if (!trades.length)
      return { strategy, trades: 0, wins: 0, losses: 0, winRate: 0, totalProfit: 0 };
    const wins = trades.filter(t => t.result === 'WIN').length;
    const profit = trades.reduce((s, t) => s + (t.profit || 0), 0);
    return { strategy, trades: trades.length, wins, losses: trades.length - wins,
      winRate: +(wins / trades.length).toFixed(3), totalProfit: +profit.toFixed(2) };
  }

  // ── 6. Suggestion Engine ─────────────────────────────────────────────

  function _generateSuggestions(trade, mistakes) {
    const out = [];
    if (mistakes.includes('WRONG_DIRECTION_TREND'))
      out.push({ type: 'config', key: 'rsiPeriod', value: MF.getConfig('rsiPeriod') + 2,
        reason: 'Increase RSI period to better confirm trend direction' });
    if (mistakes.includes('HIGH_MARTINGALE_STEP')) {
      const steps = MF.getConfig('martingaleSteps') || 3;
      if (steps > 1) out.push({ type: 'config', key: 'martingaleSteps', value: steps - 1,
        reason: 'Reduce martingale steps — deep steps cause large losses' });
    }
    if (mistakes.includes('LOW_CONFIDENCE_ENTRY'))
      out.push({ type: 'config', key: 'minConfidence', value: 45,
        reason: 'Set minimum confidence threshold to 45 to filter weak signals' });
    if (mistakes.includes('STRATEGY_MISMATCH') && trade.strategy)
      out.push({ type: 'strategy', strategy: trade.strategy, pair: trade.pair,
        reason: trade.strategy + ' performs poorly on ' + trade.pair });
    if (mistakes.includes('OVERTRADING'))
      out.push({ type: 'behavior', action: 'pause',
        reason: 'Overtrading on ' + trade.pair + ' — take a 5-minute break' });

    for (const s of out) {
      _data.suggestions.push({ ...s, timestamp: trade.timestamp });
      MF.bus.emit('improvement:suggestion', s);
    }
    if (_data.suggestions.length > 50) _data.suggestions = _data.suggestions.slice(-50);
  }

  // ── 7. Statistics ────────────────────────────────────────────────────

  function _empty() {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalProfit: 0,
      avgProfit: 0, bestPair: null, bestPairProfit: 0, streak: { type: 'none', count: 0 } };
  }

  function getStats() {
    const trades = MF.state.tradeHistory;
    if (!trades.length) return _empty();
    const wins = trades.filter(t => t.result === 'WIN');
    const totalProf = trades.reduce((s, t) => s + (t.profit || 0), 0);
    const byPair = {};
    for (const t of trades) {
      if (!byPair[t.pair]) byPair[t.pair] = { profit: 0 };
      byPair[t.pair].profit += (t.profit || 0);
    }
    let bestPair = null, bestProfit = -Infinity;
    for (const [p, s] of Object.entries(byPair))
      if (s.profit > bestProfit) { bestProfit = s.profit; bestPair = p; }
    return { totalTrades: trades.length, wins: wins.length, losses: trades.length - wins.length,
      winRate: +(wins.length / trades.length).toFixed(3), totalProfit: +totalProf.toFixed(2),
      avgProfit: +(totalProf / trades.length).toFixed(2), bestPair, bestPairProfit: +bestProfit.toFixed(2),
      streak: getStreak() };
  }

  function getPairStats(pair) {
    const trades = MF.state.tradeHistory.filter(t => t.pair === pair);
    if (!trades.length) return _empty();
    const wins = trades.filter(t => t.result === 'WIN');
    const totalProf = trades.reduce((s, t) => s + (t.profit || 0), 0);
    return { pair, totalTrades: trades.length, wins: wins.length, losses: trades.length - wins.length,
      winRate: +(wins.length / trades.length).toFixed(3), totalProfit: +totalProf.toFixed(2),
      avgProfit: +(totalProf / trades.length).toFixed(2), streak: getStreak(pair) };
  }

  function getStreak(pair) {
    const trades = pair ? MF.state.tradeHistory.filter(t => t.pair === pair) : MF.state.tradeHistory;
    if (!trades.length) return { type: 'none', count: 0 };
    let type = 'none', count = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      const r = trades[i].result === 'WIN' ? 'win' : 'loss';
      if (type === 'none') { type = r; count = 1; } else if (r === type) count++; else break;
    }
    return { type, count };
  }

  // ── Public API ───────────────────────────────────────────────────────
  return { recordTrade, analyzeOutcome, getCommonMistakes, getLessons,
    getStrategyPerformance, getStats, getPairStats, getStreak };
})();
