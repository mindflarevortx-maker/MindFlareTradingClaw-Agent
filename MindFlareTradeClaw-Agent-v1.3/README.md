# MindFlare TradingClaw Agent

AI-powered trading assistant Chrome extension for [market-qx.trade](https://market-qx.trade) — WebSocket sniffing, technical analysis, LLM signals, auto-pilot trading with martingale, backtesting, and self-improvement.

## Features

### WebSocket Interception
- Passive WebSocket monitoring via ES6 class extension (doesn't break chart loading)
- Socket.IO v3/v4 frame decoding
- Automatic tick → 1-minute candle aggregation
- DOM polling fallback when WS data is unavailable
- Outgoing WS message capture for trade tracking

### Technical Analysis Engine
- **15 Indicators**: RSI, MACD, Bollinger Bands, EMA, ATR, Stochastic, ADX, CCI, Williams %R, VWAP, Parabolic SAR, Ichimoku Cloud, OBV, MFI, SMA
- **SMC/ICT Concepts**: Order Blocks, Fair Value Gaps (FVG), Break of Structure (BOS), Change of Character (CHOCH), Liquidity Sweeps, Premium/Discount Zones, Killzone Sessions
- **11 Candlestick Patterns**: Doji, Hammer, Inverted Hammer, Shooting Star, Engulfing (bull/bear), Morning Star, Evening Star, Three White Soldiers, Three Black Crows, Harami (bull/bear), Spinning Top

### Trading Strategies
1. **RSI Reversal** — Oversold/overbought reversal signals
2. **MACD Crossover** — Momentum-based crossover signals
3. **Bollinger Bounce** — Mean-reversion at band extremes
4. **EMA Trend** — EMA9/EMA21 crossover trend-following
5. **Stochastic Momentum** — %K/%D crossovers in extreme zones
6. **SMC/ICT** — Smart money concept confluence trading
7. **Composite AI** — Weighted combination + LLM signal integration

### LLM Integration (12 Providers)
- Ollama (free, local)
- OpenRouter
- Groq
- Together AI
- DeepInfra
- Mistral
- OpenAI
- Anthropic
- Cohere
- Fireworks AI
- Perplexity
- Custom endpoint

### Auto-Pilot Trading
- Automatic pair switching to highest-payout pairs
- Signal-driven trade execution (confidence > 65%)
- Trade result detection via DOM monitoring
- Configurable martingale system (WIN → reset, LOSS → multiply)

### Candle History Storage
- IndexedDB persistence for up to 30 days per pair
- Auto-fetches historical data when pairs are discovered
- Export/Import for backup
- Instant access for analysis and backtesting

### Self-Improvement
- Records every trade outcome
- Detects common mistakes per pair
- Adjusts strategy weights based on historical performance
- Suggests configuration improvements

## Installation

1. Download the latest release ZIP
2. Unzip the file
3. Go to `chrome://extensions/`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked**
6. Select the unzipped folder
7. Navigate to [market-qx.trade](https://market-qx.trade/en/demo-trade)

## Usage

### Quick Start
1. The overlay dashboard appears in the top-right corner
2. **Scanner tab** — View active pairs, WS status, price ticks
3. **Analysis tab** — See technical signals and indicator values
4. **Auto-Pilot tab** — Toggle auto-trading, view martingale state
5. **Chat tab** — Talk to the AI assistant with slash commands
6. **History tab** — View trade history and statistics

### Chat Commands
```
/analyze [pair]     — Analyze current or specified pair
/scan               — Rescan all pairs
/trade CALL 5       — Place a $5 CALL trade
/trade PUT          — Place a PUT trade with default investment
/stop               — Stop auto-pilot
/autopilot          — Toggle auto-pilot on/off
/status             — Show current status
/history [count]    — Show recent trades
/martingale         — Show martingale state
/config key [value] — Get/set configuration
/help               — Show all commands
```

### LLM Setup
1. Open Options page (right-click extension icon → Options)
2. Select your LLM provider
3. Enter your API key
4. For Ollama: make sure it's running locally (`ollama serve`)

## File Structure

```
├── manifest.json              — Chrome MV3 manifest
├── page-hook.js               — WebSocket interception (page context)
├── inject-page-hook.js        — Injection bridge (content script)
├── core.js                    — Config, state, event bus
├── candle-store.js            — IndexedDB candle storage
├── historical-loader.js       — Historical data fetcher
├── scanner.js                 — WS frame router + DOM polling
├── technical-engine.js        — 15 indicators + SMC/ICT
├── strategy-engine.js         — 7 strategies + pattern registry
├── dom-claw.js                — DOM interaction with trading page
├── llm-claw.js                — LLM interface (content side)
├── self-improvement.js        — Trade learning system
├── agent.js                   — Auto-pilot + signal pipeline
├── chat.js                    — Chat interface with slash commands
├── ui-overlay.js              — Dashboard overlay
├── overlay.css                — Overlay styles
├── bootstrap.js               — Safe init sequence
├── bg/
│   └── service-worker.js      — Background worker (LLM, alarms)
├── popup/
│   ├── popup.html             — Quick popup UI
│   ├── popup.js               — Popup logic
│   └── popup.css              — Popup styles
├── options/
│   ├── options.html           — Full settings page
│   ├── options.js             — Settings logic
│   └── options.css            — Settings styles
├── prompts/
│   ├── SOUL.md                — AI personality
│   ├── AGENTS.md              — Agent architecture
│   ├── STRATEGIES.md          — Strategy documentation
│   ├── TOOLS.md               — Available tools
│   └── USER.md                — User guide
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    ├── icon128.png
    └── icon256.png
```

## Changelog

### v1.4.0
- **FIX**: WebSocket connection now properly intercepts Socket.IO traffic
- **FIX**: Added Quotex/market-qx.trade specific Socket.IO event names
- **FIX**: LLM chat responses now properly reach content scripts with helpful error messages
- **FIX**: Extension context validity check before sending messages to service worker
- **ADD**: WebSocket.send interception for outgoing message tracking
- **ADD**: fetch() interception for API endpoint discovery
- **ADD**: XHR now also matches qxbroker/quotex domains
- **ADD**: More price/pair field extractors for Quotex data format

### v1.3.0
- **FIX**: Chart loading issue — WebSocket hook uses proper ES6 class extension
- **FIX**: Content scripts run at document_idle (except inject-page-hook)
- **FIX**: Bootstrap waits for page readiness before initializing
- **ADD**: Candle history storage via IndexedDB (30-day per pair)
- **ADD**: Historical data auto-loader
- **ADD**: Export/Import candle data
- **ADD**: Self-improvement loop
- **ADD**: Backtesting engine
- **ADD**: 5-tab dashboard overlay
- **ADD**: Chat interface with slash commands
- **ADD**: 12 LLM providers

### v1.2.0-beta1
- Initial release with chart fix

## Disclaimer

Trading binary options involves significant risk. Past performance does not guarantee future results. This extension is an analytical tool, not financial advice. Always trade responsibly.

## License

MIT
