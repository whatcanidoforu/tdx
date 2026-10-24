<template>
  <div class="indicator-chart">
    <div class="chart-header">
      <span class="chart-title">HJ 指标</span>
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
  const hj10 = d.rows.map((r) => r.hj10);
  const hj11 = d.rows.map((r) => r.hj11);

  const N = d.rows.length;
  const baseData = new Array(N);
  const diffData = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = hj10[i];
    const b = hj11[i];
    if (a == null || b == null || isNaN(a) || isNaN(b)) {
      baseData[i] = null;
      diffData[i] = null;
    } else {
      baseData[i] = Math.min(a, b);
      diffData[i] = Math.abs(a - b);
    }
  }

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
    grid: { left: '8%', right: '5%', top: '5%', bottom: '10%' },
    dataZoom: [{ type: 'inside', xAxisIndex: 0, start: 0, end: 100 }],
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: true,
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
    series: [
      {
        name: 'Placeholder',
        type: 'bar',
        stack: 'Total',
        data: baseData,
        barWidth: '70%',
        itemStyle: {
          borderColor: 'transparent',
          color: 'transparent',
        },
        emphasis: {
          itemStyle: {
            borderColor: 'transparent',
            color: 'transparent',
          },
        },
      },
      {
        name: 'HJ',
        type: 'bar',
        stack: 'Total',
        data: diffData,
        barWidth: '70%',
        itemStyle: {
          color: function (p) {
            const a = hj10[p.dataIndex];
            const b = hj11[p.dataIndex];
            if (a == null || b == null) return 'transparent';
            return a > b ? '#ef5350' : '#3fb950';
          },
        },
      },
    ],
  };
}

function initChart() {
  if (!chartRef.value) return;
  if (chart) { chart.dispose(); chart = null; }
  chart = echarts.init(chartRef.value, null, { group: 'tdx-group' });
  resizeHandler = () => chart && chart.resize();
  window.addEventListener('resize', resizeHandler);
  const option = buildOption();
  if (option) {
    chart.setOption(option);
    register(chart);
  }
}

onMounted(() => nextTick(initChart));

onUnmounted(() => {
  window.removeEventListener('resize', resizeHandler);
  if (chart) { unregister(chart); chart.dispose(); chart = null; }
});

watch(() => props.data, () => {
  if (!chart) {
    nextTick(initChart);
    return;
  }
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
  height: 280px;
}
</style>