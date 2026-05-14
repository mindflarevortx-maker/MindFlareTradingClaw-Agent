/**
 * inject-page-hook.js  —  Content Script (runs at document_start)
 *
 * Safely injects page-hook.js into the PAGE context so it can intercept
 * WebSocket traffic.  This script runs in the CONTENT SCRIPT world and
 * only creates a <script> element — it does NOT touch the page's JS at all.
 *
 * CRITICAL FIX (v1.2-beta1):
 *   - Wait for <head> to exist before injecting (avoid racing with page init)
 *   - Wrap injection in comprehensive error handling
 *   - Do NOT block or delay page rendering in any way
 *   - Use a minimal, non-blocking script element
 */

(function injectPageHook() {
  'use strict';

  // Guard: only run on the actual trading page
  if (!location.hostname.includes('market-qx.trade')) return;

  // Guard: don't double-inject
  if (document.documentElement?.hasAttribute('data-mf-hook-injected')) return;

  /**
   * We must inject BEFORE the page's own scripts run so our WebSocket
   * proxy is in place. But we also need <head> to exist to append the
   * script tag. We use a microtask + MutationObserver approach.
   */
  function inject() {
    try {
      if (document.documentElement?.hasAttribute('data-mf-hook-injected')) return;
      document.documentElement.setAttribute('data-mf-hook-injected', '1');

      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('page-hook.js');
      script.type = 'text/javascript';
      script.async = true;             // Non-blocking
      script.defer = true;             // Don't block parsing
      script.setAttribute('data-mf', 'page-hook');

      // Remove the script tag after it loads (keep DOM clean)
      script.addEventListener('load', () => {
        try { script.remove(); } catch(_) {}
      });
      script.addEventListener('error', () => {
        try { script.remove(); } catch(_) {}
        console.warn('[MindFlare] page-hook.js failed to load — running without WS interception');
      });

      // Append to the earliest available parent
      const target = document.head || document.documentElement;
      target.insertBefore(script, target.firstChild);
    } catch (e) {
      // NEVER let an injection error break the page
      console.warn('[MindFlare] page-hook injection failed:', e.message);
    }
  }

  // If <head> already exists, inject immediately
  if (document.head) {
    inject();
  } else {
    // Otherwise, use MutationObserver to inject as soon as <head> appears
    const observer = new MutationObserver((mutations, obs) => {
      if (document.head) {
        obs.disconnect();
        inject();
      }
    });
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true
    });

    // Fallback timeout — if <head> doesn't appear in 3 seconds, inject anyway
    setTimeout(() => {
      observer.disconnect();
      inject();
    }, 3000);
  }
})();
