/**
 * bootstrap.js  —  Delayed Safe Initialization Sequence
 *
 * This is the LAST content script loaded. It waits for the page to be
 * fully interactive before starting any extension functionality.
 *
 * CRITICAL FIX (v1.2-beta1):
 *   - Wait for page to be FULLY loaded before initializing
 *   - Use multiple fallback checks to ensure page readiness
 *   - Never block or delay page rendering
 *   - Initialize modules one at a time with error recovery
 */

(async function bootstrap() {
  'use strict';

  const BOOT_KEY = '__mf_bootstrapped';

  // Guard: don't bootstrap twice
  if (window[BOOT_KEY]) return;
  window[BOOT_KEY] = true;

  MF.log('info', 'MindFlare TradingClaw v' + MF.VERSION + ' bootstrap starting...');

  // ── Step 1: Wait for page to be fully interactive ──────────────────
  // We must NOT initialize before the trading platform has loaded its
  // chart and UI, otherwise we might interfere with its initialization.

  function waitForPageReady() {
    return new Promise((resolve) => {
      // Check if already ready
      if (document.readyState === 'complete' && DomClaw.isPageReady()) {
        resolve();
        return;
      }

      let attempts = 0;
      const maxAttempts = 30; // 30 seconds max

      const check = () => {
        attempts++;
        if ((document.readyState === 'complete' && DomClaw.isPageReady()) || attempts >= maxAttempts) {
          resolve();
        } else {
          setTimeout(check, 1000);
        }
      };

      // Also listen for DOMContentLoaded and load events
      if (document.readyState !== 'complete') {
        window.addEventListener('load', () => {
          // Give the page 2 more seconds after load to finish rendering
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
    const storeOk = await CandleStore.init();
    MF.log('info', 'CandleStore initialized:', storeOk ? 'OK' : 'FAILED');
  } catch (e) {
    MF.log('warn', 'CandleStore init failed:', e.message);
  }

  // ── Step 4: Listen for page-hook ready signal ─────────────────────
  // The page-hook.js posts a 'hook_ready' message when it's done setting
  // up the WebSocket proxy. We listen for it here.
  let hookTimeout = null;

  function onHookReady() {
    MF.state.hookReady = true;
    MF.log('info', 'Page hook is ready — WS interception active');
    MF.bus.emit('ws:hook-ready');
  }

  // Listen for hook ready from page context
  window.addEventListener('message', (event) => {
    if (event.data && event.data.__mf && event.data.type === 'hook_ready') {
      onHookReady();
    }
  });

  // Also check if the hook was already loaded before our listener
  if (document.documentElement?.hasAttribute('data-mf-hook-injected')) {
    // The hook might already be ready — give it a moment
    hookTimeout = setTimeout(() => {
      if (!MF.state.hookReady) {
        MF.log('info', 'Hook attribute found but no ready signal — assuming ready');
        onHookReady();
      }
    }, 3000);
  }

  // ── Step 5: Start Scanner ──────────────────────────────────────────
  try {
    Scanner.start();
    MF.log('info', 'Scanner started');
  } catch (e) {
    MF.log('warn', 'Scanner start failed:', e.message);
  }

  // ── Step 6: Enable Historical Auto-Load ────────────────────────────
  try {
    HistoricalLoader.enableAutoLoad();
    MF.log('info', 'Historical auto-load enabled');
  } catch (e) {
    MF.log('warn', 'Historical loader setup failed:', e.message);
  }

  // ── Step 7: Initialize UI Overlay ──────────────────────────────────
  try {
    // Small delay to ensure page is fully rendered
    await MF.sleep(1000);

    if (MF.getConfig('overlayVisible')) {
      UIOverlay.init();
      MF.log('info', 'UI Overlay initialized');
    }
  } catch (e) {
    MF.log('warn', 'UI Overlay init failed:', e.message);
  }

  // ── Step 8: Start DomClaw observers ────────────────────────────────
  try {
    DomClaw.init && DomClaw.init();
    MF.log('info', 'DomClaw observers started');
  } catch (e) {
    // DomClaw might not have an init method — that's ok
  }

  // ── Step 9: Restore auto-pilot if it was running ──────────────────
  try {
    if (MF.getConfig('autoPilot')) {
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

  // ── Step 10: Periodic health check ─────────────────────────────────
  setInterval(() => {
    try {
      // Re-emit status for UI updates
      MF.bus.emit('health:check', {
        wsConnected: MF.state.wsConnected,
        hookReady: MF.state.hookReady,
        scannerRunning: Scanner.isRunning(),
        autoPilot: MF.getConfig('autoPilot'),
        activePair: MF.state.activePair,
        tradeCount: MF.state.tradeHistory?.length || 0,
      });
    } catch (e) {
      // Silent
    }
  }, 30000);

  // ── Done ───────────────────────────────────────────────────────────
  MF.log('info', 'MindFlare TradingClaw v' + MF.VERSION + ' bootstrap complete ✓');
  MF.bus.emit('bootstrap:complete');

})();
