<template>
  <div class="data-table-panel">
    <div class="table-header">
      <span class="table-title">📋 数据明细</span>
      <div class="table-controls">
        <label class="control-label">显示条数</label>
        <select v-model.number="pageSize" class="select-input">
          <option :value="30">30</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="200">200</option>
        </select>
        <label class="control-label">排序</label>
        <select v-model="order" class="select-input">
          <option value="desc">最新在前</option>
          <option value="asc">最早在前</option>
        </select>
      </div>
    </div>
    <div class="table-scroll">
      <table v-if="pagedRows.length > 0" class="data-table">
        <thead>
          <tr>
            <th>日期</th>
            <th>开盘</th>
            <th>最高</th>
            <th>最低</th>
            <th>收盘</th>
            <th>涨跌%</th>
            <th>成交量</th>
            <th>成交额</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in pagedRows" :key="row.date + (row.time || '')">
            <td class="col-date">{{ row.date }}</td>
            <td class="col-num">{{ formatPrice(row.open) }}</td>
            <td class="col-num">{{ formatPrice(row.high) }}</td>
            <td class="col-num">{{ formatPrice(row.low) }}</td>
            <td class="col-num" :class="(row.changePct ?? 0) >= 0 ? 'up' : 'down'">{{ formatPrice(row.close) }}</td>
            <td class="col-num" :class="(row.changePct ?? 0) >= 0 ? 'up' : 'down'">{{ formatPct(row.changePct) }}</td>
            <td class="col-num">{{ formatVolume(row.volume) }}</td>
            <td class="col-num">{{ formatAmount(row.amount) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-msg">暂无数据</div>
    </div>
    <div v-if="allRows.length > 0" class="table-footer">
      共 {{ allRows.length }} 条记录
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { formatPrice, formatPct, formatVolume, formatAmount } from '../utils/format.js';

const props = defineProps({
  rows: { type: Array, default: () => [] },
});

const pageSize = ref(30);
const order = ref('desc');

const allRows = computed(() => props.rows || []);

const pagedRows = computed(() => {
  const ordered = order.value === 'desc' ? [...allRows.value].reverse() : allRows.value;
  return ordered.slice(0, pageSize.value);
});
</script>

<style scoped>
.data-table-panel {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  gap: 8px;
}

.table-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.table-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.control-label {
  font-size: 11px;
  color: var(--text-muted);
}

.select-input {
  padding: 4px 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  cursor: pointer;
}

.table-scroll {
  overflow-x: auto;
  max-height: 320px;
  overflow-y: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

.data-table th {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 8px 12px;
  text-align: right;
  white-space: nowrap;
}

.data-table th:first-child { text-align: left; }

.data-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.data-table tbody tr:hover {
  background: rgba(88, 166, 255, 0.04);
}

.col-date {
  font-family: var(--font-mono);
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left !important;
}

.col-num {
  font-family: var(--font-mono);
  font-size: 12px;
  text-align: right;
  color: var(--text-primary);
}

.col-num.up { color: var(--accent-green); }
.col-num.down { color: var(--accent-red); }

.empty-msg {
  padding: 32px;
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
}

.table-footer {
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
</style>