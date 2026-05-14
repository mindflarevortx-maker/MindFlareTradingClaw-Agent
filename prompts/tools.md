# MindFlare TradingClaw — Tools

The agent has access to 22 tools for interacting with the trading platform:

## Market Analysis
1. **analyze** — Run full technical analysis on current or specified pair
2. **scan** — Rescan all available pairs and their payouts
3. **indicators** — Display current indicator values
4. **strategy** — Show strategy evaluation results
5. **llm_signal** — Get LLM-generated trading signal

## Trading
6. **trade** — Execute a trade (CALL/PUT) with specified investment
7. **stop** — Stop auto-pilot and cancel pending trades
8. **martingale** — Show martingale state and progression
9. **reset_martingale** — Reset martingale to base investment

## Information
10. **status** — Show current agent status and state
11. **pairs** — List all available pairs with payouts
12. **history** — Show recent trade history
13. **candle_history** — Show stored candle history info
14. **backtest** — Run backtesting on historical data
15. **help** — Show available commands and tools

## Configuration
16. **set_config** — Set a configuration value
17. **get_config** — Get a configuration value
18. **llm_ask** — Ask the LLM a question (non-trading)

## Data Management
19. **export_data** — Export candle data and trade history
20. **import_data** — Import candle data
21. **clear_history** — Clear trade history and stored data

## Debug
22. **debug** — Show debug information and diagnostics
