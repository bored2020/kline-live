// 图表封装：初始化、样式、指标、数据、画线序列化
/* global klinecharts */
const UP = '#F04B4B';
const DOWN = '#1FBF75';
export const CANDLE_PANE = 'candle_pane';

// 自定义矩形框（标记区间）
klinecharts.registerOverlay({
  name: 'rectBox',
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates }) => {
    if (coordinates.length < 2) return [];
    const [a, b] = coordinates;
    const c = overlay.styles?.line?.color || '#f5c542';
    return [{
      type: 'polygon',
      attrs: { coordinates: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }] },
      styles: { style: 'stroke_fill', color: c + '22', borderColor: c, borderSize: 1 },
    }];
  },
});

const bar = (upColor, downColor) => ({
  style: 'fill', borderStyle: 'solid', borderSize: 1, borderDashedValue: [2, 2],
  upColor, downColor, noChangeColor: '#888888',
});

export const chart = klinecharts.init('chart', { locale: 'zh-CN', timezone: 'Asia/Shanghai', styles: 'dark' });
chart.setStyles({
  grid: { horizontal: { color: '#1e232d' }, vertical: { color: '#1e232d' } },
  candle: {
    bar: {
      upColor: UP, downColor: DOWN, upBorderColor: UP, downBorderColor: DOWN, upWickColor: UP, downWickColor: DOWN,
    },
    priceMark: { last: { upColor: UP, downColor: DOWN } },
    tooltip: { showRule: 'always' },
  },
  indicator: {
    bars: [bar(UP + 'B3', DOWN + 'B3')],
    ohlc: { upColor: UP + 'B3', downColor: DOWN + 'B3' },
  },
});
window.addEventListener('resize', () => chart.resize());

// ---------- 指标 ----------
let mainInd = null;
const subPanes = new Map(); // name -> paneId

export function setMainIndicator(name) {
  if (mainInd === name) return;
  if (mainInd) chart.removeIndicator(CANDLE_PANE, mainInd);
  mainInd = name || null;
  if (mainInd) chart.createIndicator(mainInd, true, { id: CANDLE_PANE });
}

export function setSubIndicators(names) {
  for (const [name, paneId] of subPanes) {
    if (!names.includes(name)) { chart.removeIndicator(paneId, name); subPanes.delete(name); }
  }
  for (const name of names) {
    if (!subPanes.has(name)) subPanes.set(name, chart.createIndicator(name, false, { id: `pane_${name}`, height: 110 }));
  }
}

// ---------- 数据 ----------
function decimals(v) {
  for (let d = 0; d <= 4; d++) if (Math.abs(v * 10 ** d - Math.round(v * 10 ** d)) < 1e-6) return d;
  return 4;
}

export function applyData(list, isStock) {
  let prec = 0;
  for (const k of list.slice(-80)) prec = Math.max(prec, decimals(k.open), decimals(k.close), decimals(k.high), decimals(k.low));
  chart.setPriceVolumePrecision(isStock ? Math.max(2, prec) : prec, 0);
  chart.applyNewData(list);
}

// 只追加/更新最新K线，避免整体重绘打断视图
export function mergeData(list) {
  const cur = chart.getDataList();
  if (!cur.length) return chart.applyNewData(list);
  const lastTs = cur[cur.length - 1].timestamp;
  for (const k of list) if (k.timestamp >= lastTs) chart.updateData(k);
}

// ---------- 画线序列化 ----------
// 超出数据范围的点（画在右侧空白处）记为：锚点K线时间 + 偏移根数 ext
export function serializePoints(points) {
  const list = chart.getDataList();
  const n = list.length;
  return points.map((p) => {
    const idx = typeof p.dataIndex === 'number' ? p.dataIndex : null;
    if (idx === null || !n) return { timestamp: p.timestamp, value: p.value };
    if (idx >= n) return { timestamp: list[n - 1].timestamp, value: p.value, ext: idx - (n - 1) };
    if (idx < 0) return { timestamp: list[0].timestamp, value: p.value, ext: idx };
    return { timestamp: list[idx].timestamp, value: p.value };
  });
}

function indexOfTs(list, ts) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].timestamp < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function deserializePoints(points) {
  const list = chart.getDataList();
  return points.map((p) => {
    if (!p.ext || !list.length) return { timestamp: p.timestamp, value: p.value };
    const idx = indexOfTs(list, p.timestamp) + p.ext;
    return idx >= 0 && idx < list.length
      ? { timestamp: list[idx].timestamp, value: p.value }
      : { dataIndex: idx, value: p.value };
  });
}

export function overlayStyles(color) {
  return {
    line: { color, size: 1.5 },
    point: { color, borderColor: color, activeColor: color, activeBorderColor: color + '66' },
    polygon: { color, borderColor: color },
    rect: { color: color + '22', borderColor: color },
    text: { color: '#111111', backgroundColor: color, borderColor: color },
  };
}
