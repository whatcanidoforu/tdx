/**
 * 跌幅扫描核心 —— 双数据源。
 *
 * 数据源 A（主）：本地通达信 vipdoc 日线。扫描全市场 A 股 `vipdoc\{sh,sz,bj}\lday\*.day`，
 *   取「最后一条」与「倒数第二条」的收盘价，即当日收盘价与昨收价，算出当日跌幅。
 *   盘中通达信只要落盘过当日 K 线（默认实时刷新），本地读取就是实时的。
 *
 * 数据源 B（备）：通达信行情主站 0x0450 证券列表（含昨收价）+ 本地日线最新价做交叉校验。
 *
 * @module dsh-tdx/app/market-scan
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 日线记录字节数。 */
const DAY_RECORD_BYTES = 32;

/**
 * A 股代码规则（同 market-data 的 isAShare，这里按文件名前缀快速判定）。
 */
const A_SHARE_FILE = /^(sh6(00|01|03|05|88|89)\d{3}|sz(00[0123]|30[01])\d{3}|bj(4[3-9]|8[3-9]|92)\d{3})\.day$/;

/**
 * 解析日线文件名中的市场与代码。
 * @param {string} fileName 例如 `sh600000.day`
 */
export function parseFileName(fileName) {
  const match = /^([a-z]{2})(\d{6})\.day$/i.exec(fileName);
  if (!match) return null;
  return { market: match[1].toLowerCase(), code: match[2] };
}

/**
 * 从 .day 文件尾部读取最近两条记录。
 * @param {string} file 绝对路径
 * @returns {{prev: object|null, last: object|null}}
 */
export function readLastTwoBars(file) {
  const size = statSync(file).size;
  if (size < DAY_RECORD_BYTES) return { prev: null, last: null };
  const readSize = size >= DAY_RECORD_BYTES * 2 ? DAY_RECORD_BYTES * 2 : DAY_RECORD_BYTES;
  const buffer = Buffer.alloc(readSize);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, readSize, size - readSize);
  } finally {
    closeSync(fd);
  }
  const parse = (offset) => ({
    date: buffer.readUInt32LE(offset),
    open: buffer.readUInt32LE(offset + 4) / 100,
    high: buffer.readUInt32LE(offset + 8) / 100,
    low: buffer.readUInt32LE(offset + 12) / 100,
    close: buffer.readUInt32LE(offset + 16) / 100,
    amount: buffer.readFloatLE(offset + 20),
    volume: buffer.readUInt32LE(offset + 24),
  });
  if (size >= DAY_RECORD_BYTES * 2) {
    return { prev: parse(0), last: parse(DAY_RECORD_BYTES) };
  }
  return { prev: null, last: parse(0) };
}

/**
 * 扫描本地 vipdoc，返回当日跌幅超阈值的股票。
 *
 * 关键：必须先确定「当前交易日」，再只统计最后一条 K 线日期等于该交易日的股票。
 * 否则退市股（vipdoc 里仍保留历史文件，最后交易日可能是几年前）会被误算成巨幅下跌。
 *
 * @param {{
 *   tdxHome: string,
 *   thresholdPct?: number,
 *   log?: (line: string) => void,
 * }} options
 * @returns {{rows: object[], universe: number, scanned: number, tradeDate: number|null, delisted: number}}
 */
export function scanLocalVipdoc(options) {
  const threshold = options.thresholdPct ?? 5;
  const log = options.log ?? (() => {});
  const all = [];
  let universe = 0;
  const dateCount = new Map();

  for (const market of ['sh', 'sz', 'bj']) {
    const directory = join(options.tdxHome, 'vipdoc', market, 'lday');
    let files;
    try {
      files = readdirSync(directory);
    } catch {
      log(`  ${market}：目录不存在，跳过`);
      continue;
    }
    for (const fileName of files) {
      if (!fileName.endsWith('.day')) continue;
      if (!A_SHARE_FILE.test(fileName)) continue;
      universe += 1;
      const parsed = parseFileName(fileName);
      if (!parsed) continue;
      let bars;
      try {
        bars = readLastTwoBars(join(directory, fileName));
      } catch {
        continue;
      }
      const { prev, last } = bars;
      if (!prev || !last) continue;
      if (!(prev.close > 0) || !(last.close > 0)) continue;
      if (last.volume <= 0) continue;
      dateCount.set(last.date, (dateCount.get(last.date) ?? 0) + 1);
      all.push({
        market: parsed.market,
        code: parsed.code,
        price: last.close,
        lastClose: prev.close,
        open: last.open,
        high: last.high,
        low: last.low,
        amount: last.amount,
        volume: last.volume,
        date: last.date,
        prevDate: prev.date,
      });
    }
  }

  // 当前交易日 = 出现次数最多的最后 K 线日期
  const tradeDate = [...dateCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (tradeDate === null) {
    return { rows: [], universe, scanned: 0, tradeDate: null, delisted: 0 };
  }

  // 只保留「最后一条 K 线就是当前交易日」的股票——自动排除退市股与停牌股
  const active = all.filter((row) => row.date === tradeDate);
  const delisted = all.length - active.length;

  const rows = [];
  for (const row of active) {
    const changePct = ((row.price - row.lastClose) / row.lastClose) * 100;
    if (changePct > -threshold) continue;
    rows.push({ ...row, changePct: Number(changePct.toFixed(2)) });
  }
  rows.sort((left, right) => left.changePct - right.changePct);
  return { rows, universe, scanned: active.length, tradeDate, delisted };
}

/**
 * 用名称表补齐行里的股票名称。
 *
 * @param {object[]} rows
 * @param {Map<string, string>} nameBySymbol 键为 `{sh|sz|bj}{code}`
 */
export function attachNames(rows, nameBySymbol) {
  for (const row of rows) {
    row.name = nameBySymbol.get(`${row.market}${row.code}`) ?? row.name ?? '';
  }
  return rows;
}

/** 市场缩写 → 行情主站市场编号。 */
export const MARKET_NUMBER = Object.freeze({ sz: 0, sh: 1, bj: 2 });

/** ST 名称判定。 */
export function isSpecialName(name) {
  return /ST|\*|退|停牌/.test(name ?? '');
}
