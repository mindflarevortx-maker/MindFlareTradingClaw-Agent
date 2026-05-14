/**
 * options.js — MindFlare TradingClaw Options Page Controller
 *
 * Self-contained controller for the Options page.
 * Handles: config load/save, 11 provider multi-key management,
 * model suggestions, test connection, sidebar navigation, toast notifications.
 *
 * All config stored in chrome.storage.local under key 'mf_config'.
 */
'use strict';

/* ═══════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'mf_config';
const VERSION = '2.1.0';

/** Full default config — matches core.js & service-worker.js */
const DEFAULTS = {
  // LLM
  llmProvider: 'ollama',
  llmModel: 'gemma4:31b',
  ollamaBaseUrl: 'https://api.ollama.com',
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
  // Single-key backward compat fields
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

  // Trading
  autoPilot: false,
  baseInvestment: 1,
  maxInvestment: 100,
  tradeDuration: 60,
  minPayout: 70,
  martingaleEnabled: true,
  martingaleSteps: 3,
  martingaleMultiplier: 2.0,

  // Scanner
  wsEnabled: true,
  domPollFallback: true,
  scanInterval: 2000,

  // Technical Analysis
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bollingerPeriod: 20,
  bollingerStdDev: 2,
  emaPeriods: [9, 21, 50, 200],
  atrPeriod: 14,
  stochasticK: 14,
  stochasticD: 3,

  // Historical / Candle Store
  historicalLoadEnabled: true,
  historicalDaysPerPair: 30,
  maxCandlesPerPair: 100000,

  // Self-Improvement
  selfLearnEnabled: true,
  maxLessons: 200,

  // UI
  overlayVisible: true,
  overlayOpacity: 0.95,

  // Debug
  debugMode: false,
  logLevel: 'warn',
};

/** All 11 providers and their display info */
const PROVIDERS = {
  ollama:       { name: 'Ollama Cloud',      keyField: 'ollamaKeys',      singleKeyField: null },
  openai:       { name: 'OpenAI',             keyField: 'openaiKeys',      singleKeyField: 'openaiKey' },
  openrouter:   { name: 'OpenRouter',         keyField: 'openrouterKeys',  singleKeyField: 'openrouterKey' },
  anthropic:    { name: 'Claude / Anthropic', keyField: 'anthropicKeys',   singleKeyField: 'anthropicKey' },
  gemini:       { name: 'Google Gemini',      keyField: 'geminiKeys',      singleKeyField: 'geminiKey' },
  grok:         { name: 'xAI Grok',           keyField: 'grokKeys',        singleKeyField: 'grokKey' },
  opencode:     { name: 'OpenCode',           keyField: 'opencodeKeys',    singleKeyField: 'opencodeKey' },
  zia:          { name: 'Zia',                keyField: 'ziaKeys',         singleKeyField: 'ziaKey' },
  moonshot:     { name: 'Kimi / Moonshot',    keyField: 'moonshotKeys',    singleKeyField: 'moonshotKey' },
  qwen:         { name: 'Alibaba Qwen',       keyField: 'qwenKeys',        singleKeyField: 'qwenKey' },
  openai_compat:{ name: 'OpenAI Compatible',  keyField: 'openaiCompatKeys',singleKeyField: 'openaiCompatKey' },
};

/** Per-provider model suggestions */
const MODEL_SUGGESTIONS = {
  ollama: [
    'gemma4:31b', 'llama3.1:70b', 'llama3.1:8b', 'mistral:7b',
    'codellama:34b', 'deepseek-coder:33b', 'qwen2:72b', 'gemma2:27b',
  ],
  openai: [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo',
    'o1-preview', 'o1-mini',
  ],
  openrouter: [
    'openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-pro-1.5',
    'meta-llama/llama-3.1-70b-instruct', 'mistralai/mistral-large',
    'deepseek/deepseek-chat',
  ],
  anthropic: [
    'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229', 'claude-3-sonnet-20240229',
  ],
  gemini: [
    'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0-pro',
  ],
  grok: [
    'grok-2', 'grok-2-mini', 'grok-beta',
  ],
  opencode: [
    'gpt-4o', 'claude-3-5-sonnet-20241022', 'deepseek-chat',
  ],
  zia: [
    'zia-1', 'zia-1-mini',
  ],
  moonshot: [
    'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k',
  ],
  qwen: [
    'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long',
  ],
  openai_compat: [
    'custom-model',
  ],
};

/* ═══════════════════════════════════════════════════════════════════
   State
   ═══════════════════════════════════════════════════════════════════ */

let currentConfig = { ...DEFAULTS };
let toastTimer = null;

/* ═══════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const $qs = (sel) => document.querySelector(sel);
const $qsa = (sel) => document.querySelectorAll(sel);

/* ═══════════════════════════════════════════════════════════════════
   Storage
   ═══════════════════════════════════════════════════════════════════ */

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (result[STORAGE_KEY]) {
        currentConfig = { ...DEFAULTS, ...result[STORAGE_KEY] };
      }
      resolve(currentConfig);
    });
  });
}

async function saveConfig(config) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: config }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Toast
   ═══════════════════════════════════════════════════════════════════ */

function showToast(message, type = 'success') {
  const toast = $('mf-toast');
  toast.textContent = message;
  toast.className = 'mf-toast ' + type + ' visible';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
  }, 3000);
}

/* ═══════════════════════════════════════════════════════════════════
   Populate Form — simple fields
   ═══════════════════════════════════════════════════════════════════ */

function populateForm(cfg) {
  // Trading
  $('mf-autoPilot').checked = !!cfg.autoPilot;
  $('mf-baseInvestment').value = cfg.baseInvestment;
  $('mf-maxInvestment').value = cfg.maxInvestment;
  $('mf-tradeDuration').value = cfg.tradeDuration;
  $('mf-minPayout').value = cfg.minPayout;
  $('mf-martingaleEnabled').checked = !!cfg.martingaleEnabled;
  $('mf-martingaleSteps').value = cfg.martingaleSteps;
  $('mf-martingaleMultiplier').value = cfg.martingaleMultiplier;

  // Scanner
  $('mf-wsEnabled').checked = !!cfg.wsEnabled;
  $('mf-domPollFallback').checked = !!cfg.domPollFallback;
  $('mf-scanInterval').value = cfg.scanInterval;

  // Technical Analysis
  $('mf-rsiPeriod').value = cfg.rsiPeriod;
  $('mf-macdFast').value = cfg.macdFast;
  $('mf-macdSlow').value = cfg.macdSlow;
  $('mf-macdSignal').value = cfg.macdSignal;
  $('mf-bollingerPeriod').value = cfg.bollingerPeriod;
  $('mf-bollingerStdDev').value = cfg.bollingerStdDev;
  $('mf-emaPeriods').value = Array.isArray(cfg.emaPeriods) ? cfg.emaPeriods.join(',') : String(cfg.emaPeriods);
  $('mf-atrPeriod').value = cfg.atrPeriod;
  $('mf-stochasticK').value = cfg.stochasticK;
  $('mf-stochasticD').value = cfg.stochasticD;

  // LLM Config
  $('mf-llmProvider').value = cfg.llmProvider;
  $('mf-llmModel').value = cfg.llmModel;
  $('mf-ollamaBaseUrl').value = cfg.ollamaBaseUrl;
  $('mf-openaiCompatBaseUrl').value = cfg.openaiCompatBaseUrl || '';
  $('mf-llmTemperature').value = cfg.llmTemperature;
  $('mf-temp-display').textContent = cfg.llmTemperature;
  $('mf-llmMaxTokens').value = cfg.llmMaxTokens;

  // Candle Store
  $('mf-historicalDaysPerPair').value = cfg.historicalDaysPerPair;
  $('mf-maxCandlesPerPair').value = cfg.maxCandlesPerPair;

  // UI
  $('mf-overlayVisible').checked = !!cfg.overlayVisible;
  $('mf-overlayOpacity').value = cfg.overlayOpacity;
  $('mf-opacity-display').textContent = cfg.overlayOpacity;

  // Debug
  $('mf-debugMode').checked = !!cfg.debugMode;
  $('mf-logLevel').value = cfg.logLevel;

  // Provider-specific visibility
  updateProviderFields(cfg.llmProvider);

  // Fallback providers
  renderFallbackProviders(cfg.llmProvider, cfg.fallbackProviders || []);

  // Multi-key sections
  renderAllKeySections(cfg);

  // Model suggestions
  updateModelSuggestions(cfg.llmProvider);
}

/* ═══════════════════════════════════════════════════════════════════
   Provider field visibility
   ═══════════════════════════════════════════════════════════════════ */

function updateProviderFields(provider) {
  const ollamaUrl = $('mf-field-ollama-url');
  const compatUrl = $('mf-field-compat-url');

  // Ollama base URL — only for ollama
  if (provider === 'ollama') {
    ollamaUrl.classList.remove('hidden');
  } else {
    ollamaUrl.classList.add('hidden');
  }

  // Compat base URL — only for openai_compat
  if (provider === 'openai_compat') {
    compatUrl.classList.remove('hidden');
  } else {
    compatUrl.classList.add('hidden');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Model Suggestions Dropdown
   ═══════════════════════════════════════════════════════════════════ */

function updateModelSuggestions(provider) {
  const dropdown = $('mf-model-dropdown');
  const models = MODEL_SUGGESTIONS[provider] || [];

  dropdown.innerHTML = '';
  if (models.length === 0) return;

  models.forEach((model) => {
    const div = document.createElement('div');
    div.className = 'mf-model-option';
    div.textContent = model;
    div.addEventListener('click', () => {
      $('mf-llmModel').value = model;
      closeModelDropdown();
    });
    dropdown.appendChild(div);
  });
}

function toggleModelDropdown() {
  const dropdown = $('mf-model-dropdown');
  if (dropdown.classList.contains('hidden')) {
    dropdown.classList.remove('hidden');
  } else {
    closeModelDropdown();
  }
}

function closeModelDropdown() {
  $('mf-model-dropdown').classList.add('hidden');
}

/* ═══════════════════════════════════════════════════════════════════
   Fallback Providers
   ═══════════════════════════════════════════════════════════════════ */

function renderFallbackProviders(currentProvider, selected) {
  const grid = $('mf-fallback-grid');
  grid.innerHTML = '';

  const providerIds = Object.keys(PROVIDERS).filter(p => p !== currentProvider);
  providerIds.forEach((pid) => {
    const info = PROVIDERS[pid];
    const label = document.createElement('label');
    label.className = 'mf-fallback-check';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = pid;
    cb.checked = selected.includes(pid);
    cb.addEventListener('change', () => {
      label.classList.toggle('active', cb.checked);
    });
    if (cb.checked) label.classList.add('active');

    const span = document.createElement('span');
    span.textContent = info.name;

    label.appendChild(cb);
    label.appendChild(span);
    grid.appendChild(label);
  });
}

function collectFallbackProviders() {
  const checks = $qsa('#mf-fallback-grid input[type="checkbox"]');
  const result = [];
  checks.forEach((cb) => {
    if (cb.checked) result.push(cb.value);
  });
  return result;
}

/* ═══════════════════════════════════════════════════════════════════
   Multi-Key Management
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Migrate legacy single-key fields into array fields.
 * If the array is empty but the single-key field has a value, copy it.
 */
function migrateKeys(cfg) {
  for (const [pid, info] of Object.entries(PROVIDERS)) {
    if (!info.singleKeyField) continue;
    const arr = cfg[info.keyField];
    const single = cfg[info.singleKeyField];
    if ((!arr || arr.length === 0) && single) {
      cfg[info.keyField] = [single];
    }
    if (!Array.isArray(cfg[info.keyField])) {
      cfg[info.keyField] = [];
    }
  }
}

function renderAllKeySections(cfg) {
  for (const pid of Object.keys(PROVIDERS)) {
    renderKeySection(pid, cfg[PROVIDERS[pid].keyField] || []);
  }
}

function renderKeySection(provider, keys) {
  const listEl = $('mf-key-list-' + provider);
  const countEl = $('mf-key-count-' + provider);
  if (!listEl || !countEl) return;

  listEl.innerHTML = '';

  keys.forEach((key, idx) => {
    const row = document.createElement('div');
    row.className = 'mf-key-row';

    const indexSpan = document.createElement('span');
    indexSpan.className = 'mf-key-row-index';
    indexSpan.textContent = idx + 1;

    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'mf-input';
    input.value = key;
    input.placeholder = 'sk-...';
    input.dataset.provider = provider;
    input.dataset.index = idx;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'mf-btn-remove-key';
    removeBtn.type = 'button';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = 'Remove key';
    removeBtn.dataset.provider = provider;
    removeBtn.dataset.index = idx;
    removeBtn.addEventListener('click', () => {
      removeKey(provider, idx);
    });

    row.appendChild(indexSpan);
    row.appendChild(input);
    row.appendChild(removeBtn);
    listEl.appendChild(row);
  });

  // Update count badge
  const count = keys.length;
  countEl.textContent = count + (count === 1 ? ' key' : ' keys');
  countEl.classList.toggle('has-keys', count > 0);
}

function addKey(provider) {
  const keyField = PROVIDERS[provider].keyField;
  const keys = collectKeysFromUI(provider);
  keys.push('');
  currentConfig[keyField] = keys;
  renderKeySection(provider, keys);

  // Auto-expand the provider section when adding a key
  const provEl = document.querySelector(`.mf-key-provider[data-provider="${provider}"]`);
  if (provEl && !provEl.classList.contains('open')) {
    toggleProviderSection(provEl);
  }

  // Focus the new input
  setTimeout(() => {
    const inputs = $qsa(`#mf-key-list-${provider} .mf-key-row input`);
    if (inputs.length > 0) {
      inputs[inputs.length - 1].focus();
    }
  }, 100);
}

function removeKey(provider, index) {
  const keyField = PROVIDERS[provider].keyField;
  const keys = collectKeysFromUI(provider);
  keys.splice(index, 1);
  currentConfig[keyField] = keys;
  renderKeySection(provider, keys);
}

function collectKeysFromUI(provider) {
  const listEl = $('mf-key-list-' + provider);
  if (!listEl) return [];
  const inputs = listEl.querySelectorAll('.mf-key-row input');
  const keys = [];
  inputs.forEach((inp) => {
    const val = inp.value.trim();
    keys.push(val);
  });
  return keys;
}

function collectAllKeysFromUI() {
  const result = {};
  for (const [pid, info] of Object.entries(PROVIDERS)) {
    result[info.keyField] = collectKeysFromUI(pid);
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════
   Accordion Toggle
   ═══════════════════════════════════════════════════════════════════ */

function toggleProviderSection(providerEl) {
  const body = providerEl.querySelector('.mf-key-provider-body');
  const isOpen = providerEl.classList.contains('open');

  if (isOpen) {
    providerEl.classList.remove('open');
    body.classList.remove('expanded');
    body.classList.add('collapsed');
  } else {
    providerEl.classList.add('open');
    body.classList.remove('collapsed');
    body.classList.add('expanded');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Collect All Form Values
   ═══════════════════════════════════════════════════════════════════ */

function collectFormValues() {
  const emaRaw = $('mf-emaPeriods').value.trim();
  const emaPeriods = emaRaw
    ? emaRaw.split(',').map(Number).filter((n) => !isNaN(n) && n > 0)
    : DEFAULTS.emaPeriods;

  // Gather all multi-key arrays from UI
  const allKeys = collectAllKeysFromUI();

  const config = {
    // LLM
    llmProvider: $('mf-llmProvider').value,
    llmModel: $('mf-llmModel').value.trim() || DEFAULTS.llmModel,
    ollamaBaseUrl: $('mf-ollamaBaseUrl').value.trim() || DEFAULTS.ollamaBaseUrl,
    openaiCompatBaseUrl: $('mf-openaiCompatBaseUrl').value.trim() || '',
    fallbackProviders: collectFallbackProviders(),
    llmTemperature: Number($('mf-llmTemperature').value),
    llmMaxTokens: Number($('mf-llmMaxTokens').value) || DEFAULTS.llmMaxTokens,

    // Multi-key arrays
    ...allKeys,

    // Single-key backward compat — pick first from each array
    ollamaKeys: allKeys.ollamaKeys || [],
    openaiKey: (allKeys.openaiKeys && allKeys.openaiKeys[0]) || '',
    openrouterKey: (allKeys.openrouterKeys && allKeys.openrouterKeys[0]) || '',
    anthropicKey: (allKeys.anthropicKeys && allKeys.anthropicKeys[0]) || '',
    geminiKey: (allKeys.geminiKeys && allKeys.geminiKeys[0]) || '',
    grokKey: (allKeys.grokKeys && allKeys.grokKeys[0]) || '',
    opencodeKey: (allKeys.opencodeKeys && allKeys.opencodeKeys[0]) || '',
    ziaKey: (allKeys.ziaKeys && allKeys.ziaKeys[0]) || '',
    moonshotKey: (allKeys.moonshotKeys && allKeys.moonshotKeys[0]) || '',
    qwenKey: (allKeys.qwenKeys && allKeys.qwenKeys[0]) || '',
    openaiCompatKey: (allKeys.openaiCompatKeys && allKeys.openaiCompatKeys[0]) || '',

    // Trading
    autoPilot: $('mf-autoPilot').checked,
    baseInvestment: Number($('mf-baseInvestment').value) || DEFAULTS.baseInvestment,
    maxInvestment: Number($('mf-maxInvestment').value) || DEFAULTS.maxInvestment,
    tradeDuration: Number($('mf-tradeDuration').value) || DEFAULTS.tradeDuration,
    minPayout: Number($('mf-minPayout').value) || DEFAULTS.minPayout,
    martingaleEnabled: $('mf-martingaleEnabled').checked,
    martingaleSteps: Number($('mf-martingaleSteps').value) || DEFAULTS.martingaleSteps,
    martingaleMultiplier: Number($('mf-martingaleMultiplier').value) || DEFAULTS.martingaleMultiplier,

    // Scanner
    wsEnabled: $('mf-wsEnabled').checked,
    domPollFallback: $('mf-domPollFallback').checked,
    scanInterval: Number($('mf-scanInterval').value) || DEFAULTS.scanInterval,

    // Technical Analysis
    rsiPeriod: Number($('mf-rsiPeriod').value) || DEFAULTS.rsiPeriod,
    macdFast: Number($('mf-macdFast').value) || DEFAULTS.macdFast,
    macdSlow: Number($('mf-macdSlow').value) || DEFAULTS.macdSlow,
    macdSignal: Number($('mf-macdSignal').value) || DEFAULTS.macdSignal,
    bollingerPeriod: Number($('mf-bollingerPeriod').value) || DEFAULTS.bollingerPeriod,
    bollingerStdDev: Number($('mf-bollingerStdDev').value) || DEFAULTS.bollingerStdDev,
    emaPeriods,
    atrPeriod: Number($('mf-atrPeriod').value) || DEFAULTS.atrPeriod,
    stochasticK: Number($('mf-stochasticK').value) || DEFAULTS.stochasticK,
    stochasticD: Number($('mf-stochasticD').value) || DEFAULTS.stochasticD,

    // Candle Store
    historicalLoadEnabled: true,
    historicalDaysPerPair: Number($('mf-historicalDaysPerPair').value) || DEFAULTS.historicalDaysPerPair,
    maxCandlesPerPair: Number($('mf-maxCandlesPerPair').value) || DEFAULTS.maxCandlesPerPair,

    // Self-Improvement
    selfLearnEnabled: currentConfig.selfLearnEnabled ?? DEFAULTS.selfLearnEnabled,
    maxLessons: currentConfig.maxLessons ?? DEFAULTS.maxLessons,

    // UI
    overlayVisible: $('mf-overlayVisible').checked,
    overlayOpacity: Number($('mf-overlayOpacity').value),

    // Debug
    debugMode: $('mf-debugMode').checked,
    logLevel: $('mf-logLevel').value,
  };

  return config;
}

/* ═══════════════════════════════════════════════════════════════════
   Save / Reset
   ═══════════════════════════════════════════════════════════════════ */

async function handleSave() {
  try {
    const config = collectFormValues();
    await saveConfig(config);
    currentConfig = config;
    showToast('Settings saved successfully!', 'success');
  } catch (err) {
    console.error('[MFC Options] Save failed:', err);
    showToast('Save failed: ' + err.message, 'error');
  }
}

async function handleReset() {
  if (!confirm('Reset all settings to defaults? This cannot be undone.')) return;
  try {
    const fresh = JSON.parse(JSON.stringify(DEFAULTS));
    await saveConfig(fresh);
    currentConfig = fresh;
    populateForm(currentConfig);
    showToast('Settings reset to defaults.', 'info');
  } catch (err) {
    console.error('[MFC Options] Reset failed:', err);
    showToast('Reset failed: ' + err.message, 'error');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Test Connection
   ═══════════════════════════════════════════════════════════════════ */

async function handleTestConnection() {
  const provider = $('mf-llmProvider').value;
  const model = $('mf-llmModel').value.trim() || DEFAULTS.llmModel;
  const keys = collectKeysFromUI(provider);
  const resultEl = $('mf-test-result');
  const btn = $('mf-btn-test-connection');

  // Determine which key to use for test
  let testKey = keys.length > 0 ? keys.find(k => k.trim() !== '') : '';
  if (!testKey && provider !== 'ollama') {
    resultEl.textContent = 'No API key configured for ' + (PROVIDERS[provider]?.name || provider);
    resultEl.className = 'mf-test-result error';
    return;
  }

  btn.disabled = true;
  resultEl.textContent = 'Testing...';
  resultEl.className = 'mf-test-result pending';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'llm:chat',
      messages: [
        { role: 'system', content: 'Reply with exactly: CONNECTION_OK' },
        { role: 'user', content: 'ping' },
      ],
      options: {
        provider,
        model,
        temperature: 0.1,
        maxTokens: 20,
      },
    });

    if (response && response.error) {
      resultEl.textContent = 'Error: ' + response.error;
      resultEl.className = 'mf-test-result error';
    } else if (response && response.text) {
      const text = response.text.trim();
      resultEl.textContent = 'Connected! (' + (PROVIDERS[provider]?.name || provider) + ' / ' + (response.model || model) + ')';
      resultEl.className = 'mf-test-result success';
    } else {
      resultEl.textContent = 'Unexpected response';
      resultEl.className = 'mf-test-result error';
    }
  } catch (err) {
    resultEl.textContent = 'Failed: ' + err.message;
    resultEl.className = 'mf-test-result error';
  } finally {
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Candle Store Actions
   ═══════════════════════════════════════════════════════════════════ */

async function handleLoadHistory() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) {
      showToast('No active tab found.', 'error');
      return;
    }
    await chrome.tabs.sendMessage(tabs[0].id, {
      type: 'MF_ACTION',
      action: 'load-history',
    });
    showToast('History load request sent.', 'success');
  } catch (err) {
    showToast('Failed. Is the trading page open?', 'error');
  }
}

async function handleClearHistory() {
  if (!confirm('Clear all stored candle data? This cannot be undone.')) return;
  try {
    await new Promise((resolve) => chrome.storage.local.remove('mf_candles', resolve));
    await clearIndexedDBCandles();
    showToast('Candle history cleared.', 'success');
  } catch (err) {
    showToast('Clear failed: ' + err.message, 'error');
  }
}

function clearIndexedDBCandles() {
  return new Promise((resolve) => {
    const request = indexedDB.open('MindFlareCandleStore', 1);
    request.onsuccess = (event) => {
      const db = event.target.result;
      try {
        const tx = db.transaction('candles', 'readwrite');
        const store = tx.objectStore('candles');
        store.clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); resolve(); };
      } catch (e) { db.close(); resolve(); }
    };
    request.onerror = () => resolve();
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('candles')) {
        db.createObjectStore('candles', { keyPath: 'pair' });
      }
    };
  });
}

async function handleExportData() {
  try {
    const stored = await new Promise((resolve) => chrome.storage.local.get('mf_candles', resolve));
    let candles = stored.mf_candles || {};

    const idbCandles = await readIndexedDBCandles();
    if (idbCandles && Object.keys(idbCandles).length > 0) {
      candles = { ...candles, ...idbCandles };
    }

    if (Object.keys(candles).length === 0) {
      showToast('No candle data to export.', 'error');
      return;
    }

    const blob = new Blob([JSON.stringify(candles, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mindflare-candles-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Candle data exported!', 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
}

function readIndexedDBCandles() {
  return new Promise((resolve) => {
    const request = indexedDB.open('MindFlareCandleStore', 1);
    request.onsuccess = (event) => {
      const db = event.target.result;
      try {
        const tx = db.transaction('candles', 'readonly');
        const store = tx.objectStore('candles');
        const getAll = store.getAll();
        getAll.onsuccess = () => {
          const result = {};
          for (const item of getAll.result) { result[item.pair] = item; }
          db.close(); resolve(result);
        };
        getAll.onerror = () => { db.close(); resolve({}); };
      } catch (e) { db.close(); resolve({}); }
    };
    request.onerror = () => resolve({});
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('candles')) {
        db.createObjectStore('candles', { keyPath: 'pair' });
      }
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Sidebar Navigation
   ═══════════════════════════════════════════════════════════════════ */

function setupSidebarNavigation() {
  const links = $qsa('.mf-sidebar-link');

  links.forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const sectionId = link.dataset.section;
      const section = $(sectionId);
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      // Update active state
      links.forEach((l) => l.classList.remove('active'));
      link.classList.add('active');

      // Close mobile sidebar
      closeMobileSidebar();
    });
  });

  // Intersection observer for scroll-based active tracking
  const sections = $qsa('main.mf-main > section');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        links.forEach((l) => l.classList.remove('active'));
        const activeLink = document.querySelector(`.mf-sidebar-link[data-section="${entry.target.id}"]`);
        if (activeLink) activeLink.classList.add('active');
      }
    });
  }, { rootMargin: '-20% 0px -60% 0px' });

  sections.forEach((section) => observer.observe(section));
}

/* ═══════════════════════════════════════════════════════════════════
   Mobile Sidebar
   ═══════════════════════════════════════════════════════════════════ */

function openMobileSidebar() {
  $('mf-sidebar').classList.add('open');
  $('mf-overlay').classList.add('open');
}

function closeMobileSidebar() {
  $('mf-sidebar').classList.remove('open');
  $('mf-overlay').classList.remove('open');
}

/* ═══════════════════════════════════════════════════════════════════
   Event Bindings
   ═══════════════════════════════════════════════════════════════════ */

function bindEvents() {
  // Save / Reset
  $('mf-btn-save').addEventListener('click', handleSave);
  $('mf-btn-reset').addEventListener('click', handleReset);

  // Candle Store
  $('mf-btn-load-history').addEventListener('click', handleLoadHistory);
  $('mf-btn-clear-history').addEventListener('click', handleClearHistory);
  $('mf-btn-export-data').addEventListener('click', handleExportData);

  // Test Connection
  $('mf-btn-test-connection').addEventListener('click', handleTestConnection);

  // Temperature slider display
  $('mf-llmTemperature').addEventListener('input', (e) => {
    $('mf-temp-display').textContent = e.target.value;
  });

  // Opacity slider display
  $('mf-overlayOpacity').addEventListener('input', (e) => {
    $('mf-opacity-display').textContent = e.target.value;
  });

  // Provider change
  $('mf-llmProvider').addEventListener('change', (e) => {
    const provider = e.target.value;
    updateProviderFields(provider);
    renderFallbackProviders(provider, collectFallbackProviders());
    updateModelSuggestions(provider);
  });

  // Model dropdown toggle
  $('mf-model-dropdown-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelDropdown();
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.mf-model-combo')) {
      closeModelDropdown();
    }
  });

  // Accordion: key provider headers
  $qsa('.mf-key-provider-header').forEach((header) => {
    header.addEventListener('click', () => {
      const providerEl = header.closest('.mf-key-provider');
      toggleProviderSection(providerEl);
    });
  });

  // Add key buttons
  $qsa('.mf-btn-add-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider;
      addKey(provider);
    });
  });

  // Mobile sidebar
  $('mf-hamburger').addEventListener('click', openMobileSidebar);
  $('mf-overlay').addEventListener('click', closeMobileSidebar);

  // Keyboard shortcut: Ctrl+S to save
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Initialization
   ═══════════════════════════════════════════════════════════════════ */

async function init() {
  try {
    await loadConfig();

    // Migrate legacy single-key fields into array fields
    migrateKeys(currentConfig);

    populateForm(currentConfig);
    setupSidebarNavigation();
    bindEvents();

    console.log(`[MFC Options v${VERSION}] Config loaded successfully.`);
  } catch (err) {
    console.error('[MFC Options] Init failed:', err);
    showToast('Failed to load settings.', 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
