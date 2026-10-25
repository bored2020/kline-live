import {
  chart, CANDLE_PANE, setMainIndicator, setSubIndicators, applyData, mergeData,
  serializePoints, deserializePoints, overlayStyles,
} from './chart.js';
import { createSync, throttle } from './sync.js';

const $ = (id) => document.getElementById(id);
const PERIODS = [['1m', '1分'], ['5m', '5分'], ['15m', '15分'], ['30m', '30分'], ['60m', '60分'], ['1d', '日K'], ['1w', '周K'], ['1M', '月K']];
const SUB_INDS = ['VOL', 'MACD', 'KDJ', 'RSI'];
const TOOLS = [
  ['segment', '线段'], ['straightLine', '直线'], ['rayLine', '射线'],
  ['horizontalStraightLine', '水平线'], ['horizontalRayLine', '水平射线'], ['verticalStraightLine', '垂直线'],
  ['priceLine', '价格线'], ['parallelStraightLine', '平行线'], ['priceChannelLine', '通道'],
  ['fibonacciLine', '斐波那契'], ['rectBox', '矩形'], ['simpleAnnotation', '文字'],
];
const wantHost = new URLSearchParams(location.search).has('host');
const isStock = (s) => /^(sh|sz|bj)\d{6}$/.test(s);

let isHost = false;
let state = { symbol: '', period: '', main: '', subs: [], note: '', name: '' };
let loadedKey = '';
let loadToken = 0;
let hostView = null;
let follow = true;
let applyingView = false;
let silentRemove = false;
let selectedId = null;
let drawColor = '#f5c542';
let magnet = false;
let drawingId = null; // 正在绘制中的画线
const overlays = new Map(); // id -> 序列化数据（与服务端一致）
const undoStack = [];

const sync = createSync(onMessage, () => {
  const pw = sessionStorage.getItem('hostPassword');
  if (wantHost && pw) sync.send({ type: 'auth', password: pw });
});

// ================= 消息处理 =================
function onMessage(msg) {
  switch (msg.type) {
    case 'init':
      // 首次连接或断线重连：强制重新拉取，补齐断线期间漏掉的K线
      loadedKey = '';
      hostView = msg.view;
      applyState(msg.state, msg.overlays);
      break;
    case 'state':
      if (!isHost) applyState(msg.state, msg.overlays);
      break;
    case 'auth':
      onAuth(msg.ok);
      break;
    case 'viewers':
      $('viewerCount').textContent = msg.count;
      break;
    case 'overlay:upsert':
      if (msg.key === curKey()) { overlays.set(msg.overlay.id, msg.overlay); drawOverlay(msg.overlay); }
      break;
    case 'overlay:remove':
      if (msg.key === curKey()) { overlays.delete(msg.id); withSilent(() => chart.removeOverlay(msg.id)); }
      break;
    case 'overlay:clear':
      if (msg.key === curKey()) clearOverlaysLocal();
      break;
    case 'view':
      hostView = msg.view;
      applyView();
      break;
    case 'tick':
      onTick(msg);
      break;
    case 'cursor':
      showHostCursor(msg);
      break;
  }
}

const curKey = () => `${state.symbol}:${state.period}`;

function applyState(next, overlayList) {
  const prevKey = curKey();
  state = { ...state, ...next };
  renderControls();
  setMainIndicator(state.main);
  setSubIndicators(state.subs);
  if (curKey() !== prevKey || curKey() !== loadedKey) {
    loadChart(overlayList);
  } else if (overlayList) {
    resetOverlays(overlayList);
  }
}

// 主播修改状态：本地生效 + 广播
function pushState(partial) {
  const prevKey = curKey();
  state = { ...state, ...partial };
  sync.send({ type: 'state', ...partial });
  renderControls();
  setMainIndicator(state.main);
  setSubIndicators(state.subs);
  if (curKey() !== prevKey) loadChart();
}

// ================= 行情 =================
async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

async function loadChart(overlayList) {
  const token = ++loadToken;
  const { symbol, period } = state;
  $('loading').hidden = false;
  clearOverlaysLocal();
  try {
    const [k, ov] = await Promise.all([
      fetchJson(`/api/kline?symbol=${symbol}&period=${period}`),
      overlayList ? Promise.resolve(overlayList) : fetchJson(`/api/overlays?symbol=${symbol}&period=${period}`),
    ]);
    if (token !== loadToken) return;
    if (!k.data.length) toast('暂无数据，请检查代码或周期');
    applyData(k.data, isStock(symbol));
    loadedKey = `${symbol}:${period}`;
    resetOverlays(ov);
    if (isHost) emitView(); else applyView();
    loadPrevClose(period === '1d' ? k.data : null);
  } catch (e) {
    if (token === loadToken) toast('加载失败：' + e.message);
  } finally {
    if (token === loadToken) $('loading').hidden = true;
  }
  if (!state.name && token === loadToken) {
    fetchJson(`/api/name?symbol=${symbol}`).then((r) => { if (r.symbol === state.symbol) { state.name = r.name; renderSymbol(); } }).catch(() => {});
  }
}

// 昨收价：只在切换品种时取一次日线，之后用推送的最新价计算涨跌
let prevClose = null;
async function loadPrevClose(daily) {
  const symbol = state.symbol;
  prevClose = null;
  try {
    const list = daily || (await fetchJson(`/api/kline?symbol=${symbol}&period=1d`)).data;
    if (symbol !== state.symbol || list.length < 2) return;
    prevClose = list[list.length - 2].close;
    renderQuote();
  } catch { /* 报价失败不影响图表 */ }
}

function renderQuote() {
  const list = chart.getDataList();
  if (!list.length || prevClose === null) return;
  const last = list[list.length - 1].close;
  const diff = last - prevClose;
  const pct = prevClose ? (diff / prevClose) * 100 : 0;
  const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'muted';
  const prec = chart.getPriceVolumePrecision().price;
  const sign = diff >= 0 ? '+' : '';
  $('lastPrice').textContent = last.toFixed(prec);
  $('lastPrice').className = cls;
  $('lastChange').textContent = `${sign}${diff.toFixed(prec)}  ${sign}${pct.toFixed(2)}%`;
  $('lastChange').className = cls;
}

// 服务端推送的最新K线（只含最后几根）
function onTick(msg) {
  if (msg.key !== curKey() || loadedKey !== curKey()) return;
  mergeData(msg.bars);
  renderQuote();
}

// ================= 画线 =================
const genId = () => 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function withSilent(fn) {
  silentRemove = true;
  try { fn(); } finally { silentRemove = false; }
}

function clearOverlaysLocal() {
  overlays.clear();
  undoStack.length = 0;
  selectedId = null;
  withSilent(() => chart.removeOverlay());
}

function resetOverlays(list) {
  clearOverlaysLocal();
  for (const o of list || []) { overlays.set(o.id, o); drawOverlay(o); }
}

function serialize(overlay) {
  const prev = overlays.get(overlay.id);
  return {
    id: overlay.id,
    name: overlay.name,
    points: serializePoints(overlay.points),
    color: prev?.color || overlay.extendData?.color || drawColor,
    text: prev?.text ?? (typeof overlay.extendData === 'string' ? overlay.extendData : undefined),
  };
}

function persist(overlay) {
  const data = serialize(overlay);
  overlays.set(data.id, data);
  sync.send({ type: 'overlay:upsert', overlay: data });
}

// 所有画线共用的事件回调
function overlayEvents() {
  return {
    onPressedMoveEnd: (e) => { if (isHost) persist(e.overlay); return false; },
    onRemoved: (e) => {
      if (silentRemove || !isHost) return false;
      overlays.delete(e.overlay.id);
      sync.send({ type: 'overlay:remove', id: e.overlay.id });
      return false;
    },
    onSelected: (e) => { selectedId = e.overlay.id; return false; },
    onDeselected: (e) => { if (selectedId === e.overlay.id) selectedId = null; return false; },
    // 观众右键不删除；主播右键删除
    onRightClick: () => !isHost,
  };
}

function drawOverlay(o) {
  withSilent(() => chart.removeOverlay(o.id));
  chart.createOverlay({
    name: o.name,
    id: o.id,
    points: deserializePoints(o.points),
    extendData: o.name === 'simpleAnnotation' ? (o.text || '') : { color: o.color },
    styles: overlayStyles(o.color),
    lock: !isHost,
    ...overlayEvents(),
  }, CANDLE_PANE);
}

function startDraw(name) {
  if (!isHost) return;
  let text;
  if (name === 'simpleAnnotation') {
    text = prompt('输入标注文字', '');
    if (!text) return;
    text = text.slice(0, 100);
  }
  cancelDrawing();
  const id = genId();
  const color = drawColor;
  drawingId = id;
  chart.createOverlay({
    name,
    id,
    extendData: name === 'simpleAnnotation' ? text : { color },
    styles: overlayStyles(color),
    mode: magnet ? 'weak_magnet' : 'normal',
    ...overlayEvents(),
    onDrawEnd: (e) => {
      const data = serialize(e.overlay);
      data.color = color;
      if (text) data.text = text;
      drawingId = null;
      overlays.set(id, data);
      undoStack.push(id);
      sync.send({ type: 'overlay:upsert', overlay: data });
      setActiveTool(null);
      return false;
    },
  }, CANDLE_PANE);
  setActiveTool(name);
}

function removeOverlayById(id) {
  if (id && overlays.has(id)) chart.removeOverlay(id); // onRemoved 负责同步
}

function undo() {
  while (undoStack.length) {
    const id = undoStack.pop();
    if (overlays.has(id)) return removeOverlayById(id);
  }
  toast('没有可撤销的画线');
}

function clearAll() {
  if (!overlays.size || !confirm('清除当前品种和周期的所有画线？')) return;
  clearOverlaysLocal();
  sync.send({ type: 'overlay:clear' });
}

// ================= 视图同步 =================
function mainWidth() {
  return chart.getSize(CANDLE_PANE, 'main')?.width || 0;
}

// 主播：广播可见区间（右边界 + 可见根数），观众按自身宽度换算
const emitView = throttle(() => {
  if (!isHost || loadedKey !== curKey()) return;
  const list = chart.getDataList();
  if (!list.length) return;
  const width = mainWidth();
  const [edge] = chart.convertFromPixel([{ x: width - 1 }], { paneId: CANDLE_PANE });
  const [p] = serializePoints([{ dataIndex: edge.dataIndex }]);
  sync.send({ type: 'view', rightTimestamp: p.timestamp, ext: p.ext || 0, count: width / chart.getBarSpace() });
}, 150);

function applyView() {
  if (isHost || !follow || !hostView || loadedKey !== curKey()) return;
  const list = chart.getDataList();
  const width = mainWidth();
  if (!list.length || !width) return;
  applyingView = true;
  try {
    if (hostView.count > 0) chart.setBarSpace(Math.min(50, Math.max(1, width / hostView.count)));
    const [p] = deserializePoints([{ timestamp: hostView.rightTimestamp, value: 0, ext: hostView.ext }]);
    const idx = p.dataIndex ?? list.findIndex((k) => k.timestamp >= p.timestamp);
    const bs = chart.getBarSpace();
    if (idx >= list.length) {
      chart.scrollToDataIndex(list.length - 1);
      chart.scrollByDistance(-(idx - list.length + 1) * bs);
    } else {
      chart.scrollToDataIndex(Math.max(0, idx));
    }
  } finally {
    applyingView = false;
  }
  repositionCursor();
}

function onUserMoveView() {
  if (isHost) return emitView();
  if (applyingView || !hostView) return;
  if (follow) { follow = false; $('followBtn').hidden = false; }
}
chart.subscribeAction('onVisibleRangeChange', () => { if (isHost) emitView(); });
chart.subscribeAction('onScroll', onUserMoveView);
chart.subscribeAction('onZoom', onUserMoveView);
window.addEventListener('resize', () => setTimeout(() => (isHost ? emitView() : applyView()), 50));

// ================= 主播光标 =================
let lastCursor = null;
const emitCursor = throttle((c) => sync.send({ type: 'cursor', ...c }), 60);
chart.subscribeAction('onCrosshairChange', (c) => {
  if (!isHost) return;
  if (c.paneId !== CANDLE_PANE || typeof c.x !== 'number') return emitCursor({ timestamp: null, value: null });
  const [pt] = chart.convertFromPixel([{ x: c.x, y: c.y }], { paneId: CANDLE_PANE });
  const [s] = serializePoints([pt]);
  emitCursor({ timestamp: s.timestamp, value: s.value, ext: s.ext || 0 });
});

function showHostCursor(c) {
  lastCursor = c.timestamp == null ? null : c;
  repositionCursor();
}

function repositionCursor() {
  const el = $('hostCursor');
  if (!lastCursor || isHost) { el.hidden = true; return; }
  const [p] = deserializePoints([{ timestamp: lastCursor.timestamp, value: lastCursor.value, ext: lastCursor.ext }]);
  const pos = chart.convertToPixel(p, { paneId: CANDLE_PANE, absolute: true });
  const h = chart.getSize(CANDLE_PANE, 'main')?.height || 0;
  const w = mainWidth();
  const visible = Number.isFinite(pos.x) && Number.isFinite(pos.y) && pos.x >= 0 && pos.x <= w && pos.y >= 0 && pos.y <= h;
  el.hidden = !visible;
  if (visible) { el.style.left = pos.x + 'px'; el.style.top = pos.y + 'px'; }
}
chart.subscribeAction('onVisibleRangeChange', () => { if (!isHost) requestAnimationFrame(repositionCursor); });

// ================= 界面 =================
function renderSymbol() {
  const code = isStock(state.symbol) ? state.symbol.slice(2) : state.symbol.toUpperCase();
  $('symName').textContent = state.name || code;
  $('symCode').textContent = code;
  document.title = `${state.name || code} · K线直播间`;
}

function renderControls() {
  renderSymbol();
  for (const btn of $('periods').children) btn.setAttribute('aria-pressed', btn.dataset.v === state.period);
  for (const btn of $('subInds').children) btn.setAttribute('aria-pressed', state.subs.includes(btn.dataset.v));
  $('mainInd').value = state.main || '';
  $('mainInd').disabled = !isHost;
  $('noteBar').hidden = !state.note;
  $('noteText').textContent = state.note || '';
  if (isHost && document.activeElement !== $('noteInput')) $('noteInput').value = state.note || '';
}

function makeButton(label, onClick, attrs = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.onclick = onClick;
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  return b;
}

function buildControls() {
  for (const [v, label] of PERIODS) {
    $('periods').append(makeButton(label, () => isHost && pushState({ period: v }), { 'data-v': v }));
  }
  for (const v of SUB_INDS) {
    $('subInds').append(makeButton(v, () => {
      if (!isHost) return;
      const subs = state.subs.includes(v) ? state.subs.filter((s) => s !== v) : [...state.subs, v];
      pushState({ subs: SUB_INDS.filter((s) => subs.includes(s)) });
    }, { 'data-v': v }));
  }
  $('mainInd').onchange = (e) => isHost && pushState({ main: e.target.value });
  const tb = $('toolbar');
  for (const [name, label] of TOOLS) {
    tb.append(makeButton(label, () => startDraw(name), { 'data-tool': name, 'aria-pressed': 'false' }));
  }
  tb.append(document.createElement('hr'));

  const color = document.createElement('input');
  color.type = 'color';
  color.value = drawColor;
  color.title = '画线颜色';
  color.setAttribute('aria-label', '画线颜色');
  color.oninput = () => { drawColor = color.value; };
  tb.append(color);

  const mag = makeButton('磁吸', () => {
    magnet = !magnet;
    mag.setAttribute('aria-pressed', magnet);
  }, { title: '画线时吸附到K线高低点', 'aria-pressed': 'false' });
  tb.append(mag);
  tb.append(makeButton('撤销', undo, { title: 'Ctrl+Z' }));
  tb.append(makeButton('删除选中', () => removeOverlayById(selectedId), { title: 'Delete 键；也可右键画线删除' }));
  tb.append(makeButton('清空', clearAll, { title: '清空当前品种和周期的画线', class: 'danger' }));

  $('noteInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      pushState({ note: e.target.value.trim() });
      toast('观点已推送');
    }
  });
  $('followBtn').onclick = () => {
    follow = true;
    $('followBtn').hidden = true;
    applyView();
  };

  document.addEventListener('keydown', (e) => {
    if (!isHost || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) removeOverlayById(selectedId);
    if (e.key === 'Escape') cancelDrawing();
  });
}

// 取消尚未画完的线：未完成的画线不在 overlays 中
function cancelDrawing() {
  if (!drawingId) return;
  withSilent(() => chart.removeOverlay(drawingId));
  drawingId = null;
  setActiveTool(null);
}

function setActiveTool(name) {
  for (const b of document.querySelectorAll('#toolbar [data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === name);
}
// ---------- 搜索 ----------
function setupSearch() {
  const input = $('searchInput');
  const ul = $('searchResult');
  let items = [];
  let active = -1;
  let timer = null;

  const render = () => {
    ul.innerHTML = '';
    items.forEach((r, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === active);
      const left = document.createElement('span');
      left.textContent = `${r.name}  ${r.code}`;
      const right = document.createElement('span');
      right.className = 'muted';
      right.textContent = r.type;
      li.append(left, right);
      li.onmousedown = (e) => { e.preventDefault(); choose(r); };
      ul.append(li);
    });
    ul.hidden = !items.length;
  };
  const choose = (r) => {
    input.value = '';
    items = [];
    render();
    input.blur();
    pushState({ symbol: r.symbol, name: r.name });
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { items = []; render(); return; }
    timer = setTimeout(async () => {
      try { items = await fetchJson(`/api/search?q=${encodeURIComponent(q)}`); } catch { items = []; }
      active = items.length ? 0 : -1;
      render();
    }, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'Enter' && items[active]) {
      choose(items[active]);
    } else if (e.key === 'Escape') {
      items = [];
      render();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { ul.hidden = true; }, 100));
  input.addEventListener('focus', () => { ul.hidden = !items.length; });
}
// ---------- 主播登录 ----------
function setupAuth() {
  if (!wantHost) return;
  const dlg = $('authDialog');
  if (!sessionStorage.getItem('hostPassword')) dlg.showModal();
  $('authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = $('pwdInput').value;
    sessionStorage.setItem('hostPassword', pw);
    sync.send({ type: 'auth', password: pw });
  });
  $('authCancel').onclick = () => dlg.close();
}

function onAuth(ok) {
  const dlg = $('authDialog');
  if (!ok) {
    sessionStorage.removeItem('hostPassword');
    if (wantHost) {
      $('authError').hidden = false;
      if (!dlg.open) dlg.showModal();
    }
    return;
  }
  const first = !isHost;
  isHost = true;
  if (dlg.open) dlg.close();
  document.body.classList.add('is-host');
  $('roleBadge').textContent = '主播';
  $('followBtn').hidden = true;
  $('hostCursor').hidden = true;
  renderControls();
  if (first) {
    toast('已进入主播模式');
    for (const o of overlays.values()) drawOverlay(o); // 解锁画线
    setTimeout(() => { chart.resize(); emitView(); }, 0);
  }
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

buildControls();
setupSearch();
setupAuth();
