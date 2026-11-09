/**
 * 周期（K 线级别）定义与换算。
 *
 * 支持的级别：
 *   5   → 5 分钟（直接用 .lc5，1 根合成）
 *   15  → 15 分钟（.lc5 每 3 根合成）
 *   30  → 30 分钟（.lc5 每 6 根合成）
 *   day → 日线（读 .day 文件）
 *
 * @module app/period
 */

/** 支持的周期。 */
export const PERIODS = Object.freeze({
  '5': {
    key: '5',
    label: '5分钟',
    minutes: 5,
    // .lc5 每几根合成 1 根
    groupSize: 1,
    // 行情主站的周期码
    tdxCategory: 0,
    // 每交易日多少根（用于估算 maxBars 之类）
    barsPerDay: 48,
    source: 'lc5',
  },
  '15': {
    key: '15',
    label: '15分钟',
    minutes: 15,
    groupSize: 3,
    tdxCategory: 1,
    barsPerDay: 16,
    source: 'lc5',
  },
  '30': {
    key: '30',
    label: '30分钟',
    minutes: 30,
    groupSize: 6,
    tdxCategory: 2,
    barsPerDay: 8,
    source: 'lc5',
  },
  day: {
    key: 'day',
    label: '日线',
    minutes: 1440,
    groupSize: null,
    tdxCategory: 9,
    barsPerDay: 1,
    source: 'day',
    // 日线的 HJ10 分布与分钟级不同：13 周期窗口跨 13 天，数值整体偏高
    // 实测 200 只 × 120 日：中位数 39.2，低于 25 占 25.7%，低于 10 仅 1.9%
    // 因此日线默认阈值建议 25（与分钟级别一致但含义不同）
    defaultThreshold: 25,
  },
});

/** 周期别名。 */
const ALIASES = new Map([
  ['5', '5'], ['5m', '5'], ['5min', '5'], ['m5', '5'],
  ['15', '15'], ['15m', '15'], ['15min', '15'], ['m15', '15'],
  ['30', '30'], ['30m', '30'], ['30min', '30'], ['m30', '30'],
  ['d', 'day'], ['day', 'day'], ['1d', 'day'], ['日', 'day'], ['日线', 'day'],
]);

/**
 * 解析周期参数。
 *
 * @param {string|number|null} value
 * @returns {object|null} 周期定义，无法识别时返回 null
 */
export function resolvePeriod(value) {
  if (value === null || value === undefined) return PERIODS['15'];
  const text = String(value).trim().toLowerCase();
  const key = ALIASES.get(text);
  return key ? PERIODS[key] : null;
}

/** 全部可用的周期名（用于报错提示）。 */
export function periodNames() {
  return ['5', '15', '30', 'day'];
}
