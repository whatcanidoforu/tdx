<template>
  <div class="indicator-chart">
    <div class="chart-header">
      <span class="chart-title">HJ 指标</span>
      <span class="chart-hint"><b>B</b> HJ5 买点</span>
    </div>
    <div ref="chartRef" class="chart-body"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import * as echarts from 'echarts';
import { register, unregister } from '../chartSync.js';
import { buildHjOption } from '../charts/hjOption.js';

const props = defineProps({ data: Object });
const chartRef = ref(null);
let chart = null;
let resizeHandler = null;

function buildOption() {
  return buildHjOption(props.data);
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.chart-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.chart-hint b {
  color: #f5a623;
  font-weight: 700;
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
