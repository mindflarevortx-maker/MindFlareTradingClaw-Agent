/**
 * service-worker.js  —  Background Service Worker (MV3)
 *
 * MindFlareClaw-AGENT v2.0
 *
 * Roles:
 *   1. LLM HTTP proxy (CSP bypass for content scripts)
 *   2. Ollama Cloud API key auto-rotation with cooldown
 *   3. Screenshot capture for vision
 *   4. Cross-tab message bus
 *   5. Notification dispatch
 *
 * Supports 11 LLM providers:
 *   Ollama Cloud, OpenAI, OpenRouter, Anthropic, Gemini, Grok,
 *   OpenCode, Zia, Moonshot, Qwen, OpenAI-Compatible
 */

'use strict';

const log = (...a) => console.log('[MFC-bg]', ...a);

// =================================================================
// LLM PROVIDER DEFINITIONS — 11 providers, all request shapes
// =================================================================
const PROVIDER_DEFS = {
  ollama: {
    url: () => 'https://api.ollama.com/api/chat',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (msgs, m, opts) => ({ model: m, messages: msgs, stream: false, options: { temperature: opts.temperature ?? 0.2, num_predict: opts.max_tokens ?? 600 } }),
    parse: (j) => j?.message?.content || j?.choices?.[0]?.message?.content || '',
  },
  openai: {
    url: () => 'https://api.openai.com/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (msgs, m, opts) => ({ model: m, messages: msgs, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 600 }),
    parse: (j) => j?.choices?.[0]?.message?.content || '',
  },
  openrouter: {
    url: () => 'https://openrouter.ai/api/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://market-qx.trade', 'X-Title': 'MFC Agent' }),
    body: (msgs, m, opts) => ({ model: m, messages: msgs, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 600 }),
    parse: (j) => j?.choices?.[0]?.message?.content || '',
  },
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' }),
    body: (msgs, m, opts) => {
      const sys = msgs.filter(x => x.role === 'system').map(x => contentToText(x.content)).join('\n\n');
      const rest = msgs.filter(x => x.role !== 'system').map(x => ({
        role: x.role === 'assistant' ? 'assistant' : 'user',
        content: anthropicContent(x.content),
      }));
      return { model: m, system: sys || undefined, messages: rest, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 600 };
    },
    parse: (j) => (j?.content || []).map(c => c.text || '').join('') || '',
  },
  gemini: {
    url: (m, k) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(k)}`,
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: (msgs, m, opts) => {
      const sys = msgs.filter(x => x.role === 'system').map(x => contentToText(x.content)).join('\n\n');
      const contents = msgs.filter(x => x.role !== 'system').map(x => ({
        role: x.role === 'assistant' ? 'model' : 'user',
        parts: geminiParts(x.content),
      }));
      const req = { contents, generationConfig: { temperature: opts.temperature ?? 0.2, maxOutputTokens: opts.max_tokens ?? 600 } };
      if (sys) req.systemInstruction = { parts: [{ text: sys }] };
      return req;
    },
    parse: (j) => j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '',
  },
  grok: {
    url: () => 'https://api.x.ai/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (msgs, m, opts) => ({ model: m, messages: msgs, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 600 }),
    parse: (j) => j?.choices?.[0]?.message?.content || '',
  },
  opencode: {
    url: () => 'https://api.opencode.ai/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (msgs, m, opts) => ({ model: m, messages: msgs, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 600 }),
    parse: (j) => j?.choices?.[0]?.message?.content || '',
  },
  zia: {
    url: () => 'https://api.zia.ai/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (msgs, m, opts) => ({ model: m, messages: msgs, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 600 }),
    parse: (j) => j?.choices?.[0]?.message?.content || '',
  },
  moonshot: {
    url: () => 'https://api.moonshot.cn/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (msgs, m, opts) => ({ model: m, messages: msgs, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 600 }),
    parse: (j) => j?.choices?.[0]?.message?.content || '',
  },
  qwen: {
    url: () => 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (msgs, m, opts) => ({ model: m, messages: msgs, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 600 }),
    parse: (j) => j?.choices?.[0]?.message?.content || '',
  },
  openai_compat: {
    url: (m, k, opts) => opts?.baseUrl || 'https://api.openai.com/v1/chat/completions',
    headers: (k) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: (msgs, m, opts) => ({ model: m, messages: msgs, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens ?? 600 }),
    parse: (j) => j?.choices?.[0]?.message?.content || '',
  },
};

// =================================================================
// Content format helpers
// =================================================================
const contentToText = (c) => Array.isArray(c) ? c.filter(p => p.type === 'text').map(p => p.text).join('\n') : (c || '');

const splitDataUrl = (u) => {
  const m = String(u || '').match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mediaType: m[1], data: m[2] } : null;
};

const anthropicContent = (c) => Array.isArray(c)
  ? c.map(p => p.type === 'image'
    ? { type: 'image', source: (() => { const s = splitDataUrl(p.dataUrl); return s ? { type:'base64', media_type:s.mediaType, data:s.data } : null; })() }
    : { type: 'text', text: p.text || '' }).filter(p => p.source !== null)
  : [{ type: 'text', text: c || '' }];

const geminiParts = (c) => Array.isArray(c)
  ? c.map(p => p.type === 'image'
    ? (() => { const s = splitDataUrl(p.dataUrl); return s ? { inline_data: { mime_type: s.mediaType, data: s.data } } : null; })()
    : { text: p.text || '' }).filter(Boolean)
  : [{ text: c || '' }];

const normaliseMessages = (provider, msgs) => {
  if (provider === 'anthropic' || provider === 'gemini') return msgs;
  return msgs.map(m => ({ role: m.role, content: m.content }));
};

// =================================================================
// Single LLM call
// =================================================================
async function callLLMOnce({ provider, apiKey, model, messages, opts }) {
  const def = PROVIDER_DEFS[provider];
  if (!def) throw new Error('unknown provider: ' + provider);
  const url = provider === 'openai_compat' ? (opts?.baseUrl || def.url()) : def.url(model, apiKey);
  const normalised = normaliseMessages(provider, messages);
  const body = JSON.stringify(def.body(normalised, model, opts));
  const headers = def.headers(apiKey);
  const r = await fetch(url, { method: 'POST', headers, body });
  const txt = await r.text();
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  let j;
  try { j = JSON.parse(txt); } catch (_) { return txt; }
  return def.parse(j) || txt;
}

// =================================================================
// KEY AUTO-ROTATION with cooldown (ALL providers, not just Ollama)
// =================================================================
// Keys are loaded from chrome.storage at runtime. Configure via Options page.

async function callLLM({ provider, apiKeys, model, messages, opts = {} }) {
  const config = await getConfig();
  
  // Get keys for this provider — support both array and single-key formats
  function getProviderKeys(prov) {
    // Try array format first (new multi-key support)
    const arrayKey = prov + 'Keys'; // e.g., 'ollamaKeys', 'openaiKeys'
    if (Array.isArray(apiKeys?.[prov]) && apiKeys[prov].length > 0) {
      return apiKeys[prov].filter(k => k && k.trim());
    }
    // Fallback to config array
    if (Array.isArray(config[arrayKey]) && config[arrayKey].length > 0) {
      return config[arrayKey].filter(k => k && k.trim());
    }
    // Try single-key format (backward compat)
    const singleKey = apiKeys?.[prov] || config[prov + 'Key'] || '';
    if (singleKey && typeof singleKey === 'string' && singleKey.trim()) {
      return [singleKey.trim()];
    }
    return [];
  }

  // Try keys for a provider with rotation and cooldown
  async function tryProviderWithRotation(prov) {
    const keys = getProviderKeys(prov);
    if (keys.length === 0) return null; // no keys available

    const storeKey = prov + 'KeyIdx';
    const cdKey = prov + 'Cooldown';
    const store = await chrome.storage.local.get([storeKey, cdKey]);
    let idx = store[storeKey] || 0;
    const cd = store[cdKey] || {};
    const now = Date.now();

    let lastErr;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[(idx + i) % keys.length];
      const pfx = k.slice(0, 8);
      if ((cd[pfx] || 0) > now) continue; // key on cooldown
      try {
        // For openai_compat, include baseUrl
        const callOpts = { ...opts };
        if (prov === 'openai_compat') {
          callOpts.baseUrl = config.openaiCompatBaseUrl || opts?.baseUrl || '';
        }
        const r = await callLLMOnce({ provider: prov, apiKey: k, model, messages, opts: callOpts });
        await chrome.storage.local.set({ [storeKey]: (idx + i) % keys.length });
        return r;
      } catch (e) {
        lastErr = e;
        if (e.status === 429 || e.status === 402) {
          cd[pfx] = now + 60_000; // 1 min cooldown on rate-limit
          await chrome.storage.local.set({ [cdKey]: cd });
          continue; // try next key
        }
        if (e.status >= 500) continue; // retry on server error
        throw e;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  // Try the primary provider first
  try {
    const result = await tryProviderWithRotation(provider);
    if (result !== null) return result;
  } catch (primaryErr) {
    // Primary failed — try fallback chain
    const fallbacks = opts.fallbackProviders || config.fallbackProviders || [];
    for (const fb of fallbacks) {
      if (fb === provider) continue; // skip primary
      try {
        const fbResult = await tryProviderWithRotation(fb);
        if (fbResult !== null) return fbResult;
      } catch (_) {
        continue; // try next fallback
      }
    }
    throw primaryErr;
  }

  // Primary had no keys — try fallbacks
  const fallbacks = opts.fallbackProviders || config.fallbackProviders || [];
  for (const fb of fallbacks) {
    try {
      const fbResult = await tryProviderWithRotation(fb);
      if (fbResult !== null) return fbResult;
    } catch (_) {
      continue;
    }
  }

  throw new Error('no API key configured for ' + provider + ' and all fallbacks failed');
}

// =================================================================
// DEFAULT CONFIG
// =================================================================
const DEFAULTS = {
  llmProvider: 'ollama',
  llmModel: 'gemma4:31b',
  ollamaBaseUrl: 'https://api.ollama.com',
  // Multi-key arrays (new v2.1 format for rate-limit rotation)
  ollamaKeys: [],
  openaiKeys: [],
  openrouterKeys: [],
  anthropicKeys: [],
  geminiKeys: [],
  grokKeys: [],
  opencodeKeys: [],
  ziaKeys: [],
  moonshotKeys: [],
  qwenKeys: [],
  openaiCompatKeys: [],
  // Single-key fields (backward compat, populated from arrays)
  openrouterKey: '',
  openaiKey: '',
  anthropicKey: '',
  geminiKey: '',
  grokKey: '',
  opencodeKey: '',
  ziaKey: '',
  moonshotKey: '',
  qwenKey: '',
  openaiCompatKey: '',
  openaiCompatBaseUrl: '',
  fallbackProviders: [],
  llmTemperature: 0.2,
  llmMaxTokens: 600,
  autoPilot: false,
  baseInvestment: 1,
  minPayout: 70,
  maxInvestment: 100,
  martingaleEnabled: true,
  martingaleSteps: 3,
  martingaleMultiplier: 2.0,
  scanInterval: 2000,
  domPollFallback: true,
  historicalLoadEnabled: true,
  historicalDaysPerPair: 30,
  selfLearnEnabled: true,
  maxLessons: 200,
  debugMode: false,
  logLevel: 'warn',
};

async function getConfig() {
  try {
    const stored = await chrome.storage.local.get('mf_config');
    return { ...DEFAULTS, ...(stored.mf_config || {}) };
  } catch (_) { return { ...DEFAULTS }; }
}

async function setConfig(updates) {
  const current = await getConfig();
  Object.assign(current, updates);
  await chrome.storage.local.set({ mf_config: current });
  return current;
}

// =================================================================
// Message router
// =================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  // Legacy format: { type: 'llm:chat', messages, options }
  if (msg.type === 'llm:chat') {
    (async () => {
      try {
        const config = await getConfig();
        const provider = msg.options?.provider || config.llmProvider || 'ollama';
        const model = msg.options?.model || config.llmModel || 'gemma4:31b';

        // Build apiKeys from config (both array and single-key formats)
        const configApiKeys = {
          ollama:      config.ollamaKeys?.length      ? config.ollamaKeys      : [],
          openai:      config.openaiKeys?.length      ? config.openaiKeys      : (config.openaiKey ? [config.openaiKey] : []),
          openrouter:  config.openrouterKeys?.length  ? config.openrouterKeys  : (config.openrouterKey ? [config.openrouterKey] : []),
          anthropic:   config.anthropicKeys?.length   ? config.anthropicKeys   : (config.anthropicKey ? [config.anthropicKey] : []),
          gemini:      config.geminiKeys?.length       ? config.geminiKeys      : (config.geminiKey ? [config.geminiKey] : []),
          grok:        config.grokKeys?.length         ? config.grokKeys        : (config.grokKey ? [config.grokKey] : []),
          opencode:    config.opencodeKeys?.length    ? config.opencodeKeys    : (config.opencodeKey ? [config.opencodeKey] : []),
          zia:         config.ziaKeys?.length          ? config.ziaKeys         : (config.ziaKey ? [config.ziaKey] : []),
          moonshot:    config.moonshotKeys?.length     ? config.moonshotKeys    : (config.moonshotKey ? [config.moonshotKey] : []),
          qwen:        config.qwenKeys?.length         ? config.qwenKeys        : (config.qwenKey ? [config.qwenKey] : []),
          openai_compat: config.openaiCompatKeys?.length ? config.openaiCompatKeys : (config.openaiCompatKey ? [config.openaiCompatKey] : []),
        };

        // Merge apiKeys passed from the content script with config keys.
        // Content-script keys take PRIORITY — they may be fresher if the
        // user just updated settings and the SW config hasn't reloaded yet.
        const passedApiKeys = msg.options?.apiKeys;
        const apiKeys = { ...configApiKeys };
        if (passedApiKeys && typeof passedApiKeys === 'object') {
          for (const [prov, keys] of Object.entries(passedApiKeys)) {
            if (Array.isArray(keys) && keys.length > 0) {
              apiKeys[prov] = keys;
            }
          }
        }

        // Also check if the content script passed a single apiKey for the
        // primary provider — ensure it's in the apiKeys array as well.
        const singleKey = msg.options?.apiKey;
        if (singleKey && typeof singleKey === 'string' && singleKey.trim()) {
          if (!apiKeys[provider] || !apiKeys[provider].includes(singleKey)) {
            apiKeys[provider] = [singleKey, ...(apiKeys[provider] || [])];
          }
        }

        const fallbackProviders = config.fallbackProviders || DEFAULTS.fallbackProviders;
        const opts = {
          temperature: msg.options?.temperature ?? config.llmTemperature ?? 0.2,
          max_tokens: msg.options?.maxTokens ?? config.llmMaxTokens ?? 600,
          fallbackProviders,
          baseUrl: msg.options?.baseUrl || config.openaiCompatBaseUrl || undefined,
        };

        const reply = await callLLM({ provider, apiKeys, model, messages: msg.messages || [], opts });
        sendResponse({ text: reply, provider, model });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true; // keep channel open
  }

  // New format: { action: 'llm', payload: { ... } }
  if (msg.action === 'llm') {
    (async () => {
      try {
        const reply = await callLLM(msg.payload);
        sendResponse({ ok: true, reply });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === 'captureTab') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) =>
      sendResponse(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : { ok: true, dataUrl }));
    return true;
  }

  if (msg.type === 'config:get' || msg.action === 'config:get') {
    getConfig().then(c => sendResponse(c)).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'config:set' || msg.action === 'config:set') {
    setConfig(msg.updates || msg.payload || {}).then(c => sendResponse({ ok: true, config: c })).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'notify' || msg.type === 'notification:show') {
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: msg.title || msg.message?.title || 'MFC Agent',
      message: String(msg.message || msg.message?.text || '').slice(0, 500),
    });
    return false;
  }

  if (msg.action === 'togglePanel') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
    });
    return false;
  }

  if (msg.type === 'alarm:set') {
    const { name, periodInMinutes, delayInMinutes } = msg;
    if (!name) { sendResponse({ ok: false, error: 'Alarm name required' }); return false; }
    chrome.alarms.create(name, { periodInMinutes: periodInMinutes || 5, delayInMinutes: delayInMinutes || 1 });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// Keyboard command
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-panel') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
    });
  }
});

// Chrome Alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  switch (alarm.name) {
    case 'scanner:health':
      log('Scanner health check');
      break;
    case 'candle:cleanup':
      log('Candle cleanup triggered');
      break;
  }
});

// Extension Install / Update
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ mf_config: DEFAULTS });
    log('Default config saved on install');
  }
  chrome.alarms.create('scanner:health', { periodInMinutes: 5, delayInMinutes: 1 });
  chrome.alarms.create('candle:cleanup', { periodInMinutes: 30, delayInMinutes: 5 });

  if (details.reason === 'update') {
    const existing = await getConfig();
    const merged = { ...DEFAULTS, ...existing };
    await chrome.storage.local.set({ mf_config: merged });
    log(`Updated to v${chrome.runtime.getManifest().version}`);
  }
});

log('MindFlareClaw service-worker booted');
