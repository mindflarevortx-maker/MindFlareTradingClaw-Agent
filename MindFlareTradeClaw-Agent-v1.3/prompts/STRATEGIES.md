# MindFlare TradingClaw — Strategies

## 1. RSI Reversal
- **Logic**: RSI below 30 (oversold) → CALL; RSI above 70 (overbought) → PUT
- **Confidence**: Scales with distance from threshold (extreme RSI = higher confidence)
- **Best For**: Range-bound markets with clear support/resistance
- **Weakness**: Fails in strong trending markets

## 2. MACD Crossover
- **Logic**: MACD line crosses above signal line → CALL; below → PUT
- **Confidence**: Scales with histogram magnitude
- **Best For**: Trending markets with momentum
- **Weakness**: Lagging indicator, late signals

## 3. Bollinger Bounce
- **Logic**: Price touches lower band → CALL; upper band → PUT
- **Confidence**: Scales with percentB distance from 0.5
- **Best For**: Range-bound, mean-reverting markets
- **Weakness**: Breakouts through bands lead to losses

## 4. EMA Trend
- **Logic**: EMA9 crosses above EMA21 → CALL; below → PUT
- **Confidence**: Scales with gap percentage between EMAs
- **Best For**: Trend-following in directional markets
- **Weakness**: Whipsaws in choppy markets

## 5. Stochastic Momentum
- **Logic**: %K crosses %D in oversold zone (<20) → CALL; overbought (>80) → PUT
- **Confidence**: Scales with zone extremity
- **Best For**: Range-bound markets with oscillations
- **Weakness**: Can stay overbought/oversold in trends

## 6. SMC/ICT
- **Logic**: Combines order blocks, FVGs, BOS, CHOCH, and killzone alignment
- **Confidence**: Based on number of confluences aligned
- **Best For**: All market conditions when multiple confluences align
- **Weakness**: Subjective pattern recognition, requires experience

## 7. Composite AI
- **Logic**: Weighted combination of all strategies + LLM signal
- **Confidence**: Weighted average with adaptive per-pair weights
- **Best For**: General purpose, adapts to market conditions
- **Weakness**: Can dilute strong individual signals
