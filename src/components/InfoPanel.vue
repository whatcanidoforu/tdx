<template>
  <div v-if="info" class="info-panel">
    <div class="info-header">📋 文件信息</div>
    <div class="info-grid">
      <div class="info-item">
        <span class="info-label">标的</span>
        <span class="info-value code">{{ info.instrument.market }}{{ info.instrument.code }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">类型</span>
        <span class="info-value">{{ info.instrument.kindLabel }} · {{ info.instrument.boardLabel }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">市场</span>
        <span class="info-value">{{ info.instrument.marketLabel }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">格式</span>
        <span class="info-value">{{ info.format.label }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">记录数</span>
        <span class="info-value mono">{{ formatCount(info.count) }}</span>
      </div>
      <div v-if="info.range" class="info-item">
        <span class="info-label">日期区间</span>
        <span class="info-value mono">{{ info.range.start }} ~ {{ info.range.end }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { formatCount } from '../utils/format.js';
defineProps({ info: Object });
</script>

<style scoped>
.info-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.info-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.info-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.info-label {
  font-size: 12px;
  color: var(--text-muted);
}

.info-value {
  font-size: 13px;
  color: var(--text-primary);
}

.info-value.code {
  font-family: var(--font-mono);
  color: var(--accent-blue);
  font-weight: 600;
}

.info-value.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}
</style>