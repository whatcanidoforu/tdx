<template>
  <div v-if="summary" class="summary-cards">
    <div class="summary-row">
      <div class="card card-main">
        <div class="card-label">最新价</div>
        <div class="card-value price">{{ formatPrice(summary.latest?.close) }}</div>
        <div class="card-sub" :class="changeClass">
          {{ formatPct(summary.changePct) }}
          <span v-if="summary.latest?.date" class="card-date">{{ summary.latest.date }}</span>
        </div>
      </div>

      <div class="card">
        <div class="card-label">最高 / 最低</div>
        <div class="card-value small">{{ formatPrice(summary.latest?.high) }} / {{ formatPrice(summary.latest?.low) }}</div>
        <div class="card-sub muted">振幅 {{ formatPct(summary.amplitudePct, 2, false) }}</div>
      </div>

      <div class="card">
        <div class="card-label">成交额</div>
        <div class="card-value small">{{ formatAmount(summary.latest?.amount) }}</div>
        <div class="card-sub muted">量 {{ formatVolume(summary.latest?.volume) }}</div>
      </div>

      <div class="card">
        <div class="card-label">{{ summary.windowSize }}日区间</div>
        <div class="card-value small">{{ formatPrice(summary.low52w) }} ~ {{ formatPrice(summary.high52w) }}</div>
        <div class="card-sub muted">位置 {{ formatPct(summary.position52w * 100, 1, false) }}</div>
      </div>
    </div>

    <div class="summary-row">
      <div class="card">
        <div class="card-label">MA5 / MA10 / MA20</div>
        <div class="card-value small">
          {{ formatPrice(summary.ma?.[5]) }} / {{ formatPrice(summary.ma?.[10]) }} / {{ formatPrice(summary.ma?.[20]) }}
        </div>
      </div>
      <div class="card">
        <div class="card-label">MA60 / MA120 / MA250</div>
        <div class="card-value small">
          {{ formatPrice(summary.ma?.[60]) }} / {{ formatPrice(summary.ma?.[120]) }} / {{ formatPrice(summary.ma?.[250]) }}
        </div>
      </div>
      <div class="card">
        <div class="card-label">MACD</div>
        <div class="card-value small">
          DIF {{ formatNum(summary.macd?.dif, 3) }} DEA {{ formatNum(summary.macd?.dea, 3) }}
        </div>
        <div class="card-sub" :class="summary.macd?.histogram >= 0 ? 'up' : 'down'">
          柱 {{ formatNum(summary.macd?.histogram, 3) }}
        </div>
      </div>
      <div class="card">
        <div class="card-label">RSI14 / KDJ</div>
        <div class="card-value small">
          RSI {{ formatNum(summary.rsi14, 1) }}
        </div>
        <div class="card-sub muted">
          K {{ formatNum(summary.kdj?.k, 1) }} D {{ formatNum(summary.kdj?.d, 1) }} J {{ formatNum(summary.kdj?.j, 1) }}
        </div>
      </div>
    </div>

    <div class="summary-row">
      <div class="card">
        <div class="card-label">BOLL (20,2)</div>
        <div class="card-value small">
          上 {{ formatPrice(summary.boll?.upper) }} 中 {{ formatPrice(summary.boll?.middle) }} 下 {{ formatPrice(summary.boll?.lower) }}
        </div>
      </div>
      <div class="card">
        <div class="card-label">年化波动 / 最大回撤</div>
        <div class="card-value small">
          {{ formatPct(summary.volatilityPct, 2, false) }} / {{ formatPct(summary.maxDrawdownPct, 2) }}
        </div>
      </div>
      <div v-for="r in summary.returns" :key="r.period" class="card card-small">
        <div class="card-label">{{ r.period }}日收益</div>
        <div class="card-value xsmall" :class="(r.pct ?? 0) >= 0 ? 'up' : 'down'">
          {{ formatPct(r.pct) }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { formatPrice, formatPct, formatAmount, formatVolume } from '../utils/format.js';

const props = defineProps({ summary: Object, instrument: Object });

const changeClass = computed(() => {
  return (props.summary?.changePct ?? 0) >= 0 ? 'up' : 'down';
});

function formatNum(value, digits) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}
</script>

<style scoped>
.summary-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.summary-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-main {
  border-color: rgba(88, 166, 255, 0.3);
}

.card-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.card-value {
  font-family: var(--font-mono);
  font-weight: 600;
}

.card-value.price {
  font-size: 24px;
  color: var(--text-primary);
}

.card-value.small {
  font-size: 14px;
  color: var(--text-primary);
}

.card-value.xsmall {
  font-size: 18px;
}

.card-sub {
  font-size: 12px;
  font-family: var(--font-mono);
}

.card-sub.muted { color: var(--text-muted); }
.card-sub.up { color: var(--accent-green); }
.card-sub.down { color: var(--accent-red); }
.card-sub .card-date {
  color: var(--text-muted);
  margin-left: 8px;
}

.card-value.up { color: var(--accent-green); }
.card-value.down { color: var(--accent-red); }

@media (max-width: 1000px) {
  .summary-row {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>