<template>
  <div class="chart-panel">
    <div class="chart-header">
      <span class="chart-title">🕯️ K线图</span>
      <span class="chart-info">{{ data.instrument?.market }}{{ data.instrument?.code }} · {{ data.format?.label }} · {{ data.count }}条</span>
    </div>
    <div ref="chartRef" class="chart-body"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import * as echarts from 'echarts';
import { register, unregister } from '../chartSync.js';

const props = defineProps({ data: Object });
const chartRef = ref(null);
let chart = null;
let resizeHandler = null;

function buildOption() {
  const d = props.data;
  if (!d || !d.rows || d.rows.length === 0) return null;

  const dates = d.rows.map((r) => r.date);
  const ohlc = d.rows.map((r) => [r.open, r.close, r.low, r.high]);
  const volumes = d.rows.map((r) => r.volume);
  const ma5 = d.rows.map((r) => r.ma5);
  const ma10 = d.rows.map((r) => r.ma10);
  const ma20 = d.rows.map((r) => r.ma20);
  const ma60 = d.rows.map((r) => r.ma60);

  const upColor = '#26a69a';
  const downColor = '#ef5350';

  return {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', crossStyle: { color: '#58a6ff', type: 'dashed', width: 1 } },
      backgroundColor: 'rgba(22,27,34,0.95)',
      borderColor: '#30363d',
      textStyle: { color: '#e6edf3', fontSize: 12 },
    },
    legend: {
      data: ['K线', 'MA5', 'MA10', 'MA20', 'MA60', '成交量'],
      top: 0,
      textStyle: { color: '#8b949e', fontSize: 11 },
    },
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
    },
    grid: [
      { left: '8%', right: '5%', top: '10%', height: '55%' },
      { left: '8%', right: '5%', top: '72%', height: '18%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        boundaryGap: true,
        axisLine: { onZero: false, lineStyle: { color: '#30363d' } },
        axisLabel: { color: '#8b949e', fontSize: 10, rotate: 0 },
        axisTick: { show: false },
        splitLine: { show: false },
        min: 'dataMin',
        max: 'dataMax',
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        boundaryGap: true,
        axisLine: { onZero: false, lineStyle: { color: '#30363d' } },
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        min: 'dataMin',
        max: 'dataMax',
      },
    ],
    yAxis: [
      {
        scale: true,
        splitArea: { show: false },
        axisLine: { lineStyle: { color: '#30363d' } },
        axisLabel: { color: '#8b949e', fontSize: 10 },
        splitLine: { lineStyle: { color: '#21262d' } },
      },
      {
        scale: true,
        gridIndex: 1,
        splitArea: { show: false },
        axisLine: { lineStyle: { color: '#30363d' } },
        axisLabel: { color: '#8b949e', fontSize: 10 },
        splitLine: { lineStyle: { color: '#21262d' } },
      },
    ],
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: [0, 1],
        start: 0,
        end: 100,
      },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        data: ohlc,
        itemStyle: {
          color: upColor,
          color0: downColor,
          borderColor: upColor,
          borderColor0: downColor,
        },
      },
      {
        name: 'MA5',
        type: 'line',
        data: ma5,
        smooth: true,
        lineStyle: { width: 1, color: '#f5a623' },
        symbol: 'none',
      },
      {
        name: 'MA10',
        type: 'line',
        data: ma10,
        smooth: true,
        lineStyle: { width: 1, color: '#7b68ee' },
        symbol: 'none',
      },
      {
        name: 'MA20',
        type: 'line',
        data: ma20,
        smooth: true,
        lineStyle: { width: 1, color: '#ff6b9d' },
        symbol: 'none',
      },
      {
        name: 'MA60',
        type: 'line',
        data: ma60,
        smooth: true,
        lineStyle: { width: 1, color: '#20b2aa' },
        symbol: 'none',
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes.map((v, i) => {
          const change = i > 0 ? d.rows[i].close - d.rows[i - 1].close : 0;
          return {
            value: v,
            itemStyle: { color: change >= 0 ? upColor : downColor },
          };
        }),
      },
    ],
  };
}

function initChart() {
  if (!chartRef.value) return;
  if (chart) chart.dispose();
  chart = echarts.init(chartRef.value, null, { group: 'tdx-group' });
  resizeHandler = () => chart?.resize();
  window.addEventListener('resize', resizeHandler);
  updateChart();
  register(chart);
}

function updateChart() {
  if (!chart) return;
  const option = buildOption();
  if (option) chart.setOption(option, true);
}

onMounted(() => {
  nextTick(initChart);
});

onUnmounted(() => {
  window.removeEventListener('resize', resizeHandler);
  if (chart) { unregister(chart); chart.dispose(); }
});

watch(() => props.data, () => {
  updateChart();
}, { deep: true });
</script>

<style scoped>
.chart-panel {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.chart-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.chart-info {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.chart-body {
  width: 100%;
  height: 420px;
}
</style>