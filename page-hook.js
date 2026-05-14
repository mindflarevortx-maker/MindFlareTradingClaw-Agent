/**
 * page-hook.js  —  Runs in PAGE context (injected by inject-page-hook.js)
 *
 * Intercepts WebSocket traffic for market-qx.trade so the extension can
 * observe real-time price ticks, candle updates, and trade outcomes.
 *
 * CRITICAL FIX (v2.1):
 *   - Proper Socket.IO v3 (EIO=3) binary event handling
 *   - market-qx.trade uses wss://ws2.market-qx.trade/socket.io/?EIO=3&transport=websocket
 *   - Binary events: 451-[event, {_placeholder:true, num:0}] followed by B-prefixed base64 msgpack
 *   - The binary attachment IS the actual data — must decode msgpack from base64
 *   - Specific event names: instruments/list, quotes/stream, history/list/v2,
 *     s_balance/list, orders/closed/list, depth/change, etc.
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

  // ── Pending binary attachment buffer ──────────────────────────────
  // Socket.IO v3 binary events come as TWO messages:
  //   1. "451-[event, {_placeholder:true, num:0}]"  (text frame with placeholder)
  //   2. Binary frame with msgpack data (the actual payload)
  let _pendingBinaryEvent = null;

  // ── Message queue for late-starting content scripts ───────────────
  // page-hook runs at document_start but scanner.js (content script)
  // doesn't register its window.addEventListener('message') until
  // document_idle. Early WS events would be LOST without this queue.
  const _msgQueue = window.__MFC_MSG_QUEUE || [];
  window.__MFC_MSG_QUEUE = _msgQueue;

  // ── Helper: post message to content script ────────────────────────
  const post = (type, data) => {
    try {
      const msg = { __mf: true, type };
      // Safely spread data without overwriting __mf or type
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          if (k !== '__mf' && k !== 'type') msg[k] = v;
        }
      }
      window.postMessage(msg, '*');
      // Also queue for late-starting content scripts
      _msgQueue.push(msg);
      // Keep queue bounded
      if (_msgQueue.length > 500) _msgQueue.splice(0, _msgQueue.length - 500);
    } catch (_) {
      // Silently swallow — never break page JS
    }
  };

  // ── Socket.IO frame parser ────────────────────────────────────────
  function parseSioFrame(raw) {
    if (typeof raw !== 'string' || !raw) return null;

    // Socket.IO BINARY EVENT (451- or 452- etc.)
    // Format: 451-["event_name", {"_placeholder":true,"num":0}]
    const binaryMatch = raw.match(/^45(\d+)-(?:\/[^,]*,)?([\s\S]*)$/);
    if (binaryMatch) {
      const attachmentCount = parseInt(binaryMatch[1], 10) || 1;
      const payload = binaryMatch[2];
      if (payload) {
        try {
          const arr = JSON.parse(payload);
          if (Array.isArray(arr) && arr.length >= 1) {
            const event = String(arr[0] ?? '');
            const data = arr.length === 2 ? arr[1] : arr.slice(1);
            return { event, data, isBinary: true, attachmentCount };
          }
        } catch (_) {}
      }
      return { event: null, data: null, isBinary: true, attachmentCount };
    }

    // Socket.IO EVENT (42)
    // Format: 42["event_name", ...data]
    const eventMatch = raw.match(/^42(?:\/[^,]*,)?([\s\S]*)$/);
    if (eventMatch) {
      const payload = eventMatch[1];
      if (payload) {
        try {
          const arr = JSON.parse(payload);
          if (Array.isArray(arr) && arr.length >= 1) {
            return { event: String(arr[0] ?? ''), data: arr.length === 2 ? arr[1] : arr.slice(1), isBinary: false };
          }
        } catch (_) {}
      }
      return { event: null, data: null, isBinary: false };
    }

    // Socket.IO CONNECT (40)
    if (raw === '40') return { event: '__connect', data: null, isBinary: false };

    // Socket.IO ACK (43...)
    const ackMatch = raw.match(/^43(\d*)(?:\/[^,]*,)?([\s\S]*)$/);
    if (ackMatch) {
      const payload = ackMatch[2];
      if (payload) {
        try {
          const arr = JSON.parse(payload);
          return { event: '__ack', data: arr, isBinary: false };
        } catch (_) {}
      }
      return { event: '__ack', data: null, isBinary: false };
    }

    // Raw JSON that might be an event array
    if (raw[0] === '{' || raw[0] === '[') {
      try {
        const j = JSON.parse(raw);
        if (Array.isArray(j) && j.length >= 1 && typeof j[0] === 'string') {
          return { event: j[0], data: j.length === 2 ? j[1] : j.slice(1), isBinary: false };
        }
        return { event: 'raw', data: j, isBinary: false };
      } catch (_) {}
    }

    return null;
  }

  // ── Process a parsed Socket.IO frame (text-based) ─────────────────
  function processSioFrame(parsed, url, dir) {
    if (!parsed) return;

    // If this is a binary event with placeholder, store it and wait for attachment
    if (parsed.isBinary && parsed.data && typeof parsed.data === 'object' &&
        parsed.data._placeholder === true) {
      _pendingBinaryEvent = { event: parsed.event, attachmentCount: parsed.attachmentCount, url, dir };
      // Post the event name even without data — the scanner can use the event name
      post('ws_sio', { event: parsed.event, data: { _pendingBinary: true }, url, dir, ts: Date.now() });
      return;
    }

    // Regular event — post immediately
    if (parsed.event && parsed.event !== '__connect' && parsed.event !== '__ack') {
      post('ws_sio', { event: parsed.event, data: parsed.data, url, dir, ts: Date.now() });
    }
  }

  // ── Process a binary attachment (follows a 451- frame) ────────────
  function processBinaryAttachment(rawData, url) {
    if (!_pendingBinaryEvent) return;

    const evt = _pendingBinaryEvent;
    _pendingBinaryEvent = null;

    let decodedData = null;

    // Try to decode as text first (some binary attachments are just base64 of JSON/msgpack)
    if (typeof rawData === 'string') {
      // B-prefixed base64 data from Socket.IO
      if (rawData[0] === 'B') {
        try {
          // The data after B is base64-encoded msgpack or raw binary
          const b64 = rawData.substring(1);
          // Add padding if needed
          const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
          const binary = atob(padded);
          // Try msgpack decode
          try {
            decodedData = msgpackDecode(binary);
          } catch (_) {
            // If msgpack fails, try as UTF-8 text
            try {
              decodedData = JSON.parse(binary);
            } catch (_2) {
              decodedData = { _rawText: binary.substring(0, 5000) };
            }
          }
        } catch (_) {}
      } else {
        decodedData = rawData;
      }
    }
    // ArrayBuffer
    else if (rawData instanceof ArrayBuffer) {
      try {
        const u8 = new Uint8Array(rawData);
        // Try msgpack
        try {
          decodedData = msgpackDecodeFromArray(u8);
        } catch (_) {
          // Try as text
          try {
            const txt = new TextDecoder('utf-8', { fatal: false }).decode(u8);
            try { decodedData = JSON.parse(txt); } catch (_2) { decodedData = { _rawText: txt.substring(0, 5000) }; }
          } catch (_2) {}
        }
      } catch (_) {}
    }
    // Blob
    else if (rawData && typeof rawData.arrayBuffer === 'function') {
      rawData.arrayBuffer().then(buf => {
        processBinaryAttachment(buf, url);
      }).catch(() => {});
      return;
    }

    // Post the decoded data with the event name
    if (decodedData !== null) {
      post('ws_sio', {
        event: evt.event,
        data: decodedData,
        url: evt.url || url || '',
        dir: evt.dir || 'in',
        ts: Date.now(),
        isAttachment: true
      });
    }
  }

  // ── Minimal msgpack decoder (for Socket.IO binary attachments) ────
  // market-qx.trade uses msgpack to encode instrument lists, quotes, etc.

  function msgpackDecode(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i);
    }
    return msgpackDecodeFromArray(bytes);
  }

  function msgpackDecodeFromArray(bytes, offset) {
    offset = offset || { val: 0 };
    const i = offset.val;
    if (i >= bytes.length) return null;

    const b = bytes[i];
    offset.val++;

    // Positive fixint (0x00 - 0x7f)
    if (b <= 0x7f) return b;

    // Negative fixint (0xe0 - 0xff)
    if (b >= 0xe0) return b - 256;

    // fixmap (0x80 - 0x8f)
    if (b >= 0x80 && b <= 0x8f) {
      const count = b & 0x0f;
      const map = {};
      for (let j = 0; j < count; j++) {
        const key = msgpackDecodeFromArray(bytes, offset);
        const val = msgpackDecodeFromArray(bytes, offset);
        map[key] = val;
      }
      return map;
    }

    // fixarray (0x90 - 0x9f)
    if (b >= 0x90 && b <= 0x9f) {
      const count = b & 0x0f;
      const arr = [];
      for (let j = 0; j < count; j++) {
        arr.push(msgpackDecodeFromArray(bytes, offset));
      }
      return arr;
    }

    // fixstr (0xa0 - 0xbf)
    if (b >= 0xa0 && b <= 0xbf) {
      const len = b & 0x1f;
      const str = String.fromCharCode.apply(null, bytes.subarray(offset.val, offset.val + len));
      offset.val += len;
      return str;
    }

    // null
    if (b === 0xc0) return null;
    // false
    if (b === 0xc2) return false;
    // true
    if (b === 0xc3) return true;

    // bin 8
    if (b === 0xc4) {
      const len = bytes[offset.val++];
      const buf = bytes.subarray(offset.val, offset.val + len);
      offset.val += len;
      return buf;
    }
    // bin 16
    if (b === 0xc5) {
      const len = (bytes[offset.val] << 8) | bytes[offset.val + 1];
      offset.val += 2;
      const buf = bytes.subarray(offset.val, offset.val + len);
      offset.val += len;
      return buf;
    }

    // str 8
    if (b === 0xd9) {
      const len = bytes[offset.val++];
      const str = String.fromCharCode.apply(null, bytes.subarray(offset.val, offset.val + len));
      offset.val += len;
      return str;
    }
    // str 16
    if (b === 0xda) {
      const len = (bytes[offset.val] << 8) | bytes[offset.val + 1];
      offset.val += 2;
      const str = String.fromCharCode.apply(null, bytes.subarray(offset.val, offset.val + len));
      offset.val += len;
      return str;
    }
    // str 32
    if (b === 0xdb) {
      const len = (bytes[offset.val] << 24) | (bytes[offset.val + 1] << 16) | (bytes[offset.val + 2] << 8) | bytes[offset.val + 3];
      offset.val += 4;
      const str = String.fromCharCode.apply(null, bytes.subarray(offset.val, offset.val + len));
      offset.val += len;
      return str;
    }

    // array 16
    if (b === 0xdc) {
      const count = (bytes[offset.val] << 8) | bytes[offset.val + 1];
      offset.val += 2;
      const arr = [];
      for (let j = 0; j < count; j++) {
        arr.push(msgpackDecodeFromArray(bytes, offset));
      }
      return arr;
    }
    // array 32
    if (b === 0xdd) {
      const count = (bytes[offset.val] << 24) | (bytes[offset.val + 1] << 16) | (bytes[offset.val + 2] << 8) | bytes[offset.val + 3];
      offset.val += 4;
      const arr = [];
      for (let j = 0; j < count; j++) {
        arr.push(msgpackDecodeFromArray(bytes, offset));
      }
      return arr;
    }

    // map 16
    if (b === 0xde) {
      const count = (bytes[offset.val] << 8) | bytes[offset.val + 1];
      offset.val += 2;
      const map = {};
      for (let j = 0; j < count; j++) {
        const key = msgpackDecodeFromArray(bytes, offset);
        const val = msgpackDecodeFromArray(bytes, offset);
        map[key] = val;
      }
      return map;
    }
    // map 32
    if (b === 0xdf) {
      const count = (bytes[offset.val] << 24) | (bytes[offset.val + 1] << 16) | (bytes[offset.val + 2] << 8) | bytes[offset.val + 3];
      offset.val += 4;
      const map = {};
      for (let j = 0; j < count; j++) {
        const key = msgpackDecodeFromArray(bytes, offset);
        const val = msgpackDecodeFromArray(bytes, offset);
        map[key] = val;
      }
      return map;
    }

    // uint 8
    if (b === 0xcc) return bytes[offset.val++];
    // uint 16
    if (b === 0xcd) {
      const v = (bytes[offset.val] << 8) | bytes[offset.val + 1];
      offset.val += 2;
      return v;
    }
    // uint 32
    if (b === 0xce) {
      const v = (bytes[offset.val] << 24) | (bytes[offset.val + 1] << 16) | (bytes[offset.val + 2] << 8) | bytes[offset.val + 3];
      offset.val += 4;
      return v;
    }

    // int 8
    if (b === 0xd0) {
      const v = bytes[offset.val++];
      return v > 127 ? v - 256 : v;
    }
    // int 16
    if (b === 0xd1) {
      const v = (bytes[offset.val] << 8) | bytes[offset.val + 1];
      offset.val += 2;
      return v > 32767 ? v - 65536 : v;
    }
    // int 32
    if (b === 0xd2) {
      const v = (bytes[offset.val] << 24) | (bytes[offset.val + 1] << 16) | (bytes[offset.val + 2] << 8) | bytes[offset.val + 3];
      offset.val += 4;
      return v;
    }

    // float 64
    if (b === 0xcb) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset.val, 8);
      offset.val += 8;
      return view.getFloat64(0);
    }
    // float 32
    if (b === 0xca) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset.val, 4);
      offset.val += 4;
      return view.getFloat32(0);
    }

    // Fallback: return as number
    return b;
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
                // Engine.IO OPEN (0{...})
                if (rawData[0] === '0') {
                  post('ws_msg', { data: rawData, url: String(url), ts: Date.now() });
                  return;
                }
                // Engine.IO PONG (3)
                if (rawData === '3') {
                  post('ws_msg', { data: rawData, url: String(url), ts: Date.now() });
                  return;
                }
                // Socket.IO CONNECT (40)
                if (rawData === '40') {
                  post('ws_msg', { data: rawData, url: String(url), ts: Date.now() });
                  post('ws_sio', { event: '__sio_connect', data: null, url: String(url), dir: 'in', ts: Date.now() });
                  return;
                }

                // Check if this is a binary event placeholder (451-[...])
                if (rawData[0] === '4' && rawData.length > 1 && rawData[1] === '5') {
                  // This is a binary event frame — parse it and store for attachment
                  const parsed = parseSioFrame(rawData);
                  if (parsed) {
                    processSioFrame(parsed, String(url), 'in');
                  }
                  // Also post raw for scanner's own decoder
                  post('ws_msg', { data: rawData, url: String(url), ts: Date.now() });
                  return;
                }

                // Regular Socket.IO event (42[...])
                if (rawData[0] === '4' && rawData.length > 1 && rawData[1] === '2') {
                  const parsed = parseSioFrame(rawData);
                  if (parsed) {
                    processSioFrame(parsed, String(url), 'in');
                  }
                  // Also post raw for scanner
                  post('ws_msg', { data: rawData, url: String(url), ts: Date.now() });
                  return;
                }

                // Any other text frame — post raw
                post('ws_msg', { data: rawData, url: String(url), ts: Date.now() });
              }
              // Handle binary data (ArrayBuffer) — this is the attachment for 451- frames
              else if (rawData instanceof ArrayBuffer) {
                // This is likely the binary attachment for a pending binary event
                processBinaryAttachment(rawData, String(url));
              }
              // Handle Blob
              else if (rawData && typeof rawData.arrayBuffer === 'function') {
                rawData.arrayBuffer().then(buf => {
                  processBinaryAttachment(buf, String(url));
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
              _pendingBinaryEvent = null;
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
            if (parsed && parsed.event) {
              post('ws_sio', { event: parsed.event, data: parsed.data, url: this.__mfUrl || this.url || '', dir: 'out', ts: Date.now() });
            }
          }
        } catch (_) {}
        return origSend.apply(this, arguments);
      };
    } catch (_) {}

    // ── Signal to content script that hook is ready ───────────────
    post('hook_ready', { ts: Date.now() });

  } catch (err) {
    // ── ULTIMATE SAFETY NET ───────────────────────────────────────
    console.warn('[MindFlare] page-hook initialization error:', err.message);
  }
})();
