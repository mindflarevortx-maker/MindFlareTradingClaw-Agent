/**
 * service-worker.js  —  Background Service Worker
 *
 * MindFlare TradingClaw Agent v1.2.0-beta1
 * Handles LLM chat completions across 11+ providers, config management,
 * Chrome alarms, and notification relay for the extension.
 */
'use strict';

// ── LLM Provider Registry ────────────────────────────────────────────
const PROVIDERS = {
  ollama: {
    name: 'Ollama',
    endpoint: (base) => `${base || 'http://localhost:11434'}/api/chat`,
    keyField: null,  // local — no key needed
    models: ['llama3', 'llama3.1', 'mistral', 'codellama', 'qwen2', 'gemma2'],
    format: 'ollama',
  },
  openrouter: {
    name: 'OpenRouter',
    endpoint: () => 'https://openrouter.ai/api/v1/chat/completions',
    keyField: 'openrouterKey',
    models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-pro-1.5', 'meta-llama/llama-3.1-70b-instruct'],
    format: 'openai',
  },
  groq: {
    name: 'Groq',
    endpoint: () => 'https://api.groq.com/openai/v1/chat/completions',
    keyField: 'groqKey',
    models: ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    format: 'openai',
  },
  together: {
    name: 'Together AI',
    endpoint: () => 'https://api.together.xyz/v1/chat/completions',
    keyField: 'togetherKey',
    models: ['meta-llama/Llama-3-70b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
    format: 'openai',
  },
  deepinfra: {
    name: 'DeepInfra',
    endpoint: () => 'https://api.deepinfra.com/v1/openai/chat/completions',
    keyField: 'deepinfraKey',
    models: ['meta-llama/Meta-Llama-3.1-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
    format: 'openai',
  },
  mistral: {
    name: 'Mistral',
    endpoint: () => 'https://api.mistral.ai/v1/chat/completions',
    keyField: 'mistralKey',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'open-mistral-nemo'],
    format: 'openai',
  },
  openai: {
    name: 'OpenAI',
    endpoint: () => 'https://api.openai.com/v1/chat/completions',
    keyField: 'openaiKey',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    format: 'openai',
  },
  anthropic: {
    name: 'Anthropic',
    endpoint: () => 'https://api.anthropic.com/v1/messages',
    keyField: 'anthropicKey',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
    format: 'anthropic',
  },
  cohere: {
    name: 'Cohere',
    endpoint: () => 'https://api.cohere.com/v1/chat',
    keyField: 'cohereKey',
    models: ['command-r-plus', 'command-r'],
    format: 'cohere',
  },
  fireworks: {
    name: 'Fireworks AI',
    endpoint: () => 'https://api.fireworks.ai/inference/v1/chat/completions',
    keyField: 'fireworksKey',
    models: ['accounts/fireworks/models/llama-v3p1-70b-instruct', 'accounts/fireworks/models/qwen2p5-72b-instruct'],
    format: 'openai',
  },
  perplexity: {
    name: 'Perplexity',
    endpoint: () => 'https://api.perplexity.ai/chat/completions',
    keyField: 'perplexityKey',
    models: ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'],
    format: 'openai',
  },
  custom: {
    name: 'Custom Endpoint',
    endpoint: (base) => base || '',
    keyField: 'customKey',
    models: [],
    format: 'openai',
  },
};

// ── Ollama Key Rotation ──────────────────────────────────────────────
// Rotate through multiple Ollama model endpoints to spread rate-limit load
let _ollamaRotationIndex = 0;

function getOllamaRotatedModel(config) {
  const available = PROVIDERS.ollama.models;
  if (!available.length) return config.llmModel || 'llama3';
  const model = available[_ollamaRotationIndex % available.length];
  _ollamaRotationIndex++;
  return model;
}

// ── Default Config ────────────────────────────────────────────────────
const DEFAULTS = {
  llmProvider: 'ollama',
  llmModel: 'llama3',
  ollamaBaseUrl: 'http://localhost:11434',
  openrouterKey: '', groqKey: '', togetherKey: '', deepinfraKey: '',
  mistralKey: '', openaiKey: '', anthropicKey: '', cohereKey: '',
  fireworksKey: '', perplexityKey: '', customEndpoint: '', customKey: '',
  llmTemperature: 0.3,
  llmMaxTokens: 2048,
};

// ── Config helpers ────────────────────────────────────────────────────
async function getConfig() {
  try {
    const stored = await chrome.storage.local.get('mf_config');
    return { ...DEFAULTS, ...(stored.mf_config || {}) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

async function setConfig(updates) {
  const current = await getConfig();
  Object.assign(current, updates);
  await chrome.storage.local.set({ mf_config: current });
  return current;
}

// ── Build request body per provider format ────────────────────────────
function buildRequestBody(provider, model, messages, config) {
  const temperature = config.llmTemperature ?? 0.3;
  const maxTokens = config.llmMaxTokens ?? 2048;

  if (provider.format === 'ollama') {
    return { model, messages, stream: false, options: { temperature, num_predict: maxTokens } };
  }
  if (provider.format === 'anthropic') {
    // Anthropic expects separate system + messages array
    const system = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    return {
      model, max_tokens: maxTokens, temperature,
      system: system ? system.content : '',
      messages: chatMsgs,
    };
  }
  if (provider.format === 'cohere') {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const system = messages.find(m => m.role === 'system');
    return {
      model, message: lastUser ? lastUser.content : '',
      temperature, max_tokens: maxTokens,
      preamble: system ? system.content : '',
      chat_history: messages.filter(m => m.role !== 'system' && m !== lastUser)
        .map(m => ({ role: m.role === 'assistant' ? 'CHATBOT' : 'USER', message: m.content })),
    };
  }
  // Default: OpenAI-compatible
  return { model, messages, temperature, max_tokens: maxTokens };
}

// ── Parse response per provider format ────────────────────────────────
function parseResponse(provider, data) {
  if (provider.format === 'ollama') {
    return data.message ? data.message.content : (data.response || '');
  }
  if (provider.format === 'anthropic') {
    return data.content && data.content[0] ? data.content[0].text : '';
  }
  if (provider.format === 'cohere') {
    return data.text || '';
  }
  // OpenAI-compatible
  return data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
}

// ── Build request headers per provider ────────────────────────────────
function buildHeaders(provider, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.format === 'ollama') return headers;
  if (provider.format === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return headers;
  }
  headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

// ── Chat completion with fallback ─────────────────────────────────────
async function chatCompletion(messages, overrides) {
  const config = await getConfig();
  const merged = { ...config, ...overrides };
  const providerName = merged.llmProvider || 'ollama';
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);

  // Resolve model — rotate if Ollama
  let model = merged.llmModel || 'llama3';
  if (providerName === 'ollama') {
    model = getOllamaRotatedModel(merged);
  }

  // Resolve API key
  const apiKey = provider.keyField ? (merged[provider.keyField] || '') : '';
  if (provider.keyField && !apiKey) {
    throw new Error(`API key missing for ${provider.name}`);
  }

  // Build endpoint URL
  const endpoint = providerName === 'ollama'
    ? provider.endpoint(merged.ollamaBaseUrl)
    : (providerName === 'custom'
        ? provider.endpoint(merged.customEndpoint)
        : provider.endpoint());

  // Attempt primary provider, then fallback
  const tryProviders = [providerName];
  if (providerName !== 'ollama') {
    // Fall back to Ollama (free) if remote fails
    tryProviders.push('ollama');
  }

  for (const name of tryProviders) {
    const p = PROVIDERS[name];
    let m = model, url = endpoint, key = apiKey;

    if (name === 'ollama' && name !== providerName) {
      // Fallback to Ollama
      m = getOllamaRotatedModel(merged);
      url = p.endpoint(merged.ollamaBaseUrl);
      key = '';
    }

    const body = buildRequestBody(p, m, messages, merged);
    const headers = buildHeaders(p, key);

    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.warn(`[MindFlare SW] ${p.name} error ${resp.status}: ${errText}`);
        continue; // try next fallback
      }
      const data = await resp.json();
      const text = parseResponse(p, data);
      if (text) return { text, provider: name, model: m };
    } catch (err) {
      console.warn(`[MindFlare SW] ${p.name} fetch failed:`, err.message);
      continue;
    }
  }

  throw new Error('All LLM providers failed');
}

// ── Message Handler ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  const handle = async () => {
    switch (msg.type) {
      case 'llm:chat': {
        const result = await chatCompletion(msg.messages || [], msg.options);
        return result;
      }

      case 'llm:stream': {
        // MV3 service workers don't support persistent connections well,
        // so we fall back to non-streaming and return the full result
        const result = await chatCompletion(msg.messages || [], msg.options);
        return { ...result, streamed: false };
      }

      case 'config:get': {
        const config = await getConfig();
        return config;
      }

      case 'config:set': {
        const config = await setConfig(msg.updates || {});
        return { ok: true, config };
      }

      case 'alarm:set': {
        const { name, periodInMinutes, delayInMinutes } = msg;
        if (!name) return { ok: false, error: 'Alarm name required' };
        chrome.alarms.create(name, { periodInMinutes: periodInMinutes || 5, delayInMinutes: delayInMinutes || 1 });
        return { ok: true };
      }

      case 'notification:show': {
        const { title, message, iconUrl } = msg;
        chrome.notifications.create({
          type: 'basic',
          iconUrl: iconUrl || 'icons/icon128.png',
          title: title || 'MindFlare TradingClaw',
          message: message || '',
        });
        return { ok: true };
      }

      default:
        return { error: `Unknown message type: ${msg.type}` };
    }
  };

  handle().then(sendResponse).catch(err => {
    sendResponse({ error: err.message || 'Unknown error' });
  });
  return true; // keep channel open for async response
});

// ── Chrome Alarms ────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  switch (alarm.name) {
    case 'scanner:health':
      console.log('[MindFlare SW] Scanner health check');
      break;
    case 'candle:cleanup':
      console.log('[MindFlare SW] Candle cleanup triggered');
      break;
  }
});

// ── Extension Install / Update ───────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ mf_config: DEFAULTS });
    console.log('[MindFlare SW] Default config saved on install');
  }

  // Set up periodic alarms
  chrome.alarms.create('scanner:health', { periodInMinutes: 5, delayInMinutes: 1 });
  chrome.alarms.create('candle:cleanup', { periodInMinutes: 30, delayInMinutes: 5 });

  if (details.reason === 'update') {
    // Merge new defaults into existing config (preserves user keys)
    const existing = await getConfig();
    const merged = { ...DEFAULTS, ...existing };
    await chrome.storage.local.set({ mf_config: merged });
    console.log(`[MindFlare SW] Updated to v${chrome.runtime.getManifest().version}`);
  }
});
