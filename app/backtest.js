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
  // T 日的前一个交易日（用于算 T日收盘涨跌幅）
  const dayPrev = buyDayIndex > 0 ? allDates[buyDayIndex - 1] : null;

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

  // ── 口径说明 ──
  //
  // 1) T+N最高收益%（累计收益）
  //      分母 = 买入价 = 拐点那根 K 线的收盘价
  //      · 拐点非 15:00（如 14:45）→ 就是该拐点收盘价
  //      · 拐点是 15:00 → 就是 15:00 收盘价，可在盘后 15:00~15:30 竞价成交
  //
  // 2) T+N日内最高涨幅%（单日涨幅，与行情软件口径一致）
  //      T+1 分母 = T 日【真正收盘价】（当日最后一根 K 线收盘，通常 15:00）
  //      T+2 分母 = T+1 日真正收盘价
  //      注意：若拐点是 14:45，则买入价(14:45收盘) ≠ T日收盘价(15:00收盘)，
  //            两者口径不同，数值会有细微差异。
  //
  // 可能为负：开盘高开低走时，当日最高价仍低于前收。
  const pct = (high) => (high === null ? null : Number((((high - buyPrice) / buyPrice) * 100).toFixed(2)));

  // T 日真正收盘价（拐点所在交易日的最后一根 K 线收盘价）
  const tClose = dayClose(bars15, dayT0);
  const t1Close = dayT1 ? dayClose(bars15, dayT1) : null;
  const t2Close = dayT2 ? dayClose(bars15, dayT2) : null;

  const riseFrom = (high, base) => {
    if (high === null || base === null || !(base > 0)) return null;
    return Number((((high - base) / base) * 100).toFixed(2));
  };

  // T日收盘涨跌幅%（行情软件口径）：(T日收盘 - T-1日收盘) / T-1日收盘 × 100
  const prevClose = dayPrev ? dayClose(bars15, dayPrev) : null;
  const tDayChange = riseFrom(tClose, prevClose);

  // T+1 日内涨幅基准 = T日收盘价；T+2 日内涨幅基准 = T+1日收盘价
  const t1Rise = riseFrom(t1High, tClose);
  const t2Rise = riseFrom(t2High, t1Close);

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
    // 日内最高涨幅（分母为各自前一交易日的真正收盘价）
    t1Rise,
    t2Rise,
    // T日收盘涨跌幅%（相对前一交易日收盘价，行情软件口径）
    tDayChange,
    // 各交易日收盘价（便于核对/后续分析）
    tPrevClose: prevClose === null ? null : Number(prevClose.toFixed(2)),
    tClose: tClose === null ? null : Number(tClose.toFixed(2)),
    t1Close: t1Close === null ? null : Number(t1Close.toFixed(2)),
    t2Close: t2Close === null ? null : Number(t2Close.toFixed(2)),
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

/** 取某日收盘价（该日最后一根 K 线的收盘价）。 */
function dayClose(bars, date) {
  let close = null;
  for (const bar of bars) {
    if (bar.date === date) close = bar.close;
  }
  return close;
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
