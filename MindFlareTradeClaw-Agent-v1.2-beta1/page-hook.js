/**
 * page-hook.js  —  Runs in PAGE context (injected by inject-page-hook.js)
 *
 * Intercepts WebSocket traffic for market-qx.trade so the extension can
 * observe real-time price ticks, candle updates, and trade outcomes.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  CRITICAL FIX (v1.2-beta1):                                     ║
 * ║                                                                  ║
 * ║  Previous versions replaced WebSocket with a wrapper function    ║
 * ║  that broke instanceof checks and Socket.IO v3/v4's internal    ║
 * ║  transport layer.  This caused the chart to fail loading.        ║
 * ║                                                                  ║
 * ║  Fix: Use proper ES6 class extension (extends) so that:         ║
 * ║    ✅ new HookedWS() instanceof WebSocket  →  true              ║
 * ║    ✅ ws.constructor === WebSocket          →  true (name)      ║
 * ║    ✅ All prototype methods work            →  send, close, etc.║
 * ║    ✅ All static constants preserved        →  CONNECTING, etc. ║
 * ║    ✅ Socket.IO transport layer works       →  chart loads      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Communication: posts messages to content script via window.postMessage
 */

(function pageHook() {
  'use strict';

  // ── Guard: don't run twice ────────────────────────────────────────
  if (window.__MindFlarePageHookV2) return;
  window.__MindFlarePageHookV2 = true;

  // ── Guard: only on trading pages ──────────────────────────────────
  if (!location.hostname.includes('market-qx.trade')) return;

  try {
    // ── Save original WebSocket ───────────────────────────────────
    const OriginalWebSocket = window.WebSocket;
    if (!OriginalWebSocket) {
      console.warn('[MindFlare] No WebSocket on page — skipping hook');
      return;
    }

    // ── Create proper subclass ────────────────────────────────────
    //    Using 'extends' ensures:
    //    - instanceof checks pass
    //    - prototype chain is correct
    //    - internal [[Prototype]] links work
    //    - Socket.IO v3/v4 transport layer works
    class MindFlareWebSocket extends OriginalWebSocket {
      constructor(url, protocols) {
        // Call parent constructor — this creates the actual WS connection
        if (protocols !== undefined) {
          super(url, protocols);
        } else {
          super(url);
        }

        // ── Passive observation ONLY — never modify WS behavior ──
        try {
          this.addEventListener('message', (event) => {
            try {
              const payload = {
                __mf: true,
                type: 'ws_msg',
                data: typeof event.data === 'string' ? event.data : '',
                url: url,
                ts: Date.now()
              };
              window.postMessage(payload, '*');
            } catch (_) {
              // Silently swallow — never break page JS
            }
          });

          this.addEventListener('open', () => {
            try {
              window.postMessage({
                __mf: true,
                type: 'ws_open',
                url: url,
                ts: Date.now()
              }, '*');
            } catch (_) {}
          });

          this.addEventListener('close', (event) => {
            try {
              window.postMessage({
                __mf: true,
                type: 'ws_close',
                url: url,
                code: event.code,
                reason: event.reason || '',
                ts: Date.now()
              }, '*');
            } catch (_) {}
          });

          this.addEventListener('error', () => {
            try {
              window.postMessage({
                __mf: true,
                type: 'ws_error',
                url: url,
                ts: Date.now()
              }, '*');
            } catch (_) {}
          });
        } catch (_) {
          // If listener attachment fails, the WS still works fine
        }
      }
    }

    // ── Preserve the class name for any code that checks ──────────
    Object.defineProperty(MindFlareWebSocket, 'name', {
      value: 'WebSocket',
      configurable: true
    });

    // ── Copy static constants ─────────────────────────────────────
    MindFlareWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    MindFlareWebSocket.OPEN = OriginalWebSocket.OPEN;
    MindFlareWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    MindFlareWebSocket.CLOSED = OriginalWebSocket.CLOSED;

    // ── Replace window.WebSocket ──────────────────────────────────
    Object.defineProperty(window, 'WebSocket', {
      value: MindFlareWebSocket,
      writable: true,
      configurable: true,
      enumerable: true
    });

    // ── Also hook XMLHttpRequest for API call observation ──────────
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function(method, url) {
        this.__mfUrl = url;
        this.__mfMethod = method;
        return origOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function(body) {
        if (this.__mfUrl && typeof this.__mfUrl === 'string' &&
            this.__mfUrl.includes('market-qx')) {
          this.addEventListener('load', function() {
            try {
              window.postMessage({
                __mf: true,
                type: 'xhr_load',
                url: this.__mfUrl,
                method: this.__mfMethod,
                status: this.status,
                response: typeof this.responseText === 'string'
                  ? this.responseText.substring(0, 50000)
                  : '',
                ts: Date.now()
              }, '*');
            } catch (_) {}
          });
        }
        return origSend.apply(this, arguments);
      };
    } catch (_) {
      // XHR hook is optional — don't break the page
    }

    // ── Signal to content script that hook is ready ───────────────
    window.postMessage({
      __mf: true,
      type: 'hook_ready',
      ts: Date.now()
    }, '*');

  } catch (err) {
    // ── ULTIMATE SAFETY NET ───────────────────────────────────────
    // If ANYTHING goes wrong, we MUST NOT break the page.
    // The extension will fall back to DOM-polling mode.
    console.warn('[MindFlare] page-hook initialization error:', err.message);
  }
})();
