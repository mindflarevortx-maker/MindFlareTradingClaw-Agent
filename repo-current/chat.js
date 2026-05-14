/**
 * chat.js  —  Tool-Calling Chat Interface for MindFlare TradingClaw
 *
 * Self-contained IIFE assigned to global `Chat`.  Provides the overlay
 * UI's chat panel with slash-command dispatch, LLM-powered conversation
 * with agent tool execution, and persistent chat history.
 *
 * Globals used: MF (config/state/logging/event bus),
 *               Agent (22 tools), LLMClaw
 */

const Chat = (() => {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────
  const MAX_MESSAGES = 100;
  const TOOL_PATTERN = /\[TOOL:(\w+)(?:\s+(.+?))?\]/g;

  // ── Internal state ───────────────────────────────────────────────
  let _llmBusy = false;

  // ══════════════════════════════════════════════════════════════════
  //  MESSAGE STORAGE
  // ══════════════════════════════════════════════════════════════════

  function _addMessage(role, content) {
    if (!MF.state.chatMessages) MF.state.chatMessages = [];
    const msg = { role, content, timestamp: Date.now() };
    MF.state.chatMessages.push(msg);
    if (MF.state.chatMessages.length > MAX_MESSAGES) {
      MF.state.chatMessages = MF.state.chatMessages.slice(-MAX_MESSAGES);
    }
    MF.bus.emit('chat:message', msg);
  }

  function getMessages() {
    return (MF.state.chatMessages || []).slice();
  }

  function clearMessages() {
    MF.state.chatMessages = [];
    MF.bus.emit('chat:cleared');
  }

  // ══════════════════════════════════════════════════════════════════
  //  SYSTEM PROMPT BUILDER
  // ══════════════════════════════════════════════════════════════════

  function _buildSystemPrompt() {
    const pair       = MF.state.activePair || 'NONE';
    const payout     = MF.state.activePairPayout || 0;
    const investment = MF.state.currentInvestment || MF.getConfig('baseInvestment') || 1;
    const autoPilot  = MF.getConfig('autoPilot') ? 'ON' : 'OFF';
    const martStep   = MF.state.martingaleStep || 0;
    const wsStatus   = MF.state.wsConnected ? 'connected' : 'disconnected';

    const recentSignals = (MF.state.signals || []).slice(-3)
      .map(s => `${s.direction || '?'} @ ${s.confidence || 0}% (${s.pair || '?'})`)
      .join('; ') || 'none';

    let priceInfo = 'N/A';
    try {
      const pd = MF.state.allPairs && MF.state.allPairs[pair];
      if (pd && pd.lastTick) priceInfo = String(pd.lastTick);
    } catch (_) { /* ignore */ }

    let toolList = 'none';
    try {
      if (typeof Agent !== 'undefined' && Agent.getToolNames) {
        toolList = Agent.getToolNames().join(', ');
      }
    } catch (_) { /* ignore */ }

    return [
      'You are MindFlare TradingClaw AI assistant — an interactive trading companion.',
      'You help the user analyze markets, execute trades, and manage settings.',
      '',
      '== CURRENT CONTEXT ==',
      `Active pair: ${pair}`,
      `Payout: ${payout}%`,
      `Current price: ${priceInfo}`,
      `Current investment: $${investment}`,
      `Auto-pilot: ${autoPilot}`,
      `Martingale step: ${martStep}`,
      `WebSocket: ${wsStatus}`,
      `Recent signals: ${recentSignals}`,
      '',
      '== TOOL CALLING ==',
      'You can invoke agent tools by embedding a tool call in your response.',
      'Format: [TOOL:tool_name key1=val1 key2=val2]',
      'Example: [TOOL:analyze pair=EURUSD-OTC]',
      'Example: [TOOL:trade direction=CALL investment=2]',
      'You may include multiple tool calls in a single response.',
      '',
      '== AVAILABLE TOOLS ==',
      toolList,
      '',
      'Guidelines:',
      '- Be concise and trading-focused.',
      '- When the user asks to trade, use the trade tool.',
      '- When the user asks for analysis, use the analyze tool.',
      '- If unsure about a tool argument, ask the user rather than guessing.',
      '- Never fabricate market data — rely on tool results.',
    ].join('\n');
  }

  // ══════════════════════════════════════════════════════════════════
  //  TOOL CALL PARSER & EXECUTOR
  // ══════════════════════════════════════════════════════════════════

  function _parseToolCalls(text) {
    const calls = [];
    if (!text || typeof text !== 'string') return calls;
    TOOL_PATTERN.lastIndex = 0;
    let match;
    while ((match = TOOL_PATTERN.exec(text)) !== null) {
      calls.push({ name: match[1], args: _parseToolArgs(match[2] || '') });
    }
    return calls;
  }

  function _parseToolArgs(raw) {
    const args = {};
    if (!raw) return args;
    const ARG_PATTERN = /(\w+)=(?:"([^"]*)"|(\S+))/g;
    let m;
    while ((m = ARG_PATTERN.exec(raw)) !== null) {
      args[m[1]] = _coerceValue(m[2] !== undefined ? m[2] : m[3]);
    }
    return args;
  }

  function _coerceValue(val) {
    if (val === 'true')  return true;
    if (val === 'false') return false;
    if (val !== '' && !isNaN(Number(val))) return Number(val);
    return val;
  }

  async function _executeToolCalls(calls) {
    const results = [];
    for (const call of calls) {
      try {
        if (typeof Agent === 'undefined' || !Agent.callTool) {
          results.push({ name: call.name, result: { ok: false, error: 'Agent not available' } });
          continue;
        }
        MF.log('debug', 'Chat: executing tool', call.name, call.args);
        const result = await Agent.callTool(call.name, call.args);
        results.push({ name: call.name, result });
      } catch (e) {
        MF.log('error', 'Chat: tool execution error for', call.name, e.message);
        results.push({ name: call.name, result: { ok: false, error: e.message } });
      }
    }
    return results;
  }

  function _stripToolCalls(text) {
    if (!text) return '';
    return text.replace(TOOL_PATTERN, '').trim();
  }

  function _summarizeResult(result) {
    try {
      if (result.direction && result.confidence !== undefined) {
        return `${result.direction} @ ${result.confidence}%` +
          (result.pair ? ` on ${result.pair}` : '') +
          (result.reasons ? ` — ${result.reasons.join('; ')}` : '');
      }
      if (result.message) return result.message;
      if (result.result && result.profit !== undefined) {
        return `${result.result} (profit: ${result.profit >= 0 ? '+' : ''}$${result.profit})`;
      }
      if (result.trades) return `${result.count || result.trades.length} trades`;
      if (result.pairs)  return `${result.count || result.pairs.length} pairs`;
      if (result.value !== undefined) return `${result.key} = ${JSON.stringify(result.value)}`;
      const json = JSON.stringify(result);
      return json.length > 200 ? json.slice(0, 200) + '...' : json;
    } catch (_) { return 'ok'; }
  }

  // ══════════════════════════════════════════════════════════════════
  //  SLASH COMMANDS
  // ══════════════════════════════════════════════════════════════════

  async function _handleSlashCommand(command) {
    const parts = command.slice(1).trim().split(/\s+/);
    const cmd   = (parts[0] || '').toLowerCase();
    const args  = parts.slice(1);

    switch (cmd) {

      case 'analyze': {
        const pair = args[0] || MF.state.activePair || null;
        if (!pair) return 'No active pair. Specify a pair: /analyze EURUSD-OTC';
        _addMessage('system', `Running analysis on ${pair}...`);
        try {
          const r = await Agent.callTool('analyze', { pair });
          if (!r.ok) return `Analysis failed: ${r.error || 'unknown error'}`;
          return `**${r.pair}** → ${r.direction} @ ${r.confidence}% confidence\nReasons: ${r.reasons ? r.reasons.join('; ') : 'none'}`;
        } catch (e) { return `Analysis error: ${e.message}`; }
      }

      case 'scan': {
        _addMessage('system', 'Rescanning pairs...');
        try {
          const r = await Agent.callTool('scan', {});
          if (!r.ok) return `Scan failed: ${r.error || 'unknown error'}`;
          const pairCount = Object.keys(MF.state.allPairs || {}).length;
          const highCount = (MF.state.highPayoutPairs || []).length;
          return `Scan complete. ${pairCount} pairs found, ${highCount} above min payout.`;
        } catch (e) { return `Scan error: ${e.message}`; }
      }

      case 'trade': {
        const direction = (args[0] || '').toUpperCase();
        if (direction !== 'CALL' && direction !== 'PUT') {
          return 'Usage: /trade <CALL|PUT> [investment]\nExample: /trade CALL 2';
        }
        const investment = args[1] ? Number(args[1]) : undefined;
        if (args[1] && (isNaN(investment) || investment <= 0)) {
          return 'Investment must be a positive number.';
        }
        _addMessage('system', `Executing ${direction} trade${investment ? ' $' + investment : ''}...`);
        try {
          const r = await Agent.callTool('trade', { direction, investment });
          if (!r.success && !r.ok) return `Trade failed: ${r.error || 'unknown error'}`;
          const t = r.trade || r;
          return `Trade placed: ${t.direction || direction} on ${t.pair || MF.state.activePair}\n` +
            `Investment: $${t.investment || investment || '?'}\nResult: ${t.result || 'pending'}\n` +
            `Profit: ${t.profit !== undefined ? '$' + t.profit : 'pending'}`;
        } catch (e) { return `Trade error: ${e.message}`; }
      }

      case 'stop': {
        try {
          const r = await Agent.callTool('stop', {});
          return r.ok ? 'Auto-pilot stopped.' : `Failed: ${r.error}`;
        } catch (e) { return `Stop error: ${e.message}`; }
      }

      case 'autopilot': {
        const current = MF.getConfig('autoPilot');
        if (current) {
          try {
            await Agent.callTool('stop', {});
            return 'Auto-pilot toggled **OFF**.';
          } catch (e) { return `Error stopping auto-pilot: ${e.message}`; }
        }
        try {
          if (typeof Agent !== 'undefined' && Agent.startAutoPilot) {
            Agent.startAutoPilot();
            return 'Auto-pilot toggled **ON**. The agent will now trade autonomously.';
          }
          return 'Agent not available for auto-pilot.';
        } catch (e) { return `Error starting auto-pilot: ${e.message}`; }
      }

      case 'status': {
        try {
          const s = await Agent.callTool('status', {});
          if (!s.ok) return `Status error: ${s.error}`;
          return [
            '**Status**',
            `Busy: ${s.busy ? 'Yes' : 'No'}`,
            `Auto-pilot: ${s.autoPilot ? 'ON' : 'OFF'}`,
            `Active pair: ${s.activePair || 'NONE'} (${s.activePairPayout || 0}%)`,
            `Investment: $${s.currentInvestment || 0}`,
            `Martingale step: ${s.martingaleStep || 0}`,
            `Last signal: ${s.lastSignal ? s.lastSignal.direction + ' @ ' + s.lastSignal.confidence + '%' : 'none'}`,
            `Trades: ${s.tradeHistoryCount || 0}`,
            `WebSocket: ${s.wsConnected ? 'connected' : 'disconnected'}`,
            `DOM: ${s.domReady ? 'ready' : 'not ready'}`,
          ].join('\n');
        } catch (e) { return `Status error: ${e.message}`; }
      }

      case 'history': {
        const limit = args[0] ? Math.min(Number(args[0]) || 10, 50) : 10;
        try {
          const r = await Agent.callTool('history', { limit });
          if (!r.ok) return `History error: ${r.error}`;
          const trades = r.trades || [];
          if (trades.length === 0) return 'No trade history.';
          const lines = trades.map((t, i) => {
            const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '?';
            return `${i + 1}. [${time}] ${t.pair || '?'} ${t.direction || '?'} ` +
              `$${t.investment || '?'} → ${t.result || '?'} (${t.profit >= 0 ? '+' : ''}$${t.profit || 0})`;
          });
          return `**Last ${trades.length} trades:**\n` + lines.join('\n');
        } catch (e) { return `History error: ${e.message}`; }
      }

      case 'martingale': {
        try {
          const m = await Agent.callTool('martingale', {});
          if (!m.ok) return `Martingale error: ${m.error}`;
          return [
            '**Martingale State**',
            `Enabled: ${m.enabled ? 'Yes' : 'No'}`,
            `Step: ${m.step || 0} / ${m.maxSteps || 3}`,
            `Current investment: $${m.currentInvestment || 0}`,
            `Base investment: $${m.baseInvestment || 1}`,
            `Multiplier: ${m.multiplier || 2}x`,
            `Max investment: $${m.maxInvestment || 100}`,
          ].join('\n');
        } catch (e) { return `Martingale error: ${e.message}`; }
      }

      case 'config': {
        const key = args[0];
        if (!key) return 'Usage: /config <key> [value]\nSpecify a key to read it, or key + value to set it.';
        if (args.length >= 2) {
          let value = args.slice(1).join(' ');
          value = _coerceValue(value);
          try {
            const r = await Agent.callTool('set_config', { key, value });
            if (!r.ok) return `Config set error: ${r.error}`;
            return `Config **${key}** set to \`${JSON.stringify(value)}\``;
          } catch (e) { return `Config set error: ${e.message}`; }
        }
        try {
          const r = await Agent.callTool('get_config', { key });
          if (!r.ok) return `Config get error: ${r.error}`;
          return `Config **${key}** = \`${JSON.stringify(r.value)}\``;
        } catch (e) { return `Config get error: ${e.message}`; }
      }

      case 'help':
        return [
          '**MindFlare TradingClaw — Chat Commands**',
          '',
          '`/analyze [pair]`   — Run analysis on current or specified pair',
          '`/scan`             — Rescan pairs for data',
          '`/trade <CALL|PUT> [investment]` — Execute a trade',
          '`/stop`             — Stop auto-pilot',
          '`/autopilot`        — Toggle auto-pilot on/off',
          '`/status`           — Show current status',
          '`/history [count]`  — Show recent trade history (default 10)',
          '`/martingale`       — Show martingale state',
          '`/config <key> [value]` — Get or set a config value',
          '`/help`             — Show this help message',
          '',
          'Or just type a message to chat with the AI assistant.',
          'The AI can invoke tools like analyze, trade, scan, etc.',
        ].join('\n');

      default:
        return `Unknown command: /${cmd}\nType /help for available commands.`;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  LLM CHAT MODE
  // ══════════════════════════════════════════════════════════════════

  async function _chatWithLLM(text) {
    if (typeof LLMClaw === 'undefined' || !LLMClaw.isAvailable()) {
      return 'LLM is not available. Configure an LLM provider in settings (e.g., Ollama, OpenRouter).';
    }
    if (_llmBusy) return 'Still processing a previous request — please wait.';

    _llmBusy = true;

    try {
      const systemPrompt = _buildSystemPrompt();
      const messages = [{ role: 'system', content: systemPrompt }];

      // Include recent chat history (last 20 messages for context window)
      const history = (MF.state.chatMessages || []).slice(-20);
      for (const msg of history) {
        if (msg.role === 'system') continue; // skip system messages — we have our own
        messages.push({ role: msg.role, content: msg.content });
      }
      messages.push({ role: 'user', content: text });

      MF.log('debug', 'Chat: sending to LLM, messages:', messages.length);

      const response = await LLMClaw.chat(messages, {
        temperature: MF.getConfig('llmTemperature') || 0.3,
        maxTokens:  MF.getConfig('llmMaxTokens') || 2048,
      });

      const rawText = response.text || '';
      const toolCalls = _parseToolCalls(rawText);
      const displayText = _stripToolCalls(rawText);

      if (displayText) _addMessage('assistant', displayText);

      // Execute any tool calls found in the response
      if (toolCalls.length > 0) {
        _addMessage('system', `Executing ${toolCalls.length} tool(s): ${toolCalls.map(c => c.name).join(', ')}...`);
        const toolResults = await _executeToolCalls(toolCalls);

        const resultLines = toolResults.map(r => {
          const res = r.result;
          if (res.ok === false || res.success === false) {
            return `**${r.name}**: Error — ${res.error || 'unknown'}`;
          }
          return `**${r.name}**: ${_summarizeResult(res)}`;
        });
        const toolMessage = resultLines.join('\n');
        _addMessage('assistant', toolMessage);
        return displayText ? displayText + '\n\n' + toolMessage : toolMessage;
      }

      return displayText || '(empty response)';

    } catch (e) {
      MF.log('error', 'Chat: LLM chat error:', e.message);
      const errMsg = `LLM error: ${e.message}`;
      _addMessage('system', errMsg);
      return errMsg;
    } finally {
      _llmBusy = false;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  MAIN ENTRY POINT
  // ══════════════════════════════════════════════════════════════════

  /**
   * Process a user message from the chat input.
   *   - If it starts with `/`, dispatch as a slash command.
   *   - Otherwise, send to the LLM with agent context.
   *
   * @param {string} text — the raw user input
   * @returns {Promise<string>} The response text shown to the user
   */
  async function sendMessage(text) {
    if (!text || typeof text !== 'string') return '';
    text = text.trim();
    if (!text) return '';

    // Record the user message
    _addMessage('user', text);

    try {
      if (text.startsWith('/')) {
        const response = await _handleSlashCommand(text);
        _addMessage('assistant', response);
        return response;
      }
      return await _chatWithLLM(text);
    } catch (e) {
      MF.log('error', 'Chat: sendMessage error:', e.message);
      const errMsg = `Error: ${e.message}`;
      _addMessage('system', errMsg);
      return errMsg;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT LISTENERS
  // ══════════════════════════════════════════════════════════════════

  MF.bus.on('agent:trade-complete', (trade) => {
    try {
      if (!trade) return;
      const profitStr = trade.profit >= 0 ? `+$${trade.profit}` : `-$${Math.abs(trade.profit)}`;
      _addMessage('system', `Trade complete: ${trade.direction} on ${trade.pair || '?'} → ${trade.result || '?'} (${profitStr})`);
    } catch (e) { MF.log('warn', 'Chat: trade-complete handler error:', e.message); }
  });

  MF.bus.on('agent:autopilot-start', () => {
    try { _addMessage('system', 'Auto-pilot **started**.'); } catch (_) {}
  });

  MF.bus.on('agent:autopilot-stop', () => {
    try { _addMessage('system', 'Auto-pilot **stopped**.'); } catch (_) {}
  });

  MF.bus.on('agent:martingale-reset', () => {
    try { _addMessage('system', 'Martingale reset to base investment.'); } catch (_) {}
  });

  // ══════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ══════════════════════════════════════════════════════════════════

  (function _init() {
    try {
      if (!Array.isArray(MF.state.chatMessages)) MF.state.chatMessages = [];
      if (MF.state.chatMessages.length === 0) {
        _addMessage('system', 'Welcome to **MindFlare TradingClaw** chat. Type /help for commands, or just ask me anything about trading.');
      }
      MF.log('info', 'Chat: initialized');
      MF.bus.emit('chat:ready');
    } catch (e) {
      MF.log('error', 'Chat: init error:', e.message);
    }
  })();

  // ══════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════════

  return {
    sendMessage,
    getMessages,
    clearMessages,
  };

})();
