# MindFlare TradingClaw — User Guide

## Quick Start

1. Install the extension in Chrome
2. Navigate to https://market-qx.trade/en/demo-trade
3. The extension overlay will appear in the top-right corner
4. Use the Scanner tab to view active pairs and payouts
5. Use the Analysis tab to see technical signals
6. Toggle Auto-Pilot from the Auto-Pilot tab or popup

## Chat Commands

Type in the Chat tab to interact with the agent:

- `/analyze` — Analyze current pair
- `/analyze EURUSD` — Analyze specific pair
- `/scan` — Rescan all pairs
- `/trade CALL 5` — Place a $5 CALL trade
- `/trade PUT` — Place a PUT trade with default investment
- `/stop` — Stop auto-pilot
- `/autopilot` — Toggle auto-pilot
- `/status` — Show current status
- `/history` — Show recent trades
- `/martingale` — Show martingale state
- `/config autoPilot true` — Set a config value
- `/help` — Show all commands

## Auto-Pilot Mode

When auto-pilot is enabled, the agent will:
1. Scan for high-payout pairs
2. Switch to the best available pair
3. Wait for a strong signal (confidence > 65)
4. Execute the trade
5. Wait for the result
6. Apply martingale on loss (if enabled)
7. Record the outcome for learning
8. Repeat

## Martingale System

- On WIN: Reset to base investment
- On LOSS: Multiply investment by martingale multiplier (default: 2x)
- Maximum steps: Configurable (default: 3)
- Maximum investment cap: Configurable

## LLM Integration

Configure your preferred LLM provider in Settings:
- **Ollama** (free, local): Set base URL (default: http://localhost:11434)
- **OpenRouter**: Enter API key
- **Groq**: Enter API key (fast inference)
- And 9 more providers...

## Candle History

The extension stores candlestick history in IndexedDB for instant access:
- Up to 30 days of 1-minute candles per pair
- Auto-loads when pairs are discovered
- Export/Import for backup
- Used for backtesting and analysis

## Troubleshooting

- **Chart not loading**: The extension uses passive WebSocket interception that should not interfere with the chart. Try disabling and re-enabling the extension.
- **No signals**: Make sure the Scanner is receiving data (check WS status in Scanner tab).
- **LLM not responding**: Verify your API key and provider settings in Options.
