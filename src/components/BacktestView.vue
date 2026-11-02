<template>
  <div class="bt-page">
    <section class="bt-hero">
      <div>
        <h2 class="bt-title">📊 4 日 OHLC 模型回测</h2>
        <p class="bt-subtitle">
          真实价格 · 默认剔除 T 日收盘涨停 · 预测/实际分别展示开高低收与涨跌幅
        </p>
      </div>
      <div class="bt-date-tabs">
        <button
          v-for="d in datasets"
          :key="d.date"
          :class="['bt-date-btn', { active: d.date === activeDate }]"
          @click="activeDate = d.date"
        >{{ d.label }}</button>
      </div>
    </section>

    <section class="bt-cards">
      <div class="bt-card">
        <div class="bt-card-label">可买入信号</div>
        <div class="bt-card-value">{{ stats.total }}</div>
        <div class="bt-card-sub">已剔除 T 日涨停</div>
      </div>
      <div class="bt-card">
        <div class="bt-card-label">有实际值</div>
        <div class="bt-card-value">{{ stats.available }}</div>
        <div class="bt-card-sub">T+1 实际已更新</div>
      </div>
      <div class="bt-card">
        <div class="bt-card-label">T+1 最高 MAE</div>
        <div class="bt-card-value" :class="stats.mae > 3 ? 'warn' : 'good'">{{ fmt(stats.mae, 2) }}%</div>
        <div class="bt-card-sub">|实际−预测| / 买入价</div>
      </div>
      <div class="bt-card">
        <div class="bt-card-label">高估比例</div>
        <div class="bt-card-value">{{ fmt(stats.overRate, 1) }}%</div>
        <div class="bt-card-sub">预测最高价 &gt; 实际</div>
      </div>
      <div class="bt-card">
        <div class="bt-card-label">平均预测 4 日最高</div>
        <div class="bt-card-value">{{ fmt(stats.avgPredMax, 2) }}%</div>
        <div class="bt-card-sub">相对买入价</div>
      </div>
    </section>

    <section class="bt-charts">
      <div class="bt-panel">
        <div class="bt-panel-head">
          <span class="bt-panel-title">个股最高 / 收盘路径</span>
          <select v-model="selectedCode" class="bt-select">
            <option v-for="r in dateRows" :key="r.code" :value="r.code">
              {{ r.code }} {{ r.market }} · 买 {{ fmt(r.buy, 2) }}
            </option>
          </select>
        </div>
        <div ref="pathRef" class="bt-chart"></div>
        <div class="bt-legend-note">
          <span class="dot blue"></span>预测
          <span class="dot green"></span>实际
          <span class="dot orange"></span>买入价
        </div>
      </div>

      <div class="bt-panel">
        <div class="bt-panel-head">
          <span class="bt-panel-title">T+1 最高：预测 vs 实际</span>
          <span class="bt-panel-meta">{{ stats.available }} 个点</span>
        </div>
        <div ref="scatterRef" class="bt-chart"></div>
        <div class="bt-legend-note">横轴：预测 T+1 最高涨幅(%)；纵轴：实际 T+1 最高涨幅(%)；对角线 = 完美预测，点在下方表示高估</div>
      </div>
    </section>

    <section class="bt-panel bt-table-panel">
      <div class="bt-panel-head">
        <span class="bt-panel-title">📋 明细（{{ filteredRows.length }} 条）</span>
        <div class="bt-filters">
          <input v-model="search" class="bt-input" placeholder="代码 / 市场" />
          <select v-model="market" class="bt-select">
            <option value="all">全部市场</option>
            <option v-for="m in markets" :key="m" :value="m">{{ m }}</option>
          </select>
          <select v-model.number="limit" class="bt-select">
            <option :value="30">30 条</option>
            <option :value="60">60 条</option>
            <option :value="120">120 条</option>
            <option :value="10000">全部</option>
          </select>
        </div>
      </div>
      <div class="bt-table-wrap">
        <table class="bt-table">
          <thead>
            <tr>
              <th>代码</th>
              <th>市场</th>
              <th>买入价</th>
              <th>T 日涨%</th>
              <th>T+1 最高预测</th>
              <th>T+1 最高实际</th>
              <th>误差%</th>
              <th>T+1 收盘预测</th>
              <th>T+1 收盘实际</th>
              <th>T+2 最高预测</th>
              <th>T+2 最高实际</th>
              <th>预测 4 日最高%</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in tableRows"
              :key="row.code"
              :class="{ selected: row.code === selectedCode }"
              @click="selectedCode = row.code"
            >
              <td class="code">{{ row.code }}</td>
              <td class="muted">{{ row.market }}</td>
              <td>{{ fmt(row.buy, 2) }}</td>
              <td :class="signClass(row.tRet)">{{ fmt(row.tRet, 2) }}</td>
              <td class="pred">{{ fmt(row.t1HighPred, 2) }}</td>
              <td class="actual">{{ fmt(row.t1HighActual, 2) }}</td>
              <td :class="errorClass(row.errHigh)">{{ fmt(row.errHigh, 2) }}</td>
              <td class="pred">{{ fmt(row.t1ClosePred, 2) }}</td>
              <td class="actual">{{ fmt(row.t1CloseActual, 2) }}</td>
              <td class="pred">{{ fmt(row.t2HighPred, 2) }}</td>
              <td class="actual">{{ fmt(row.t2HighActual, 2) }}</td>
              <td :class="signClass(row.predMax)">{{ fmt(row.predMax, 2) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="tableRows.length === 0" class="bt-empty">没有匹配的信号</div>
      </div>
      <div class="bt-table-footer">
        显示 {{ tableRows.length }} / {{ filteredRows.length }} 条；点击行切换上方个股图。
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';

// Vite 会把 src/assets/backtest/*.csv 以原始文本打包；新增日期只需放文件进来重新构建
const csvModules = import.meta.glob('../assets/backtest/backtest_4day_*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function parseCsv(text) {
  const clean = String(text).replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? '').trim();
    });
    return obj;
  });
}

function toNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateLabel(d) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function buildRow(raw) {
  const buy = toNum(raw.buy_close);
  const pick = (h, f, suffix) => toNum(raw[`T+${h}_${f}_${suffix}`]);
  const predHighs = [1, 2, 3, 4].map((h) => pick(h, 'high', 'pred'));
  const actualHighs = [1, 2, 3, 4].map((h) => pick(h, 'high', 'actual'));
  const predCloses = [1, 2, 3, 4].map((h) => pick(h, 'close', 'pred'));
  const actualCloses = [1, 2, 3, 4].map((h) => pick(h, 'close', 'actual'));
  const t1HighPred = pick(1, 'high', 'pred');
  const t1HighActual = pick(1, 'high', 'actual');
  return {
    code: String(raw.stock_code || '').padStart(6, '0'),
    market: raw.market || '',
    buy,
    tRet: toNum(raw.T_ret_pct),
    predMax: toNum(raw.pred_max_high_4d_ret_pct),
    t1HighPred,
    t1HighActual,
    t1HighPredPct: pick(1, 'high', 'pred') != null ? toNum(raw['T+1_high_pred_pct']) : null,
    t1HighActualPct: toNum(raw['T+1_high_actual_pct']),
    t1ClosePred: pick(1, 'close', 'pred'),
    t1CloseActual: pick(1, 'close', 'actual'),
    t2HighPred: pick(2, 'high', 'pred'),
    t2HighActual: pick(2, 'high', 'actual'),
    errHigh: t1HighActual != null && t1HighPred != null && buy
      ? ((t1HighActual - t1HighPred) / buy) * 100
      : null,
    predHighs,
    actualHighs,
    predCloses,
    actualCloses,
  };
}

const datasets = Object.entries(csvModules)
  .map(([path, text]) => {
    const m = path.match(/(\d{8})/);
    const date = m ? m[1] : path;
    return {
      date,
      label: dateLabel(date),
      rows: parseCsv(text).map(buildRow),
    };
  })
  .filter((d) => d.rows.length > 0)
  .sort((a, b) => b.date.localeCompare(a.date));

const initialDate = new URLSearchParams(window.location.search).get('date');
const activeDate = ref(
  datasets.some((d) => d.date === initialDate) ? initialDate : datasets[0]?.date || ''
);
watch(activeDate, (d) => {
  if (!d) return;
  const url = new URL(window.location.href);
  url.searchParams.set('date', d);
  history.replaceState(null, '', url);
});
const activeDataset = computed(() => datasets.find((d) => d.date === activeDate.value) || datasets[0]);
const dateRows = computed(() => activeDataset.value?.rows || []);

const selectedCode = ref('');
const search = ref('');
const market = ref('all');
const limit = ref(60);

const markets = computed(() => [...new Set(dateRows.value.map((r) => r.market))].sort());

watch(
  dateRows,
  (rows) => {
    if (!rows.some((r) => r.code === selectedCode.value)) {
      const top = [...rows].sort((a, b) => (b.predMax ?? -99) - (a.predMax ?? -99))[0];
      selectedCode.value = top?.code || '';
    }
  },
  { immediate: true }
);

const filteredRows = computed(() => {
  const q = search.value.trim().toLowerCase();
  return dateRows.value.filter((r) => {
    if (market.value !== 'all' && r.market !== market.value) return false;
    if (!q) return true;
    return r.code.toLowerCase().includes(q) || r.market.toLowerCase().includes(q);
  });
});

const tableRows = computed(() => {
  const sorted = [...filteredRows.value].sort((a, b) => (b.predMax ?? -99) - (a.predMax ?? -99));
  return sorted.slice(0, limit.value);
});

const selectedRow = computed(() => dateRows.value.find((r) => r.code === selectedCode.value));

const stats = computed(() => {
  const rows = dateRows.value;
  const withActual = rows.filter((r) => r.t1HighActual != null && r.t1HighPred != null && r.buy);
  const total = rows.length;
  const available = withActual.length;
  const mae = available
    ? withActual.reduce((s, r) => s + Math.abs(r.t1HighActual - r.t1HighPred) / r.buy * 100, 0) / available
    : 0;
  const over = available
    ? withActual.filter((r) => r.t1HighPred > r.t1HighActual).length / available * 100
    : 0;
  const avgPredMax = total
    ? rows.reduce((s, r) => s + (r.predMax ?? 0), 0) / total
    : 0;
  return { total, available, mae, overRate: over, avgPredMax };
});

function fmt(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(digits);
}

function signClass(v) {
  if (v == null) return 'muted';
  return v >= 0 ? 'up' : 'down';
}

function errorClass(v) {
  if (v == null) return 'muted';
  if (Math.abs(v) >= 3) return 'down';
  if (Math.abs(v) >= 1.5) return 'warn-text';
  return 'muted';
}

const pathRef = ref(null);
const scatterRef = ref(null);
let pathChart = null;
let scatterChart = null;

function renderPath() {
  if (!pathChart) return;
  const r = selectedRow.value;
  if (!r) {
    pathChart.clear();
    return;
  }
  pathChart.setOption({
    backgroundColor: 'transparent',
    animationDuration: 300,
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(22,27,34,0.95)',
      borderColor: '#30363d',
      textStyle: { color: '#e6edf3', fontSize: 12 },
    },
    legend: {
      data: ['预测最高', '实际最高', '预测收盘', '实际收盘'],
      top: 0,
      textStyle: { color: '#8b949e', fontSize: 11 },
    },
    grid: { left: 46, right: 62, top: 40, bottom: 30 },
    xAxis: {
      type: 'category',
      data: ['T+1', 'T+2', 'T+3', 'T+4'],
      axisLine: { lineStyle: { color: '#30363d' } },
      axisLabel: { color: '#8b949e' },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: '#8b949e' },
      splitLine: { lineStyle: { color: '#21262d' } },
    },
    series: [
      {
        name: '预测最高',
        type: 'line',
        data: r.predHighs,
        symbolSize: 7,
        connectNulls: false,
        lineStyle: { width: 2, color: '#58a6ff' },
        itemStyle: { color: '#58a6ff' },
      },
      {
        name: '实际最高',
        type: 'line',
        data: r.actualHighs,
        symbolSize: 7,
        connectNulls: false,
        lineStyle: { width: 2, color: '#3fb950' },
        itemStyle: { color: '#3fb950' },
      },
      {
        name: '预测收盘',
        type: 'line',
        data: r.predCloses,
        symbolSize: 5,
        connectNulls: false,
        lineStyle: { width: 1.5, type: 'dashed', color: '#a371f7' },
        itemStyle: { color: '#a371f7' },
      },
      {
        name: '实际收盘',
        type: 'line',
        data: r.actualCloses,
        symbolSize: 5,
        connectNulls: false,
        lineStyle: { width: 1.5, type: 'dashed', color: '#d29922' },
        itemStyle: { color: '#d29922' },
        markLine: r.buy != null
          ? {
              symbol: 'none',
              silent: true,
              data: [{ yAxis: r.buy }],
              lineStyle: { color: '#d29922', type: 'dotted', width: 1 },
              label: {
                color: '#8b949e',
                position: 'insideStartTop',
                formatter: `买入 ${r.buy.toFixed(2)}`,
              },
            }
          : undefined,
      },
    ],
  }, true);
}

function renderScatter() {
  if (!scatterChart) return;
  const pts = dateRows.value
    .filter((r) => r.t1HighPredPct != null && r.t1HighActualPct != null)
    .map((r) => [r.t1HighPredPct, r.t1HighActualPct, r.code]);
  if (!pts.length) {
    scatterChart.clear();
    return;
  }
  const vals = pts.flatMap((p) => [p[0], p[1]]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max(1, (hi - lo) * 0.1);
  scatterChart.setOption({
    backgroundColor: 'transparent',
    animationDuration: 300,
    tooltip: {
      backgroundColor: 'rgba(22,27,34,0.95)',
      borderColor: '#30363d',
      textStyle: { color: '#e6edf3', fontSize: 12 },
      formatter: (p) => `${p.data[2]}<br/>预测 ${p.data[0].toFixed(2)}%<br/>实际 ${p.data[1].toFixed(2)}%`,
    },
    grid: { left: 54, right: 28, top: 18, bottom: 28 },
    xAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: '#8b949e' },
      splitLine: { lineStyle: { color: '#21262d' } },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: '#8b949e' },
      splitLine: { lineStyle: { color: '#21262d' } },
    },
    series: [
      {
        type: 'line',
        data: [[lo, lo], [hi, hi]],
        symbol: 'none',
        silent: true,
        lineStyle: { color: '#8b949e', type: 'dashed', width: 1 },
        tooltip: { show: false },
      },
      {
        type: 'scatter',
        data: pts,
        symbolSize: 9,
        itemStyle: { color: '#58a6ff', opacity: 0.75 },
      },
    ],
  }, true);
}

function renderCharts() {
  renderPath();
  renderScatter();
}

function onResize() {
  pathChart?.resize();
  scatterChart?.resize();
}

onMounted(() => {
  pathChart = echarts.init(pathRef.value);
  scatterChart = echarts.init(scatterRef.value);
  window.addEventListener('resize', onResize);
  renderCharts();
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  pathChart?.dispose();
  scatterChart?.dispose();
});

watch([activeDate, selectedCode, dateRows], () => nextTick(renderCharts));
</script>

<style scoped>
.bt-page {
  padding: 20px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1600px;
  width: 100%;
  margin: 0 auto;
}

.bt-hero {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}

.bt-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.bt-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.bt-date-tabs {
  display: flex;
  gap: 8px;
}

.bt-date-btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 12px;
}

.bt-date-btn.active {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
  background: rgba(88, 166, 255, 0.08);
}

.bt-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}

.bt-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}

.bt-card-label {
  font-size: 12px;
  color: var(--text-muted);
}

.bt-card-value {
  margin-top: 4px;
  font-size: 22px;
  font-weight: 700;
  font-family: var(--font-mono);
  color: var(--text-primary);
}

.bt-card-value.good { color: var(--accent-green); }
.bt-card-value.warn { color: var(--accent-orange); }

.bt-card-sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted);
}

.bt-charts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.bt-panel {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.bt-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.bt-panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.bt-panel-meta {
  font-size: 11px;
  color: var(--text-muted);
}

.bt-chart {
  height: 320px;
  width: 100%;
}

.bt-legend-note {
  padding: 6px 14px 10px;
  font-size: 11px;
  color: var(--text-muted);
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 4px;
}
.dot.blue { background: #58a6ff; }
.dot.green { background: #3fb950; }
.dot.orange { background: #d29922; }

.bt-legacy-note { display: none; }

.bt-table-panel {
  display: flex;
  flex-direction: column;
}

.bt-filters {
  display: flex;
  gap: 8px;
  align-items: center;
}

.bt-input,
.bt-select {
  padding: 5px 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.bt-input { width: 130px; }

.bt-table-wrap {
  overflow: auto;
  max-height: 420px;
}

.bt-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}

.bt-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-secondary);
  color: var(--text-muted);
  font-weight: 500;
  text-align: right;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.bt-table th:first-child,
.bt-table th:nth-child(2) {
  text-align: left;
}

.bt-table td {
  padding: 7px 10px;
  border-bottom: 1px solid #21262d;
  text-align: right;
  color: var(--text-secondary);
}

.bt-table td:first-child,
.bt-table td:nth-child(2) {
  text-align: left;
}

.bt-table tbody tr {
  cursor: pointer;
}

.bt-table tbody tr:hover {
  background: rgba(88, 166, 255, 0.06);
}

.bt-table tbody tr.selected {
  background: rgba(88, 166, 255, 0.12);
}

.bt-table .code {
  font-family: var(--font-mono);
  color: var(--text-primary);
}

.bt-table .pred { color: #79c0ff; }
.bt-table .actual { color: #7ee787; }

.bt-table .up { color: var(--accent-red); }
.bt-table .down { color: var(--accent-green); }
.bt-table .warn-text { color: var(--accent-orange); }
.bt-table .muted { color: var(--text-muted); }

.bt-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
}

.bt-table-footer {
  padding: 8px 14px;
  font-size: 11px;
  color: var(--text-muted);
  border-top: 1px solid var(--border);
}

@media (max-width: 1100px) {
  .bt-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bt-charts { grid-template-columns: 1fr; }
}
</style>
