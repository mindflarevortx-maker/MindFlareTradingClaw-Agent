/**
 * options.js  —  MindFlare TradingClaw Options Page Controller
 *
 * Reads all config from chrome.storage.local on load,
 * populates form fields, handles save/reset, and provides
 * candle store management (load / clear / export).
 */
'use strict';

/* ── Config Key Definitions ──────────────────────────────────────── */

const STORAGE_KEY = 'mf_config';

const DEFAULTS = {
  autoPilot: false,
  baseInvestment: 1,
  maxInvestment: 100,
  tradeDuration: 60,
  minPayout: 70,
  martingaleEnabled: true,
  martingaleSteps: 3,
  martingaleMultiplier: 2.0,
  wsEnabled: true,
  domPollFallback: true,
  scanInterval: 2000,
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
  llmProvider: 'ollama',
  llmModel: 'llama3',
  ollamaBaseUrl: 'http://localhost:11434',
  openrouterKey: '',
  groqKey: '',
  togetherKey: '',
  deepinfraKey: '',
  mistralKey: '',
  openaiKey: '',
  anthropicKey: '',
  cohereKey: '',
  fireworksKey: '',
  perplexityKey: '',
  customEndpoint: '',
  customKey: '',
  llmTemperature: 0.3,
  llmMaxTokens: 2048,
  candleHistoryDays: 30,
  candleMaxPerPair: 43200,
  overlayVisible: true,
  overlayOpacity: 0.95,
  debugMode: false,
  logLevel: 'warn',
};

/* ── Provider → API key field mapping ────────────────────────────── */

const PROVIDER_KEY_MAP = {
  ollama: null,
  openrouter: 'openrouterKey',
  groq: 'groqKey',
  together: 'togetherKey',
  deepinfra: 'deepinfraKey',
  mistral: 'mistralKey',
  openai: 'openaiKey',
  anthropic: 'anthropicKey',
  cohere: 'cohereKey',
  fireworks: 'fireworksKey',
  perplexity: 'perplexityKey',
  custom: null,
};

/* ── DOM References ──────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const els = {
  autoPilot: $('mf-autoPilot'),
  baseInvestment: $('mf-baseInvestment'),
  maxInvestment: $('mf-maxInvestment'),
  tradeDuration: $('mf-tradeDuration'),
  minPayout: $('mf-minPayout'),
  martingaleEnabled: $('mf-martingaleEnabled'),
  martingaleSteps: $('mf-martingaleSteps'),
  martingaleMultiplier: $('mf-martingaleMultiplier'),
  wsEnabled: $('mf-wsEnabled'),
  domPollFallback: $('mf-domPollFallback'),
  scanInterval: $('mf-scanInterval'),
  rsiPeriod: $('mf-rsiPeriod'),
  macdFast: $('mf-macdFast'),
  macdSlow: $('mf-macdSlow'),
  macdSignal: $('mf-macdSignal'),
  bollingerPeriod: $('mf-bollingerPeriod'),
  bollingerStdDev: $('mf-bollingerStdDev'),
  emaPeriods: $('mf-emaPeriods'),
  atrPeriod: $('mf-atrPeriod'),
  stochasticK: $('mf-stochasticK'),
  stochasticD: $('mf-stochasticD'),
  llmProvider: $('mf-llmProvider'),
  llmModel: $('mf-llmModel'),
  ollamaBaseUrl: $('mf-ollamaBaseUrl'),
  apiKey: $('mf-apiKey'),
  customEndpoint: $('mf-customEndpoint'),
  customKey: $('mf-customKey'),
  llmTemperature: $('mf-llmTemperature'),
  tempDisplay: $('mf-temp-display'),
  llmMaxTokens: $('mf-llmMaxTokens'),
  candleHistoryDays: $('mf-candleHistoryDays'),
  candleMaxPerPair: $('mf-candleMaxPerPair'),
  overlayVisible: $('mf-overlayVisible'),
  overlayOpacity: $('mf-overlayOpacity'),
  opacityDisplay: $('mf-opacity-display'),
  debugMode: $('mf-debugMode'),
  logLevel: $('mf-logLevel'),
  btnLoadHistory: $('mf-btn-load-history'),
  btnClearHistory: $('mf-btn-clear-history'),
  btnExportData: $('mf-btn-export-data'),
  btnReset: $('mf-btn-reset'),
  btnSave: $('mf-btn-save'),
  toast: $('mf-opt-toast'),
  fieldOllama: $('mf-field-ollama'),
  fieldApikey: $('mf-field-apikey'),
  fieldCustom: $('mf-field-custom'),
  fieldCustomkey: $('mf-field-customkey'),
};

/* ── Current config snapshot (loaded from storage) ───────────────── */

let currentConfig = { ...DEFAULTS };

/* ── Storage Helpers ─────────────────────────────────────────────── */

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

/* ── Populate Form Fields ────────────────────────────────────────── */

function populateForm(config) {
  // Trading
  els.autoPilot.checked = !!config.autoPilot;
  els.baseInvestment.value = config.baseInvestment;
  els.maxInvestment.value = config.maxInvestment;
  els.tradeDuration.value = config.tradeDuration;
  els.minPayout.value = config.minPayout;
  els.martingaleEnabled.checked = !!config.martingaleEnabled;
  els.martingaleSteps.value = config.martingaleSteps;
  els.martingaleMultiplier.value = config.martingaleMultiplier;

  // Scanner
  els.wsEnabled.checked = !!config.wsEnabled;
  els.domPollFallback.checked = !!config.domPollFallback;
  els.scanInterval.value = config.scanInterval;

  // Technical Analysis
  els.rsiPeriod.value = config.rsiPeriod;
  els.macdFast.value = config.macdFast;
  els.macdSlow.value = config.macdSlow;
  els.macdSignal.value = config.macdSignal;
  els.bollingerPeriod.value = config.bollingerPeriod;
  els.bollingerStdDev.value = config.bollingerStdDev;
  els.emaPeriods.value = Array.isArray(config.emaPeriods)
    ? config.emaPeriods.join(',')
    : String(config.emaPeriods);
  els.atrPeriod.value = config.atrPeriod;
  els.stochasticK.value = config.stochasticK;
  els.stochasticD.value = config.stochasticD;

  // LLM
  els.llmProvider.value = config.llmProvider;
  els.llmModel.value = config.llmModel;
  els.ollamaBaseUrl.value = config.ollamaBaseUrl;
  els.customEndpoint.value = config.customEndpoint;
  els.customKey.value = config.customKey;
  els.llmTemperature.value = config.llmTemperature;
  els.tempDisplay.textContent = config.llmTemperature;
  els.llmMaxTokens.value = config.llmMaxTokens;

  // Set the correct API key for the selected provider
  updateApiKeyField(config);

  // Candle Store
  els.candleHistoryDays.value = config.candleHistoryDays;
  els.candleMaxPerPair.value = config.candleMaxPerPair;

  // UI
  els.overlayVisible.checked = !!config.overlayVisible;
  els.overlayOpacity.value = config.overlayOpacity;
  els.opacityDisplay.textContent = config.overlayOpacity;

  // Debug
  els.debugMode.checked = !!config.debugMode;
  els.logLevel.value = config.logLevel;

  // Update provider-specific field visibility
  updateProviderVisibility(config.llmProvider);
}

/* ── API Key Field Management ────────────────────────────────────── */

function updateApiKeyField(config) {
  const provider = config.llmProvider;
  const keyField = PROVIDER_KEY_MAP[provider];
  if (keyField) {
    els.apiKey.value = config[keyField] || '';
  } else {
    els.apiKey.value = '';
  }
}

function updateProviderVisibility(provider) {
  // Ollama fields
  const isOllama = provider === 'ollama';
  els.fieldOllama.style.display = isOllama ? '' : 'none';

  // API key field (shown for everything except ollama and custom)
  const needsApiKey = !isOllama && provider !== 'custom';
  els.fieldApikey.style.display = needsApiKey ? '' : 'none';

  // Custom endpoint fields
  const isCustom = provider === 'custom';
  els.fieldCustom.style.display = isCustom ? '' : 'none';
  els.fieldCustomkey.style.display = isCustom ? '' : 'none';
}

/* ── Collect Form Values ─────────────────────────────────────────── */

function collectFormValues() {
  const provider = els.llmProvider.value;
  const emaRaw = els.emaPeriods.value.trim();
  const emaPeriods = emaRaw
    ? emaRaw.split(',').map(Number).filter((n) => !isNaN(n) && n > 0)
    : DEFAULTS.emaPeriods;

  const config = {
    // Trading
    autoPilot: els.autoPilot.checked,
    baseInvestment: Number(els.baseInvestment.value) || DEFAULTS.baseInvestment,
    maxInvestment: Number(els.maxInvestment.value) || DEFAULTS.maxInvestment,
    tradeDuration: Number(els.tradeDuration.value) || DEFAULTS.tradeDuration,
    minPayout: Number(els.minPayout.value) || DEFAULTS.minPayout,
    martingaleEnabled: els.martingaleEnabled.checked,
    martingaleSteps: Number(els.martingaleSteps.value) || DEFAULTS.martingaleSteps,
    martingaleMultiplier: Number(els.martingaleMultiplier.value) || DEFAULTS.martingaleMultiplier,

    // Scanner
    wsEnabled: els.wsEnabled.checked,
    domPollFallback: els.domPollFallback.checked,
    scanInterval: Number(els.scanInterval.value) || DEFAULTS.scanInterval,

    // Technical Analysis
    rsiPeriod: Number(els.rsiPeriod.value) || DEFAULTS.rsiPeriod,
    macdFast: Number(els.macdFast.value) || DEFAULTS.macdFast,
    macdSlow: Number(els.macdSlow.value) || DEFAULTS.macdSlow,
    macdSignal: Number(els.macdSignal.value) || DEFAULTS.macdSignal,
    bollingerPeriod: Number(els.bollingerPeriod.value) || DEFAULTS.bollingerPeriod,
    bollingerStdDev: Number(els.bollingerStdDev.value) || DEFAULTS.bollingerStdDev,
    emaPeriods,
    atrPeriod: Number(els.atrPeriod.value) || DEFAULTS.atrPeriod,
    stochasticK: Number(els.stochasticK.value) || DEFAULTS.stochasticK,
    stochasticD: Number(els.stochasticD.value) || DEFAULTS.stochasticD,

    // LLM
    llmProvider: provider,
    llmModel: els.llmModel.value.trim() || DEFAULTS.llmModel,
    ollamaBaseUrl: els.ollamaBaseUrl.value.trim() || DEFAULTS.ollamaBaseUrl,
    customEndpoint: els.customEndpoint.value.trim() || '',
    customKey: els.customKey.value.trim() || '',
    llmTemperature: Number(els.llmTemperature.value),
    llmMaxTokens: Number(els.llmMaxTokens.value) || DEFAULTS.llmMaxTokens,

    // Candle Store
    candleHistoryDays: Number(els.candleHistoryDays.value) || DEFAULTS.candleHistoryDays,
    candleMaxPerPair: Number(els.candleMaxPerPair.value) || DEFAULTS.candleMaxPerPair,

    // UI
    overlayVisible: els.overlayVisible.checked,
    overlayOpacity: Number(els.overlayOpacity.value),

    // Debug
    debugMode: els.debugMode.checked,
    logLevel: els.logLevel.value,
  };

  // Map API key to correct provider field
  const keyField = PROVIDER_KEY_MAP[provider];
  if (keyField) {
    config[keyField] = els.apiKey.value.trim();
  }

  // Preserve all other provider keys from current config
  for (const [prov, k] of Object.entries(PROVIDER_KEY_MAP)) {
    if (k && prov !== provider) {
      config[k] = currentConfig[k] || '';
    }
  }

  return config;
}

/* ── Toast Notification ──────────────────────────────────────────── */

let toastTimer = null;

function showToast(message, type) {
  const toast = els.toast;
  toast.textContent = message;
  toast.className = 'mf-opt-toast mf-opt-toast-' + type;
  toast.classList.add('mf-opt-toast-visible');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('mf-opt-toast-visible');
  }, 3000);
}

/* ── Save Handler ────────────────────────────────────────────────── */

async function handleSave() {
  try {
    const config = collectFormValues();
    await saveConfig(config);
    currentConfig = config;
    showToast('Settings saved successfully!', 'success');
  } catch (err) {
    console.error('[MindFlare Options] Save failed:', err);
    showToast('Save failed: ' + err.message, 'error');
  }
}

/* ── Reset Handler ───────────────────────────────────────────────── */

async function handleReset() {
  if (!confirm('Reset all settings to defaults? This cannot be undone.')) return;

  try {
    await saveConfig({ ...DEFAULTS });
    currentConfig = { ...DEFAULTS };
    populateForm(currentConfig);
    showToast('Settings reset to defaults.', 'success');
  } catch (err) {
    console.error('[MindFlare Options] Reset failed:', err);
    showToast('Reset failed: ' + err.message, 'error');
  }
}

/* ── Load History ────────────────────────────────────────────────── */

async function handleLoadHistory() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) {
      showToast('No active tab found.', 'error');
      return;
    }
    const tab = tabs[0];
    await chrome.tabs.sendMessage(tab.id, {
      type: 'MF_ACTION',
      action: 'load-history',
    });
    showToast('History load request sent to active tab.', 'success');
  } catch (err) {
    console.error('[MindFlare Options] Load history failed:', err);
    showToast('Failed to send load request. Is the trading page open?', 'error');
  }
}

/* ── Clear History ───────────────────────────────────────────────── */

async function handleClearHistory() {
  if (!confirm('Clear all stored candle data? This cannot be undone.')) return;

  try {
    // Clear from chrome.storage.local
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get('mf_candles', resolve);
    });
    if (stored.mf_candles) {
      await new Promise((resolve) => {
        chrome.storage.local.remove('mf_candles', resolve);
      });
    }

    // Clear from IndexedDB
    await clearIndexedDBCandles();

    showToast('Candle history cleared.', 'success');
  } catch (err) {
    console.error('[MindFlare Options] Clear history failed:', err);
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
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
      } catch (e) {
        db.close();
        resolve();
      }
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

/* ── Export Data ─────────────────────────────────────────────────── */

async function handleExportData() {
  try {
    // Try to read candles from chrome.storage.local
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get('mf_candles', resolve);
    });
    let candles = stored.mf_candles || {};

    // Also try IndexedDB
    const idbCandles = await readIndexedDBCandles();
    if (idbCandles && Object.keys(idbCandles).length > 0) {
      // Merge: IDB data takes priority
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
    console.error('[MindFlare Options] Export failed:', err);
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
          for (const item of getAll.result) {
            result[item.pair] = item;
          }
          db.close();
          resolve(result);
        };
        getAll.onerror = () => {
          db.close();
          resolve({});
        };
      } catch (e) {
        db.close();
        resolve({});
      }
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

/* ── Slider Display Updates ──────────────────────────────────────── */

function setupSliderDisplays() {
  els.llmTemperature.addEventListener('input', () => {
    els.tempDisplay.textContent = els.llmTemperature.value;
  });

  els.overlayOpacity.addEventListener('input', () => {
    els.opacityDisplay.textContent = els.overlayOpacity.value;
  });
}

/* ── Provider Change Handler ─────────────────────────────────────── */

function setupProviderChange() {
  els.llmProvider.addEventListener('change', () => {
    const provider = els.llmProvider.value;
    updateProviderVisibility(provider);
    updateApiKeyField({ ...currentConfig, llmProvider: provider });
  });
}

/* ── Event Bindings ──────────────────────────────────────────────── */

function bindEvents() {
  els.btnSave.addEventListener('click', handleSave);
  els.btnReset.addEventListener('click', handleReset);
  els.btnLoadHistory.addEventListener('click', handleLoadHistory);
  els.btnClearHistory.addEventListener('click', handleClearHistory);
  els.btnExportData.addEventListener('click', handleExportData);

  setupSliderDisplays();
  setupProviderChange();
}

/* ── Initialization ──────────────────────────────────────────────── */

async function init() {
  try {
    await loadConfig();
    populateForm(currentConfig);
    bindEvents();
    console.log('[MindFlare Options] Loaded config successfully.');
  } catch (err) {
    console.error('[MindFlare Options] Init failed:', err);
    showToast('Failed to load settings.', 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
