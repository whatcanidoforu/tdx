/**
 * 收益回测 —— 对每只命中的股票，按「最后一个拐点收盘价」买入，
 * 统计 T+0 / T+1 / T+2 各自最高价卖出的收益。
 *
 * 买入时机：
 *   底背离链的最后一个拐点收盘价。因为必须先看到拐点才能确认信号，那一刻才下得了单。
 *   例：603578 三星新材，最后一个拐点是 10-09 13:15 HJ10=16.22，收盘价 13.38 → 买入价 13.38。
 *
 * 卖出时机：
 *   T+0 = 买入之后、同一交易日剩余的 K 线中的最高价
 *   T+1 = 下一个交易日的最高价
 *   T+2 = 再下一个交易日的最高价
 *
 * 收益 = (卖出价 - 买入价) / 买入价 × 100%
 *
 * @module dsh-tdx/app/backtest
 */

/**
 * 对单个信号做收益回测。
 *
 * @param {object[]} bars15 该股票完整的 15 分钟 K 线（升序）
 * @param {number} buyIndex 买入那根 K 线的下标（最后一个拐点的下标）
 * @returns {{
 *   buyDate: string, buyTime: string, buyPrice: number,
 *   t0: number|null, t1: number|null, t2: number|null,
 *   t0High: number|null, t1High: number|null, t2High: number|null,
 * }|null}
 */
export function backtestSignal(bars15, buyIndex) {
  const buyBar = bars15[buyIndex];
  if (!buyBar) return null;
  const buyPrice = buyBar.close;
  if (!(buyPrice > 0)) return null;

  const buyDate = buyBar.date;

  // 找出后续所有交易日（升序，去重）
  const allDates = [];
  for (const bar of bars15) {
    if (allDates[allDates.length - 1] !== bar.date) allDates.push(bar.date);
  }
  const buyDayIndex = allDates.indexOf(buyDate);
  if (buyDayIndex < 0) return null;

  const dayT0 = allDates[buyDayIndex] ?? null;
  const dayT1 = allDates[buyDayIndex + 1] ?? null;
  const dayT2 = allDates[buyDayIndex + 2] ?? null;

  // T+0：买入之后、同一交易日剩余的 K 线
  let t0High = null;
  for (let index = buyIndex + 1; index < bars15.length; index += 1) {
    const bar = bars15[index];
    if (bar.date !== dayT0) break;
    if (t0High === null || bar.high > t0High) t0High = bar.high;
  }

  // T+1 / T+2：整天的最高价
  const t1High = dayT1 ? dayMax(bars15, dayT1) : null;
  const t2High = dayT2 ? dayMax(bars15, dayT2) : null;

  const pct = (high) => (high === null ? null : Number((((high - buyPrice) / buyPrice) * 100).toFixed(2)));

  return {
    buyDate,
    buyTime: buyBar.time,
    buyPrice: Number(buyPrice.toFixed(2)),
    t0High: t0High === null ? null : Number(t0High.toFixed(2)),
    t1High: t1High === null ? null : Number(t1High.toFixed(2)),
    t2High: t2High === null ? null : Number(t2High.toFixed(2)),
    t0: pct(t0High),
    t1: pct(t1High),
    t2: pct(t2High),
  };
}

/** 取某日所有 K 线的最高价。 */
function dayMax(bars, date) {
  let high = null;
  for (const bar of bars) {
    if (bar.date !== date) continue;
    if (high === null || bar.high > high) high = bar.high;
  }
  return high;
}

/** 分段边界（1% 一段）。 */
export function bucketOf(pct) {
  if (!Number.isFinite(pct)) return null;
  // 按 1% 向下取整；负数单独处理（-0.5% → "-1~0"）
  const floor = Math.floor(pct);
  const lower = floor;
  const upper = floor + 1;
  return { lower, upper, label: `${lower}~${upper}%` };
}

/**
 * 把一批回测结果按 1% 分段统计。
 *
 * @param {{t0: number|null, t1: number|null, t2: number|null}[]} results
 * @returns {object} 三个周期的分段统计
 */
export function summarize(results) {
  const summary = {};
  for (const key of ['t0', 't1', 't2']) {
    const values = results.map((r) => r[key]).filter((v) => Number.isFinite(v));
    const buckets = new Map();
    for (const value of values) {
      const bucket = bucketOf(value);
      if (!bucket) continue;
      const entry = buckets.get(bucket.label) ?? { label: bucket.label, lower: bucket.lower, count: 0 };
      entry.count += 1;
      buckets.set(bucket.label, entry);
    }
    const sorted = [...buckets.values()].sort((a, b) => a.lower - b.lower);
    const total = values.length;
    for (const entry of sorted) entry.ratio = total > 0 ? (entry.count / total) * 100 : 0;
    const positive = values.filter((v) => v > 0).length;
    summary[key] = {
      count: total,
      min: total > 0 ? Math.min(...values) : null,
      max: total > 0 ? Math.max(...values) : null,
      avg: total > 0 ? Number((values.reduce((a, b) => a + b, 0) / total).toFixed(2)) : null,
      winRate: total > 0 ? Number(((positive / total) * 100).toFixed(2)) : null,
      buckets: sorted,
    };
  }
  return summary;
}
