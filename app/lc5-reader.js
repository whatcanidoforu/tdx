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

/** 每条记录字节数。 */
const RECORD_BYTES = 32;

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
 * 把 5 分钟线聚合为 15 分钟线（每 3 根合并，按自然日分组）。
 *
 * @param {object[]} bars5
 * @returns {{date: string, time: string, open: number, high: number, low: number, close: number, amount: number, volume: number}[]}
 */
export function mergeTo15Min(bars5) {
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
    for (let index = 0; index + 2 < dayBars.length; index += 3) {
      const trio = [dayBars[index], dayBars[index + 1], dayBars[index + 2]];
      const last = trio[2];
      out.push({
        date,
        time: `${String(last.hour).padStart(2, '0')}:${String(last.minute).padStart(2, '0')}`,
        open: trio[0].open,
        high: Math.max(trio[0].high, trio[1].high, trio[2].high),
        low: Math.min(trio[0].low, trio[1].low, trio[2].low),
        close: last.close,
        amount: trio[0].amount + trio[1].amount + trio[2].amount,
        volume: trio[0].volume + trio[1].volume + trio[2].volume,
      });
    }
  }
  return out;
}

/**
 * 直接读取并聚合为 15 分钟线。
 * @param {string} file
 */
export function readLc5As15Min(file) {
  return mergeTo15Min(readLc5(file));
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
    if (!isAShareFile(market, fileName)) continue;
    const match = /^[a-z]{2}(\d{6})\.lc5$/i.exec(fileName);
    out.push({ market, code: match[1], file: join(dir, fileName) });
  }
  return out;
}
