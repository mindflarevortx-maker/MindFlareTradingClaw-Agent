/**
 * ui-overlay.js  —  Draggable Dashboard Overlay for MindFlare TradingClaw
 *
 * Self-contained IIFE assigned to global `UIOverlay`.  Creates a compact,
 * draggable, resizable, minimizable panel with 5 tabs that sits on the
 * trading page without interfering with the chart.
 *
 * Globals used: MF, Agent, Chat, Scanner, TechnicalEngine, CandleStore,
 *               SelfImprovement, StrategyEngine
 */

const UIOverlay = (() => {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  //  CONSTANTS
  // ══════════════════════════════════════════════════════════════════

  const MIN_WIDTH  = 320;
  const MIN_HEIGHT = 400;
  const DEFAULT_POS  = { x: 20, y: 80 };
  const DEFAULT_SIZE = { w: 380, h: 520 };
  const TICK_DISPLAY_MAX = 12;
  const TABS = ['scanner', 'analysis', 'autopilot', 'chat', 'history'];
  const TAB_LABELS = {
    scanner:   'Scanner',
    analysis:  'Analysis',
    autopilot: 'Auto-Pilot',
    chat:      'Chat',
    history:   'History',
  };

  // ══════════════════════════════════════════════════════════════════
  //  INTERNAL STATE
  // ══════════════════════════════════════════════════════════════════

  let _panel     = null;  // root container div
  let _titleBar  = null;
  let _content   = null;
  let _statusBar = null;
  let _minBtn    = null;  // floating minimized button
  let _activeTab = 'scanner';
  let _minimized = false;
  let _visible   = true;
  let _ticks     = [];    // recent tick stream for scanner display

  // Drag state
  let _dragging  = false;
  let _dragOff   = { x: 0, y: 0 };

  // Resize state
  let _resizing    = false;
  let _resizeStart = { x: 0, y: 0, w: 0, h: 0 };

  // ══════════════════════════════════════════════════════════════════
  //  DOM CREATION
  // ══════════════════════════════════════════════════════════════════

  function _el(tag, cls, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else e.setAttribute(k, v);
      }
    }
    return e;
  }

  function _buildOverlay() {
    // ── Root container ─────────────────────────────────────────────
    _panel = _el('div', 'mf-overlay');
    _panel.style.display = 'none'; // hidden until init positions

    const pos  = MF.getConfig('overlayPosition') || DEFAULT_POS;
    const size = MF.getConfig('overlaySize') || DEFAULT_SIZE;
    const opac = MF.getConfig('overlayOpacity') || 0.95;
    _panel.style.left     = pos.x + 'px';
    _panel.style.top      = pos.y + 'px';
    _panel.style.width    = size.w + 'px';
    _panel.style.height   = size.h + 'px';
    _panel.style.opacity  = opac;

    // ── Title bar ──────────────────────────────────────────────────
    _titleBar = _el('div', 'mf-title-bar');
    const titleText = _el('span', 'mf-title-text', { text: 'MindFlare TradingClaw' });
    const titleVers = _el('span', 'mf-title-version', { text: 'v' + MF.VERSION });
    const btnMin    = _el('button', 'mf-title-btn mf-btn-minimize', { text: '\u2013' });
    const btnClose  = _el('button', 'mf-title-btn mf-btn-close', { text: '\u00D7' });

    btnMin.addEventListener('click', (e) => { e.stopPropagation(); _minimize(); });
    btnClose.addEventListener('click', (e) => { e.stopPropagation(); _hide(); });

    _titleBar.appendChild(titleText);
    _titleBar.appendChild(titleVers);
    _titleBar.appendChild(btnMin);
    _titleBar.appendChild(btnClose);

    // Drag handlers
    _titleBar.addEventListener('mousedown', _onDragStart);
    _titleBar.addEventListener('touchstart', _onDragStartTouch, { passive: false });

    _panel.appendChild(_titleBar);

    // ── Tab bar ────────────────────────────────────────────────────
    const tabBar = _el('div', 'mf-tab-bar');
    for (const tab of TABS) {
      const btn = _el('button', 'mf-tab-btn' + (tab === _activeTab ? ' mf-tab-active' : ''));
      btn.dataset.tab = tab;
      btn.textContent = TAB_LABELS[tab];
      btn.addEventListener('click', () => _switchTab(tab));
      tabBar.appendChild(btn);
    }
    _panel.appendChild(tabBar);

    // ── Content area ───────────────────────────────────────────────
    _content = _el('div', 'mf-content');
    for (const tab of TABS) {
      const pane = _el('div', 'mf-tab-pane' + (tab === _activeTab ? ' mf-pane-active' : ''));
      pane.dataset.pane = tab;
      _content.appendChild(pane);
    }
    _panel.appendChild(_content);

    // ── Resize handle ──────────────────────────────────────────────
    const resizeHandle = _el('div', 'mf-resize-handle');
    resizeHandle.addEventListener('mousedown', _onResizeStart);
    resizeHandle.addEventListener('touchstart', _onResizeStartTouch, { passive: false });
    _panel.appendChild(resizeHandle);

    // ── Status bar ─────────────────────────────────────────────────
    _statusBar = _el('div', 'mf-status-bar');
    const statusConn  = _el('span', 'mf-status-item mf-status-conn',  { text: 'WS: ---' });
    const statusPair  = _el('span', 'mf-status-item mf-status-pair',  { text: 'Pair: ---' });
    const statusTime  = _el('span', 'mf-status-item mf-status-time',  { text: '' });
    _statusBar.appendChild(statusConn);
    _statusBar.appendChild(statusPair);
    _statusBar.appendChild(statusTime);
    _panel.appendChild(_statusBar);

    document.body.appendChild(_panel);

    // ── Minimized floating button ──────────────────────────────────
    _minBtn = _el('button', 'mf-minimized-btn');
    _minBtn.textContent = 'MF';
    _minBtn.title = 'MindFlare TradingClaw — click to restore';
    _minBtn.style.display = 'none';
    _minBtn.addEventListener('click', _restore);
    document.body.appendChild(_minBtn);
  }

  // ══════════════════════════════════════════════════════════════════
  //  TAB SWITCHING
  // ══════════════════════════════════════════════════════════════════

  function _switchTab(tab) {
    if (!TABS.includes(tab)) return;
    _activeTab = tab;
    MF.setConfig('activeTab', tab);

    // Update tab buttons
    const btns = _panel.querySelectorAll('.mf-tab-btn');
    btns.forEach(b => b.classList.toggle('mf-tab-active', b.dataset.tab === tab));

    // Update panes
    const panes = _content.querySelectorAll('.mf-tab-pane');
    panes.forEach(p => p.classList.toggle('mf-pane-active', p.dataset.pane === tab));

    // Refresh tab content
    _refreshTab(tab);
  }

  // ══════════════════════════════════════════════════════════════════
  //  MINIMIZE / RESTORE / HIDE / SHOW
  // ══════════════════════════════════════════════════════════════════

  function _minimize() {
    _minimized = true;
    MF.setConfig('overlayMinimized', true);
    _panel.style.display = 'none';
    _minBtn.style.display = 'flex';
  }

  function _restore() {
    _minimized = false;
    MF.setConfig('overlayMinimized', false);
    _panel.style.display = 'flex';
    _minBtn.style.display = 'none';
  }

  function _hide() {
    _visible = false;
    MF.setConfig('overlayVisible', false);
    _panel.style.display = 'none';
    _minBtn.style.display = 'none';
  }

  function show() {
    _visible = true;
    MF.setConfig('overlayVisible', true);
    if (_minimized) {
      _minBtn.style.display = 'flex';
    } else {
      _panel.style.display = 'flex';
    }
  }

  function toggle() {
    if (_visible && !_minimized) _minimize();
    else show();
  }

  // ══════════════════════════════════════════════════════════════════
  //  DRAG LOGIC
  // ══════════════════════════════════════════════════════════════════

  function _onDragStart(e) {
    if (e.target.closest('.mf-title-btn')) return;
    e.preventDefault();
    _dragging = true;
    const rect = _panel.getBoundingClientRect();
    _dragOff.x = e.clientX - rect.left;
    _dragOff.y = e.clientY - rect.top;
    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup', _onDragEnd);
  }

  function _onDragStartTouch(e) {
    if (e.target.closest('.mf-title-btn')) return;
    e.preventDefault();
    _dragging = true;
    const touch = e.touches[0];
    const rect = _panel.getBoundingClientRect();
    _dragOff.x = touch.clientX - rect.left;
    _dragOff.y = touch.clientY - rect.top;
    document.addEventListener('touchmove', _onDragMoveTouch, { passive: false });
    document.addEventListener('touchend', _onDragEndTouch);
  }

  function _onDragMove(e) {
    if (!_dragging) return;
    _setPosition(e.clientX - _dragOff.x, e.clientY - _dragOff.y);
  }

  function _onDragMoveTouch(e) {
    if (!_dragging) return;
    e.preventDefault();
    const touch = e.touches[0];
    _setPosition(touch.clientX - _dragOff.x, touch.clientY - _dragOff.y);
  }

  function _onDragEnd() {
    _dragging = false;
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('mouseup', _onDragEnd);
    _savePosition();
  }

  function _onDragEndTouch() {
    _dragging = false;
    document.removeEventListener('touchmove', _onDragMoveTouch);
    document.removeEventListener('touchend', _onDragEndTouch);
    _savePosition();
  }

  function _setPosition(x, y) {
    const maxW = window.innerWidth - 60;
    const maxH = window.innerHeight - 40;
    x = MF.clamp(x, 0, maxW);
    y = MF.clamp(y, 0, maxH);
    _panel.style.left = x + 'px';
    _panel.style.top  = y + 'px';
  }

  function _savePosition() {
    MF.setConfig('overlayPosition', {
      x: parseInt(_panel.style.left, 10) || 0,
      y: parseInt(_panel.style.top, 10) || 0,
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  RESIZE LOGIC
  // ══════════════════════════════════════════════════════════════════

  function _onResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    _resizing = true;
    _resizeStart = {
      x: e.clientX, y: e.clientY,
      w: _panel.offsetWidth, h: _panel.offsetHeight,
    };
    document.addEventListener('mousemove', _onResizeMove);
    document.addEventListener('mouseup', _onResizeEnd);
  }

  function _onResizeStartTouch(e) {
    e.preventDefault();
    e.stopPropagation();
    _resizing = true;
    const touch = e.touches[0];
    _resizeStart = {
      x: touch.clientX, y: touch.clientY,
      w: _panel.offsetWidth, h: _panel.offsetHeight,
    };
    document.addEventListener('touchmove', _onResizeMoveTouch, { passive: false });
    document.addEventListener('touchend', _onResizeEndTouch);
  }

  function _onResizeMove(e) {
    if (!_resizing) return;
    const dx = e.clientX - _resizeStart.x;
    const dy = e.clientY - _resizeStart.y;
    _setSize(_resizeStart.w + dx, _resizeStart.h + dy);
  }

  function _onResizeMoveTouch(e) {
    if (!_resizing) return;
    e.preventDefault();
    const touch = e.touches[0];
    const dx = touch.clientX - _resizeStart.x;
    const dy = touch.clientY - _resizeStart.y;
    _setSize(_resizeStart.w + dx, _resizeStart.h + dy);
  }

  function _onResizeEnd() {
    _resizing = false;
    document.removeEventListener('mousemove', _onResizeMove);
    document.removeEventListener('mouseup', _onResizeEnd);
    _saveSize();
  }

  function _onResizeEndTouch() {
    _resizing = false;
    document.removeEventListener('touchmove', _onResizeMoveTouch);
    document.removeEventListener('touchend', _onResizeEndTouch);
    _saveSize();
  }

  function _setSize(w, h) {
    w = Math.max(MIN_WIDTH, w);
    h = Math.max(MIN_HEIGHT, h);
    _panel.style.width  = w + 'px';
    _panel.style.height = h + 'px';
  }

  function _saveSize() {
    MF.setConfig('overlaySize', {
      w: _panel.offsetWidth,
      h: _panel.offsetHeight,
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  TAB CONTENT BUILDERS
  // ══════════════════════════════════════════════════════════════════

  // ── Helper: get pane element by tab name ─────────────────────────
  function _pane(tab) {
    return _content.querySelector('[data-pane="' + tab + '"]');
  }

  // ── Refresh a single tab's content ───────────────────────────────
  function _refreshTab(tab) {
    try {
      switch (tab) {
        case 'scanner':   _refreshScanner();   break;
        case 'analysis':  _refreshAnalysis();  break;
        case 'autopilot': _refreshAutoPilot(); break;
        case 'chat':      _refreshChat();      break;
        case 'history':   _refreshHistory();   break;
      }
    } catch (e) {
      MF.log('warn', 'UIOverlay: refresh error for', tab, e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  SCANNER TAB
  // ══════════════════════════════════════════════════════════════════

  function _refreshScanner() {
    const pane = _pane('scanner');
    pane.innerHTML = '';

    // Active pair section
    const section = _el('div', 'mf-section');
    const header  = _el('div', 'mf-section-header', { text: 'Active Pair' });
    section.appendChild(header);

    const pairGrid = _el('div', 'mf-info-grid');
    const pair = MF.state.activePair || '---';
    const payout = MF.state.activePairPayout || 0;
    const price = _getLastPrice(pair);
    pairGrid.appendChild(_infoRow('Pair', pair));
    pairGrid.appendChild(_infoRow('Price', price || '---'));
    pairGrid.appendChild(_infoRow('Payout', payout ? payout + '%' : '---'));
    section.appendChild(pairGrid);
    pane.appendChild(section);

    // WS status
    const wsSection = _el('div', 'mf-section');
    const wsHeader  = _el('div', 'mf-section-header', { text: 'Connection' });
    wsSection.appendChild(wsHeader);
    const wsGrid = _el('div', 'mf-info-grid');
    const wsStatus = MF.state.wsConnected ? 'Connected' : 'Disconnected';
    const wsClass  = MF.state.wsConnected ? 'mf-val-green' : 'mf-val-red';
    wsGrid.appendChild(_infoRow('WebSocket', wsStatus, wsClass));
    const diag = typeof Scanner !== 'undefined' ? Scanner.getDiagnostics() : {};
    wsGrid.appendChild(_infoRow('DOM Poll', diag.domPollActive ? 'Active' : 'Inactive'));
    wsSection.appendChild(wsGrid);
    pane.appendChild(wsSection);

    // High payout pairs
    const hpSection = _el('div', 'mf-section');
    const hpHeader  = _el('div', 'mf-section-header', { text: 'High-Payout Pairs' });
    hpSection.appendChild(hpHeader);
    const hpList = _el('div', 'mf-pair-list');
    const highPairs = MF.state.highPayoutPairs || [];
    if (highPairs.length === 0) {
      hpList.appendChild(_el('div', 'mf-empty', { text: 'No pairs above min payout' }));
    } else {
      for (let i = 0; i < Math.min(highPairs.length, 10); i++) {
        const pName = highPairs[i];
        const pInfo = MF.state.allPairs[pName] || {};
        const row = _el('div', 'mf-pair-row');
        row.appendChild(_el('span', 'mf-pair-name', { text: pName }));
        row.appendChild(_el('span', 'mf-pair-payout mf-val-green', { text: (pInfo.payout || 0) + '%' }));
        hpList.appendChild(row);
      }
    }
    hpSection.appendChild(hpList);
    pane.appendChild(hpSection);

    // Tick stream
    const tickSection = _el('div', 'mf-section');
    const tickHeader  = _el('div', 'mf-section-header', { text: 'Tick Stream' });
    tickSection.appendChild(tickHeader);
    const tickList = _el('div', 'mf-tick-list');
    if (_ticks.length === 0) {
      tickList.appendChild(_el('div', 'mf-empty', { text: 'Waiting for ticks...' }));
    } else {
      for (let i = _ticks.length - 1; i >= 0; i--) {
        const t = _ticks[i];
        const row = _el('div', 'mf-tick-row');
        const dir = i > 0 && _ticks[i - 1].price < t.price ? 'mf-tick-up'
                  : i > 0 && _ticks[i - 1].price > t.price ? 'mf-tick-down'
                  : '';
        row.classList.add(dir);
        row.appendChild(_el('span', 'mf-tick-time', { text: _formatTime(t.timestamp) }));
        row.appendChild(_el('span', 'mf-tick-price', { text: t.price.toFixed(t.price < 10 ? 5 : 2) }));
        tickList.appendChild(row);
      }
    }
    tickSection.appendChild(tickList);
    pane.appendChild(tickSection);

    // Rescan button
    const btnRow = _el('div', 'mf-btn-row');
    const rescanBtn = _el('button', 'mf-btn mf-btn-primary', { text: 'Rescan Pairs' });
    rescanBtn.addEventListener('click', () => {
      try { if (typeof Scanner !== 'undefined') Scanner.rescan(); } catch (_) {}
    });
    btnRow.appendChild(rescanBtn);
    pane.appendChild(btnRow);
  }

  // ══════════════════════════════════════════════════════════════════
  //  ANALYSIS TAB
  // ══════════════════════════════════════════════════════════════════

  function _refreshAnalysis() {
    const pane = _pane('analysis');
    pane.innerHTML = '';

    const analysis = MF.state.lastAnalysis;
    if (!analysis) {
      pane.appendChild(_el('div', 'mf-empty', { text: 'No analysis yet. Signal pipeline will populate this tab.' }));
      const btnRow = _el('div', 'mf-btn-row');
      const btn = _el('button', 'mf-btn mf-btn-primary', { text: 'Run Analysis' });
      btn.addEventListener('click', () => {
        try { if (typeof Agent !== 'undefined') Agent.getSignal(); } catch (_) {}
      });
      btnRow.appendChild(btn);
      pane.appendChild(btnRow);
      return;
    }

    // Trend
    const trendSec = _el('div', 'mf-section');
    trendSec.appendChild(_el('div', 'mf-section-header', { text: 'Trend' }));
    const trendGrid = _el('div', 'mf-info-grid');
    const trend = analysis.trend || {};
    const trendDir = (trend.direction || 'sideways').toUpperCase();
    const trendCls = trendDir === 'UP' ? 'mf-val-green' : trendDir === 'DOWN' ? 'mf-val-red' : 'mf-val-blue';
    trendGrid.appendChild(_infoRow('Direction', trendDir, trendCls));
    trendGrid.appendChild(_infoRow('Strength', (trend.strength || 0) + '%'));
    trendSec.appendChild(trendGrid);
    pane.appendChild(trendSec);

    // Technical indicators
    const indSec = _el('div', 'mf-section');
    indSec.appendChild(_el('div', 'mf-section-header', { text: 'Technical Indicators' }));
    const indGrid = _el('div', 'mf-info-grid');
    const ind = analysis.indicators || {};

    if (ind.rsi != null) {
      const cls = ind.rsi < 30 ? 'mf-val-green' : ind.rsi > 70 ? 'mf-val-red' : '';
      indGrid.appendChild(_infoRow('RSI(14)', ind.rsi.toFixed(1), cls));
    }
    if (ind.macd) {
      const mCls = ind.macd.histogram > 0 ? 'mf-val-green' : 'mf-val-red';
      indGrid.appendChild(_infoRow('MACD', ind.macd.macd.toFixed(4), mCls));
      indGrid.appendChild(_infoRow('Signal', ind.macd.signal.toFixed(4)));
      indGrid.appendChild(_infoRow('Histogram', ind.macd.histogram.toFixed(4), mCls));
    }
    if (ind.bollinger) {
      indGrid.appendChild(_infoRow('BB Upper', ind.bollinger.upper.toFixed(4)));
      indGrid.appendChild(_infoRow('BB Lower', ind.bollinger.lower.toFixed(4)));
      indGrid.appendChild(_infoRow('%B', (ind.bollinger.percentB || 0).toFixed(2)));
    }
    if (ind.stochastic) {
      const sCls = ind.stochastic.k < 20 ? 'mf-val-green' : ind.stochastic.k > 80 ? 'mf-val-red' : '';
      indGrid.appendChild(_infoRow('Stoch %K', ind.stochastic.k.toFixed(1), sCls));
      indGrid.appendChild(_infoRow('Stoch %D', ind.stochastic.d.toFixed(1)));
    }
    if (ind.ema) {
      if (ind.ema.ema9 != null)  indGrid.appendChild(_infoRow('EMA 9', ind.ema.ema9.toFixed(4)));
      if (ind.ema.ema21 != null) indGrid.appendChild(_infoRow('EMA 21', ind.ema.ema21.toFixed(4)));
    }
    if (ind.atr != null)   indGrid.appendChild(_infoRow('ATR', ind.atr.toFixed(4)));
    if (ind.adx != null)   indGrid.appendChild(_infoRow('ADX', ind.adx.toFixed(1)));
    indSec.appendChild(indGrid);
    pane.appendChild(indSec);

    // SMC / ICT
    const smc = analysis.smc;
    if (smc) {
      const smcSec = _el('div', 'mf-section');
      smcSec.appendChild(_el('div', 'mf-section-header', { text: 'SMC / ICT' }));
      const smcGrid = _el('div', 'mf-info-grid');
      const obs = smc.orderBlocks || [];
      const fvgs = smc.fvgs || [];
      const bos = smc.bos || [];
      const choch = smc.choch || [];
      smcGrid.appendChild(_infoRow('Order Blocks', obs.length));
      smcGrid.appendChild(_infoRow('FVGs', fvgs.length));
      smcGrid.appendChild(_infoRow('BOS', bos.length));
      smcGrid.appendChild(_infoRow('CHOCH', choch.length));
      if (obs.length) {
        const lastOB = obs[obs.length - 1];
        smcGrid.appendChild(_infoRow('Last OB', lastOB.type, lastOB.type === 'bullish' ? 'mf-val-green' : 'mf-val-red'));
      }
      if (choch.length) {
        const lastCH = choch[choch.length - 1];
        smcGrid.appendChild(_infoRow('Last CHOCH', lastCH.type, lastCH.type === 'bullish' ? 'mf-val-green' : 'mf-val-red'));
      }
      smcSec.appendChild(smcGrid);
      pane.appendChild(smcSec);
    }

    // Patterns
    const patterns = analysis.patterns || [];
    if (patterns.length) {
      const patSec = _el('div', 'mf-section');
      patSec.appendChild(_el('div', 'mf-section-header', { text: 'Candlestick Patterns' }));
      const patList = _el('div', 'mf-pattern-list');
      for (const p of patterns) {
        const cls = p.type === 'bullish' ? 'mf-val-green' : p.type === 'bearish' ? 'mf-val-red' : 'mf-val-blue';
        const row = _el('div', 'mf-pattern-row');
        row.appendChild(_el('span', 'mf-pattern-name ' + cls, { text: p.name }));
        row.appendChild(_el('span', 'mf-pattern-conf', { text: p.confidence + '%' }));
        patList.appendChild(row);
      }
      patSec.appendChild(patList);
      pane.appendChild(patSec);
    }

    // Signal display
    const signals = MF.state.signals || [];
    if (signals.length) {
      const sigSec = _el('div', 'mf-section');
      sigSec.appendChild(_el('div', 'mf-section-header', { text: 'Recent Signals' }));
      const sigList = _el('div', 'mf-signal-list');
      for (const s of signals.slice(-5)) {
        const cls = s.direction === 'CALL' ? 'mf-signal-call' : s.direction === 'PUT' ? 'mf-signal-put' : 'mf-signal-neutral';
        const row = _el('div', 'mf-signal-row ' + cls);
        row.appendChild(_el('span', 'mf-signal-dir', { text: s.direction || '---' }));
        row.appendChild(_el('span', 'mf-signal-conf', { text: (s.confidence || 0) + '%' }));
        if (s.pair) row.appendChild(_el('span', 'mf-signal-pair', { text: s.pair }));
        sigList.appendChild(row);
      }
      sigSec.appendChild(sigList);
      pane.appendChild(sigSec);
    }

    // Refresh button
    const btnRow = _el('div', 'mf-btn-row');
    const refreshBtn = _el('button', 'mf-btn mf-btn-primary', { text: 'Refresh Analysis' });
    refreshBtn.addEventListener('click', () => {
      try { if (typeof Agent !== 'undefined') Agent.getSignal(); } catch (_) {}
    });
    btnRow.appendChild(refreshBtn);
    pane.appendChild(btnRow);
  }

  // ══════════════════════════════════════════════════════════════════
  //  AUTO-PILOT TAB
  // ══════════════════════════════════════════════════════════════════

  function _refreshAutoPilot() {
    const pane = _pane('autopilot');
    pane.innerHTML = '';

    const autoPilot = MF.getConfig('autoPilot');
    const martingaleEnabled = MF.getConfig('martingaleEnabled');
    const status = typeof Agent !== 'undefined' ? Agent.getStatus() : {};

    // Auto-pilot toggle
    const apSection = _el('div', 'mf-section');
    apSection.appendChild(_el('div', 'mf-section-header', { text: 'Auto-Pilot' }));

    const apToggle = _el('div', 'mf-toggle-row');
    const apLabel  = _el('span', 'mf-toggle-label', { text: 'Auto-Pilot Mode' });
    const apSwitch = _buildToggle(autoPilot, (val) => {
      try {
        if (val && typeof Agent !== 'undefined') Agent.startAutoPilot();
        else if (typeof Agent !== 'undefined') Agent.stopAutoPilot();
      } catch (_) {}
    });
    apToggle.appendChild(apLabel);
    apToggle.appendChild(apSwitch);
    apSection.appendChild(apToggle);

    const apGrid = _el('div', 'mf-info-grid');
    const apStatus = autoPilot ? 'RUNNING' : 'STOPPED';
    apGrid.appendChild(_infoRow('Status', apStatus, autoPilot ? 'mf-val-green' : 'mf-val-red'));
    apGrid.appendChild(_infoRow('Busy', status.busy ? 'Yes' : 'No'));
    apSection.appendChild(apGrid);
    pane.appendChild(apSection);

    // Martingale
    const mgSection = _el('div', 'mf-section');
    mgSection.appendChild(_el('div', 'mf-section-header', { text: 'Martingale' }));

    const mgToggle = _el('div', 'mf-toggle-row');
    const mgLabel  = _el('span', 'mf-toggle-label', { text: 'Martingale' });
    const mgSwitch = _buildToggle(martingaleEnabled, (val) => {
      MF.setConfig('martingaleEnabled', val);
    });
    mgToggle.appendChild(mgLabel);
    mgToggle.appendChild(mgSwitch);
    mgSection.appendChild(mgToggle);

    const mgGrid = _el('div', 'mf-info-grid');
    const mgStep = MF.state.martingaleStep || 0;
    const mgMaxSteps = MF.getConfig('martingaleSteps') || 3;
    mgGrid.appendChild(_infoRow('Step', mgStep + ' / ' + mgMaxSteps, mgStep >= mgMaxSteps ? 'mf-val-red' : ''));
    mgGrid.appendChild(_infoRow('Current Investment', '$' + (MF.state.currentInvestment || MF.getConfig('baseInvestment') || 1)));
    mgGrid.appendChild(_infoRow('Base Investment', '$' + (MF.getConfig('baseInvestment') || 1)));
    mgGrid.appendChild(_infoRow('Multiplier', (MF.getConfig('martingaleMultiplier') || 2.0) + 'x'));
    mgGrid.appendChild(_infoRow('Max Investment', '$' + (MF.getConfig('maxInvestment') || 100)));
    mgSection.appendChild(mgGrid);
    pane.appendChild(mgSection);

    // Last signal
    if (status.lastSignal) {
      const sigSec = _el('div', 'mf-section');
      sigSec.appendChild(_el('div', 'mf-section-header', { text: 'Last Signal' }));
      const sigGrid = _el('div', 'mf-info-grid');
      const ls = status.lastSignal;
      const dirCls = ls.direction === 'CALL' ? 'mf-val-green' : ls.direction === 'PUT' ? 'mf-val-red' : 'mf-val-blue';
      sigGrid.appendChild(_infoRow('Direction', ls.direction || '---', dirCls));
      sigGrid.appendChild(_infoRow('Confidence', (ls.confidence || 0) + '%'));
      sigGrid.appendChild(_infoRow('Pair', ls.pair || '---'));
      sigSec.appendChild(sigGrid);
      pane.appendChild(sigSec);
    }

    // Trade execution controls
    const ctrlSection = _el('div', 'mf-section');
    ctrlSection.appendChild(_el('div', 'mf-section-header', { text: 'Manual Trade' }));

    const investRow = _el('div', 'mf-input-row');
    investRow.appendChild(_el('label', 'mf-input-label', { text: 'Investment $' }));
    const investInput = _el('input', 'mf-input mf-invest-input');
    investInput.type = 'number';
    investInput.min = '0.35';
    investInput.step = '0.01';
    investInput.value = MF.state.currentInvestment || MF.getConfig('baseInvestment') || 1;
    investRow.appendChild(investInput);
    ctrlSection.appendChild(investRow);

    const btnRow = _el('div', 'mf-btn-row mf-btn-row-trade');
    const callBtn = _el('button', 'mf-btn mf-btn-call', { text: 'CALL \u25B2' });
    const putBtn  = _el('button', 'mf-btn mf-btn-put',  { text: 'PUT \u25BC' });
    const resetMgBtn = _el('button', 'mf-btn mf-btn-secondary', { text: 'Reset Martingale' });

    callBtn.addEventListener('click', () => {
      const inv = parseFloat(investInput.value);
      try { if (typeof Agent !== 'undefined') Agent.execute('CALL', null, inv > 0 ? inv : undefined); } catch (_) {}
    });
    putBtn.addEventListener('click', () => {
      const inv = parseFloat(investInput.value);
      try { if (typeof Agent !== 'undefined') Agent.execute('PUT', null, inv > 0 ? inv : undefined); } catch (_) {}
    });
    resetMgBtn.addEventListener('click', () => {
      try { if (typeof Agent !== 'undefined') Agent.resetMartingale(); } catch (_) {}
    });

    btnRow.appendChild(callBtn);
    btnRow.appendChild(putBtn);
    ctrlSection.appendChild(btnRow);

    const btnRow2 = _el('div', 'mf-btn-row');
    btnRow2.appendChild(resetMgBtn);
    ctrlSection.appendChild(btnRow2);
    pane.appendChild(ctrlSection);
  }

  // ══════════════════════════════════════════════════════════════════
  //  CHAT TAB
  // ══════════════════════════════════════════════════════════════════

  function _refreshChat() {
    const pane = _pane('chat');

    // Only build the chat structure once; then just update messages
    if (pane.querySelector('.mf-chat-container')) {
      _updateChatMessages();
      return;
    }

    pane.innerHTML = '';

    const container = _el('div', 'mf-chat-container');
    const messages  = _el('div', 'mf-chat-messages');

    const messagesArr = typeof Chat !== 'undefined' ? Chat.getMessages() : [];
    for (const msg of messagesArr) {
      messages.appendChild(_buildChatBubble(msg));
    }
    container.appendChild(messages);

    // Input area
    const inputArea = _el('div', 'mf-chat-input-area');
    const input     = _el('input', 'mf-chat-input');
    input.type = 'text';
    input.placeholder = 'Type a message or /help for commands...';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _sendChatMessage(input);
      }
    });

    const sendBtn = _el('button', 'mf-btn mf-btn-send', { text: '\u27A4' });
    sendBtn.addEventListener('click', () => _sendChatMessage(input));

    inputArea.appendChild(input);
    inputArea.appendChild(sendBtn);
    container.appendChild(inputArea);
    pane.appendChild(container);

    // Scroll to bottom
    _scrollChatToBottom();
  }

  function _buildChatBubble(msg) {
    const cls = 'mf-chat-bubble mf-chat-' + (msg.role || 'system');
    const bubble = _el('div', cls);
    if (msg.role && msg.role !== 'system') {
      const label = _el('div', 'mf-chat-role', { text: msg.role === 'user' ? 'You' : 'AI' });
      bubble.appendChild(label);
    }
    const content = _el('div', 'mf-chat-content');
    content.innerHTML = _formatChatText(msg.content || '');
    bubble.appendChild(content);
    if (msg.timestamp) {
      bubble.appendChild(_el('div', 'mf-chat-time', { text: _formatTime(msg.timestamp) }));
    }
    return bubble;
  }

  function _formatChatText(text) {
    if (!text) return '';
    // Basic markdown-ish formatting
    let html = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
    return html;
  }

  function _sendChatMessage(inputEl) {
    const text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';

    if (typeof Chat !== 'undefined') {
      Chat.sendMessage(text).catch((e) => {
        MF.log('warn', 'UIOverlay: Chat sendMessage error:', e.message);
      });
    }
  }

  function _updateChatMessages() {
    const msgContainer = _pane('chat').querySelector('.mf-chat-messages');
    if (!msgContainer) return;

    const messagesArr = typeof Chat !== 'undefined' ? Chat.getMessages() : [];
    // Rebuild only if count differs (simple approach)
    const currentCount = msgContainer.querySelectorAll('.mf-chat-bubble').length;
    if (currentCount !== messagesArr.length) {
      msgContainer.innerHTML = '';
      for (const msg of messagesArr) {
        msgContainer.appendChild(_buildChatBubble(msg));
      }
      _scrollChatToBottom();
    }
  }

  function _scrollChatToBottom() {
    try {
      const msgContainer = _pane('chat').querySelector('.mf-chat-messages');
      if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
    } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════════
  //  HISTORY TAB
  // ══════════════════════════════════════════════════════════════════

  function _refreshHistory() {
    const pane = _pane('history');
    pane.innerHTML = '';

    // Statistics section
    const statsSec = _el('div', 'mf-section');
    statsSec.appendChild(_el('div', 'mf-section-header', { text: 'Statistics' }));

    const stats = typeof SelfImprovement !== 'undefined' ? SelfImprovement.getStats() : {};
    const statsGrid = _el('div', 'mf-info-grid');
    const wr = stats.winRate != null ? (stats.winRate * 100).toFixed(1) + '%' : '---';
    const wrCls = stats.winRate >= 0.55 ? 'mf-val-green' : stats.winRate < 0.45 ? 'mf-val-red' : '';
    statsGrid.appendChild(_infoRow('Total Trades', stats.totalTrades || 0));
    statsGrid.appendChild(_infoRow('Wins', stats.wins || 0, 'mf-val-green'));
    statsGrid.appendChild(_infoRow('Losses', stats.losses || 0, 'mf-val-red'));
    statsGrid.appendChild(_infoRow('Win Rate', wr, wrCls));
    const tp = stats.totalProfit || 0;
    statsGrid.appendChild(_infoRow('Total Profit', (tp >= 0 ? '+' : '') + '$' + tp.toFixed(2), tp >= 0 ? 'mf-val-green' : 'mf-val-red'));
    if (stats.streak && stats.streak.type !== 'none') {
      const streakCls = stats.streak.type === 'win' ? 'mf-val-green' : 'mf-val-red';
      statsGrid.appendChild(_infoRow('Streak', stats.streak.count + ' ' + stats.streak.type + 's', streakCls));
    }
    if (stats.bestPair) {
      statsGrid.appendChild(_infoRow('Best Pair', stats.bestPair, 'mf-val-green'));
    }
    statsSec.appendChild(statsGrid);
    pane.appendChild(statsSec);

    // Trade history table
    const tableSec = _el('div', 'mf-section');
    tableSec.appendChild(_el('div', 'mf-section-header', { text: 'Trade History' }));

    const trades = (MF.state.tradeHistory || []).slice(-30).reverse();
    if (trades.length === 0) {
      tableSec.appendChild(_el('div', 'mf-empty', { text: 'No trades recorded yet.' }));
    } else {
      const table = _el('table', 'mf-history-table');
      const thead = _el('thead');
      const headerRow = _el('tr');
      ['Time', 'Pair', 'Dir', 'Invest', 'Result', 'Profit'].forEach(h => {
        headerRow.appendChild(_el('th', '', { text: h }));
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = _el('tbody');
      for (const t of trades) {
        const row = _el('tr', t.result === 'WIN' ? 'mf-row-win' : t.result === 'LOSS' ? 'mf-row-loss' : '');
        row.appendChild(_el('td', '', { text: _formatTime(t.timestamp) }));
        row.appendChild(_el('td', '', { text: t.pair || '---' }));
        const dirCls = t.direction === 'CALL' ? 'mf-val-green' : 'mf-val-red';
        row.appendChild(_el('td', dirCls, { text: t.direction || '---' }));
        row.appendChild(_el('td', '', { text: '$' + (t.investment || 0) }));
        row.appendChild(_el('td', t.result === 'WIN' ? 'mf-val-green' : 'mf-val-red', { text: t.result || '---' }));
        const profitCls = (t.profit || 0) >= 0 ? 'mf-val-green' : 'mf-val-red';
        const profitText = (t.profit >= 0 ? '+' : '') + '$' + (t.profit || 0).toFixed(2);
        row.appendChild(_el('td', profitCls, { text: profitText }));
        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      tableSec.appendChild(table);
    }
    pane.appendChild(tableSec);

    // Lessons section
    if (typeof SelfImprovement !== 'undefined') {
      const pair = MF.state.activePair;
      const lessons = pair ? SelfImprovement.getLessons(pair) : [];
      if (lessons.length) {
        const lessonSec = _el('div', 'mf-section');
        lessonSec.appendChild(_el('div', 'mf-section-header', { text: 'Lessons Learned' }));
        for (const l of lessons.slice(0, 5)) {
          lessonSec.appendChild(_el('div', 'mf-lesson-item', { text: l.text + ' (' + l.count + 'x)' }));
        }
        pane.appendChild(lessonSec);
      }
    }

    // Action buttons
    const btnRow = _el('div', 'mf-btn-row');
    const clearBtn = _el('button', 'mf-btn mf-btn-danger', { text: 'Clear History' });
    clearBtn.addEventListener('click', () => {
      if (confirm('Clear all trade history? This cannot be undone.')) {
        try { if (typeof Agent !== 'undefined') Agent.callTool('clear_history', {}); } catch (_) {}
      }
    });
    btnRow.appendChild(clearBtn);
    pane.appendChild(btnRow);
  }

  // ══════════════════════════════════════════════════════════════════
  //  UI HELPERS
  // ══════════════════════════════════════════════════════════════════

  function _infoRow(label, value, valCls) {
    const row = _el('div', 'mf-info-row');
    row.appendChild(_el('span', 'mf-info-label', { text: label }));
    row.appendChild(_el('span', 'mf-info-value ' + (valCls || ''), { text: String(value) }));
    return row;
  }

  function _buildToggle(checked, onChange) {
    const wrapper = _el('label', 'mf-toggle');
    const input   = _el('input', 'mf-toggle-input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', () => {
      try { onChange(input.checked); } catch (_) {}
    });
    const slider = _el('span', 'mf-toggle-slider');
    wrapper.appendChild(input);
    wrapper.appendChild(slider);
    return wrapper;
  }

  function _getLastPrice(pair) {
    try {
      const pd = MF.state.allPairs && MF.state.allPairs[pair];
      if (pd && pd.lastTick) {
        // Find latest tick from the tick stream
        const lastTick = _ticks[_ticks.length - 1];
        if (lastTick) return lastTick.price;
      }
    } catch (_) {}
    return null;
  }

  function _formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ══════════════════════════════════════════════════════════════════
  //  STATUS BAR UPDATES
  // ══════════════════════════════════════════════════════════════════

  function _updateStatusBar() {
    if (!_statusBar) return;
    try {
      const connEl = _statusBar.querySelector('.mf-status-conn');
      const pairEl = _statusBar.querySelector('.mf-status-pair');
      const timeEl = _statusBar.querySelector('.mf-status-time');

      if (connEl) {
        const connected = MF.state.wsConnected;
        connEl.textContent = 'WS: ' + (connected ? 'Connected' : 'Disconnected');
        connEl.className = 'mf-status-item mf-status-conn ' + (connected ? 'mf-val-green' : 'mf-val-red');
      }
      if (pairEl) {
        pairEl.textContent = 'Pair: ' + (MF.state.activePair || '---');
      }
      if (timeEl) {
        timeEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT BUS LISTENERS — REACTIVE UI UPDATES
  // ══════════════════════════════════════════════════════════════════

  function _bindEvents() {
    // ── Tick stream ────────────────────────────────────────────────
    MF.bus.on('ws:tick', (data) => {
      _ticks.push({ pair: data.pair, price: data.price, timestamp: data.timestamp });
      if (_ticks.length > TICK_DISPLAY_MAX) _ticks = _ticks.slice(-TICK_DISPLAY_MAX);
      if (_activeTab === 'scanner') _refreshScanner();
      _updateStatusBar();
    });

    MF.bus.on('price:update', (data) => {
      if (_activeTab === 'scanner') _refreshScanner();
      _updateStatusBar();
    });

    // ── WebSocket connection ───────────────────────────────────────
    MF.bus.on('ws:connected', () => {
      _updateStatusBar();
      if (_activeTab === 'scanner') _refreshScanner();
    });

    MF.bus.on('ws:disconnected', () => {
      _updateStatusBar();
      if (_activeTab === 'scanner') _refreshScanner();
    });

    // ── Pair changes ───────────────────────────────────────────────
    MF.bus.on('pair:active', () => {
      if (_activeTab === 'scanner' || _activeTab === 'autopilot') {
        _refreshTab(_activeTab);
      }
      _updateStatusBar();
    });

    MF.bus.on('pair:changed', () => {
      _ticks = []; // reset tick display on pair change
      _updateStatusBar();
    });

    MF.bus.on('pairs:discovered', () => {
      if (_activeTab === 'scanner') _refreshScanner();
    });

    // ── Agent signals ──────────────────────────────────────────────
    MF.bus.on('agent:signal', (signal) => {
      if (!MF.state.signals) MF.state.signals = [];
      MF.state.signals.push(signal);
      if (MF.state.signals.length > 20) MF.state.signals = MF.state.signals.slice(-20);
      if (_activeTab === 'analysis' || _activeTab === 'autopilot') {
        _refreshTab(_activeTab);
      }
    });

    // ── Trade events ───────────────────────────────────────────────
    MF.bus.on('agent:trade-placed', () => {
      if (_activeTab === 'autopilot') _refreshAutoPilot();
    });

    MF.bus.on('agent:trade-complete', () => {
      _refreshTab(_activeTab);
    });

    MF.bus.on('agent:trade-failed', () => {
      if (_activeTab === 'autopilot') _refreshAutoPilot();
    });

    MF.bus.on('agent:trade-error', () => {
      if (_activeTab === 'autopilot') _refreshAutoPilot();
    });

    // ── Auto-pilot ─────────────────────────────────────────────────
    MF.bus.on('agent:autopilot-start', () => {
      if (_activeTab === 'autopilot') _refreshAutoPilot();
    });

    MF.bus.on('agent:autopilot-stop', () => {
      if (_activeTab === 'autopilot') _refreshAutoPilot();
    });

    MF.bus.on('agent:martingale-reset', () => {
      if (_activeTab === 'autopilot') _refreshAutoPilot();
    });

    // ── Chat ───────────────────────────────────────────────────────
    MF.bus.on('chat:message', () => {
      if (_activeTab === 'chat') _updateChatMessages();
    });

    MF.bus.on('chat:cleared', () => {
      if (_activeTab === 'chat') _refreshChat();
    });

    // ── Config changes ─────────────────────────────────────────────
    MF.bus.on('config:change', (key) => {
      if (key === 'autoPilot' && _activeTab === 'autopilot') _refreshAutoPilot();
      if (key === 'martingaleEnabled' && _activeTab === 'autopilot') _refreshAutoPilot();
      if (key === 'overlayOpacity') {
        const opac = MF.getConfig('overlayOpacity');
        if (opac != null && _panel) _panel.style.opacity = opac;
      }
    });

    // ── Self-improvement ───────────────────────────────────────────
    MF.bus.on('improvement:trade-recorded', () => {
      if (_activeTab === 'history') _refreshHistory();
    });

    // ── Backtest ───────────────────────────────────────────────────
    MF.bus.on('agent:backtest-complete', () => {
      if (_activeTab === 'history') _refreshHistory();
    });

    // ── Candles updated ────────────────────────────────────────────
    MF.bus.on('ws:candle', () => {
      // Don't refresh on every candle; analysis tab picks it up on demand
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  CLOCK TICKER FOR STATUS BAR
  // ══════════════════════════════════════════════════════════════════

  let _clockTimer = null;

  function _startClock() {
    if (_clockTimer) return;
    _clockTimer = setInterval(() => {
      _updateStatusBar();
    }, 10000);
  }

  function _stopClock() {
    if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; }
  }

  // ══════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ══════════════════════════════════════════════════════════════════

  function init() {
    try {
      // Read saved state
      _activeTab = MF.getConfig('activeTab') || 'scanner';
      _minimized = MF.getConfig('overlayMinimized') || false;
      _visible   = MF.getConfig('overlayVisible') !== false;

      // Build the DOM
      _buildOverlay();

      // Apply visibility
      if (!_visible) {
        _panel.style.display = 'none';
        _minBtn.style.display = 'none';
      } else if (_minimized) {
        _panel.style.display = 'none';
        _minBtn.style.display = 'flex';
      } else {
        _panel.style.display = 'flex';
        _minBtn.style.display = 'none';
      }

      // Bind event bus listeners
      _bindEvents();

      // Initial content render
      _refreshTab(_activeTab);
      _updateStatusBar();

      // Start status bar clock
      _startClock();

      MF.log('info', 'UIOverlay: initialized');
      MF.bus.emit('ui-overlay:ready');
    } catch (e) {
      MF.log('error', 'UIOverlay: init error:', e.message);
    }
  }

  function destroy() {
    try {
      _stopClock();
      if (_panel && _panel.parentNode) _panel.parentNode.removeChild(_panel);
      if (_minBtn && _minBtn.parentNode) _minBtn.parentNode.removeChild(_minBtn);
      _panel = null;
      _minBtn = null;
    } catch (e) {
      MF.log('warn', 'UIOverlay: destroy error:', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════════

  return {
    init,
    destroy,
    show,
    toggle,
    /** Switch to a specific tab */
    switchTab(tab) { _switchTab(tab); },
    /** Refresh the currently active tab */
    refresh() { _refreshTab(_activeTab); },
    /** Get current active tab name */
    getActiveTab() { return _activeTab; },
    /** Check if overlay is visible */
    isVisible() { return _visible; },
    /** Check if overlay is minimized */
    isMinimized() { return _minimized; },
  };

})();
