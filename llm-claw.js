/**
 * llm-claw.js  —  Content-Side LLM Interface
 *
 * Self-contained IIFE assigned to global `LLMClaw`.
 * Bridges content scripts to the background service worker for all
 * LLM-powered trading analysis, signal generation, and chat.
 *
 * Globals used: MF (config/state/logging)
 */
'use strict';

const LLMClaw = (() => {
  // ── Trading-focused system prompt ──────────────────────────────────
  const TRADING_SYSTEM_PROMPT = [
    'You are MindFlare TradingClaw AI, a precise binary-options trading analyst.',
    'Analyze the provided technical data and market conditions carefully.',
    'Return ONLY valid JSON with this exact schema:',
    '{ "direction": "CALL" | "PUT" | "NEUTRAL", "confidence": <0-100>, "reasoning": "<brief explanation>" }',
    'Rules:',
    '- Be CONSERVATIVE: prefer NEUTRAL when signals are conflicting or weak.',
    '- Only recommend CALL/PUT when confidence is above 60.',
    '- Consider RSI extremes, MACD crossovers, Bollinger positions, EMA alignment,',
    '  SMC/ICT concepts (order blocks, FVGs, BOS/CHOCH), and candlestick patterns.',
    '- Factor in killzone timing — signals in active sessions carry more weight.',
    '- Never fabricate data — base your analysis strictly on what is provided.',
  ].join('\n');

  // ── Send message to background service worker ──────────────────────
  function _send(type, payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.error) {
            reject(new Error(response.error));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ── chat(messages, options) ────────────────────────────────────────
  /**
   * Send a chat completion request via the background service worker.
   * @param {Array<{role:string, content:string}>} messages
   * @param {Object} [options] — optional overrides (provider, model, etc.)
   * @returns {Promise<{text:string, provider:string, model:string}>}
   */
  async function chat(messages, options) {
    if (!Array.isArray(messages) || !messages.length) {
      throw new Error('LLMClaw.chat: messages array is required');
    }
    const result = await _send('llm:chat', { messages, options: options || {} });
    return result;
  }

  // ── analyze(pair, analysis) ────────────────────────────────────────
  /**
   * Send a structured analysis request to the LLM.
   * @param {string} pair — e.g. "EURUSD-OTC"
   * @param {Object} analysis — technical analysis output from TechnicalEngine
   * @returns {Promise<{text:string}>}
   */
  async function analyze(pair, analysis) {
    const userContent = [
      `Trading Pair: ${pair}`,
      `Timestamp: ${new Date().toISOString()}`,
      '',
      'Technical Analysis Data:',
      JSON.stringify(analysis, null, 2),
    ].join('\n');

    const messages = [
      { role: 'system', content: TRADING_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];

    return chat(messages);
  }

  // ── getSignal(pair, candles, analysis) ─────────────────────────────
  /**
   * Ask the LLM for a trading signal with direction, confidence, reasoning.
   * @param {string} pair
   * @param {Array} candles — recent candle data
   * @param {Object} analysis — technical analysis
   * @returns {Promise<{direction:string, confidence:number, reasoning:string}>}
   */
  async function getSignal(pair, candles, analysis) {
    // Summarize recent candles (last 10) to keep payload manageable
    const recentCandles = (candles || []).slice(-10).map(c => ({
      time: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume,
    }));

    const userContent = [
      `PAIR: ${pair}`,
      `TIME: ${new Date().toISOString()}`,
      '',
      '== RECENT CANDLES (last 10) ==',
      JSON.stringify(recentCandles, null, 2),
      '',
      '== TECHNICAL ANALYSIS ==',
      JSON.stringify(analysis || {}, null, 2),
      '',
      'Based on the above data, provide your trading signal as JSON.',
    ].join('\n');

    const messages = [
      { role: 'system', content: TRADING_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];

    try {
      const result = await chat(messages);
      // Parse JSON from the LLM response
      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          direction: ['CALL', 'PUT', 'NEUTRAL'].includes(parsed.direction) ? parsed.direction : 'NEUTRAL',
          confidence: MF.clamp(Math.round(parsed.confidence || 0), 0, 100),
          reasoning: parsed.reasoning || text,
        };
      }
      // Fallback: couldn't parse JSON
      return { direction: 'NEUTRAL', confidence: 0, reasoning: text };
    } catch (err) {
      MF.log('warn', 'LLMClaw.getSignal failed:', err.message);
      return { direction: 'NEUTRAL', confidence: 0, reasoning: `LLM error: ${err.message}` };
    }
  }

  // ── isAvailable() ──────────────────────────────────────────────────
  /**
   * Check whether an LLM provider is configured.
   * @returns {boolean}
   */
  function isAvailable() {
    const provider = MF.getConfig('llmProvider');
    if (!provider) return false;
    // Ollama is always "available" (local), others need an API key
    if (provider === 'ollama') return true;
    const providerInfo = _getProviderInfo(provider);
    if (!providerInfo || !providerInfo.keyField) return true; // custom with no key req
    const key = MF.getConfig(providerInfo.keyField);
    return !!(key && key.length > 0);
  }

  // ── getProviders() ─────────────────────────────────────────────────
  /**
   * Get list of available LLM providers (fetched from bg worker).
   * Falls back to a static list if the worker is unavailable.
   * @returns {Promise<Array<{id:string, name:string, needsKey:boolean}>>}
   */
  async function getProviders() {
    try {
      const config = await _send('config:get', {});
      // Build provider list from what we know
      const staticProviders = [
        { id: 'ollama', name: 'Ollama', needsKey: false },
        { id: 'openrouter', name: 'OpenRouter', needsKey: true },
        { id: 'groq', name: 'Groq', needsKey: true },
        { id: 'together', name: 'Together AI', needsKey: true },
        { id: 'deepinfra', name: 'DeepInfra', needsKey: true },
        { id: 'mistral', name: 'Mistral', needsKey: true },
        { id: 'openai', name: 'OpenAI', needsKey: true },
        { id: 'anthropic', name: 'Anthropic', needsKey: true },
        { id: 'cohere', name: 'Cohere', needsKey: true },
        { id: 'fireworks', name: 'Fireworks AI', needsKey: true },
        { id: 'perplexity', name: 'Perplexity', needsKey: true },
        { id: 'custom', name: 'Custom Endpoint', needsKey: false },
      ];
      // Mark which ones have keys configured
      return staticProviders.map(p => ({
        ...p,
        configured: p.needsKey ? !!(config && config[`${p.id}Key`]) : true,
      }));
    } catch (_) {
      return [
        { id: 'ollama', name: 'Ollama', needsKey: false, configured: true },
      ];
    }
  }

  // ── Internal: provider metadata mirror ─────────────────────────────
  function _getProviderInfo(id) {
    const map = {
      ollama: { keyField: null },
      openrouter: { keyField: 'openrouterKey' },
      groq: { keyField: 'groqKey' },
      together: { keyField: 'togetherKey' },
      deepinfra: { keyField: 'deepinfraKey' },
      mistral: { keyField: 'mistralKey' },
      openai: { keyField: 'openaiKey' },
      anthropic: { keyField: 'anthropicKey' },
      cohere: { keyField: 'cohereKey' },
      fireworks: { keyField: 'fireworksKey' },
      perplexity: { keyField: 'perplexityKey' },
      custom: { keyField: 'customKey' },
    };
    return map[id] || null;
  }

  // ── Public API ─────────────────────────────────────────────────────
  return { chat, analyze, getSignal, isAvailable, getProviders };
})();
