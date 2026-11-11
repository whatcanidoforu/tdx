/**
 * 数据缺口检测与自动补齐。
 *
 * 问题背景：
 *   本地 .lc5 文件可能因为没做盘后下载而缺少整个交易日（例如 11-10 缺失），
 *   而 HJ10/MACD 都基于 EMA 递推，缺口会被「静默忽略」，
 *   把 11-09 收盘当成 11-11 的前一根，算出错误的指标。
 *
 * 策略（B + A）：
 *   B. 先尝试从行情主站自动补齐缺口日期
 *   A. 补不上的，明确告警（而不是静默算下去）
 *
 * 检测方式：
 *   比较「本地最后日期」与「主站最新日期」，列出其间缺失的交易日。
 *   也支持检测中间任意缺口（本地日期序列里不连续的地方）。
 *
 * @module app/gap-filler
 */

/** 合法日期：YYYYMMDD，年份 1990-2100，月份 1-12，日 1-31。 */
export function isValidDateStr(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{8}$/.test(dateStr)) return false;
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  return year >= 1990 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * 过滤掉非法日期的 K 线。
 *
 * 为什么需要：指数（如 bj899050）用的是不同的 K 线接口，价格与日期编码
 * 与股票不一致，解析出来会是 20040039 这种垃圾日期。这类数据必须丢弃，
 * 否则会污染缺口判断，产生「缺 586 个日期」的假告警。
 *
 * @param {object[]} bars
 * @returns {object[]}
 */
export function sanitizeBars(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.filter((bar) => bar && isValidDateStr(bar.date));
}

/** 交易日判定：跳过周末。节假日无法仅凭本地数据判断，靠主站返回的实际数据为准。 */
export function isWeekend(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * 枚举两个日期之间的所有自然日（含两端，升序）。
 * @param {string} from YYYYMMDD
 * @param {string} to YYYYMMDD
 */
export function enumerateDates(from, to) {
  const result = [];
  if (!from || !to || from > to) return result;
  const start = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(4, 6)) - 1, Number(from.slice(6, 8)));
  const end = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(4, 6)) - 1, Number(to.slice(6, 8)));
  for (let time = start; time <= end; time += 24 * 60 * 60 * 1000) {
    const date = new Date(time);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    result.push(`${year}${month}${day}`);
  }
  return result;
}

/**
 * 检测本地日期序列里缺失的交易日。
 *
 * @param {string[]} localDates 本地已有的日期（可重复，内部去重）
 * @param {string[]} referenceDates 参考交易日历（来自主站实际返回的日期，最可靠）
 * @returns {string[]} 缺失的日期（升序）
 */
export function findMissingDates(localDates, referenceDates) {
  const localSet = new Set(localDates);
  const refSet = new Set(referenceDates);
  if (refSet.size === 0) return [];

  const known = [...refSet].sort();
  const first = known[0];
  const last = known[known.length - 1];

  // 在「参考日历的最早~最晚」范围内，找本地缺失且参考日历里存在的日期
  const missing = [];
  for (const date of known) {
    if (date < first || date > last) continue;
    if (localSet.has(date)) continue;
    // 只把「参考日历里确实有数据」的日期算作缺口（自动跳过法定节假日）
    missing.push(date);
  }
  return missing;
}

/**
 * 判断本地数据相对主站是否落后（本地最后日期 < 主站最后日期）。
 *
 * @param {string[]} localDates
 * @param {string[]} referenceDates
 * @returns {{stale: boolean, localLast: string|null, refLast: string|null, missing: string[]}}
 */
export function analyzeGap(localDates, referenceDates) {
  const localSorted = [...new Set(localDates)].sort();
  const refSorted = [...new Set(referenceDates)].sort();
  const localLast = localSorted.length > 0 ? localSorted[localSorted.length - 1] : null;
  const refLast = refSorted.length > 0 ? refSorted[refSorted.length - 1] : null;
  const missing = findMissingDates(localSorted, refSorted);
  const stale = Boolean(refLast && (!localLast || localLast < refLast));
  return { stale, localLast, refLast, missing };
}

/**
 * 把一段补丁数据合并进本地序列（按日期+时间去重，补丁优先）。
 *
 * @param {object[]} local 本地 K 线（升序）
 * @param {object[]} patch 主站返回的补丁 K 线（升序）
 * @returns {{bars: object[], filled: number}}
 */
export function applyPatch(local, patch) {
  if (!patch || patch.length === 0) return { bars: local, filled: 0 };
  const map = new Map();
  for (const bar of local) map.set(`${bar.date}${bar.time}`, bar);
  const before = map.size;
  for (const bar of patch) map.set(`${bar.date}${bar.time}`, bar);
  const bars = [...map.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
  });
  return { bars, filled: map.size - before };
}

/**
 * 只保留指定日期集合内的 K 线。
 * @param {object[]} bars
 * @param {Set<string>} dates
 */
export function filterByDates(bars, dates) {
  return bars.filter((bar) => dates.has(bar.date));
}
