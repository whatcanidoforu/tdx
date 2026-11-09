/**
 * 通达信 15 分钟 K 线读取（.lc5 → 15 分钟聚合）。
 *
 * `.lc5` 是 5 分钟线，每条记录 32 字节：
 *   uint16 压缩日期  (年-2004)*2048 + 月*100 + 日
 *   uint16 当日分钟数
 *   float32 open / high / low / close / amount
 *   uint32 volume
 *   uint32 reserved
 *
 * 15 分钟 K 线 = 每 3 根 5 分钟线合并：开=首根开、高=三根最高、低=三根最低、收=末根收、量额求和。
 *
 * @module dsh-tdx/app/lc5-reader
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 每条记录字节数（5 分钟线）。 */
const RECORD_BYTES = 32;

/** 每条记录字节数（日线）。 */
const RECORD_BYTES_DAY = 32;

/**
 * 解码一条 .lc5 记录。
 * @param {Buffer} buffer
 * @param {number} offset
 */
export function decodeRecord(buffer, offset) {
  const zip = buffer.readUInt16LE(offset);
  const minutes = buffer.readUInt16LE(offset + 2);
  return {
    year: (zip >> 11) + 2004,
    month: Math.trunc((zip % 2048) / 100),
    day: (zip % 2048) % 100,
    hour: Math.trunc(minutes / 60),
    minute: minutes % 60,
    open: buffer.readFloatLE(offset + 4),
    high: buffer.readFloatLE(offset + 8),
    low: buffer.readFloatLE(offset + 12),
    close: buffer.readFloatLE(offset + 16),
    amount: buffer.readFloatLE(offset + 20),
    volume: buffer.readUInt32LE(offset + 24),
  };
}

/**
 * 读取单个 .lc5 文件为 5 分钟 K 线数组。
 * @param {string} file
 * @returns {object[]}
 */
export function readLc5(file) {
  const size = statSync(file).size;
  const count = Math.floor(size / RECORD_BYTES);
  if (count === 0) return [];
  const buffer = Buffer.alloc(count * RECORD_BYTES);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, count * RECORD_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  const bars = new Array(count);
  for (let index = 0; index < count; index += 1) {
    bars[index] = decodeRecord(buffer, index * RECORD_BYTES);
  }
  return bars;
}

/**
 * 把 5 分钟线聚合为任意更高周期（按自然日分组，每 N 根合并成 1 根）。
 *
 * @param {object[]} bars5
 * @param {number} groupSize 合并根数：1=5分钟，3=15分钟，6=30分钟
 * @returns {{date: string, time: string, open: number, high: number, low: number, close: number, amount: number, volume: number}[]}
 */
export function mergeBars(bars5, groupSize = 3) {
  const size = Math.max(1, Math.floor(groupSize));
  const byDay = new Map();
  for (const bar of bars5) {
    const key = `${bar.year}${String(bar.month).padStart(2, '0')}${String(bar.day).padStart(2, '0')}`;
    let group = byDay.get(key);
    if (!group) {
      group = [];
      byDay.set(key, group);
    }
    group.push(bar);
  }

  const out = [];
  for (const [date, dayBars] of byDay) {
    for (let index = 0; index + size - 1 < dayBars.length; index += size) {
      const group = dayBars.slice(index, index + size);
      const last = group[group.length - 1];
      let high = group[0].high;
      let low = group[0].low;
      let amount = 0;
      let volume = 0;
      for (const item of group) {
        if (item.high > high) high = item.high;
        if (item.low < low) low = item.low;
        amount += item.amount;
        volume += item.volume;
      }
      out.push({
        date,
        time: `${String(last.hour).padStart(2, '0')}:${String(last.minute).padStart(2, '0')}`,
        open: group[0].open,
        high,
        low,
        close: last.close,
        amount,
        volume,
      });
    }
  }
  return out;
}

/**
 * 把 5 分钟线聚合为 15 分钟线（每 3 根合并）。
 * @param {object[]} bars5
 */
export function mergeTo15Min(bars5) {
  return mergeBars(bars5, 3);
}

/**
 * 按周期读取本地 5 分钟源文件，返回对应级别的 K 线。
 *
 * @param {string} file `.lc5` 文件路径
 * @param {number} groupSize 合并根数（1=5分钟，3=15分钟，6=30分钟）
 */
export function readLc5As(file, groupSize) {
  return mergeBars(readLc5(file), groupSize);
}

/**
 * 直接读取并聚合为 15 分钟线。
 * @param {string} file
 */
export function readLc5As15Min(file) {
  return mergeTo15Min(readLc5(file));
}

/* ------------------------------------------------------------ 日线 .day */

/**
 * 读取通达信日线 `.day` 文件。
 *
 * 每条记录 32 字节：
 *   uint32 日期 YYYYMMDD
 *   uint32 开盘价 ×100
 *   uint32 最高价 ×100
 *   uint32 最低价 ×100
 *   uint32 收盘价 ×100
 *   float32 成交额（元）
 *   uint32 成交量
 *   uint32 保留
 *
 * @param {string} file
 * @returns {{date: string, time: string, open: number, high: number, low: number, close: number, amount: number, volume: number}[]}
 */
export function readDayFile(file) {
  const size = statSync(file).size;
  const count = Math.floor(size / RECORD_BYTES_DAY);
  if (count === 0) return [];
  const buffer = Buffer.alloc(count * RECORD_BYTES_DAY);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, count * RECORD_BYTES_DAY, 0);
  } finally {
    closeSync(fd);
  }
  const bars = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * RECORD_BYTES_DAY;
    const dateInt = buffer.readUInt32LE(offset);
    bars[index] = {
      date: String(dateInt),
      time: '15:00',
      open: buffer.readUInt32LE(offset + 4) / 100,
      high: buffer.readUInt32LE(offset + 8) / 100,
      low: buffer.readUInt32LE(offset + 12) / 100,
      close: buffer.readUInt32LE(offset + 16) / 100,
      amount: buffer.readFloatLE(offset + 20),
      volume: buffer.readUInt32LE(offset + 24),
    };
  }
  return bars;
}

/** A 股代码判定（按 .lc5 文件名）。 */
export function isAShareFile(market, fileName) {
  const match = /^[a-z]{2}(\d{6})\.lc5$/i.exec(fileName);
  if (!match) return false;
  const code = match[1];
  if (market === 'sh') return /^(600|601|603|605|688|689)/.test(code);
  if (market === 'sz') return /^(000|001|002|003|300|301)/.test(code);
  if (market === 'bj') return /^(43\d|83\d|87\d|92\d)/.test(code);
  return false;
}

/**
 * 枚举某市场所有 A 股 .lc5 文件。
 * @param {string} tdxHome
 * @param {string} market `sh` / `sz` / `bj`
 * @returns {{code: string, market: string, file: string}[]}
 */
/**
 * 枚举某市场所有 .lc5 文件（不区分股票/ETF，交由调用方过滤）。
 * @param {string} tdxHome
 * @param {string} market
 * @returns {{code: string, market: string, file: string}[]}
 */
export function listLc5Files(tdxHome, market) {
  const dir = join(tdxHome, 'vipdoc', market, 'fzline');
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const fileName of files) {
    if (!fileName.endsWith('.lc5')) continue;
    const match = /^[a-z]{2}(\d{6})\.lc5$/i.exec(fileName);
    if (!match) continue;
    out.push({ market, code: match[1], file: join(dir, fileName) });
  }
  return out;
}
