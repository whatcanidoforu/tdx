<template>
  <div class="indicator-chart">
    <div class="chart-header">
      <span class="chart-title">📈 RSI (14)</span>
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
  const rsi = d.rows.map((r) => r.rsi14);

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
      data: ['RSI14'],
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
      min: 0,
      max: 100,
      axisLine: { lineStyle: { color: '#30363d' } },
      axisLabel: { color: '#8b949e', fontSize: 10 },
      splitLine: { lineStyle: { color: '#21262d' } },
    },
    visualMap: {
      show: false,
      pieces: [
        { gt: 70, color: '#ef5350' },
        { gt: 30, lte: 70, color: '#a371f7' },
        { lte: 30, color: '#26a69a' },
      ],
    },
    series: [
      {
        name: 'RSI14',
        type: 'line',
        data: rsi,
        lineStyle: { width: 2 },
        symbol: 'none',
        markLine: {
          silent: true,
          data: [
            { yAxis: 70, lineStyle: { color: '#ef5350', type: 'dashed', width: 1 } },
            { yAxis: 30, lineStyle: { color: '#26a69a', type: 'dashed', width: 1 } },
          ],
          label: { show: false },
        },
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