# MindFlareClaw-AGENT

**Autonomous Trading Agent for market-qx.trade** — Multi-LLM consensus, unlimited historical data, self-improvement, and chat with media support.

## Features

### WebSocket Interception & Market Data
- Real-time WebSocket monitoring via page-context injection (`page-hook.js`)
- Socket.IO v3 (EIO=3) binary event decoding with msgpack support
- Captures `quotes/stream`, `instruments/list`, `history/list/v2`, `depth/change` events
- 1-minute candle aggregation from live tick data
- DOM polling fallback when WebSocket is unavailable
- Automatic instrument/pair discovery with payout tracking

### Multi-LLM Provider Support (11 Providers)
- **Ollama Cloud** — with multi-key rotation and cooldown
- **OpenAI** — GPT-4.1, GPT-4o, o3, o4-mini
- **OpenRouter** — Claude, GPT-4o, Gemini, DeepSeek, Qwen
- **Anthropic** — Claude Opus 4, Sonnet 4, Haiku 4.5
- **Google Gemini** — 2.5 Pro, 2.5 Flash, 2.0 Flash
- **xAI Grok** — Grok-3, Grok-3-mini
- **OpenCode** — Zen, Go-Catalogue
- **Zia** — Zia Default
- **Moonshot (Kimi)** — Kimi-K2.5, Kimi-K2
- **Qwen (Alibaba)** — Qwen-Max, Qwen-Plus, Qwen-Turbo
- **OpenAI Compatible** — Custom endpoint + key

### Rate Limit Protection
- Multi-key support for ALL providers (add as many keys as you want)
- Automatic key rotation with round-robin
- 60-second cooldown on rate-limited keys (429/402 responses)
- Fallback provider chain: if primary fails, try next provider automatically

### Technical Analysis Engine
- RSI, MACD, Bollinger Bands, EMA, ATR, Stochastic
- SMC/ICT concepts: FVG, Order Blocks, CHoCH, BOS, Liquidity Sweeps
- Candlestick pattern detection
- Ensemble scoring with configurable weights

### Strategy Engine
- 7 built-in strategies (ICT Confirmation, Wyckoff Spring, Trend Continuation, etc.)
- Per-pair pattern registry with historical similarity search
- Backtesting evaluator

### Trading Automation
- Auto-pilot with martingale system
- Configurable investment, duration, payout filters
- DOM manipulation for trade execution on market-qx.trade

### Self-Improvement
- Trade recording and analysis
- Mistake pattern detection
- Rule generation from losses
- LLM context injection for improved signals

### Floating Dashboard UI
- 5-tab draggable overlay: Signals, Chat, Queue, Config, Analytics
- Chat with tool-calling support (22 tools)
- Media support in chat (screenshots via tab capture)

## Installation

1. Download the latest release ZIP from the [Releases](https://github.com/mindflarevortx-maker/MindFlareTradingClaw-Agent/releases) page
2. Extract the ZIP file
3. Open Chrome → `chrome://extensions/`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked**
6. Select the extracted folder

## Configuration

1. Click the extension icon → popup, or right-click → Options
2. In **LLM & API Keys**:
   - Select your primary LLM provider
   - Add one or more API keys for the provider
   - Configure fallback providers
   - Set model, temperature, max tokens
3. In **Trading Settings**:
   - Configure auto-pilot, investment amounts, martingale
4. In **Scanner Settings**:
   - WebSocket enabled (default: on)
   - DOM polling fallback (default: on)

## Usage

1. Navigate to `https://market-qx.trade` and log in
2. The extension automatically injects and connects to the WebSocket
3. The floating overlay appears — you can drag it, minimize it, or close it
4. Use the **Chat** tab to talk to the AI agent
5. Use the **Signals** tab to see real-time analysis
6. Toggle **Auto-Pilot** to let the agent trade automatically

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  market-qx.trade page                  │
│  ┌──────────────┐   window.postMessage   ┌─────────┐ │
│  │  page-hook.js│ ──────────────────────▶│scanner.js│ │
│  │  (page world)│   ws_msg, ws_sio      │(content) │ │
│  └──────────────┘                        └────┬─────┘ │
└───────────────────────────────────────────────┼───────┘
                                                │ chrome.runtime.sendMessage
                                                ▼
                                        ┌──────────────┐
                                        │service-worker│
                                        │   (LLM proxy)│
                                        └──────────────┘
```

### File Structure

```
├── manifest.json           # MV3 manifest
├── inject-page-hook.js     # Content script (document_start) — injects page-hook
├── page-hook.js            # Page-world WebSocket interceptor
├── core.js                 # Config, state, event bus, utilities
├── candle-store.js         # IndexedDB candle persistence
├── historical-loader.js    # Deep pagination historical data
├── technical-engine.js     # Technical indicators + SMC/ICT
├── strategy-engine.js      # Strategy patterns + backtesting
├── dom-claw.js             # DOM manipulation for trade execution
├── scanner.js              # WS frame router, tick/candle processing
├── llm-claw.js             # LLM client (content → service worker bridge)
├── agent.js                # Signal pipeline, auto-pilot, tool registry
├── self-improvement.js     # Trade recording, mistake analysis
├── chat.js                 # Tool-calling chat with media support
├── ui-overlay.js           # 5-tab draggable dashboard
├── overlay.css             # Overlay styles
├── bootstrap.js            # Init sequence
├── bg/
│   └── service-worker.js   # Background LLM proxy, key rotation
├── options/
│   ├── options.html        # Settings page
│   ├── options.js          # Settings controller
│   └── options.css         # Settings styles
├── popup/
│   ├── popup.html          # Extension popup
│   ├── popup.js            # Popup controller
│   └── popup.css           # Popup styles
├── prompts/
│   ├── soul.md             # Agent personality
│   ├── agents.md           # Decision protocol
│   ├── STRATEGIES.md       # Strategy playbook
│   ├── tools.md            # Available tools
│   └── user.md             # User preferences
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    ├── icon128.png
    └── icon256.png
```

## Keyboard Shortcuts

- **Ctrl+Shift+T** — Toggle the overlay panel

## Version History

### v2.1.0
- **FIXED**: WebSocket connection — proper Socket.IO v3 binary event handling
- **FIXED**: market-qx.trade specific event names (quotes/stream, instruments/list, etc.)
- **FIXED**: Msgpack decoding for binary Socket.IO attachments
- **NEW**: Multi-key API key management for ALL 11 LLM providers
- **NEW**: Rate limit protection with automatic key rotation and cooldown
- **NEW**: Redesigned Options page with sidebar navigation
- **NEW**: Test Connection button for LLM providers
- **NEW**: README.md documentation

### v2.0.0
- Complete rewrite with proper MV3 architecture
- 11 LLM providers with fallback chains
- IndexedDB candle storage
- Self-improvement engine

### v1.3.0
- WebSocket ES6 class extension fix
- Binary frame handling

### v1.2.0
- Chart loading fix

### v1.1.0
- Page load blocking fix

### v1.0.0
- Initial release

## License

Private — All rights reserved.
