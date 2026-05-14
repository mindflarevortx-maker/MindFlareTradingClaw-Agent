# MindFlareClaw-AGENT

Autonomous trading agent for **market-qx.trade** — multi-LLM consensus, unlimited historical data, WebSocket sniffing, self-improvement, and chat with media support.

## Features

- **WebSocket Sniffing** — Intercepts market-qx.trade's Socket.IO WebSocket traffic in real-time via page-context hook (ES6 class extension for `instanceof` compatibility)
- **11 LLM Providers** — Ollama Cloud (10 rotating keys), OpenAI, OpenRouter, Anthropic, Gemini, Grok, OpenCode, Zia, Moonshot, Qwen, OpenAI-Compatible
- **Ollama Key Rotation** — 10 API keys with automatic cooldown on rate-limit (429/402)
- **OpenRouter Fallback** — Ships with a default OpenRouter key so LLM works out of the box
- **Unlimited Historical Data** — IndexedDB-backed candle storage with deep pagination (bypasses 199-candle limit)
- **Technical Analysis** — 15+ indicators (RSI, MACD, Bollinger, EMA, ATR, Stochastic, ADX, Ichimoku) + SMC/ICT (FVG, Order Blocks, Sweep, CHoCH, BOS) + candlestick patterns
- **7 Trading Strategies** — ICT Confirmation, Wyckoff Spring, Trend Continuation, Breakout-Retest, Mean-Reversion, Momentum, Historical Pattern Match
- **Auto-Pilot Trading** — Autonomous trading loop with martingale system (configurable steps, multiplier, max investment)
- **Self-Improvement** — Per-trade learning, mistake analysis, rule generation, LLM context injection
- **Chat Interface** — Persistent tool-calling chat with 22+ agent tools, slash commands, and image support
- **DOM Claw** — Robust DOM interaction for market-qx.trade with multi-strategy element finding (selectors → text match → color heuristics)
- **Draggable Dashboard** — 5-tab floating overlay (Scanner, Chat, Queue, Config, Analytics)

## Installation

1. Download the latest release ZIP from the [Releases](https://github.com/mindflarevortx-maker/MindFlareTradingClaw-Agent/releases) page
2. Unzip the file
3. Open Chrome → `chrome://extensions/`
4. Enable "Developer mode" (top right)
5. Click "Load unpacked" → select the unzipped folder
6. Navigate to [market-qx.trade](https://market-qx.trade/en/demo-trade)
7. The MindFlareClaw dashboard will appear on the right side

## Quick Start

1. **WebSocket**: Automatically connects — look for the green status dot in the dashboard
2. **LLM Chat**: Works out of the box with Ollama Cloud + OpenRouter fallback
3. **Auto-Pilot**: Toggle via the dashboard or type `/autopilot` in chat
4. **Manual Trade**: Type `/trade CALL 2` or `/trade PUT` in chat

## Chat Commands

| Command | Description |
|---------|-------------|
| `/analyze [pair]` | Run full technical + LLM analysis |
| `/scan` | Rescan pairs for data |
| `/trade <CALL\|PUT> [amount]` | Execute a trade |
| `/stop` | Stop auto-pilot |
| `/autopilot` | Toggle auto-pilot on/off |
| `/status` | Show current status |
| `/history [count]` | Show recent trade history |
| `/martingale` | Show martingale state |
| `/config <key> [value]` | Get or set config |
| `/help` | Show all commands |

## Configuration

Open the Options page (right-click extension icon → Options) to configure:

- **LLM Provider** — Select from 11 providers, enter API keys, test connections
- **Trading** — Payout min/max, OTC toggle, confluence, confidence floor, cooldown
- **Historical Data** — Enable/disable, days per pair, manual backfill
- **Prompts** — Edit SOUL, AGENTS, STRATEGIES, TOOLS, USER prompts
- **Advanced** — Self-learning, max lessons, debug mode

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  market-qx.trade                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Page Hook│  │  Content     │  │  Service      │  │
│  │ (WS snif)│→│  Scripts      │→│  Worker       │  │
│  │ page-ctx │  │  (MF core)   │  │ (LLM proxy)  │  │
│  └──────────┘  └──────────────┘  └───────────────┘  │
│       │              │                    │           │
│       ▼              ▼                    ▼           │
│  WS frames ──→ Scanner/Candles ──→ LLM API calls    │
│                      │                               │
│                      ▼                               │
│              Technical Engine + Strategy Engine       │
│                      │                               │
│                      ▼                               │
│              Agent (signal + auto-pilot + tools)      │
│                      │                               │
│                      ▼                               │
│              DomClaw (trade execution)                │
└─────────────────────────────────────────────────────┘
```

## File Structure

| File | Purpose |
|------|---------|
| `manifest.json` | Chrome MV3 manifest |
| `inject-page-hook.js` | Injects page-hook.js at document_start |
| `page-hook.js` | WebSocket ES6 class extension + Socket.IO decoder |
| `core.js` | Config, state, event bus, persistence |
| `candle-store.js` | IndexedDB candle storage (unlimited per pair) |
| `historical-loader.js` | Deep pagination for historical data |
| `technical-engine.js` | 15+ indicators + SMC/ICT + patterns |
| `strategy-engine.js` | Per-pair strategy DB + backtest evaluator |
| `dom-claw.js` | DOM interaction for market-qx.trade |
| `scanner.js` | WS frame router + tick aggregation + DOM poll |
| `llm-claw.js` | Multi-provider LLM with fallback chains |
| `self-improvement.js` | Trade learning + mistake analysis |
| `agent.js` | Signal pipeline, auto-pilot, 22 tools |
| `chat.js` | Tool-calling chat interface |
| `ui-overlay.js` + `overlay.css` | Draggable dashboard |
| `bootstrap.js` | Init sequence |
| `bg/service-worker.js` | LLM proxy, Ollama rotation, notifications |
| `prompts/*.md` | SOUL, AGENTS, STRATEGIES, TOOLS, USER |

## Version History

### v2.0.0 (Current)
- **FIX**: WebSocket connection — synchronous script injection (was async/defer causing WS hook to load after page scripts)
- **FIX**: LLM chat — replaced local Ollama with Ollama Cloud (10 rotating keys) + OpenRouter fallback
- **FIX**: Binary Socket.IO frames — full ArrayBuffer/Blob decoding in page-hook
- **FIX**: WS instance tracking — `__MFC_WS_SOCKETS` for historical-loader access
- **ADD**: 11 LLM providers (was 12 generic, now specific per plan)
- **ADD**: Ollama key auto-rotation with cooldown
- **ADD**: Prompt system (SOUL/AGENTS/STRATEGIES/TOOLS/USER)
- **ADD**: WebSocket accessor in DomClaw for historical data
- **ADD**: Balance reader in DomClaw
- **ADD**: Pre-decoded Socket.IO frames (`ws_sio` message type)
- **ADD**: Proper host_permissions for all LLM providers
- **UPD**: Manifest version → 2.0.0
- **UPD**: Service worker with full provider definitions and message format compatibility

### v1.3
- Initial GitHub release
- Basic WebSocket interception
- Local Ollama + generic provider support

## License

MIT
