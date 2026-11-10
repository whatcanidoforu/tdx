/**
 * 买入日的日线指标对比 —— 观察大周期（日线）状态对小周期信号的影响。
 *
 * 三项判断（都在**日线**上比较，买入日 vs 前一交易日）：
 *   1. 买入日 HJ10 是否低于前一日
 *   2. 买入日 MACD 柱值是否小于前一日
 *   3. （另一模块）HJ10 连续下跌天数
 *
 * 同一天可能对应多个信号（15 分钟级别一天 16 根），日线指标只算一次。
 *
 * @module app/daily-context
 */

import { join } from 'node:path';

import { computeHJ } from '../src/formulas/hj.js';
import { readDayFile } from './lc5-reader.js';
import { computeMacd } from './macd.js';

/** 日线缓存：同一只股票在同一次扫描里只读一次。 */
const cache = new Map();

/**
 * 读取某只股票的日线指标（HJ10 + MACD柱）。
 *
 * @param {string} tdxHome
 * @param {string} market sh/sz/bj
 * @param {string} code
 * @returns {{dates: string[], hj10: number[], macd: number[]}}
 */
export function loadDailyIndicators(tdxHome, market, code) {
  const key = `${market}${code}`;
  if (cache.has(key)) return cache.get(key);

  const file = join(tdxHome, 'vipdoc', market, 'lday', `${market}${code}.day`);
  let result = { dates: [], hj10: [], macd: [] };
  try {
    const bars = readDayFile(file);
    if (bars.length > 0) {
      const hj = computeHJ(bars);
      const { macd } = computeMacd(bars.map((bar) => bar.close));
      result = {
        dates: bars.map((bar) => bar.date),
        hj10: hj.map((item) => item.hj10),
        macd,
      };
    }
  } catch {
    // 读不到就返回空
  }
  cache.set(key, result);
  return result;
}

/** 兼容旧名。 */
export const loadDailyHJ10 = loadDailyIndicators;

/** 清空缓存（测试用）。 */
export function clearDailyCache() {
  cache.clear();
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
 */
export function attachDailyContext(hits, tdxHome) {
  for (const hit of hits) {
    const buyDate = hit.perf?.buyDate;
    if (!buyDate) {
      hit.dailyDecline = null;
      hit.dailyCompare = null;
      continue;
    }
    const daily = loadDailyIndicators(tdxHome, hit.market, hit.code);
    const info = countDailyDecline(daily, buyDate);
    hit.dailyDecline = info.days;
    hit.dailyHj10 = info.hj10;
    hit.dailyCompare = compareDailyAt(daily, buyDate);
  }
  return hits;
}
