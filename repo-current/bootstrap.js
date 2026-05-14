/**
 * bootstrap.js  —  MindFlareClaw-AGENT v2.0 Initialization
 *
 * Last content script in load order. Waits for page to be ready,
 * then starts all modules: Scanner, CandleStore, UI, Agent.
 */

(async function bootstrap() {
  'use strict';

  const BOOT_KEY = '__mf_bootstrapped';

  // Guard: don't bootstrap twice
  if (window[BOOT_KEY]) return;
  window[BOOT_KEY] = true;

  MF.log('info', 'MindFlareClaw-AGENT v' + MF.VERSION + ' bootstrap starting...');

  // ── Step 1: Wait for page to be fully interactive ──────────────────
  function waitForPageReady() {
    return new Promise((resolve) => {
      if (document.readyState === 'complete' && typeof DomClaw !== 'undefined' && DomClaw.isPageReady()) {
        resolve();
        return;
      }

      let attempts = 0;
      const maxAttempts = 30;

      const check = () => {
        attempts++;
        const domReady = typeof DomClaw !== 'undefined' ? DomClaw.isPageReady() : (document.readyState === 'complete');
        if ((document.readyState === 'complete' && domReady) || attempts >= maxAttempts) {
          resolve();
        } else {
          setTimeout(check, 1000);
        }
      };

      if (document.readyState !== 'complete') {
        window.addEventListener('load', () => {
          setTimeout(resolve, 2000);
        }, { once: true });
      }

      setTimeout(check, 1000);
    });
  }

  try {
    await waitForPageReady();
    MF.log('info', 'Page ready, initializing modules...');
  } catch (e) {
    MF.log('warn', 'Page readiness check timed out, proceeding anyway');
  }

  // ── Step 2: Load persisted config and state ────────────────────────
  try {
    await MF.loadConfig();
    await MF.loadState();
    MF.log('info', 'Config and state loaded');
  } catch (e) {
    MF.log('warn', 'Failed to load config/state:', e.message);
  }

  // ── Step 3: Initialize CandleStore (IndexedDB) ────────────────────
  try {
    if (typeof CandleStore !== 'undefined' && CandleStore.openDB) {
      await CandleStore.openDB();
      MF.log('info', 'CandleStore initialized');
    }
  } catch (e) {
    MF.log('warn', 'CandleStore init failed:', e.message);
  }

  // ── Step 4: Listen for page-hook ready signal ─────────────────────
  function onHookReady() {
    MF.state.hookReady = true;
    MF.log('info', 'Page hook is ready — WS interception active');
    MF.bus.emit('ws:hook-ready');
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.__mf && event.data.type === 'hook_ready') {
      onHookReady();
    }
  });

  // Check if the hook was already loaded before our listener
  if (document.documentElement?.hasAttribute('data-mf-hook-injected')) {
    setTimeout(() => {
      if (!MF.state.hookReady) {
        MF.log('info', 'Hook attribute found but no ready signal — assuming ready');
        onHookReady();
      }
    }, 3000);
  }

  // ── Step 5: Start Scanner ──────────────────────────────────────────
  try {
    if (typeof Scanner !== 'undefined') {
      Scanner.start();
      MF.log('info', 'Scanner started');
    }
  } catch (e) {
    MF.log('warn', 'Scanner start failed:', e.message);
  }

  // ── Step 6: Enable Historical Auto-Load ────────────────────────────
  try {
    if (typeof HistoricalLoader !== 'undefined' && HistoricalLoader.enableAutoLoad) {
      HistoricalLoader.enableAutoLoad();
      MF.log('info', 'Historical auto-load enabled');
    }
  } catch (e) {
    MF.log('warn', 'Historical loader setup failed:', e.message);
  }

  // ── Step 7: Initialize UI Overlay ──────────────────────────────────
  try {
    await MF.sleep(1000);

    if (MF.getConfig('overlayVisible') && typeof UIOverlay !== 'undefined') {
      UIOverlay.init();
      MF.log('info', 'UI Overlay initialized');
    }
  } catch (e) {
    MF.log('warn', 'UI Overlay init failed:', e.message);
  }

  // ── Step 8: Restore auto-pilot if it was running ──────────────────
  try {
    if (MF.getConfig('autoPilot') && typeof Agent !== 'undefined') {
      MF.log('info', 'Auto-pilot was enabled — restarting in 10s...');
      setTimeout(() => {
        try {
          Agent.startAutoPilot();
        } catch (e) {
          MF.log('warn', 'Auto-pilot restart failed:', e.message);
        }
      }, 10000);
    }
  } catch (e) {
    // Silent
  }

  // ── Step 9: Periodic health check ─────────────────────────────────
  setInterval(() => {
    try {
      MF.bus.emit('health:check', {
        wsConnected: MF.state.wsConnected,
        hookReady: MF.state.hookReady,
        scannerRunning: typeof Scanner !== 'undefined' ? Scanner.isRunning() : false,
        autoPilot: MF.getConfig('autoPilot'),
        activePair: MF.state.activePair,
        tradeCount: MF.state.tradeHistory?.length || 0,
      });
    } catch (e) {
      // Silent
    }
  }, 30000);

  // ── Done ───────────────────────────────────────────────────────────
  MF.log('info', 'MindFlareClaw-AGENT v' + MF.VERSION + ' bootstrap complete');
  MF.bus.emit('bootstrap:complete');

})();
