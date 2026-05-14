/**
 * inject-page-hook.js  —  Content Script (runs at document_start)
 *
 * Injects page-hook.js into the PAGE context so it can intercept
 * WebSocket traffic BEFORE the page's own scripts run.
 *
 * CRITICAL: This script MUST inject synchronously (no async/defer)
 * so that the WebSocket patch is in place before the page creates
 * any WebSocket connections. Using async/defer was the root cause
 * of the WebSocket disconnection bug in v1.x.
 */
(function injectPageHook() {
  'use strict';

  // Guard: only run on the actual trading page
  if (!location.hostname.includes('market-qx.trade')) return;

  // Guard: don't double-inject
  if (document.documentElement?.hasAttribute('data-mf-hook-injected')) return;
  document.documentElement.setAttribute('data-mf-hook-injected', '1');

  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-hook.js');
    // CRITICAL: Do NOT set async or defer!
    // The script MUST load synchronously to patch WebSocket before
    // the page's own JavaScript creates any WS connections.
    script.setAttribute('data-mf', 'page-hook');

    // Remove the script tag after it loads (keep DOM clean)
    script.addEventListener('load', () => {
      try { script.remove(); } catch(_) {}
    });
    script.addEventListener('error', () => {
      try { script.remove(); } catch(_) {}
      console.warn('[MindFlare] page-hook.js failed to load');
    });

    // Insert as the VERY FIRST script element to ensure it runs before
    // any page scripts that might create WebSocket connections
    const target = document.documentElement;
    target.insertBefore(script, target.firstChild);
  } catch (e) {
    // NEVER let an injection error break the page
    console.warn('[MindFlare] page-hook injection failed:', e.message);
  }
})();
