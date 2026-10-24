<template>
  <div class="app">
    <header class="app-header">
      <h1 class="app-title">📈 TDX 通达信行情可视化</h1>
      <span class="app-version">v1.0</span>
    </header>
    <div class="app-body">
      <aside class="sidebar">
        <FileSelector
          :filePath="filePath"
          @select="onFileSelect"
          @error="onError"
        />
        <InfoPanel
          v-if="info"
          :info="info"
        />
      </aside>
      <main class="main-content">
        <div v-if="!filePath" class="placeholder">
          <div class="placeholder-icon">📁</div>
          <div class="placeholder-text">选择或拖入一个 .day / .lc1 / .lc5 文件开始分析</div>
        </div>
        <div v-if="loading" class="loading">解析中...</div>
        <div v-if="error" class="error-msg">{{ error }}</div>
        <template v-if="chartData && !loading">
          <SummaryCards :summary="summary" />
          <CandlestickChart :data="chartData" />
          <div class="indicator-bar">
            <button
              v-for="item in indicatorTabs"
              :key="item.key"
              :class="['indicator-tab', { active: visibleIndicators[item.key] }]"
              @click="toggleIndicator(item.key)"
            >{{ item.label }}</button>
          </div>
          <div class="indicator-stack">
            <MacdChart v-if="visibleIndicators.macd" :data="chartData" />
            <RsiChart v-if="visibleIndicators.rsi" :data="chartData" />
            <KdjChart v-if="visibleIndicators.kdj" :data="chartData" />
            <BollChart v-if="visibleIndicators.boll" :data="chartData" />
            <HjChart v-if="visibleIndicators.hj" :data="chartData" />
          </div>
          <DataTable :rows="allRows" />
        </template>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, watch, nextTick } from 'vue';
import { parseTdxFile, buildSummary, computeIndicators, filterRows } from './tdx-browser.js';
import { computeHJ } from './formulas/hj.js';
import { connectAll, reconnect } from './chartSync.js';
import FileSelector from './components/FileSelector.vue';
import InfoPanel from './components/InfoPanel.vue';
import SummaryCards from './components/SummaryCards.vue';
import CandlestickChart from './components/CandlestickChart.vue';
import MacdChart from './components/MacdChart.vue';
import RsiChart from './components/RsiChart.vue';
import KdjChart from './components/KdjChart.vue';
import BollChart from './components/BollChart.vue';
import HjChart from './components/HjChart.vue';
import DataTable from './components/DataTable.vue';

const filePath = ref('');
const chartData = ref(null);
const summary = ref(null);
const info = ref(null);
const allRows = ref([]);
const loading = ref(false);
const error = ref('');

const indicatorTabs = [
  { key: 'macd', label: 'MACD' },
  { key: 'rsi', label: 'RSI' },
  { key: 'kdj', label: 'KDJ' },
  { key: 'boll', label: 'BOLL' },
  { key: 'hj', label: 'HJ' },
];

const visibleIndicators = reactive({
  macd: false,
  rsi: false,
  kdj: false,
  boll: false,
  hj: true,
});

function toggleIndicator(key) {
  visibleIndicators[key] = !visibleIndicators[key];
  nextTick(() => reconnect());
}

watch(chartData, () => {
  if (chartData.value) nextTick(() => connectAll());
});

function processFile(name, arrayBuffer) {
  error.value = '';
  loading.value = true;
  chartData.value = null;
  summary.value = null;
  info.value = null;
  allRows.value = [];

  try {
    const loaded = parseTdxFile(name, arrayBuffer);
    const sum = buildSummary(loaded);
    const indicators = computeIndicators(loaded.rows);
    const hj = computeHJ(loaded.rows);

    console.log('=== HJ DEBUG ===');
    console.log('Total loaded rows:', loaded.rows.length);
    console.log('hj array length:', hj.length);

    const targetStart = 20261001;
    const targetEnd = 20261021;
    const matched = [];
    for (let i = 0; i < loaded.rows.length; i++) {
      const di = loaded.rows[i].dateInt;
      if (di >= targetStart && di <= targetEnd) {
        matched.push({
          date: loaded.rows[i].date,
          hj10: hj[i]?.hj10,
          hj11: hj[i]?.hj11,
        });
      }
    }
    console.log('2026-10-01 ~ 2026-10-21 data:');
    console.table(matched);

    const sampleStart = Math.max(0, loaded.rows.length - 50);
    console.log('Last 50 rows sample (hj10/hj11):');
    for (let i = sampleStart; i < loaded.rows.length; i++) {
      console.log(`  [${i}] ${loaded.rows[i].date}  hj10=${hj[i]?.hj10}  hj11=${hj[i]?.hj11}`);
    }

    const lastN = Math.min(loaded.rows.length, 200);
    const displayRows = loaded.rows.slice(-lastN);

    const combined = displayRows.map((row) => {
      const idx = loaded.rows.indexOf(row);
      return {
        date: row.date, dateInt: row.dateInt, time: row.time,
        open: row.open, high: row.high, low: row.low, close: row.close,
        volume: row.volume, amount: row.amount, changePct: row.changePct,
        ma5: indicators.ma[5][idx], ma10: indicators.ma[10][idx],
        ma20: indicators.ma[20][idx], ma60: indicators.ma[60][idx],
        ma120: indicators.ma[120][idx], ma250: indicators.ma[250][idx],
        dif: indicators.macd.dif[idx], dea: indicators.macd.dea[idx],
        macd: indicators.macd.histogram[idx],
        rsi14: indicators.rsi14[idx],
        k: indicators.kdj.k[idx], d: indicators.kdj.d[idx], j: indicators.kdj.j[idx],
        bollUpper: indicators.boll.upper[idx],
        bollMiddle: indicators.boll.middle[idx],
        bollLower: indicators.boll.lower[idx],
        atr14: indicators.atr14[idx],
        hj10: hj[idx]?.hj10 ?? null,
        hj11: hj[idx]?.hj11 ?? null,
        hj5: hj[idx]?.hj5 ?? 0,
        accelLabel: hj[idx]?.accelLabel ?? null,
      };
    });

    chartData.value = {
      instrument: loaded.instrument,
      format: loaded.format,
      count: combined.length,
      total: loaded.rows.length,
      rows: combined,
    };
    summary.value = sum;
    allRows.value = loaded.rows;
    info.value = {
      path: name,
      instrument: loaded.instrument,
      format: loaded.format,
      count: loaded.count,
      range: loaded.rows.length > 0
        ? { start: loaded.rows[0].date, end: loaded.rows[loaded.rows.length - 1].date }
        : null,
    };
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function onFileSelect({ name, arrayBuffer }) {
  filePath.value = name;
  processFile(name, arrayBuffer);
}

function onError(msg) {
  error.value = msg;
}
</script>

<style>
:root {
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --bg-card: #1c2128;
  --border: #30363d;
  --text-primary: #e6edf3;
  --text-secondary: #8b949e;
  --text-muted: #6e7681;
  --accent-green: #3fb950;
  --accent-red: #f85149;
  --accent-blue: #58a6ff;
  --accent-orange: #d29922;
  --accent-purple: #a371f7;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
}

.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

.app-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.app-version {
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.sidebar {
  width: 320px;
  min-width: 320px;
  padding: 16px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.main-content {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  gap: 16px;
}

.placeholder-icon {
  font-size: 48px;
  opacity: 0.4;
}

.placeholder-text {
  color: var(--text-muted);
  font-size: 15px;
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60px;
  color: var(--text-secondary);
  font-size: 16px;
}

.error-msg {
  padding: 16px;
  background: rgba(248, 81, 73, 0.1);
  border: 1px solid var(--accent-red);
  border-radius: 8px;
  color: var(--accent-red);
  font-size: 14px;
}

.indicator-bar {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--bg-secondary);
  border-radius: 8px;
  flex-wrap: wrap;
}

.indicator-tab {
  padding: 6px 16px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  font-family: var(--font-mono);
  cursor: pointer;
  transition: all 0.15s;
}

.indicator-tab:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.indicator-tab.active {
  color: var(--text-primary);
  background: var(--accent-blue);
}

.indicator-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>