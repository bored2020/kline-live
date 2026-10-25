'use strict';
/**
 * K线直播分享服务
 * - /api/kline   代理新浪 A股 / 国内期货 K线
 * - /api/search  代码 / 名称搜索
 * - /ws          主播 -> 观众 实时同步（品种、周期、视图、画线、光标）
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || crypto.randomBytes(4).toString('hex');
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const SINA_HEADERS = { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' };
const STOCK_RE = /^(sh|sz|bj)\d{6}$/;
const FUTURE_RE = /^[a-z]{1,2}\d{0,4}$/;
const PERIODS = ['1m', '5m', '15m', '30m', '60m', '1d', '1w', '1M'];
const MAX_OVERLAYS_PER_SYMBOL = 500;

// ---------------- 行情数据 ----------------

function normalizeSymbol(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (STOCK_RE.test(s) || FUTURE_RE.test(s)) return s;
  return null;
}

function isStock(symbol) {
  return STOCK_RE.test(symbol);
}

// 新浪返回的时间均为北京时间
function toTs(str) {
  const iso = str.length <= 10 ? `${str}T00:00:00+08:00` : `${str.replace(' ', 'T')}+08:00`;
  return Date.parse(iso);
}

async function sinaGet(url, encoding = 'utf-8') {
  const res = await fetch(url, { headers: SINA_HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder(encoding).decode(buf);
}

// 解析 "var _x=([...]);" 形式的 JSONP
function parseJsonp(text) {
  const start = text.indexOf('([');
  const end = text.lastIndexOf('])');
  if (start < 0 || end < 0) return [];
  return JSON.parse(text.slice(start + 1, end + 1));
}

async function fetchStock(symbol, period) {
  const scale = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1d': 240, '1w': 1200, '1M': 7200 }[period];
  const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_x=/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=${scale}&ma=no&datalen=1023`;
  const rows = parseJsonp(await sinaGet(url));
  return rows.map((r) => ({
    timestamp: toTs(r.day),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close,
    volume: +r.volume, turnover: r.amount ? +r.amount : undefined,
  }));
}

async function fetchFuture(symbol, period) {
  const code = symbol.toUpperCase();
  const base = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_x=/InnerFuturesNewService';
  const url = period.endsWith('m')
    ? `${base}.getFewMinLine?symbol=${code}&type=${parseInt(period, 10)}`
    : `${base}.getDailyKLine?symbol=${code}`;
  let rows = parseJsonp(await sinaGet(url)).map((r) => ({
    timestamp: toTs(r.d),
    open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v,
  }));
  if (period === '1w' || period === '1M') rows = aggregate(rows, period);
  return rows.slice(-1500);
}

// 日线合成周线 / 月线
function aggregate(rows, period) {
  const out = [];
  let cur = null;
  let curKey = null;
  for (const r of rows) {
    const d = new Date(r.timestamp + 8 * 3600e3); // 按北京时间分组
    let key;
    if (period === '1M') {
      key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    } else {
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      key = monday.toISOString().slice(0, 10);
    }
    if (key !== curKey) {
      cur = { ...r };
      curKey = key;
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, r.high);
      cur.low = Math.min(cur.low, r.low);
      cur.close = r.close;
      cur.volume += r.volume;
    }
  }
  return out;
}

// 简单内存缓存，避免观众轮询打爆上游
const cache = new Map();
async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.promise;
  const promise = loader();
  cache.set(key, { time: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return promise;
}

function getKline(symbol, period) {
  const ttl = period.endsWith('m') ? 4000 : 15000;
  return cached(`k:${symbol}:${period}`, ttl, () =>
    isStock(symbol) ? fetchStock(symbol, period) : fetchFuture(symbol, period));
}

// suggest 类型：11 A股/指数，87 商品期货，88 金融期货
const SUGGEST_TYPES = { 11: '股票', 87: '期货', 88: '期货' };
async function search(q) {
  const text = await cached(`s:${q}`, 600000, () =>
    sinaGet(`https://suggest3.sinajs.cn/suggest/key=${encodeURIComponent(q)}`, 'gbk'));
  const m = text.match(/"(.*)"/);
  if (!m || !m[1]) return [];
  const seen = new Set();
  return m[1].split(';').map((item) => item.split(','))
    .filter((f) => SUGGEST_TYPES[f[1]] && normalizeSymbol(f[3]))
    .map((f) => ({ symbol: f[3].toLowerCase(), code: f[2].toUpperCase(), name: f[4], type: SUGGEST_TYPES[f[1]] }))
    .filter((r) => !seen.has(r.symbol) && seen.add(r.symbol))
    .slice(0, 12);
}

async function getName(symbol) {
  const code = isStock(symbol) ? symbol.slice(2) : symbol;
  try {
    const list = await search(code);
    return (list.find((r) => r.symbol === symbol) || {}).name || symbol.toUpperCase();
  } catch {
    return symbol.toUpperCase();
  }
}

// ---------------- 直播状态（持久化） ----------------

const store = loadStore();
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {
      state: { symbol: 'sh000001', period: '1d', note: '', main: 'MA', subs: ['VOL', 'MACD'] },
      overlays: {}, // "symbol:period" -> overlay[]
    };
  }
}
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(STORE_FILE, JSON.stringify(store), (err) => err && console.error('保存失败', err));
  }, 500);
}
let lastView = null;
const keyOf = (symbol, period) => `${symbol}:${period}`;
const curKey = () => keyOf(store.state.symbol, store.state.period);

// 只保留需要同步的字段，防止任意数据写入
function sanitizeOverlay(o) {
  if (!o || typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  if (o.id.length > 64 || o.name.length > 40 || !Array.isArray(o.points) || o.points.length > 10) return null;
  // ext: 超出K线范围的点，相对锚点K线的偏移根数
  const points = o.points.map((p) => {
    const pt = { timestamp: Number(p.timestamp), value: Number(p.value) };
    const ext = Number(p.ext);
    if (Number.isInteger(ext) && ext !== 0 && Math.abs(ext) < 5000) pt.ext = ext;
    return pt;
  }).filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
  const color = typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color : '#f5c542';
  const text = typeof o.text === 'string' ? o.text.slice(0, 100) : undefined;
  return { id: o.id, name: o.name, points, color, text };
}

// ---------------- HTTP ----------------

const app = express();
app.disable('x-powered-by');
app.use(compression());
// 页面文件走协商缓存；图表库带版本号，可长期缓存
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m' }));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/klinecharts/dist/umd'), { maxAge: '30d', immutable: true }));

app.get('/api/kline', async (req, res) => {
  const symbol = normalizeSymbol(req.query.symbol);
  const period = PERIODS.includes(req.query.period) ? req.query.period : null;
  if (!symbol || !period) return res.status(400).json({ error: '参数错误' });
  try {
    res.json({ symbol, period, data: await getKline(symbol, period) });
  } catch (e) {
    res.status(502).json({ error: '行情获取失败：' + e.message });
  }
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 20);
  if (!q) return res.json([]);
  try {
    res.json(await search(q));
  } catch {
    res.json([]);
  }
});

app.get('/api/name', async (req, res) => {
  const symbol = normalizeSymbol(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: '参数错误' });
  res.json({ symbol, name: await getName(symbol) });
});

app.get('/api/overlays', (req, res) => {
  const symbol = normalizeSymbol(req.query.symbol);
  const period = PERIODS.includes(req.query.period) ? req.query.period : null;
  res.json(symbol && period ? store.overlays[keyOf(symbol, period)] || [] : []);
});

// ---------------- WebSocket 同步 ----------------

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 64 * 1024,
  // 压缩较大的消息（画线列表等），小消息不压缩以节省 CPU
  perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 6 } },
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg, except) {
  const text = JSON.stringify(msg);
  for (const c of wss.clients) if (c !== except && c.readyState === c.OPEN) c.send(text);
}
function broadcastCount() {
  broadcast({ type: 'viewers', count: wss.clients.size });
}
function checkPassword(pw) {
  const a = crypto.createHash('sha256').update(String(pw || '')).digest();
  const b = crypto.createHash('sha256').update(HOST_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

wss.on('connection', (ws) => {
  ws.isHost = false;
  send(ws, {
    type: 'init',
    state: store.state,
    overlays: store.overlays[curKey()] || [],
    view: lastView,
  });
  broadcastCount();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'auth') {
      ws.isHost = checkPassword(msg.password);
      return send(ws, { type: 'auth', ok: ws.isHost });
    }
    if (!ws.isHost) return; // 以下操作仅限主播

    const st = store.state;
    switch (msg.type) {
      case 'state': {
        const symbol = normalizeSymbol(msg.symbol);
        if (symbol) st.symbol = symbol;
        if (PERIODS.includes(msg.period)) st.period = msg.period;
        if (typeof msg.note === 'string') st.note = msg.note.slice(0, 200);
        if (typeof msg.main === 'string') st.main = msg.main.slice(0, 10);
        if (Array.isArray(msg.subs)) st.subs = msg.subs.filter((s) => typeof s === 'string').slice(0, 4);
        if (typeof msg.name === 'string') st.name = msg.name.slice(0, 30);
        if (symbol || msg.period) { lastView = null; lastTickSig = ''; }
        saveStore();
        broadcast({ type: 'state', state: st, overlays: store.overlays[curKey()] || [] }, ws);
        break;
      }
      case 'overlay:upsert': {
        const o = sanitizeOverlay(msg.overlay);
        if (!o) return;
        const key = curKey();
        const list = (store.overlays[key] ||= []);
        const i = list.findIndex((x) => x.id === o.id);
        if (i >= 0) list[i] = o;
        else if (list.length < MAX_OVERLAYS_PER_SYMBOL) list.push(o);
        saveStore();
        broadcast({ type: 'overlay:upsert', key, overlay: o }, ws);
        break;
      }
      case 'overlay:remove': {
        const key = curKey();
        store.overlays[key] = (store.overlays[key] || []).filter((x) => x.id !== msg.id);
        saveStore();
        broadcast({ type: 'overlay:remove', key, id: String(msg.id) }, ws);
        break;
      }
      case 'overlay:clear': {
        const key = curKey();
        delete store.overlays[key];
        saveStore();
        broadcast({ type: 'overlay:clear', key }, ws);
        break;
      }
      case 'view': {
        // 右边界K线时间 + 超出根数 + 可见K线根数
        const right = Number(msg.rightTimestamp);
        const count = Number(msg.count);
        if (!Number.isFinite(right) || !Number.isFinite(count) || count <= 0) return;
        lastView = { rightTimestamp: right, ext: Math.trunc(Number(msg.ext)) || 0, count };
        broadcast({ type: 'view', view: lastView }, ws);
        break;
      }
      case 'cursor': {
        const ts = Number(msg.timestamp);
        const value = Number(msg.value);
        const ext = Math.trunc(Number(msg.ext)) || 0;
        broadcast({ type: 'cursor', timestamp: Number.isFinite(ts) ? ts : null, value: Number.isFinite(value) ? value : null, ext }, ws);
        break;
      }
    }
  });

  ws.on('close', broadcastCount);
});

// ---------------- 行情推送 ----------------
// 服务端统一轮询当前直播品种，只把最新几根K线推给所有人；观众不再各自轮询
let lastTickSig = '';
async function pollTick() {
  const { symbol, period } = store.state;
  try {
    if (wss.clients.size > 0) {
      const data = await getKline(symbol, period);
      const st = store.state;
      if (data.length && st.symbol === symbol && st.period === period) {
        const bars = data.slice(-2);
        const sig = JSON.stringify(bars);
        if (sig !== lastTickSig) {
          lastTickSig = sig;
          broadcast({ type: 'tick', key: keyOf(symbol, period), bars });
        }
      }
    }
  } catch { /* 上游异常，下次再试 */ }
  setTimeout(pollTick, period.endsWith('m') ? 3000 : 10000);
}
pollTick();

// 心跳，清理断线客户端
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000).unref();
wss.on('connection', (ws) => { ws.alive = true; ws.on('pong', () => { ws.alive = true; }); });

server.listen(PORT, () => {
  console.log(`K线直播间已启动: http://localhost:${PORT}`);
  console.log(`主播入口:        http://localhost:${PORT}/?host`);
  console.log(`主播密码:        ${HOST_PASSWORD}${process.env.HOST_PASSWORD ? '' : '  (随机生成，可用环境变量 HOST_PASSWORD 固定)'}`);
});
