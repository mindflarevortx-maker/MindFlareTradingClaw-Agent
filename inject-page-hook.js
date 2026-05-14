/**
 * inject-page-hook.js  —  Content Script (runs at document_start)
 *
 * Injects page-hook.js code INLINE into the PAGE context so it can
 * intercept WebSocket traffic BEFORE the page's own scripts run.
 *
 * CRITICAL FIX (v2.1):
 *   Previous versions loaded page-hook.js via <script src="..."> which
 *   is ASYNCHRONOUS — the browser must fetch the external file from the
 *   extension, and during that async load the page's own scripts execute
 *   first and create WebSocket connections BEFORE the hook is in place.
 *
 *   By loading the file synchronously via XHR and injecting it as inline
 *   textContent, the script executes SYNCHRONOUSLY at document_start,
 *   guaranteeing the WebSocket patch is installed before any page
 *   JavaScript runs.
 *
 *   The page-hook.js file is kept for web_accessible_resources manifest
 *   entry, but the actual injection uses inline textContent for
 *   guaranteed synchronous execution.
 */
(function injectPageHook() {
  'use strict';

  // Guard: only run on the actual trading page
  if (!location.hostname.includes('market-qx.trade')) return;

  // Guard: don't double-inject
  if (document.documentElement?.hasAttribute('data-mf-hook-injected')) return;
  document.documentElement.setAttribute('data-mf-hook-injected', '1');

  try {
    // ── Synchronously load page-hook.js from the extension ──────────
    // Synchronous XHR blocks this content script until the file content
    // is available. Since this runs at document_start, NO page scripts
    // can execute until we finish — guaranteeing the WS hook is first.
    const xhr = new XMLHttpRequest();
    xhr.open('GET', chrome.runtime.getURL('page-hook.js'), false); // false = synchronous
    xhr.send();

    if (xhr.status !== 200 && xhr.status !== 0) {
      // status 0 is normal for chrome-extension:// URLs in some Chrome versions
      console.warn('[MindFlare] page-hook.js load failed:', xhr.status);
      return;
    }

    const code = xhr.responseText;
    if (!code) {
      console.warn('[MindFlare] page-hook.js was empty');
      return;
    }

    // ── Inject as inline script (synchronous execution) ────────────
    const script = document.createElement('script');
    script.textContent = code;
    script.setAttribute('data-mf', 'page-hook');

    // Insert as the VERY FIRST element to ensure it runs before
    // any page scripts that might create WebSocket connections
    const target = document.documentElement;
    target.insertBefore(script, target.firstChild);

    // Inline scripts execute synchronously, so we can remove
    // the tag immediately after insertion (keeps DOM clean)
    try { script.remove(); } catch(_) {}
  } catch (e) {
    // NEVER let an injection error break the page
    console.warn('[MindFlare] page-hook injection failed:', e.message);
  }
})();
