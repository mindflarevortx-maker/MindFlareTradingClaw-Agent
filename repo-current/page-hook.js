/**
 * page-hook.js  —  Runs in PAGE context (injected by inject-page-hook.js)
 *
 * Intercepts WebSocket traffic for market-qx.trade so the extension can
 * observe real-time price ticks, candle updates, and trade outcomes.
 *
 * CRITICAL FIX (v2.0):
 *   - Uses proper ES6 class extension (extends) for instanceof compatibility
 *   - Handles binary Socket.IO frames (ArrayBuffer, Blob) not just strings
 *   - Tracks all WebSocket instances for historical-loader access
 *   - Proper Socket.IO v3/v4 frame decoder with binary support
 *   - Posts decoded frames with both raw AND parsed data
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

  // ── WebSocket instance tracking for historical-loader ─────────────
  window.__MFC_WS_SOCKETS = [];

  // ── Helper: post message to content script ────────────────────────
  const post = (type, data) => {
    try {
      window.postMessage({ __mf: true, type, ...data }, '*');
    } catch (_) {
      // Silently swallow — never break page JS
    }
  };

  // ── Binary decoder ────────────────────────────────────────────────
  function decodeBinary(data) {
    try {
      if (typeof data === 'string') return data;
      if (data instanceof ArrayBuffer) {
        const u8 = new Uint8Array(data);
        // Try to decode as UTF-8 text
        let txt;
        try { txt = new TextDecoder('utf-8', { fatal: false }).decode(u8); } catch (_) { return null; }
        // If it starts with JSON-like character or Socket.IO prefix, it's text data
        if (txt && (txt[0] === '{' || txt[0] === '[' || txt[0] === '4' || txt[0] === '"' || txt[0] === '0')) return txt;
        // Socket.IO binary: first byte 0x04 = ENGINE.IO message
        if (u8[0] === 0x04) {
          try { return new TextDecoder('utf-8', { fatal: false }).decode(u8.slice(1)); } catch (_) {}
        }
        // Skip leading non-printable bytes (engine.io framing)
        let i = 0;
        while (i < u8.length && i < 8 && u8[i] < 0x20 && u8[i] !== 0x0a && u8[i] !== 0x09) i++;
        if (i > 0) {
          try { return new TextDecoder('utf-8', { fatal: false }).decode(u8.slice(i)); } catch (_) {}
        }
        return txt || null;
      }
      if (data && typeof data.arrayBuffer === 'function') {
        // Blob
        data.arrayBuffer().then(buf => {
          const decoded = decodeBinary(buf);
          if (decoded) {
            post('ws_msg', { data: decoded, url: this.__mfUrl || '', ts: Date.now() });
          }
        }).catch(() => {});
        return null; // async — don't post synchronously
      }
      if (ArrayBuffer.isView(data)) {
        try { return new TextDecoder('utf-8', { fatal: false }).decode(data); } catch (_) { return null; }
      }
    } catch (_) {}
    return null;
  }

  // ── Socket.IO frame parser ────────────────────────────────────────
  function parseSioFrame(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    // Socket.IO v3/v4 event: "42["event_name", ...data]" or "451-[...]"
    const sioMatch = raw.match(/^4(\d)(?:\d+-)?(?:\/[^,]*,)?([\s\S]*)$/);
    if (sioMatch) {
      const code = sioMatch[1], payload = sioMatch[2];
      if ((code === '2' || code === '3') && payload) {
        try {
          const arr = JSON.parse(payload);
          if (Array.isArray(arr) && arr.length >= 1) {
            return { event: String(arr[0] ?? ''), data: arr.slice(1).length === 1 ? arr[1] : arr.slice(1) };
          }
        } catch (_) {}
      }
    }
    // Raw JSON
    if (raw[0] === '{' || raw[0] === '[') {
      try {
        const j = JSON.parse(raw);
        if (Array.isArray(j) && j.length >= 1 && typeof j[0] === 'string') {
          return { event: j[0], data: j.length === 2 ? j[1] : j.slice(1) };
        }
        return { event: 'raw', data: j };
      } catch (_) {}
    }
    return null;
  }

  try {
    // ── Save original WebSocket ───────────────────────────────────
    const OriginalWebSocket = window.WebSocket;
    if (!OriginalWebSocket) {
      console.warn('[MindFlare] No WebSocket on page — skipping hook');
      return;
    }

    // ── Create proper subclass ────────────────────────────────────
    class MindFlareWebSocket extends OriginalWebSocket {
      constructor(url, protocols) {
        if (protocols !== undefined) {
          super(url, protocols);
        } else {
          super(url);
        }

        // Store URL for reference
        this.__mfUrl = String(url);

        // Track this socket instance
        try { window.__MFC_WS_SOCKETS.push(this); } catch (_) {}

        // ── Passive observation ONLY — never modify WS behavior ──
        try {
          this.addEventListener('message', (event) => {
            try {
              const rawData = event.data;

              // Handle string data directly
              if (typeof rawData === 'string' && rawData.length > 0) {
                // Post raw string for scanner
                post('ws_msg', { data: rawData, url: String(url), ts: Date.now() });

                // Also post decoded Socket.IO frame if available
                const parsed = parseSioFrame(rawData);
                if (parsed) {
                  post('ws_sio', { event: parsed.event, data: parsed.data, url: String(url), dir: 'in', ts: Date.now() });
                }
              }
              // Handle binary data (ArrayBuffer, Blob)
              else if (rawData instanceof ArrayBuffer) {
                const decoded = decodeBinary(rawData);
                if (decoded) {
                  post('ws_msg', { data: decoded, url: String(url), ts: Date.now() });
                  const parsed = parseSioFrame(decoded);
                  if (parsed) {
                    post('ws_sio', { event: parsed.event, data: parsed.data, url: String(url), dir: 'in', ts: Date.now() });
                  }
                }
              }
              else if (rawData && typeof rawData.arrayBuffer === 'function') {
                // Blob — decode async
                rawData.arrayBuffer().then(buf => {
                  const decoded = decodeBinary(buf);
                  if (decoded) {
                    post('ws_msg', { data: decoded, url: String(url), ts: Date.now() });
                    const parsed = parseSioFrame(decoded);
                    if (parsed) {
                      post('ws_sio', { event: parsed.event, data: parsed.data, url: String(url), dir: 'in', ts: Date.now() });
                    }
                  }
                }).catch(() => {});
              }
            } catch (_) {
              // Silently swallow — never break page JS
            }
          });

          this.addEventListener('open', () => {
            try {
              post('ws_open', { url: String(url), ts: Date.now() });
            } catch (_) {}
          });

          this.addEventListener('close', (event) => {
            try {
              // Remove from tracked sockets
              const idx = window.__MFC_WS_SOCKETS.indexOf(this);
              if (idx !== -1) window.__MFC_WS_SOCKETS.splice(idx, 1);
              post('ws_close', { url: String(url), code: event.code, reason: event.reason || '', ts: Date.now() });
            } catch (_) {}
          });

          this.addEventListener('error', () => {
            try {
              post('ws_error', { url: String(url), ts: Date.now() });
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

    // ── Hook WebSocket.send to capture outgoing messages ──────
    try {
      const origSend = OriginalWebSocket.prototype.send;
      MindFlareWebSocket.prototype.send = function(data) {
        try {
          // Handle string sends
          if (typeof data === 'string' && data.length > 0) {
            post('ws_send', { data: data, url: this.__mfUrl || this.url || '', ts: Date.now() });
            // Also parse Socket.IO frame for outgoing
            const parsed = parseSioFrame(data);
            if (parsed) {
              post('ws_sio', { event: parsed.event, data: parsed.data, url: this.__mfUrl || this.url || '', dir: 'out', ts: Date.now() });
            }
          }
          // Handle binary sends
          else if (data instanceof ArrayBuffer) {
            const decoded = decodeBinary(data);
            if (decoded) {
              post('ws_send', { data: decoded, url: this.__mfUrl || this.url || '', ts: Date.now() });
            }
          }
        } catch (_) {}
        return origSend.apply(this, arguments);
      };
    } catch (_) {}

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
            (this.__mfUrl.includes('market-qx') || this.__mfUrl.includes('qxbroker') || this.__mfUrl.includes('quotex'))) {
          this.addEventListener('load', function() {
            try {
              post('xhr_load', {
                url: this.__mfUrl,
                method: this.__mfMethod,
                status: this.status,
                response: typeof this.responseText === 'string'
                  ? this.responseText.substring(0, 50000)
                  : '',
                ts: Date.now()
              });
            } catch (_) {}
          });
        }
        return origSend.apply(this, arguments);
      };
    } catch (_) {}

    // ── Hook fetch() for API observation too ─────────────────────
    try {
      const origFetch = window.fetch;
      window.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : (input?.url || '');
        if (url && (url.includes('market-qx') || url.includes('qxbroker') || url.includes('quotex'))) {
          return origFetch.apply(this, arguments).then(response => {
            try {
              const cloned = response.clone();
              cloned.text().then(text => {
                post('fetch_load', {
                  url: url,
                  method: init?.method || 'GET',
                  status: response.status,
                  response: text.substring(0, 50000),
                  ts: Date.now()
                });
              }).catch(() => {});
            } catch (_) {}
            return response;
          });
        }
        return origFetch.apply(this, arguments);
      };
    } catch (_) {}

    // ── Signal to content script that hook is ready ───────────────
    post('hook_ready', { ts: Date.now() });

  } catch (err) {
    // ── ULTIMATE SAFETY NET ───────────────────────────────────────
    console.warn('[MindFlare] page-hook initialization error:', err.message);
  }
})();
