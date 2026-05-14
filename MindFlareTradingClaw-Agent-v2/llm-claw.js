/**
 * llm-claw.js  —  LLM Client Module for MindFlareClaw Agent v2.0
 *
 * Content-script side interface for LLM calls. Bridges all LLM requests
 * through the background service worker via chrome.runtime.sendMessage.
 *
 * Supports 11 providers with multi-provider fallback chain.
 * Ollama Cloud (10 rotating keys) is the default provider.
 * OpenRouter is the default fallback.
 *
 * Global namespace: MF (from core.js)
 */
/* global MF, chrome */

const LLMClaw = (() => {
  'use strict';

  // ── Provider Catalog ────────────────────────────────────────────────

  const PROVIDERS = {
    ollama: {
      label: 'Ollama Cloud',
      models: ['gemma4:31b', 'gpt-oss:120b', 'llama3.2:90b', 'mistral:123b', 'codestral:150b', 'mixtral:111b', 'deepseek-r1:671b'],
      requiresKey: true,
      keyConfig: 'ollamaKeys',
    },
    openai: {
      label: 'OpenAI',
      models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
      requiresKey: true,
      keyConfig: 'openaiKey',
    },
    openrouter: {
      label: 'OpenRouter',
      models: ['auto', 'anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-2.0-flash', 'deepseek/deepseek-r1', 'qwen/qwen-max'],
      requiresKey: true,
      keyConfig: 'openrouterKey',
    },
    anthropic: {
      label: 'Claude (Anthropic)',
      models: ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4.5'],
      requiresKey: true,
      keyConfig: 'anthropicKey',
    },
    gemini: {
      label: 'Gemini (Google)',
      models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
      requiresKey: true,
      keyConfig: 'geminiKey',
    },
    grok: {
      label: 'Grok (xAI)',
      models: ['grok-3', 'grok-3-mini', 'grok-3-reasoner'],
      requiresKey: true,
      keyConfig: 'grokKey',
    },
    opencode: {
      label: 'OpenCode',
      models: ['zen', 'go-catalogue'],
      requiresKey: true,
      keyConfig: 'opencodeKey',
    },
    zia: {
      label: 'Zia',
      models: ['zia-default'],
      requiresKey: true,
      keyConfig: 'ziaKey',
    },
    moonshot: {
      label: 'Moonshot (Kimi)',
      models: ['kimi-k2.5', 'kimi-k2'],
      requiresKey: true,
      keyConfig: 'moonshotKey',
    },
    qwen: {
      label: 'Qwen (Alibaba)',
      models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
      requiresKey: true,
      keyConfig: 'qwenKey',
    },
    openai_compat: {
      label: 'OpenAI Compatible',
      models: ['custom'],
      requiresKey: true,
      keyConfig: 'openaiCompatKey',
    },
  };

  // ── Ollama Key Rotation State ───────────────────────────────────────

  let _ollamaKeyIndex = 0;

  /**
   * Get the next Ollama Cloud key using round-robin rotation.
   * @returns {string|null} The next API key, or null if none available.
   */
  function _nextOllamaKey() {
    const keys = MF.getConfig('ollamaKeys');
    if (!Array.isArray(keys) || keys.length === 0) {
      // Fallback to defaults
      const defaults = MF.OLLAMA_KEYS_DEFAULT;
      if (!Array.isArray(defaults) || defaults.length === 0) return null;
      _ollamaKeyIndex = _ollamaKeyIndex % defaults.length;
      return defaults[_ollamaKeyIndex++];
    }
    _ollamaKeyIndex = _ollamaKeyIndex % keys.length;
    return keys[_ollamaKeyIndex++];
  }

  // ── Error Helpers ───────────────────────────────────────────────────

  const ERROR_MESSAGES = {
    no_provider:   'No LLM provider configured. Set llmProvider in settings.',
    no_model:      'No model selected for the current provider.',
    no_api_key:    'API key is missing for provider "{provider}". Add it in settings.',
    no_connection: 'Cannot reach the background service worker. Extension may be reloading.',
    bg_error:      'Background worker error: {detail}',
    timeout:       'LLM request timed out after {ms}ms. Provider may be overloaded.',
    parse_error:   'Failed to parse LLM response as JSON.',
    invalid_model: 'Model "{model}" is not available for provider "{provider}".',
    all_fallbacks: 'All providers in the fallback chain failed. Last error: {lastError}',
  };

  /**
   * Format an error message template with values.
   * @param {string} key - Error template key.
   * @param {object} vars - Variables to interpolate.
   * @returns {string} Formatted error message.
   */
  function _err(key, vars = {}) {
    let msg = ERROR_MESSAGES[key] || key;
    for (const [k, v] of Object.entries(vars)) {
      msg = msg.replace(`{${k}}`, String(v));
    }
    return msg;
  }

  // ── Core: Send message to background service worker ─────────────────

  /**
   * Send an LLM chat request to the background service worker.
   * @param {Array} messages - Chat messages array [{role, content}].
   * @param {object} options - Request options.
   * @param {string} options.provider - Provider ID.
   * @param {string} options.model - Model name.
   * @param {number} [options.temperature] - Sampling temperature.
   * @param {number} [options.maxTokens] - Max response tokens.
   * @param {string} [options.apiKey] - Optional API key override.
   * @param {number} [options.timeout] - Request timeout in ms.
   * @returns {Promise<{text: string, provider: string, model: string}>}
   */
  function _sendToBackground(messages, options) {
    return new Promise((resolve, reject) => {
      // Validate chrome.runtime is available
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error(_err('no_connection')));
        return;
      }

      const timeout = options.timeout || 90000;
      let settled = false;

      // Timeout guard — service worker may be asleep or unresponsive
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(_err('timeout', { ms: timeout })));
        }
      }, timeout);

      chrome.runtime.sendMessage(
        { type: 'llm:chat', messages, options },
        (response) => {
          clearTimeout(timer);
          if (settled) return; // already timed out
          settled = true;

          // Check for chrome.runtime.lastError (connection lost, SW killed, etc.)
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || 'Unknown runtime error';
            // Common MV3 issue: service worker was evicted
            if (msg.includes('Receiving end does not exist') || msg.includes('message port closed')) {
              reject(new Error(_err('no_connection')));
            } else {
              reject(new Error(_err('bg_error', { detail: msg })));
            }
            return;
          }

          // No response at all
          if (!response) {
            reject(new Error(_err('no_connection')));
            return;
          }

          // Background returned an error
          if (response.error) {
            reject(new Error(response.error));
            return;
          }

          // Success
          resolve({
            text: response.text || '',
            provider: response.provider || options.provider,
            model: response.model || options.model,
          });
        }
      );
    });
  }

  // ── Build options from config + overrides ───────────────────────────

  /**
   * Build LLM request options by merging config defaults with user overrides.
   * Injects the appropriate API key for the chosen provider.
   * @param {object} [overrides] - User-provided option overrides.
   * @returns {object} Merged options object.
   */
  function _buildOptions(overrides = {}) {
    const provider = overrides.provider || MF.getConfig('llmProvider') || 'ollama';
    const model = overrides.model || MF.getConfig('llmModel') || (PROVIDERS[provider]?.models?.[0]);
    const temperature = overrides.temperature ?? MF.getConfig('llmTemperature') ?? 0.2;
    const maxTokens = overrides.maxTokens ?? MF.getConfig('llmMaxTokens') ?? 600;

    const opts = {
      provider,
      model,
      temperature: MF.clamp(temperature, 0, 2),
      maxTokens: Math.max(1, Math.round(maxTokens)),
    };

    // Inject the API key for the chosen provider
    const providerDef = PROVIDERS[provider];
    if (providerDef) {
      if (provider === 'ollama') {
        // Ollama uses rotating keys — send the next one
        const key = _nextOllamaKey();
        if (key) opts.apiKey = key;
      } else if (providerDef.keyConfig) {
        const key = MF.getConfig(providerDef.keyConfig);
        if (key) opts.apiKey = key;
      }
    }

    // OpenAI Compatible needs the base URL
    if (provider === 'openai_compat') {
      opts.baseUrl = MF.getConfig('openaiCompatBaseUrl') || '';
    }

    // Apply user overrides (apiKey, baseUrl, timeout, etc.)
    if (overrides.apiKey) opts.apiKey = overrides.apiKey;
    if (overrides.baseUrl) opts.baseUrl = overrides.baseUrl;
    if (overrides.timeout) opts.timeout = overrides.timeout;

    return opts;
  }

  // ── Validate provider config ────────────────────────────────────────

  /**
   * Validate that a provider has the minimum required configuration.
   * @param {string} providerId - Provider identifier.
   * @returns {{valid: boolean, error: string|null}}
   */
  function _validateProvider(providerId) {
    const providerDef = PROVIDERS[providerId];
    if (!providerDef) {
      return { valid: false, error: `Unknown provider "${providerId}". Available: ${Object.keys(PROVIDERS).join(', ')}` };
    }

    // Check for API key
    if (providerDef.requiresKey) {
      if (providerId === 'ollama') {
        const keys = MF.getConfig('ollamaKeys');
        const defaults = MF.OLLAMA_KEYS_DEFAULT;
        if ((!Array.isArray(keys) || keys.length === 0) && (!Array.isArray(defaults) || defaults.length === 0)) {
          return { valid: false, error: _err('no_api_key', { provider: providerDef.label }) };
        }
      } else if (providerDef.keyConfig) {
        const key = MF.getConfig(providerDef.keyConfig);
        if (!key) {
          return { valid: false, error: _err('no_api_key', { provider: providerDef.label }) };
        }
      }
    }

    return { valid: true, error: null };
  }

  // ── Public API: chat() ──────────────────────────────────────────────

  /**
   * Send a chat completion request to the LLM via the background service worker.
   * Falls back through the configured provider chain on failure.
   *
   * @param {Array<{role: string, content: string}>} messages - Chat messages.
   * @param {object} [overrides] - Option overrides (provider, model, temperature, etc.).
   * @returns {Promise<{text: string, provider: string, model: string}>} Response data.
   * @throws {Error} If all providers fail or configuration is invalid.
   */
  async function chat(messages, overrides = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('chat() requires a non-empty messages array.');
    }

    // Build the primary options
    const primaryOpts = _buildOptions(overrides);

    // Validate primary provider
    const primaryCheck = _validateProvider(primaryOpts.provider);
    if (!primaryCheck.valid) {
      MF.log('warn', `Primary provider invalid: ${primaryCheck.error}`);
    }

    // Build the fallback chain
    const fallbackList = MF.getConfig('fallbackProviders') || ['openrouter'];
    const chain = [primaryOpts.provider, ...fallbackList.filter(p => p !== primaryOpts.provider)];

    let lastError = null;

    for (const providerId of chain) {
      const validation = _validateProvider(providerId);
      if (!validation.valid) {
        MF.log('warn', `Skipping provider "${providerId}": ${validation.error}`);
        lastError = new Error(validation.error);
        continue;
      }

      // Build options for this provider
      const opts = (providerId === primaryOpts.provider)
        ? primaryOpts
        : _buildOptions({ ...overrides, provider: providerId });

      // Pick the default model for this provider if the override model doesn't belong
      const providerDef = PROVIDERS[providerId];
      if (providerDef && !providerDef.models.includes(opts.model)) {
        opts.model = providerDef.models[0];
      }

      MF.log('debug', `LLM request → ${providerId}/${opts.model}`);

      try {
        const result = await _sendToBackground(messages, opts);
        MF.log('debug', `LLM response ← ${result.provider}/${result.model} (${result.text.length} chars)`);
        return result;
      } catch (err) {
        MF.log('warn', `Provider "${providerId}" failed: ${err.message}`);
        lastError = err;
        continue; // try next provider in chain
      }
    }

    // All providers exhausted
    throw new Error(_err('all_fallbacks', { lastError: lastError?.message || 'unknown' }));
  }

  // ── Public API: analyze() ───────────────────────────────────────────

  /**
   * Run a trading analysis on the given pair using the LLM.
   * Builds a trading-focused system prompt and formats the analysis data.
   *
   * @param {string} pair - Trading pair (e.g. "EUR/USD").
   * @param {object} analysis - Technical analysis data object.
   * @param {object} [overrides] - LLM option overrides.
   * @returns {Promise<{text: string, provider: string, model: string}>} Raw LLM response.
   */
  async function analyze(pair, analysis, overrides = {}) {
    if (!pair) throw new Error('analyze() requires a trading pair.');
    if (!analysis || typeof analysis !== 'object') throw new Error('analyze() requires an analysis object.');

    const systemPrompt = [
      MF.PROMPT_SOUL,
      '',
      MF.PROMPT_AGENTS,
      '',
      MF.PROMPT_STRATEGIES,
      '',
      `# CONTEXT — Current pair: ${pair}`,
      '',
      'Analyze the following technical data for this pair. Provide a structured assessment:',
      '- Market regime (trending / ranging / volatile / quiet)',
      '- Key support & resistance levels',
      '- Indicator confluences (RSI, MACD, EMA, Bollinger, Stochastic)',
      '- SMC / ICT concepts if visible (FVG, OB, CHoCH, BOS, liquidity sweeps)',
      '- Overall directional bias with confidence',
      '- Risk assessment for a 1-minute binary option',
      '',
      'Be concise. Lead with conviction. If the setup is unclear, say so — but propose the most likely scenario.',
    ].join('\n');

    const userPrompt = `## Technical Analysis — ${pair}\n\n\`\`\`json\n${JSON.stringify(analysis, null, 2)}\n\`\`\``;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    return chat(messages, overrides);
  }

  // ── Public API: getSignal() ─────────────────────────────────────────

  /**
   * Generate a trading signal for the given pair using the LLM.
   * Returns a structured signal with direction, confidence, and reasoning.
   *
   * @param {string} pair - Trading pair (e.g. "EUR/USD").
   * @param {Array} candles - Recent candle data.
   * @param {object} analysis - Technical analysis data.
   * @param {object} [overrides] - LLM option overrides.
   * @returns {Promise<{direction: 'CALL'|'PUT'|'NEUTRAL', confidence: number, reasoning: string}>}
   */
  async function getSignal(pair, candles, analysis, overrides = {}) {
    if (!pair) throw new Error('getSignal() requires a trading pair.');

    const systemPrompt = [
      MF.PROMPT_SOUL,
      '',
      MF.PROMPT_AGENTS,
      '',
      MF.PROMPT_STRATEGIES,
      '',
      `# SIGNAL REQUEST — Pair: ${pair}`,
      '',
      'Based on the technical analysis and recent candle data below, generate a trading signal.',
      '',
      'You MUST respond with ONLY a JSON object in this exact format — no markdown, no extra text:',
      '{"direction":"CALL|PUT|NEUTRAL","confidence":75,"reasoning":"brief explanation"}',
      '',
      'Rules:',
      '- direction: CALL = bullish (price likely UP), PUT = bearish (price likely DOWN), NEUTRAL = no clear edge',
      '- confidence: integer 0-100 representing your conviction level',
      '- reasoning: concise explanation (max 200 chars) of your thesis',
      '- Be decisive. Only use NEUTRAL when there is genuinely no readable edge.',
      '- Do NOT default to NEUTRAL. A readable path of least resistance means COMMIT.',
    ].join('\n');

    // Build the user message with candles and analysis
    const candleSummary = Array.isArray(candles) && candles.length > 0
      ? `Last ${Math.min(candles.length, 20)} candles (OHLCV):\n${JSON.stringify(candles.slice(-20), null, 2)}`
      : 'No candle data available.';

    const analysisStr = analysis && typeof analysis === 'object'
      ? JSON.stringify(analysis, null, 2)
      : 'No analysis data provided.';

    const userPrompt = [
      `## Pair: ${pair}`,
      '',
      candleSummary,
      '',
      '## Technical Analysis:',
      analysisStr,
      '',
      'Generate your signal now. Respond with ONLY the JSON object:',
    ].join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const result = await chat(messages, overrides);

    // Parse the JSON response
    const parsed = extractJSON(result.text);

    // Normalize the result
    const direction = _normalizeDirection(parsed.direction);
    const confidence = MF.clamp(
      typeof parsed.confidence === 'number' ? Math.round(parsed.confidence) : 50,
      0,
      100
    );
    const reasoning = typeof parsed.reasoning === 'string'
      ? parsed.reasoning.slice(0, 300)
      : 'No reasoning provided.';

    return { direction, confidence, reasoning };
  }

  // ── Direction Normalization ─────────────────────────────────────────

  /**
   * Normalize various direction strings to CALL / PUT / NEUTRAL.
   * @param {string} dir - Raw direction string from LLM.
   * @returns {'CALL'|'PUT'|'NEUTRAL'}
   */
  function _normalizeDirection(dir) {
    if (!dir || typeof dir !== 'string') return 'NEUTRAL';

    const upper = dir.trim().toUpperCase();

    // Direct matches
    if (upper === 'CALL' || upper === 'UP' || upper === 'BUY' || upper === 'LONG' || upper === 'BULLISH') {
      return 'CALL';
    }
    if (upper === 'PUT' || upper === 'DOWN' || upper === 'SELL' || upper === 'SHORT' || upper === 'BEARISH') {
      return 'PUT';
    }

    return 'NEUTRAL';
  }

  // ── Public API: extractJSON() ───────────────────────────────────────

  /**
   * Extract and parse a JSON object from an LLM response string.
   * Handles markdown code fences, extra text, and common formatting issues.
   *
   * @param {string} text - Raw LLM response text.
   * @returns {object} Parsed JSON object.
   * @throws {Error} If no valid JSON object can be extracted.
   */
  function extractJSON(text) {
    if (!text || typeof text !== 'string') {
      throw new Error(_err('parse_error') + ' Empty or invalid input.');
    }

    let cleaned = text;

    // Strip markdown code fences: ```json ... ``` or ``` ... ```
    cleaned = cleaned.replace(/```(?:json|JSON)?\s*\n?/g, '');
    cleaned = cleaned.replace(/```\s*/g, '');

    // Remove leading/trailing whitespace and newlines
    cleaned = cleaned.trim();

    // Strategy 1: Try parsing the whole cleaned string
    try {
      const obj = JSON.parse(cleaned);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (_) {
      // Not pure JSON, continue
    }

    // Strategy 2: Find the first { ... } block with balanced braces
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) {
      throw new Error(_err('parse_error') + ' No JSON object found in response.');
    }

    // Walk through to find the matching closing brace
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = firstBrace; i < cleaned.length; i++) {
      const ch = cleaned[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') depth--;

      if (depth === 0) {
        // Found the matching closing brace
        const jsonStr = cleaned.substring(firstBrace, i + 1);
        try {
          const obj = JSON.parse(jsonStr);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
        } catch (parseErr) {
          // Strategy 3: Try to fix common issues and re-parse
          const fixed = _tryFixJSON(jsonStr);
          try {
            const obj = JSON.parse(fixed);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
          } catch (_) {
            // Still broken, continue looking
          }
        }
      }
    }

    // Strategy 4: Last resort — regex extraction of what looks like a JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*?"direction"[\s\S]*?"confidence"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]);
        if (obj && typeof obj === 'object') return obj;
      } catch (_) {
        // nope
      }
    }

    throw new Error(_err('parse_error') + ' Could not extract valid JSON from LLM response.');
  }

  /**
   * Attempt to fix common JSON issues from LLM output.
   * @param {string} str - Possibly malformed JSON string.
   * @returns {string} Attempted fix.
   */
  function _tryFixJSON(str) {
    let fixed = str;

    // Remove trailing commas before } or ]
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');

    // Add missing quotes around unquoted keys
    fixed = fixed.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

    // Replace single quotes with double quotes
    fixed = fixed.replace(/'/g, '"');

    // Remove comments (// style)
    fixed = fixed.replace(/\/\/.*$/gm, '');

    return fixed;
  }

  // ── Public API: isAvailable() ───────────────────────────────────────

  /**
   * Check if the LLM subsystem is available and at least one provider is configured.
   * @returns {boolean} True if LLM calls can be made.
   */
  function isAvailable() {
    const provider = MF.getConfig('llmProvider');
    if (!provider || !PROVIDERS[provider]) return false;

    // Check that the primary provider has a key
    const validation = _validateProvider(provider);
    if (validation.valid) return true;

    // Check fallback providers
    const fallbacks = MF.getConfig('fallbackProviders') || [];
    for (const fb of fallbacks) {
      if (_validateProvider(fb).valid) return true;
    }

    return false;
  }

  // ── Public API: getProviders() ──────────────────────────────────────

  /**
   * Get the full provider catalog with current availability status.
   * Useful for building UI provider selectors.
   *
   * @returns {object} Provider info keyed by provider ID.
   *   Each entry: { label, models, requiresKey, hasKey, available }
   */
  function getProviders() {
    const result = {};

    for (const [id, def] of Object.entries(PROVIDERS)) {
      const validation = _validateProvider(id);
      let hasKey = false;

      if (id === 'ollama') {
        const keys = MF.getConfig('ollamaKeys');
        const defaults = MF.OLLAMA_KEYS_DEFAULT;
        hasKey = (Array.isArray(keys) && keys.length > 0) || (Array.isArray(defaults) && defaults.length > 0);
      } else if (def.keyConfig) {
        hasKey = !!MF.getConfig(def.keyConfig);
      }

      result[id] = {
        id,
        label: def.label,
        models: [...def.models],
        requiresKey: def.requiresKey,
        hasKey,
        available: validation.valid,
      };
    }

    return result;
  }

  // ── Event Listeners ─────────────────────────────────────────────────

  // Listen for config changes that affect LLM availability
  if (MF.bus && typeof MF.bus.on === 'function') {
    MF.bus.on('config:change', (key) => {
      const llmKeys = [
        'llmProvider', 'llmModel', 'llmTemperature', 'llmMaxTokens',
        'ollamaKeys', 'openrouterKey', 'openaiKey', 'anthropicKey',
        'geminiKey', 'grokKey', 'opencodeKey', 'ziaKey', 'moonshotKey',
        'qwenKey', 'openaiCompatKey', 'openaiCompatBaseUrl', 'fallbackProviders',
      ];
      if (llmKeys.includes(key)) {
        MF.log('debug', `LLM config changed: ${key}`);
        MF.bus.emit('llm:configChanged', key);
      }
    });
  }

  // ── Expose Public API ───────────────────────────────────────────────

  return {
    chat,
    analyze,
    getSignal,
    isAvailable,
    getProviders,
    extractJSON,
  };
})();
