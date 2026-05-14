# MindFlare TradingClaw — Agents

## Agent Architecture

The extension uses a modular agent system where each component handles a specific domain:

### Scanner Agent
- Monitors WebSocket traffic and DOM for real-time market data
- Discovers available trading pairs and their payouts
- Aggregates tick data into 1-minute candles
- Falls back to DOM polling if WebSocket data is unavailable

### Analysis Agent
- Runs 15 technical indicators on candle data
- Detects SMC/ICT concepts (order blocks, FVGs, BOS, CHOCH)
- Identifies candlestick patterns
- Generates weighted trading signals

### Strategy Agent
- Evaluates 7 trading strategies
- Maintains per-pair pattern registry
- Adjusts strategy weights based on historical performance
- Combines multiple signals into a final recommendation

### LLM Agent
- Sends market context to large language models for analysis
- Supports 12 providers (Ollama, OpenRouter, Groq, etc.)
- Falls back through providers on failure
- Integrates LLM signals into the composite strategy

### Execution Agent
- Places trades via DOM interaction
- Manages martingale progression
- Waits for trade results
- Records outcomes for self-improvement

### Self-Improvement Agent
- Analyzes trade outcomes for patterns
- Detects common mistakes per pair
- Suggests configuration adjustments
- Feeds back into strategy weights
