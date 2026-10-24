<template>
  <div class="indicator-chart">
    <div class="chart-header">
      <span class="chart-title">📐 BOLL (20,2)</span>
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
  const upper = d.rows.map((r) => r.bollUpper);
  const middle = d.rows.map((r) => r.bollMiddle);
  const lower = d.rows.map((r) => r.bollLower);
  const close = d.rows.map((r) => r.close);

  return {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: '#58a6ff', type: 'dashed', width: 1 } },
      backgroundColor: 'rgba(22,27,34,0.95)',
      borderColor: '#30363d',
      textStyle: { color: '#e6edf3', fontSize: 12 },
    },
    legend: {
      data: ['收盘', '上轨', '中轨', '下轨'],
      top: 0,
      textStyle: { color: '#8b949e', fontSize: 11 },
    },
    grid: { left: '8%', right: '5%', top: '15%', bottom: '10%' },
    dataZoom: [{ type: 'inside', xAxisIndex: 0, start: 0, end: 100 }],
    xAxis: {
      type: 'category',
      data: dates,
      axisLine: { lineStyle: { color: '#30363d' } },
      axisLabel: { color: '#8b949e', fontSize: 10 },
      axisTick: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      scale: true,
      axisLine: { lineStyle: { color: '#30363d' } },
      axisLabel: { color: '#8b949e', fontSize: 10 },
      splitLine: { lineStyle: { color: '#21262d' } },
    },
    series: [
      {
        name: '上轨',
        type: 'line',
        data: upper,
        lineStyle: { color: 'rgba(239,83,80,0.6)', width: 1 },
        symbol: 'none',
      },
      {
        name: '中轨',
        type: 'line',
        data: middle,
        lineStyle: { color: 'rgba(211,153,34,0.8)', width: 1.5 },
        symbol: 'none',
      },
      {
        name: '下轨',
        type: 'line',
        data: lower,
        lineStyle: { color: 'rgba(38,166,154,0.6)', width: 1 },
        symbol: 'none',
        areaStyle: { color: 'rgba(38,166,154,0.05)' },
      },
      {
        name: '收盘',
        type: 'line',
        data: close,
        lineStyle: { color: '#58a6ff', width: 1.5 },
        symbol: 'none',
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
  const option = buildOption();
  if (option) chart.setOption(option);
  register(chart);
}

onMounted(() => nextTick(initChart));
onUnmounted(() => {
  window.removeEventListener('resize', resizeHandler);
  if (chart) { unregister(chart); chart.dispose(); }
});

watch(() => props.data, () => {
  if (!chart) return;
  const option = buildOption();
  if (option) chart.setOption(option, true);
}, { deep: true });
</script>

<style scoped>
.indicator-chart {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.chart-header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.chart-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.chart-body {
  width: 100%;
  height: 220px;
}
</style>