/**
 * 名称服务 —— 从通达信本地缓存或行情主站获取「代码 → 名称」，带文件缓存。
 *
 * 优先级：
 *   1) 本地缓存文件（当日有效，避免每次扫描都联网）；
 *   2) 行情主站 0x0450 证券列表（沪深北，含昨收）；
 *   3) 通达信本地 `T0002\hq_cache\` 下的 list 文件（离线兜底）。
 *
 * @module dsh-tdx/app/name-service
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 把行情主站证券列表转成「symbol → 名称」映射。
 * @param {{market: string, code: string, name: string}[]} items market 用 `sh|sz|bj`
 * @returns {Map<string, string>}
 */
export function toNameMap(items) {
  const map = new Map();
  for (const item of items) {
    if (item.name) map.set(`${item.market}${item.code}`, item.name);
  }
  return map;
}

/**
 * 载入名称表，必要时联网刷新。
 *
 * @param {{
 *   cacheFile: string,
 *   tdxHome?: string,
 *   fetchFromServer: () => Promise<{market: string, code: string, name: string}[]>,
 *   log?: (line: string) => void,
 *   refresh?: boolean,
 *   now?: Date,
 * }} options
 * @returns {Promise<Map<string, string>>}
 */
export async function loadNameMap(options) {
  const log = options.log ?? (() => {});
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);

  if (!options.refresh && existsSync(options.cacheFile)) {
    try {
      const raw = JSON.parse(readFileSync(options.cacheFile, 'utf8'));
      if (raw.date === today && Array.isArray(raw.entries) && raw.entries.length > 0) {
        log(`  名称表：命中当日缓存（${raw.entries.length} 条）`);
        return new Map(raw.entries);
      }
    } catch {
      // 缓存损坏则忽略
    }
  }

  try {
    const items = await options.fetchFromServer();
    const map = toNameMap(items);
    if (map.size > 0) {
      try {
        mkdirSync(dirname(options.cacheFile), { recursive: true });
        writeFileSync(
          options.cacheFile,
          JSON.stringify({ date: today, entries: [...map.entries()] }),
          'utf8',
        );
      } catch {
        // 缓存写失败不影响主流程
      }
      log(`  名称表：从行情主站刷新 ${map.size} 条`);
      return map;
    }
  } catch (error) {
    log(`  名称表：主站刷新失败（${error.message}），尝试本地缓存`);
  }

  // 离线兜底：本地 hq_cache 里的证券列表
  if (options.tdxHome) {
    const fallback = loadNameMapFromLocal(options.tdxHome, log);
    if (fallback.size > 0) return fallback;
  }
  return new Map();
}

/**
 * 本地兜底：解析 `T0002\hq_cache\shs.tnf` / `szs.tnf`（314 字节/条，异或加密）。
 *
 * @param {string} tdxHome
 * @param {(line: string) => void} log
 */
export function loadNameMapFromLocal(tdxHome, log = () => {}) {
  const map = new Map();
  const cacheDir = join(tdxHome, 'T0002', 'hq_cache');
  const files = [
    ['shs.tnf', 'sh'],
    ['szs.tnf', 'sz'],
    ['bjs.tnf', 'bj'],
  ];
  for (const [fileName, market] of files) {
    const file = join(cacheDir, fileName);
    if (!existsSync(file)) continue;
    try {
      const buffer = readFileSync(file);
      const mask = buffer.subarray(0, 32);
      // 解密密钥 = 头部 32 字节（.tnf 的固定算法）
      const recordSize = 314;
      let offset = 32;
      let count = 0;
      while (offset + recordSize <= buffer.length) {
        const record = Buffer.alloc(recordSize);
        for (let index = 0; index < recordSize; index += 1) {
          record[index] = buffer[offset + index] ^ mask[index % 32];
        }
        const code = record.toString('latin1', 0, 6).replace(/\0+$/, '');
        const name = new TextDecoder('gbk').decode(record.subarray(23, 31)).replace(/\0+$/, '').trim();
        if (/^\d{6}$/.test(code) && name) {
          map.set(`${market}${code}`, name);
          count += 1;
        }
        offset += recordSize;
      }
      log(`  名称表：本地 ${fileName} 解析 ${count} 条`);
    } catch (error) {
      log(`  名称表：本地 ${fileName} 解析失败（${error.message}）`);
    }
  }
  return map;
}
