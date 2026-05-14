/**
 * technical-engine.js  —  Technical Analysis & SMC/ICT Engine
 *
 * Core analysis module for MindFlare TradingClaw.
 * Computes 15 technical indicators, SMC/ICT concepts, 11 candlestick
 * patterns, and produces a weighted CALL/PUT/NEUTRAL signal with a
 * 0–100 confidence score.
 *
 * Consumes candle arrays of the shape:
 *   { time, open, high, low, close, volume }
 *
 * Reads period/param defaults from MF.getConfig() with sensible fallbacks.
 */

const TechnicalEngine = (() => {
  'use strict';

  // ── Helpers ────────────────────────────────────────────────────────

  /** Safely read a numeric config key with fallback. */
  function cfg(key, fallback) {
    const v = MF.getConfig(key);
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  /** True if the candle array is long enough for the given period. */
  function enough(candles, needed) {
    return Array.isArray(candles) && candles.length >= needed;
  }

  /** Safe number — returns 0 for NaN / undefined / null. */
  function safe(n) {
    return (typeof n === 'number' && isFinite(n)) ? n : 0;
  }

  /** Pick the last N elements of an array (returns new array). */
  function last(arr, n) {
    return arr.slice(-n);
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION 1 — TECHNICAL INDICATORS
  // ══════════════════════════════════════════════════════════════════

  // ── 1. SMA (Simple Moving Average) ────────────────────────────────
  function SMA(candles, period) {
    period = period || cfg('rsiPeriod', 14);
    if (!enough(candles, period)) return null;
    const slice = last(candles, period);
    const sum = slice.reduce((s, c) => s + safe(c.close), 0);
    return sum / period;
  }

  // ── 2. EMA (Exponential Moving Average) ───────────────────────────
  function EMA(candles, period) {
    period = period || cfg('emaPeriods', [9])[0];
    if (!enough(candles, period)) return null;

    const k = 2 / (period + 1);
    const closes = candles.map(c => safe(c.close));
    let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;

    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
  }

  /** Internal: EMA from a pre-computed array of values. */
  function emaFromArray(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((s, v) => s + safe(v), 0) / period;
    for (let i = period; i < values.length; i++) {
      ema = safe(values[i]) * k + ema * (1 - k);
    }
    return ema;
  }

  // ── 3. RSI (Relative Strength Index) ──────────────────────────────
  function RSI(candles, period) {
    period = period || cfg('rsiPeriod', 14);
    if (!enough(candles, period + 1)) return null;

    const closes = candles.map(c => safe(c.close));
    let gains = 0, losses = 0;

    // Seed with simple average of first `period` deltas
    for (let i = 1; i <= period; i++) {
      const delta = closes[i] - closes[i - 1];
      if (delta > 0) gains += delta; else losses -= delta;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Smoothed (Wilder) moving average
    for (let i = period + 1; i < closes.length; i++) {
      const delta = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (delta > 0 ? delta : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (delta < 0 ? -delta : 0)) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // ── 4. MACD ───────────────────────────────────────────────────────
  function MACD(candles) {
    const fast = cfg('macdFast', 12);
    const slow = cfg('macdSlow', 26);
    const sig  = cfg('macdSignal', 9);

    if (!enough(candles, slow + sig)) return null;

    const closes = candles.map(c => safe(c.close));

    // Compute full EMA series for fast and slow
    const fastEmaArr = _emaSeries(closes, fast);
    const slowEmaArr = _emaSeries(closes, slow);

    if (!fastEmaArr || !slowEmaArr) return null;

    // MACD line = fast EMA − slow EMA (aligned to slowEmaArr start)
    const macdLine = [];
    const offset = fastEmaArr.length - slowEmaArr.length;
    for (let i = 0; i < slowEmaArr.length; i++) {
      macdLine.push(safe(fastEmaArr[i + offset]) - safe(slowEmaArr[i]));
    }

    const signalLine = emaFromArray(macdLine, sig);
    if (signalLine === null) return null;

    const macdValue = macdLine[macdLine.length - 1];
    const histogram = macdValue - signalLine;

    return { macd: macdValue, signal: signalLine, histogram };
  }

  /** Build an array of EMA values — one per close price after the seed. */
  function _emaSeries(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((s, v) => s + safe(v), 0) / period;
    const result = new Array(period).fill(null);
    result[period - 1] = ema;
    for (let i = period; i < closes.length; i++) {
      ema = safe(closes[i]) * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  // ── 5. Bollinger Bands ────────────────────────────────────────────
  function BollingerBands(candles, period, stdDevMul) {
    period     = period     || cfg('bollingerPeriod', 20);
    stdDevMul  = stdDevMul  || cfg('bollingerStdDev', 2);
    if (!enough(candles, period)) return null;

    const slice = last(candles, period);
    const closes = slice.map(c => safe(c.close));
    const mean = closes.reduce((s, v) => s + v, 0) / period;

    const variance = closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper:  mean + stdDevMul * stdDev,
      middle: mean,
      lower:  mean - stdDevMul * stdDev,
      bandwidth: (2 * stdDevMul * stdDev) / (mean || 1),
      percentB: closes.length
        ? (closes[closes.length - 1] - (mean - stdDevMul * stdDev)) /
          ((2 * stdDevMul * stdDev) || 1)
        : 0.5,
    };
  }

  // ── 6. ATR (Average True Range) ───────────────────────────────────
  function ATR(candles, period) {
    period = period || cfg('atrPeriod', 14);
    if (!enough(candles, period + 1)) return null;

    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      const tr = Math.max(
        safe(c.high) - safe(c.low),
        Math.abs(safe(c.high) - safe(p.close)),
        Math.abs(safe(c.low)  - safe(p.close))
      );
      trs.push(tr);
    }

    // Seed with simple average
    let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
  }

  // ── 7. Stochastic Oscillator (%K, %D) ─────────────────────────────
  function Stochastic(candles, kPeriod, dPeriod) {
    kPeriod = kPeriod || cfg('stochasticK', 14);
    dPeriod = dPeriod || cfg('stochasticD', 3);
    if (!enough(candles, kPeriod + dPeriod - 1)) return null;

    // Compute %K series
    const kSeries = [];
    for (let i = kPeriod - 1; i < candles.length; i++) {
      const slice = candles.slice(i - kPeriod + 1, i + 1);
      const highest = Math.max(...slice.map(c => safe(c.high)));
      const lowest  = Math.min(...slice.map(c => safe(c.low)));
      const close   = safe(candles[i].close);
      const range   = highest - lowest;
      kSeries.push(range === 0 ? 50 : ((close - lowest) / range) * 100);
    }

    const k = kSeries[kSeries.length - 1];
    const dSlice = last(kSeries, dPeriod);
    const d = dSlice.reduce((s, v) => s + v, 0) / dPeriod;

    return { k, d };
  }

  // ── 8. ADX (Average Directional Index) ────────────────────────────
  function ADX(candles, period) {
    period = period || 14;
    if (!enough(candles, period * 2 + 1)) return null;

    // Compute +DM, -DM, and TR arrays
    const plusDMs = [], minusDMs = [], trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      const upMove   = safe(c.high) - safe(p.high);
      const downMove = safe(p.low)  - safe(c.low);

      plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);

      trs.push(Math.max(
        safe(c.high) - safe(c.low),
        Math.abs(safe(c.high) - safe(p.close)),
        Math.abs(safe(c.low)  - safe(p.close))
      ));
    }

    // Wilder smooth over `period`
    const smooth = (arr) => {
      let val = arr.slice(0, period).reduce((s, v) => s + v, 0);
      const result = [val];
      for (let i = period; i < arr.length; i++) {
        val = val - (val / period) + arr[i];
        result.push(val);
      }
      return result;
    };

    const sTR = smooth(trs);
    const sPDM = smooth(plusDMs);
    const sMDM = smooth(minusDMs);

    const dxArr = [];
    for (let i = 0; i < sTR.length; i++) {
      const pdi = sTR[i] ? (sPDM[i] / sTR[i]) * 100 : 0;
      const mdi = sTR[i] ? (sMDM[i] / sTR[i]) * 100 : 0;
      const dxSum = pdi + mdi;
      dxArr.push(dxSum ? (Math.abs(pdi - mdi) / dxSum) * 100 : 0);
    }

    // ADX = Wilder-smoothed DX
    if (dxArr.length < period) return null;
    let adx = dxArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < dxArr.length; i++) {
      adx = (adx * (period - 1) + dxArr[i]) / period;
    }

    // Also return latest +DI / -DI
    const lastIdx = sTR.length - 1;
    const plusDI  = sTR[lastIdx] ? (sPDM[lastIdx] / sTR[lastIdx]) * 100 : 0;
    const minusDI = sTR[lastIdx] ? (sMDM[lastIdx] / sTR[lastIdx]) * 100 : 0;

    return { adx, plusDI, minusDI };
  }

  // ── 9. CCI (Commodity Channel Index) ──────────────────────────────
  function CCI(candles, period) {
    period = period || 20;
    if (!enough(candles, period)) return null;

    const slice = last(candles, period);
    const tps = slice.map(c => (safe(c.high) + safe(c.low) + safe(c.close)) / 3);
    const meanTP = tps.reduce((s, v) => s + v, 0) / period;
    const meanDev = tps.reduce((s, v) => s + Math.abs(v - meanTP), 0) / period;

    return meanDev === 0 ? 0 : (tps[tps.length - 1] - meanTP) / (0.015 * meanDev);
  }

  // ── 10. Williams %R ───────────────────────────────────────────────
  function WilliamsR(candles, period) {
    period = period || 14;
    if (!enough(candles, period)) return null;

    const slice = last(candles, period);
    const highest = Math.max(...slice.map(c => safe(c.high)));
    const lowest  = Math.min(...slice.map(c => safe(c.low)));
    const close   = safe(slice[slice.length - 1].close);
    const range   = highest - lowest;

    return range === 0 ? -50 : ((highest - close) / range) * -100;
  }

  // ── 11. VWAP (Volume Weighted Average Price) ──────────────────────
  function VWAP(candles) {
    if (!enough(candles, 1)) return null;

    let cumTPV = 0, cumVol = 0;
    for (const c of candles) {
      const tp  = (safe(c.high) + safe(c.low) + safe(c.close)) / 3;
      const vol = safe(c.volume);
      cumTPV += tp * vol;
      cumVol += vol;
    }
    return cumVol === 0 ? null : cumTPV / cumVol;
  }

  // ── 12. Parabolic SAR ─────────────────────────────────────────────
  function ParabolicSAR(candles, step, max) {
    step = step || 0.02;
    max  = max  || 0.20;
    if (!enough(candles, 5)) return null;

    let isLong = safe(candles[1].close) > safe(candles[0].close);
    let af = step;
    let ep = isLong ? safe(candles[1].high) : safe(candles[1].low);
    let sar = isLong ? safe(candles[0].low) : safe(candles[0].high);

    for (let i = 2; i < candles.length; i++) {
      const prevSAR = sar;

      // SAR carries forward
      sar = prevSAR + af * (ep - prevSAR);

      if (isLong) {
        sar = Math.min(sar, safe(candles[i - 1].low), safe(candles[i - 2].low));
        if (safe(candles[i].low) < sar) {
          // Reverse to short
          isLong = false;
          sar = ep;
          ep = safe(candles[i].low);
          af = step;
        } else {
          if (safe(candles[i].high) > ep) {
            ep = safe(candles[i].high);
            af = Math.min(af + step, max);
          }
        }
      } else {
        sar = Math.max(sar, safe(candles[i - 1].high), safe(candles[i - 2].high));
        if (safe(candles[i].high) > sar) {
          // Reverse to long
          isLong = true;
          sar = ep;
          ep = safe(candles[i].high);
          af = step;
        } else {
          if (safe(candles[i].low) < ep) {
            ep = safe(candles[i].low);
            af = Math.min(af + step, max);
          }
        }
      }
    }

    return { sar, trend: isLong ? 'up' : 'down' };
  }

  // ── 13. Ichimoku Cloud ────────────────────────────────────────────
  function Ichimoku(candles) {
    // Standard periods: Tenkan 9, Kijun 26, Senkou B 52
    const tenkanP = 9, kijunP = 26, senkouBP = 52;
    if (!enough(candles, senkouBP)) return null;

    /** Midpoint of highest high and lowest low over `period`. */
    const midpoint = (start, period) => {
      const slice = candles.slice(start, start + period);
      const h = Math.max(...slice.map(c => safe(c.high)));
      const l = Math.min(...slice.map(c => safe(c.low)));
      return (h + l) / 2;
    };

    const n = candles.length;
    const tenkan = midpoint(n - tenkanP, tenkanP);
    const kijun  = midpoint(n - kijunP,  kijunP);
    const senkouA = (tenkan + kijun) / 2;
    const senkouB = midpoint(n - senkouBP, senkouBP);
    const chikou  = safe(candles[n - 1].close);

    return { tenkan, kijun, senkouA, senkouB, chikou };
  }

  // ── 14. OBV (On Balance Volume) ───────────────────────────────────
  function OBV(candles) {
    if (!enough(candles, 2)) return null;

    let obv = 0;
    for (let i = 1; i < candles.length; i++) {
      const prev = safe(candles[i - 1].close);
      const curr = safe(candles[i].close);
      const vol  = safe(candles[i].volume);
      if (curr > prev)      obv += vol;
      else if (curr < prev) obv -= vol;
    }
    return obv;
  }

  // ── 15. MFI (Money Flow Index) ────────────────────────────────────
  function MFI(candles, period) {
    period = period || 14;
    if (!enough(candles, period + 1)) return null;

    let posMF = 0, negMF = 0;
    const slice = last(candles, period + 1);

    for (let i = 1; i < slice.length; i++) {
      const prevTP = (safe(slice[i - 1].high) + safe(slice[i - 1].low) + safe(slice[i - 1].close)) / 3;
      const currTP = (safe(slice[i].high)     + safe(slice[i].low)     + safe(slice[i].close))     / 3;
      const mf = currTP * safe(slice[i].volume);

      if (currTP > prevTP) posMF += mf;
      else if (currTP < prevTP) negMF += mf;
    }

    if (negMF === 0) return 100;
    return 100 - (100 / (1 + posMF / negMF));
  }


  // ══════════════════════════════════════════════════════════════════
  //  SECTION 2 — SMC / ICT CONCEPTS
  // ══════════════════════════════════════════════════════════════════

  // ── Order Block Detection ─────────────────────────────────────────
  /** Returns array of { index, type:'bullish'|'bearish', high, low } */
  function detectOrderBlocks(candles, lookback) {
    lookback = lookback || 10;
    if (!enough(candles, 3)) return [];

    const result = [];
    const recent = last(candles, lookback);

    for (let i = 1; i < recent.length - 1; i++) {
      const prev = recent[i - 1];
      const curr = recent[i];
      const next = recent[i + 1];

      // Bullish OB: bearish candle followed by strong bullish move
      if (safe(curr.close) < safe(curr.open)) { // bearish candle
        const moveUp = safe(next.close) - safe(next.open);
        const bodyCurr = safe(curr.open) - safe(curr.close);
        if (moveUp > bodyCurr * 1.5) {
          result.push({
            index: i,
            type: 'bullish',
            high: safe(curr.high),
            low:  safe(curr.low),
          });
        }
      }

      // Bearish OB: bullish candle followed by strong bearish move
      if (safe(curr.close) > safe(curr.open)) { // bullish candle
        const moveDown = safe(next.open) - safe(next.close);
        const bodyCurr = safe(curr.close) - safe(curr.open);
        if (moveDown > bodyCurr * 1.5) {
          result.push({
            index: i,
            type: 'bearish',
            high: safe(curr.high),
            low:  safe(curr.low),
          });
        }
      }
    }

    return result;
  }

  // ── Fair Value Gap (FVG) Detection ────────────────────────────────
  /** Returns array of { index, type:'bullish'|'bearish', top, bottom, midpoint } */
  function detectFVGs(candles, lookback) {
    lookback = lookback || 20;
    if (!enough(candles, 3)) return [];

    const result = [];
    const recent = last(candles, lookback);

    for (let i = 2; i < recent.length; i++) {
      const c1 = recent[i - 2];
      const c3 = recent[i];

      // Bullish FVG: candle[i-2] high < candle[i] low (gap up)
      if (safe(c1.high) < safe(c3.low)) {
        result.push({
          index: i,
          type: 'bullish',
          top:    safe(c3.low),
          bottom: safe(c1.high),
          midpoint: (safe(c3.low) + safe(c1.high)) / 2,
        });
      }

      // Bearish FVG: candle[i-2] low > candle[i] high (gap down)
      if (safe(c1.low) > safe(c3.high)) {
        result.push({
          index: i,
          type: 'bearish',
          top:    safe(c1.low),
          bottom: safe(c3.high),
          midpoint: (safe(c1.low) + safe(c3.high)) / 2,
        });
      }
    }

    return result;
  }

  // ── Break of Structure (BOS) ──────────────────────────────────────
  /** Returns array of { index, type:'bullish'|'bearish', level } */
  function detectBOS(candles, lookback) {
    lookback = lookback || 30;
    if (!enough(candles, 5)) return [];

    const result = [];
    const recent = last(candles, lookback);

    // Find recent swing highs and lows
    for (let i = 2; i < recent.length - 2; i++) {
      const isSwingHigh = safe(recent[i].high) > safe(recent[i - 1].high) &&
                          safe(recent[i].high) > safe(recent[i - 2].high) &&
                          safe(recent[i].high) > safe(recent[i + 1].high) &&
                          safe(recent[i].high) > safe(recent[i + 2].high);
      const isSwingLow  = safe(recent[i].low) < safe(recent[i - 1].low) &&
                          safe(recent[i].low) < safe(recent[i - 2].low) &&
                          safe(recent[i].low) < safe(recent[i + 1].low) &&
                          safe(recent[i].low) < safe(recent[i + 2].low);

      if (isSwingHigh || isSwingLow) {
        // Check if later candles break the level
        const level = isSwingHigh ? safe(recent[i].high) : safe(recent[i].low);
        for (let j = i + 1; j < recent.length; j++) {
          if (isSwingHigh && safe(recent[j].close) > level) {
            result.push({ index: j, type: 'bullish', level });
            break;
          }
          if (isSwingLow && safe(recent[j].close) < level) {
            result.push({ index: j, type: 'bearish', level });
            break;
          }
        }
      }
    }

    return result;
  }

  // ── Change of Character (CHOCH) ───────────────────────────────────
  /** Returns array of { index, type:'bullish'|'bearish', level } */
  function detectCHOCH(candles, lookback) {
    lookback = lookback || 40;
    if (!enough(candles, 6)) return [];

    const result = [];
    const recent = last(candles, lookback);

    // CHOCH = the FIRST break that flips the trend direction
    // We track higher-highs / lower-lows to detect the flip
    let prevTrend = null;

    for (let i = 3; i < recent.length; i++) {
      const prevHigh = safe(recent[i - 1].high);
      const prevLow  = safe(recent[i - 1].low);
      const currClose = safe(recent[i].close);
      const currHigh  = safe(recent[i].high);
      const currLow   = safe(recent[i].low);

      // Uptrend: making higher highs — CHOCH when a lower low breaks
      if (prevTrend !== 'bearish' && currLow < prevLow && currClose < prevLow) {
        result.push({ index: i, type: 'bearish', level: prevLow });
        prevTrend = 'bearish';
      }
      // Downtrend: making lower lows — CHOCH when a higher high breaks
      if (prevTrend !== 'bullish' && currHigh > prevHigh && currClose > prevHigh) {
        result.push({ index: i, type: 'bullish', level: prevHigh });
        prevTrend = 'bullish';
      }
    }

    return result;
  }

  // ── Liquidity Sweep Detection ─────────────────────────────────────
  /** Returns array of { index, type:'buy_side'|'sell_side', sweptLevel } */
  function detectLiquiditySweeps(candles, lookback) {
    lookback = lookback || 20;
    if (!enough(candles, 5)) return [];

    const result = [];
    const recent = last(candles, lookback);

    // Find equal highs / equal lows (liquidity pools)
    for (let i = 1; i < recent.length - 2; i++) {
      const tol = ATR([recent[i]]) || safe(recent[i].high) - safe(recent[i].low) || 1;

      // Equal highs (buy-side liquidity)
      for (let j = i + 1; j < recent.length - 1; j++) {
        if (Math.abs(safe(recent[i].high) - safe(recent[j].high)) < tol * 0.3) {
          // Check if the next candle sweeps above then reverses
          const next = recent[j + 1];
          if (safe(next.high) > safe(recent[j].high) &&
              safe(next.close) < safe(recent[j].high)) {
            result.push({
              index: j + 1,
              type: 'buy_side',
              sweptLevel: safe(recent[j].high),
            });
          }
        }
      }

      // Equal lows (sell-side liquidity)
      for (let j = i + 1; j < recent.length - 1; j++) {
        if (Math.abs(safe(recent[i].low) - safe(recent[j].low)) < tol * 0.3) {
          const next = recent[j + 1];
          if (safe(next.low) < safe(recent[j].low) &&
              safe(next.close) > safe(recent[j].low)) {
            result.push({
              index: j + 1,
              type: 'sell_side',
              sweptLevel: safe(recent[j].low),
            });
          }
        }
      }
    }

    return result;
  }

  // ── Premium / Discount Zones ──────────────────────────────────────
  /** Returns { premium: [0–1], discount: [0–1], equilibrium } */
  function calcPremiumDiscount(candles, lookback) {
    lookback = lookback || 50;
    if (!enough(candles, 2)) return { premium: 0.5, discount: 0.5, equilibrium: 0 };

    const recent = last(candles, lookback);
    const highest = Math.max(...recent.map(c => safe(c.high)));
    const lowest  = Math.min(...recent.map(c => safe(c.low)));
    const range   = highest - lowest;
    const current = safe(recent[recent.length - 1].close);

    if (range === 0) return { premium: 0.5, discount: 0.5, equilibrium: current };

    const equilibrium = (highest + lowest) / 2;
    const position = (current - lowest) / range;

    return {
      premium:     position,           // 0 = deep discount, 1 = deep premium
      discount:    1 - position,
      equilibrium: equilibrium,
      rangeHigh:   highest,
      rangeLow:    lowest,
    };
  }

  // ── Killzone Sessions ─────────────────────────────────────────────
  /** Returns { name, active: boolean } for each session. */
  function getKillzones() {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const t = utcH * 60 + utcM; // minutes since midnight UTC

    // London: 07:00–16:00 UTC
    // New York: 12:00–21:00 UTC
    // Asian: 00:00–09:00 UTC
    return {
      london:   { name: 'London',   active: t >= 420  && t <= 960 },
      newyork:  { name: 'New York', active: t >= 720  && t <= 1260 },
      asian:    { name: 'Asian',    active: t >= 0    && t <= 540 },
    };
  }


  // ══════════════════════════════════════════════════════════════════
  //  SECTION 3 — CANDLESTICK PATTERNS
  // ══════════════════════════════════════════════════════════════════

  /** Body size (absolute). */
  function bodySize(c) { return Math.abs(safe(c.close) - safe(c.open)); }

  /** Full range (high − low). */
  function rangeSize(c) { return safe(c.high) - safe(c.low); }

  /** True if the candle is bullish (close > open). */
  function isBullish(c) { return safe(c.close) > safe(c.open); }

  /** Upper wick length. */
  function upperWick(c) { return safe(c.high) - Math.max(safe(c.open), safe(c.close)); }

  /** Lower wick length. */
  function lowerWick(c) { return Math.min(safe(c.open), safe(c.close)) - safe(c.low); }

  /** Average body size over the last N candles (for context). */
  function avgBody(candles, n) {
    const slice = last(candles, n);
    return slice.reduce((s, c) => s + bodySize(c), 0) / (slice.length || 1);
  }

  // ── 1. Doji ───────────────────────────────────────────────────────
  function patternDoji(candles) {
    if (!enough(candles, 1)) return null;
    const c = candles[candles.length - 1];
    const body = bodySize(c);
    const range = rangeSize(c);
    if (range === 0) return null;
    // Doji: body < 10% of total range
    if (body / range > 0.1) return null;
    return { name: 'Doji', type: 'neutral', confidence: Math.round((1 - body / range) * 80) };
  }

  // ── 2. Hammer ─────────────────────────────────────────────────────
  function patternHammer(candles) {
    if (!enough(candles, 2)) return null;
    const c = candles[candles.length - 1];
    const body = bodySize(c);
    const range = rangeSize(c);
    if (range === 0) return null;
    // Small body at top, long lower wick (≥ 2× body), tiny upper wick
    if (lowerWick(c) < body * 2) return null;
    if (upperWick(c) > body * 0.5) return null;
    // Should appear in downtrend
    const prev = candles[candles.length - 2];
    if (safe(prev.close) > safe(prev.open)) return null; // previous not bearish
    return { name: 'Hammer', type: 'bullish', confidence: 70 };
  }

  // ── 3. Inverted Hammer ────────────────────────────────────────────
  function patternInvertedHammer(candles) {
    if (!enough(candles, 2)) return null;
    const c = candles[candles.length - 1];
    const body = bodySize(c);
    const range = rangeSize(c);
    if (range === 0) return null;
    if (upperWick(c) < body * 2) return null;
    if (lowerWick(c) > body * 0.5) return null;
    const prev = candles[candles.length - 2];
    if (safe(prev.close) > safe(prev.open)) return null;
    return { name: 'Inverted Hammer', type: 'bullish', confidence: 60 };
  }

  // ── 4. Shooting Star ──────────────────────────────────────────────
  function patternShootingStar(candles) {
    if (!enough(candles, 2)) return null;
    const c = candles[candles.length - 1];
    const body = bodySize(c);
    const range = rangeSize(c);
    if (range === 0) return null;
    if (upperWick(c) < body * 2) return null;
    if (lowerWick(c) > body * 0.5) return null;
    const prev = candles[candles.length - 2];
    if (safe(prev.close) < safe(prev.open)) return null; // previous not bullish
    return { name: 'Shooting Star', type: 'bearish', confidence: 70 };
  }

  // ── 5. Engulfing (bullish / bearish) ──────────────────────────────
  function patternEngulfing(candles) {
    if (!enough(candles, 2)) return null;
    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];

    // Bullish engulfing: prev bearish, curr bullish, curr body engulfs prev body
    if (!isBullish(prev) && isBullish(curr) &&
        safe(curr.open) <= safe(prev.close) &&
        safe(curr.close) >= safe(prev.open)) {
      return { name: 'Bullish Engulfing', type: 'bullish', confidence: 75 };
    }

    // Bearish engulfing: prev bullish, curr bearish, curr body engulfs prev body
    if (isBullish(prev) && !isBullish(curr) &&
        safe(curr.open) >= safe(prev.close) &&
        safe(curr.close) <= safe(prev.open)) {
      return { name: 'Bearish Engulfing', type: 'bearish', confidence: 75 };
    }

    return null;
  }

  // ── 6. Morning Star ───────────────────────────────────────────────
  function patternMorningStar(candles) {
    if (!enough(candles, 3)) return null;
    const c1 = candles[candles.length - 3]; // large bearish
    const c2 = candles[candles.length - 2]; // small body
    const c3 = candles[candles.length - 1]; // large bullish

    if (isBullish(c1) || !isBullish(c3)) return null; // c1 bearish, c3 bullish
    const avg = avgBody(candles, 10);
    if (bodySize(c2) > avg * 0.5) return null; // c2 must be small
    if (bodySize(c3) < avg * 0.8) return null;  // c3 must be sizable
    if (safe(c3.close) < (safe(c1.open) + safe(c1.close)) / 2) return null;
    return { name: 'Morning Star', type: 'bullish', confidence: 80 };
  }

  // ── 7. Evening Star ───────────────────────────────────────────────
  function patternEveningStar(candles) {
    if (!enough(candles, 3)) return null;
    const c1 = candles[candles.length - 3]; // large bullish
    const c2 = candles[candles.length - 2]; // small body
    const c3 = candles[candles.length - 1]; // large bearish

    if (!isBullish(c1) || isBullish(c3)) return null;
    const avg = avgBody(candles, 10);
    if (bodySize(c2) > avg * 0.5) return null;
    if (bodySize(c3) < avg * 0.8) return null;
    if (safe(c3.close) > (safe(c1.open) + safe(c1.close)) / 2) return null;
    return { name: 'Evening Star', type: 'bearish', confidence: 80 };
  }

  // ── 8. Three White Soldiers ───────────────────────────────────────
  function patternThreeWhiteSoldiers(candles) {
    if (!enough(candles, 3)) return null;
    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 1];

    if (!isBullish(c1) || !isBullish(c2) || !isBullish(c3)) return null;
    // Each opens within previous body and closes higher
    if (safe(c2.open) < safe(c1.close) * 0.5 + safe(c1.open) * 0.5) return null;
    if (safe(c3.open) < safe(c2.close) * 0.5 + safe(c2.open) * 0.5) return null;
    if (safe(c2.close) <= safe(c1.close)) return null;
    if (safe(c3.close) <= safe(c2.close)) return null;
    return { name: 'Three White Soldiers', type: 'bullish', confidence: 85 };
  }

  // ── 9. Three Black Crows ──────────────────────────────────────────
  function patternThreeBlackCrows(candles) {
    if (!enough(candles, 3)) return null;
    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 1];

    if (isBullish(c1) || isBullish(c2) || isBullish(c3)) return null;
    if (safe(c2.open) > safe(c1.close) * 0.5 + safe(c1.open) * 0.5) return null;
    if (safe(c3.open) > safe(c2.close) * 0.5 + safe(c2.open) * 0.5) return null;
    if (safe(c2.close) >= safe(c1.close)) return null;
    if (safe(c3.close) >= safe(c2.close)) return null;
    return { name: 'Three Black Crows', type: 'bearish', confidence: 85 };
  }

  // ── 10. Harami (bullish / bearish) ────────────────────────────────
  function patternHarami(candles) {
    if (!enough(candles, 2)) return null;
    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];

    // Bullish harami: large bearish prev, small bullish curr inside prev body
    if (!isBullish(prev) && isBullish(curr) &&
        safe(curr.open) > safe(prev.close) &&
        safe(curr.close) < safe(prev.open)) {
      return { name: 'Bullish Harami', type: 'bullish', confidence: 60 };
    }

    // Bearish harami: large bullish prev, small bearish curr inside prev body
    if (isBullish(prev) && !isBullish(curr) &&
        safe(curr.open) < safe(prev.close) &&
        safe(curr.close) > safe(prev.open)) {
      return { name: 'Bearish Harami', type: 'bearish', confidence: 60 };
    }

    return null;
  }

  // ── 11. Spinning Top ──────────────────────────────────────────────
  function patternSpinningTop(candles) {
    if (!enough(candles, 1)) return null;
    const c = candles[candles.length - 1];
    const body = bodySize(c);
    const range = rangeSize(c);
    if (range === 0) return null;
    // Body is small (10–30% of range), both wicks present
    const ratio = body / range;
    if (ratio < 0.1 || ratio > 0.35) return null;
    if (upperWick(c) < body * 0.5) return null;
    if (lowerWick(c) < body * 0.5) return null;
    return { name: 'Spinning Top', type: 'neutral', confidence: 55 };
  }

  /** Run all pattern detectors and return matched patterns. */
  function detectAllPatterns(candles) {
    const detectors = [
      patternDoji, patternHammer, patternInvertedHammer,
      patternShootingStar, patternEngulfing, patternMorningStar,
      patternEveningStar, patternThreeWhiteSoldiers, patternThreeBlackCrows,
      patternHarami, patternSpinningTop,
    ];
    const found = [];
    for (const fn of detectors) {
      try {
        const r = fn(candles);
        if (r) found.push(r);
      } catch (_) { /* skip broken detector */ }
    }
    return found;
  }


  // ══════════════════════════════════════════════════════════════════
  //  SECTION 4 — HELPER METHODS
  // ══════════════════════════════════════════════════════════════════

  // ── getTrend(candles) ─────────────────────────────────────────────
  /**
   * Determines trend direction and strength from EMA alignment and ADX.
   * Returns { direction: 'up'|'down'|'sideways', strength: 0–100 }
   */
  function getTrend(candles) {
    if (!enough(candles, 50)) {
      return { direction: 'sideways', strength: 0 };
    }

    const emaPeriods = cfg('emaPeriods', [9, 21, 50, 200]);
    const ema9  = EMA(candles, emaPeriods[0] || 9);
    const ema21 = EMA(candles, emaPeriods[1] || 21);
    const ema50 = EMA(candles, emaPeriods[2] || 50);
    const adxData = ADX(candles, 14);

    if (ema9 === null || ema21 === null || ema50 === null) {
      return { direction: 'sideways', strength: 0 };
    }

    // Score alignment: +1 per bullish alignment, −1 per bearish
    let score = 0;
    if (ema9 > ema21)  score++;
    if (ema21 > ema50) score++;
    if (ema9 > ema50)  score++;
    if (ema9 < ema21)  score--;
    if (ema21 < ema50) score--;
    if (ema9 < ema50)  score--;

    const adxVal = adxData ? adxData.adx : 0;
    // Strength from ADX (0–100 scale; ADX > 25 = trending)
    const adxStrength = Math.min(100, (adxVal / 50) * 100);

    let direction;
    if (score >= 2) direction = 'up';
    else if (score <= -2) direction = 'down';
    else direction = 'sideways';

    // Blend directional score into strength
    const scoreStrength = Math.abs(score) / 3 * 100;
    const strength = Math.round((scoreStrength * 0.4 + adxStrength * 0.6));

    return { direction, strength: MF.clamp(strength, 0, 100) };
  }

  // ── getSupportResistance(candles) ─────────────────────────────────
  /**
   * Finds support and resistance levels using swing-point clustering.
   * Returns { supports: [price], resistances: [price] }
   */
  function getSupportResistance(candles, lookback) {
    lookback = lookback || 50;
    if (!enough(candles, 5)) return { supports: [], resistances: [] };

    const recent = last(candles, lookback);
    const swingHighs = [];
    const swingLows  = [];

    for (let i = 2; i < recent.length - 2; i++) {
      if (safe(recent[i].high) > safe(recent[i - 1].high) &&
          safe(recent[i].high) > safe(recent[i - 2].high) &&
          safe(recent[i].high) > safe(recent[i + 1].high) &&
          safe(recent[i].high) > safe(recent[i + 2].high)) {
        swingHighs.push(safe(recent[i].high));
      }
      if (safe(recent[i].low) < safe(recent[i - 1].low) &&
          safe(recent[i].low) < safe(recent[i - 2].low) &&
          safe(recent[i].low) < safe(recent[i + 1].low) &&
          safe(recent[i].low) < safe(recent[i + 2].low)) {
        swingLows.push(safe(recent[i].low));
      }
    }

    // Cluster nearby levels (within 0.3 × ATR)
    const atrVal = ATR(candles) || 0;
    const clusterTolerance = atrVal * 0.3 || 0.0001;

    const cluster = (levels) => {
      if (!levels.length) return [];
      levels.sort((a, b) => a - b);
      const groups = [[levels[0]]];
      for (let i = 1; i < levels.length; i++) {
        const lastGroup = groups[groups.length - 1];
        if (levels[i] - lastGroup[0] < clusterTolerance) {
          lastGroup.push(levels[i]);
        } else {
          groups.push([levels[i]]);
        }
      }
      return groups.map(g => +(g.reduce((s, v) => s + v, 0) / g.length).toFixed(5));
    };

    const current = safe(recent[recent.length - 1].close);
    const allHighs = cluster(swingHighs).filter(l => l > current);
    const allLows  = cluster(swingLows).filter(l => l < current);

    return {
      resistances: allHighs.slice(0, 3),  // top 3 above price
      supports:    allLows.slice(-3).reverse(),  // top 3 below price
    };
  }

  // ── getVolatility(candles) ────────────────────────────────────────
  /**
   * Returns a normalised volatility score 0–100 based on ATR relative
   * to recent average ATR, plus Bollinger Bandwidth.
   */
  function getVolatility(candles) {
    if (!enough(candles, 20)) return { score: 50, atr: 0, bbWidth: 0 };

    const atrVal = ATR(candles) || 0;
    const bb     = BollingerBands(candles) || { bandwidth: 0 };

    // Normalise ATR as percentage of price
    const price = safe(candles[candles.length - 1].close);
    const atrPct = price ? (atrVal / price) * 100 : 0;

    // Typical forex/oil ATR%: 0.1–2.0 → map to 0–100
    const atrScore = MF.clamp(atrPct * 50, 0, 100);
    const bbScore  = MF.clamp(bb.bandwidth * 500, 0, 100);

    const score = Math.round(atrScore * 0.6 + bbScore * 0.4);

    return { score: MF.clamp(score, 0, 100), atr: atrVal, bbWidth: bb.bandwidth };
  }


  // ══════════════════════════════════════════════════════════════════
  //  SECTION 5 — MAIN ANALYSIS FUNCTION
  // ══════════════════════════════════════════════════════════════════

  /**
   * analyze(pair, candles) → full technical snapshot + signal
   *
   * Weights:
   *   - Trend indicators (EMA alignment, ADX)     : 30 %
   *   - Momentum indicators (RSI, MACD, Stoch)     : 25 %
   *   - Volatility / mean-reversion (BB, CCI, %R)  : 15 %
   *   - SMC / ICT concepts                         : 20 %
   *   - Candlestick patterns                       : 10 %
   */
  function analyze(pair, candles) {
    if (!Array.isArray(candles) || candles.length < 5) {
      MF.log('warn', 'TechnicalEngine.analyze: not enough candles for', pair);
      return _emptyResult(pair);
    }

    MF.log('debug', 'TechnicalEngine.analyze: running for', pair);

    // ── Indicators ─────────────────────────────────────────────────
    const rsiVal      = RSI(candles);
    const macdVal     = MACD(candles);
    const bbVal       = BollingerBands(candles);
    const emaPeriods  = cfg('emaPeriods', [9, 21, 50, 200]);
    const emaVals     = {};
    for (const p of emaPeriods) {
      emaVals[p] = EMA(candles, p);
    }
    const atrVal      = ATR(candles);
    const stochVal    = Stochastic(candles);
    const adxVal      = ADX(candles);
    const cciVal      = CCI(candles);
    const willRVal    = WilliamsR(candles);
    const vwapVal     = VWAP(candles);
    const sarVal      = ParabolicSAR(candles);
    const ichimokuVal = Ichimoku(candles);
    const obvVal      = OBV(candles);
    const mfiVal      = MFI(candles);

    // ── SMC / ICT ──────────────────────────────────────────────────
    const orderBlocks      = detectOrderBlocks(candles);
    const fvgs             = detectFVGs(candles);
    const bos              = detectBOS(candles);
    const choch            = detectCHOCH(candles);
    const liquiditySweeps  = detectLiquiditySweeps(candles);
    const premiumDiscount  = calcPremiumDiscount(candles);
    const killzone         = getKillzones();

    // ── Patterns ───────────────────────────────────────────────────
    const patterns = detectAllPatterns(candles);

    // ── Trend ──────────────────────────────────────────────────────
    const trend = getTrend(candles);

    // ── Current price ──────────────────────────────────────────────
    const price = safe(candles[candles.length - 1].close);

    // ════════════════════════════════════════════════════════════════
    //  SIGNAL GENERATION
    // ════════════════════════════════════════════════════════════════

    let bullScore = 0, bearScore = 0;
    const reasons = [];

    // --- Trend (30 pts max) ---
    if (trend.direction === 'up') {
      bullScore += 30 * (trend.strength / 100);
      reasons.push(`Uptrend (strength ${trend.strength})`);
    } else if (trend.direction === 'down') {
      bearScore += 30 * (trend.strength / 100);
      reasons.push(`Downtrend (strength ${trend.strength})`);
    } else {
      bullScore += 5; bearScore += 5;
      reasons.push('Sideways trend');
    }

    // --- Momentum (25 pts max) ---
    // RSI
    if (rsiVal !== null) {
      if (rsiVal < 30) {
        bullScore += 8;
        reasons.push(`RSI oversold (${rsiVal.toFixed(1)})`);
      } else if (rsiVal > 70) {
        bearScore += 8;
        reasons.push(`RSI overbought (${rsiVal.toFixed(1)})`);
      } else if (rsiVal < 45) {
        bullScore += 3;
      } else if (rsiVal > 55) {
        bearScore += 3;
      }
    }

    // MACD
    if (macdVal) {
      if (macdVal.histogram > 0 && macdVal.macd > macdVal.signal) {
        bullScore += 8;
        reasons.push('MACD bullish crossover');
      } else if (macdVal.histogram < 0 && macdVal.macd < macdVal.signal) {
        bearScore += 8;
        reasons.push('MACD bearish crossover');
      }
    }

    // Stochastic
    if (stochVal) {
      if (stochVal.k < 20 && stochVal.k > stochVal.d) {
        bullScore += 5;
        reasons.push('Stochastic oversold crossover');
      } else if (stochVal.k > 80 && stochVal.k < stochVal.d) {
        bearScore += 5;
        reasons.push('Stochastic overbought crossover');
      }
    }

    // MFI
    if (mfiVal !== null) {
      if (mfiVal < 20) { bullScore += 4; reasons.push('MFI oversold'); }
      else if (mfiVal > 80) { bearScore += 4; reasons.push('MFI overbought'); }
    }

    // --- Volatility / Mean-reversion (15 pts max) ---
    if (bbVal) {
      if (price <= bbVal.lower) {
        bullScore += 7;
        reasons.push('Price at lower Bollinger Band');
      } else if (price >= bbVal.upper) {
        bearScore += 7;
        reasons.push('Price at upper Bollinger Band');
      }
    }
    if (cciVal !== null) {
      if (cciVal < -100) { bullScore += 4; reasons.push('CCI oversold'); }
      else if (cciVal > 100) { bearScore += 4; reasons.push('CCI overbought'); }
    }
    if (willRVal !== null) {
      if (willRVal < -80) { bullScore += 4; reasons.push('Williams %R oversold'); }
      else if (willRVal > -20) { bearScore += 4; reasons.push('Williams %R overbought'); }
    }

    // --- SMC / ICT (20 pts max) ---
    // Order blocks
    const recentOBs = orderBlocks.slice(-3);
    for (const ob of recentOBs) {
      if (ob.type === 'bullish' && price >= ob.low && price <= ob.high) {
        bullScore += 5;
        reasons.push('Price at bullish Order Block');
      } else if (ob.type === 'bearish' && price >= ob.low && price <= ob.high) {
        bearScore += 5;
        reasons.push('Price at bearish Order Block');
      }
    }

    // FVG
    const recentFVGs = fvgs.slice(-3);
    for (const fvg of recentFVGs) {
      if (fvg.type === 'bullish' && price >= fvg.bottom && price <= fvg.top) {
        bullScore += 4;
        reasons.push('Price in bullish FVG');
      } else if (fvg.type === 'bearish' && price >= fvg.bottom && price <= fvg.top) {
        bearScore += 4;
        reasons.push('Price in bearish FVG');
      }
    }

    // BOS / CHOCH
    const lastBOS   = bos.length   ? bos[bos.length - 1]   : null;
    const lastCHOCH = choch.length ? choch[choch.length - 1] : null;
    if (lastBOS && lastBOS.type === 'bullish') { bullScore += 3; reasons.push('Bullish BOS'); }
    if (lastBOS && lastBOS.type === 'bearish') { bearScore += 3; reasons.push('Bearish BOS'); }
    if (lastCHOCH && lastCHOCH.type === 'bullish') { bullScore += 4; reasons.push('Bullish CHOCH'); }
    if (lastCHOCH && lastCHOCH.type === 'bearish') { bearScore += 4; reasons.push('Bearish CHOCH'); }

    // Liquidity sweeps
    const lastSweep = liquiditySweeps.length
      ? liquiditySweeps[liquiditySweeps.length - 1] : null;
    if (lastSweep) {
      if (lastSweep.type === 'sell_side') { bullScore += 4; reasons.push('Sell-side liquidity swept'); }
      if (lastSweep.type === 'buy_side')  { bearScore += 4; reasons.push('Buy-side liquidity swept'); }
    }

    // Premium / Discount context
    if (premiumDiscount.discount > 0.6) {
      bullScore += 2; reasons.push('Price in discount zone');
    } else if (premiumDiscount.premium > 0.6) {
      bearScore += 2; reasons.push('Price in premium zone');
    }

    // --- Candlestick patterns (10 pts max) ---
    for (const p of patterns) {
      if (p.type === 'bullish') {
        bullScore += Math.round(p.confidence / 100 * 5);
        reasons.push(`${p.name} (bullish)`);
      } else if (p.type === 'bearish') {
        bearScore += Math.round(p.confidence / 100 * 5);
        reasons.push(`${p.name} (bearish)`);
      }
    }

    // ── Determine direction & confidence ───────────────────────────
    const totalWeight = 100;
    const rawScore = Math.abs(bullScore - bearScore);
    const direction = bullScore > bearScore ? 'CALL'
                    : bearScore > bullScore ? 'PUT'
                    : 'NEUTRAL';

    // Confidence: scale the margin so that a 50-pt lead → 100%
    const confidence = direction === 'NEUTRAL'
      ? 0
      : MF.clamp(Math.round((rawScore / (totalWeight * 0.5)) * 100), 0, 100);

    // ── Assemble result ────────────────────────────────────────────
    const result = {
      pair,
      timestamp: Date.now(),
      price,

      trend,

      indicators: {
        rsi:        rsiVal,
        macd:       macdVal,
        bollinger:  bbVal,
        ema:        emaVals,
        atr:        atrVal,
        stochastic: stochVal,
        adx:        adxVal,
        cci:        cciVal,
        williamsR:  willRVal,
        vwap:       vwapVal,
        sar:        sarVal,
        ichimoku:   ichimokuVal,
        obv:        obvVal,
        mfi:        mfiVal,
      },

      smc: {
        orderBlocks,
        fvgs,
        bos,
        choch,
        liquiditySweeps,
        premiumDiscount,
        killzone,
      },

      patterns,

      signal: {
        direction,
        confidence,
        reasons,
      },
    };

    MF.log('debug', `TechnicalEngine: ${pair} → ${direction} @ ${confidence}%`);
    MF.bus.emit('analysis:complete', result);

    return result;
  }

  /** Empty result stub when there isn't enough data. */
  function _emptyResult(pair) {
    return {
      pair,
      timestamp: Date.now(),
      price: 0,
      trend: { direction: 'sideways', strength: 0 },
      indicators: { rsi: null, macd: null, bollinger: null, ema: {},
        atr: null, stochastic: null, adx: null, cci: null,
        williamsR: null, vwap: null, sar: null, ichimoku: null,
        obv: null, mfi: null },
      smc: { orderBlocks: [], fvgs: [], bos: [], choch: [],
        liquiditySweeps: [], premiumDiscount: {}, killzone: {} },
      patterns: [],
      signal: { direction: 'NEUTRAL', confidence: 0, reasons: ['Insufficient data'] },
    };
  }


  // ══════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════════

  return {
    // Main entry
    analyze,
    getTrend,
    getSupportResistance,
    getVolatility,

    // Individual indicators (for ad-hoc use)
    SMA, EMA, RSI, MACD, BollingerBands, ATR, Stochastic,
    ADX, CCI, WilliamsR, VWAP, ParabolicSAR, Ichimoku, OBV, MFI,

    // SMC / ICT detectors
    detectOrderBlocks, detectFVGs, detectBOS, detectCHOCH,
    detectLiquiditySweeps, calcPremiumDiscount, getKillzones,

    // Pattern detectors
    detectAllPatterns,
    patternDoji, patternHammer, patternInvertedHammer,
    patternShootingStar, patternEngulfing, patternMorningStar,
    patternEveningStar, patternThreeWhiteSoldiers, patternThreeBlackCrows,
    patternHarami, patternSpinningTop,
  };

})();
