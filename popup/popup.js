/**
 * popup.js  —  MindFlare TradingClaw Popup Controller
 *
 * Reads/writes chrome.storage.local for config & state,
 * sends action messages to the content script in the active tab,
 * and refreshes status every 2 seconds while the popup is open.
 */
'use strict';

/* ── DOM References ──────────────────────────────────────────────── */

const $wsStatus     = document.getElementById('mf-ws-status');
const $activePair   = document.getElementById('mf-active-pair');
const $activePayout = document.getElementById('mf-active-payout');
const $agentStatus  = document.getElementById('mf-agent-status');
const $toggleAP     = document.getElementById('mf-toggle-autopilot');
const $toggleMG     = document.getElementById('mf-toggle-martingale');
const $btnAnalyze   = document.getElementById('mf-btn-analyze');
const $btnScan      = document.getElementById('mf-btn-scan');
const $btnOverlay   = document.getElementById('mf-btn-overlay');
const $linkOptions  = document.getElementById('mf-link-options');
const $linkReload   = document.getElementById('mf-link-reload');

/* ── Constants ───────────────────────────────────────────────────── */

const STORAGE_KEYS = { config: 'mf_config', state: 'mf_state' };
const REFRESH_MS   = 2000;
const TARGET_HOST  = 'market-qx.trade';

/* ── State ───────────────────────────────────────────────────────── */

let refreshTimer = null;

/* ── Helpers ─────────────────────────────────────────────────────── */

function setText(el, text) {
  if (el) el.textContent = text;
}

function setClass(el, className, add) {
  if (el) el.classList.toggle(className, add);
}

async function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

async function setStorage(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, resolve);
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.length ? tabs[0] : null;
}

function isTargetTab(tab) {
  return tab && tab.url && tab.url.includes(TARGET_HOST);
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[MindFlare Popup] Message error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

/* ── Status Display ──────────────────────────────────────────────── */

async function refreshStatus() {
  try {
    const stored = await getStorage([STORAGE_KEYS.config, STORAGE_KEYS.state]);
    const config = stored[STORAGE_KEYS.config] || {};
    const state  = stored[STORAGE_KEYS.state]  || {};

    // WebSocket status
    const wsOk = !!state.wsConnected;
    setText($wsStatus, wsOk ? 'Connected' : 'Disconnected');
    setClass($wsStatus, 'mf-val-green', wsOk);
    setClass($wsStatus, 'mf-val-red', !wsOk);

    // Active pair
    setText($activePair, state.activePair || '—');

    // Payout
    const payout = state.activePairPayout || 0;
    if (payout > 0) {
      setText($activePayout, payout + '%');
      setClass($activePayout, 'mf-val-green', payout >= 70);
      setClass($activePayout, 'mf-val-red', payout < 70);
    } else {
      setText($activePayout, '—');
      setClass($activePayout, 'mf-val-green', false);
      setClass($activePayout, 'mf-val-red', false);
    }

    // Agent status
    const busy = !!state.agentBusy;
    const trading = !!state.isTrading;
    if (trading) {
      setText($agentStatus, 'Trading');
      setClass($agentStatus, 'mf-val-blue', true);
      setClass($agentStatus, 'mf-val-green', false);
    } else if (busy) {
      setText($agentStatus, 'Analyzing');
      setClass($agentStatus, 'mf-val-blue', true);
      setClass($agentStatus, 'mf-val-green', false);
    } else {
      setText($agentStatus, 'Idle');
      setClass($agentStatus, 'mf-val-blue', false);
      setClass($agentStatus, 'mf-val-green', true);
    }

    // Toggles (only update if not focused to avoid fighting user input)
    if (document.activeElement !== $toggleAP) {
      $toggleAP.checked = !!config.autoPilot;
    }
    if (document.activeElement !== $toggleMG) {
      $toggleMG.checked = !!config.martingaleEnabled;
    }

  } catch (err) {
    console.error('[MindFlare Popup] refreshStatus error:', err);
  }
}

/* ── Toggle Handlers ─────────────────────────────────────────────── */

async function handleToggle(key, checked) {
  const stored = await getStorage(STORAGE_KEYS.config);
  const config = stored[STORAGE_KEYS.config] || {};
  config[key] = checked;
  await setStorage({ [STORAGE_KEYS.config]: config });

  // Also notify the content script so it picks up the change immediately
  const tab = await getActiveTab();
  if (isTargetTab(tab)) {
    await sendTabMessage(tab.id, {
      type: 'MF_CONFIG_UPDATE',
      key,
      value: checked,
    });
  }
}

/* ── Action Handlers ─────────────────────────────────────────────── */

async function handleAnalyze() {
  const tab = await getActiveTab();
  if (!isTargetTab(tab)) {
    flashButton($btnAnalyze, false);
    return;
  }
  await sendTabMessage(tab.id, { type: 'MF_ACTION', action: 'analyze' });
  flashButton($btnAnalyze, true);
}

async function handleScan() {
  const tab = await getActiveTab();
  if (!isTargetTab(tab)) {
    flashButton($btnScan, false);
    return;
  }
  await sendTabMessage(tab.id, { type: 'MF_ACTION', action: 'scan' });
  flashButton($btnScan, true);
}

async function handleOverlay() {
  const tab = await getActiveTab();
  if (!isTargetTab(tab)) {
    flashButton($btnOverlay, false);
    return;
  }
  await sendTabMessage(tab.id, { type: 'MF_TOGGLE_OVERLAY' });
  flashButton($btnOverlay, true);
}

function flashButton(btn, success) {
  if (!btn) return;
  btn.classList.add(success ? 'mf-btn-flash-ok' : 'mf-btn-flash-err');
  setTimeout(() => {
    btn.classList.remove('mf-btn-flash-ok', 'mf-btn-flash-err');
  }, 600);
}

/* ── Footer Links ────────────────────────────────────────────────── */

function openOptions(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
}

async function reloadTab(e) {
  e.preventDefault();
  const tab = await getActiveTab();
  if (tab) chrome.tabs.reload(tab.id);
}

/* ── Event Bindings ──────────────────────────────────────────────── */

$toggleAP.addEventListener('change', () => {
  handleToggle('autoPilot', $toggleAP.checked);
});

$toggleMG.addEventListener('change', () => {
  handleToggle('martingaleEnabled', $toggleMG.checked);
});

$btnAnalyze.addEventListener('click', handleAnalyze);
$btnScan.addEventListener('click', handleScan);
$btnOverlay.addEventListener('click', handleOverlay);
$linkOptions.addEventListener('click', openOptions);
$linkReload.addEventListener('click', reloadTab);

/* ── Lifecycle ───────────────────────────────────────────────────── */

// Initial load
refreshStatus();

// Poll every 2 seconds while popup is open
refreshTimer = setInterval(refreshStatus, REFRESH_MS);

// Stop polling when popup closes
window.addEventListener('unload', () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
