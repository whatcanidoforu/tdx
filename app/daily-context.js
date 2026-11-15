/**
 * 买入日的日线指标对比 —— 观察大周期（日线）状态对小周期信号的影响。
 *
 * 三项判断（都在**日线**上比较，买入日 vs 前一交易日）：
 *   1. 买入日 HJ10 是否低于前一日
 *   2. 买入日 MACD 柱值是否小于前一日
 *   3. HJ10 连续下跌天数
 *
 * 数据来源与「滞后」问题：
 *   本地 `lday\*.day` 往往缺当天（通达信收盘后不一定立刻写盘）。
 *   如果直接用本地数据，买入日是今天时会静默回退到昨天，指标方向可能是反的。
 *   所以支持传入主站补丁 `tailBars`：合并后重算指标，保证是买入日当天。
 *
 * @module app/daily-context
 */

import { join } from 'node:path';

import { computeHJ } from '../src/formulas/hj.js';
import { readDayFile } from './lc5-reader.js';
import { computeMacd } from './macd.js';

/** 本地日线原始 K 线缓存：同一只股票只读一次文件。 */
const barsCache = new Map();
/** 指标结果缓存（只对「不用补丁」的情况有效）。 */
const indicatorCache = new Map();

/**
 * 读本地日线原始 K 线（缓存）。
 *
 * @param {string} tdxHome
 * @param {string} market
 * @param {string} code
 * @returns {object[]}
 */
export function loadDailyBars(tdxHome, market, code) {
  const key = `${market}${code}`;
  if (barsCache.has(key)) return barsCache.get(key);
  let bars = [];
  try {
    bars = readDayFile(join(tdxHome, 'vipdoc', market, 'lday', `${market}${code}.day`));
  } catch {
    bars = [];
  }
  barsCache.set(key, bars);
  return bars;
}

/** 本地日线的最后日期（YYYYMMDD），没有数据返回 null。 */
export function localDailyLastDate(tdxHome, market, code) {
  const bars = loadDailyBars(tdxHome, market, code);
  return bars.length > 0 ? bars[bars.length - 1].date : null;
}

/**
 * 合并本地日线与主站补丁（按日期去重，补丁优先）。
 *
 * @param {object[]} local
 * @param {object[]} tail
 * @returns {object[]}
 */
export function mergeDailyBars(local, tail) {
  if (!tail || tail.length === 0) return local;
  if (local.length === 0) return [...tail].sort((a, b) => (a.date < b.date ? -1 : 1));
  const map = new Map();
  for (const bar of local) map.set(bar.date, bar);
  for (const bar of tail) map.set(bar.date, bar);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 由 K 线算出日线指标序列。
 * @param {object[]} bars
 */
export function buildDailyIndicators(bars) {
  if (bars.length === 0) return { dates: [], hj10: [], macd: [] };
  const hj = computeHJ(bars);
  const { macd } = computeMacd(bars.map((bar) => bar.close));
  return {
    dates: bars.map((bar) => bar.date),
    hj10: hj.map((item) => item.hj10),
    macd,
  };
}

/**
 * 读取某只股票的日线指标（HJ10 + MACD柱）。
 *
 * @param {string} tdxHome
 * @param {string} market
 * @param {string} code
 * @param {object[]|null} [tailBars] 主站补丁（合并后重算，保证含当天）
 * @returns {{dates: string[], hj10: number[], macd: number[]}}
 */
export function loadDailyIndicators(tdxHome, market, code, tailBars = null) {
  const key = `${market}${code}`;

  if (!tailBars || tailBars.length === 0) {
    if (indicatorCache.has(key)) return indicatorCache.get(key);
    const result = buildDailyIndicators(loadDailyBars(tdxHome, market, code));
    indicatorCache.set(key, result);
    return result;
  }

  // 有补丁：合并后重算（不写缓存，因为补丁内容每次可能不同）
  const local = loadDailyBars(tdxHome, market, code);
  return buildDailyIndicators(mergeDailyBars(local, tailBars));
}

/** 兼容旧名。 */
export const loadDailyHJ10 = loadDailyIndicators;

/** 清空缓存（测试用）。 */
export function clearDailyCache() {
  barsCache.clear();
  indicatorCache.clear();
}

/**
 * 找到买入日（或之前最近交易日）在日线序列中的下标。
 * @param {string[]} dates
 * @param {string} date YYYYMMDD
 */
export function findDailyIndex(dates, date) {
  for (let i = dates.length - 1; i >= 0; i -= 1) {
    if (dates[i] <= date) return i;
  }
  return -1;
}

/**
 * 计算某个日期时，日线 HJ10 已经连续下跌了几天。
 *
 * @param {{dates: string[], hj10: number[]}} daily
 * @param {string} date YYYYMMDD（买入日）
 * @returns {{days: number, date: string|null, hj10: number|null}}
 */
export function countDailyDecline(daily, date) {
  const { dates, hj10 } = daily;
  if (dates.length === 0) return { days: 0, date: null, hj10: null };

  const index = findDailyIndex(dates, date);
  if (index < 0) return { days: 0, date: null, hj10: null };

  let days = 0;
  let cursor = index;
  while (cursor > 0) {
    const today = hj10[cursor];
    const yesterday = hj10[cursor - 1];
    if (!Number.isFinite(today) || !Number.isFinite(yesterday)) break;
    if (!(today < yesterday)) break;
    days += 1;
    cursor -= 1;
  }

  return {
    days,
    date: dates[index],
    hj10: Number.isFinite(hj10[index]) ? Number(hj10[index].toFixed(2)) : null,
  };
}

/**
 * 买入日的日线指标前后对比。
 *
 * @param {{dates: string[], hj10: number[], macd: number[]}} daily
 * @param {string} date 买入日
 * @returns {{
 *   date: string|null,
 *   hj10: number|null, hj10Prev: number|null, hj10Lower: boolean|null,
 *   macdHist: number|null, macdHistPrev: number|null, macdLower: boolean|null,
 * }|null}
 */
export function compareDailyAt(daily, date) {
  const { dates, hj10, macd } = daily;
  if (!dates || dates.length === 0) return null;
  const index = findDailyIndex(dates, date);
  if (index < 1) return null;

  const hj10Now = hj10[index];
  const hj10Prev = hj10[index - 1];
  const macdNow = macd[index];
  const macdPrev = macd[index - 1];

  const result = {
    date: dates[index],
    hj10: Number.isFinite(hj10Now) ? Number(hj10Now.toFixed(2)) : null,
    hj10Prev: Number.isFinite(hj10Prev) ? Number(hj10Prev.toFixed(2)) : null,
    hj10Lower: null,
    macdHist: Number.isFinite(macdNow) ? Number(macdNow.toFixed(4)) : null,
    macdHistPrev: Number.isFinite(macdPrev) ? Number(macdPrev.toFixed(4)) : null,
    macdLower: null,
  };
  if (result.hj10 !== null && result.hj10Prev !== null) {
    result.hj10Lower = result.hj10 < result.hj10Prev;
  }
  if (result.macdHist !== null && result.macdHistPrev !== null) {
    result.macdLower = result.macdHist < result.macdHistPrev;
  }
  return result;
}

/**
 * 给一批命中结果补上「日线 HJ10 连续下跌天数」与「日线指标前后对比」。
 *
 * @param {object[]} hits
 * @param {string} tdxHome
 * @param {{dailyTails?: Map<string, object[]>}} [options] 主站日线补丁（key = sh600000）
 */
export function attachDailyContext(hits, tdxHome, options = {}) {
  const tails = options.dailyTails ?? null;
  for (const hit of hits) {
    const buyDate = hit.perf?.buyDate;
    if (!buyDate) {
      hit.dailyDecline = null;
      hit.dailyCompare = null;
      continue;
    }
    const symbol = `${hit.market}${hit.code}`;
    const tail = tails ? tails.get(symbol) : null;
    const daily = loadDailyIndicators(tdxHome, hit.market, hit.code, tail);
    const info = countDailyDecline(daily, buyDate);
    hit.dailyDecline = info.days;
    hit.dailyHj10 = info.hj10;
    hit.dailyCompare = compareDailyAt(daily, buyDate);
  }
  return hits;
}
