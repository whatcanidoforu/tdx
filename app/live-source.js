/**
 * 实时 15 分钟 K 线数据源 —— 走行情主站，不依赖本地文件刷新。
 *
 * 用途：盘中本地 `fzline\*.lc5` 往往还没落盘（通达信要手动「盘后数据下载」才写），
 * 此时用 --live 模式直接从行情主站拉最新 15 分钟 K 线。
 *
 * 性能：单连接约 50ms/只，全市场要 4 分钟以上；
 *       用 5 条连接并发可降到 40 秒左右。
 *
 * @module dsh-tdx/app/live-source
 */

import { TdxConnection } from './tdx-protocol.js';
import { buildBarsRequest, parseBars, PERIOD } from './market-bars.js';

/** 单次 K 线请求上限（超过会被服务器拒绝）。 */
const PAGE_SIZE = 800;

/** K 线连接只发 SetupCmd1，绝不能发 SetupCmd3（会让服务器拒绝 K 线请求）。 */
const SETUP_ONLY = Buffer.from('0c0218930001030003000d0001', 'hex');

/** 默认主站池（并发时每个连接用不同的主站）。 */
export const LIVE_HOSTS = Object.freeze([
  '110.41.2.72',
  '101.33.225.16',
  '175.178.112.197',
  '43.139.95.83',
  '111.231.113.208',
  '175.178.128.227',
]);

/**
 * 建立一条 K 线连接。
 * @param {string} host
 * @param {number} [port]
 */
async function openConnection(host, port = 7709) {
  const connection = new TdxConnection(host, port, { timeoutMs: 10000 });
  await connection.connect();
  connection.socket.write(SETUP_ONLY);
  await connection.readResponseBody();
  return connection;
}

/**
 * 实时批量拉取 15 分钟 K 线（多连接并发）。
 *
 * @param {{
 *   targets: {market: number, code: string, symbol: string}[],
 *   hosts?: string[],
 *   concurrency?: number,
 *   category?: number,
 *   count?: number,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<Map<string, object[]>>} key = 本地风格的符号（如 sh600000）
 */
export async function fetchBarsConcurrently(options) {
  const targets = options.targets;
  const hosts = options.hosts ?? [...LIVE_HOSTS];
  const concurrency = Math.min(options.concurrency ?? 5, hosts.length);
  const category = options.category ?? PERIOD.MIN15;
  const count = options.count ?? 1216;
  const log = options.log ?? (() => {});

  const results = new Map();
  let index = 0;
  let done = 0;
  let failed = 0;

  /** 单连接顺序取数（支持分页）。 */
  async function worker(host) {
    let connection = null;
    try {
      connection = await openConnection(host);
    } catch (error) {
      log(`  主站 ${host} 连接失败：${error.message}`);
      return;
    }
    if (connection.socket.isPaused?.()) connection.socket.resume();
    for (;;) {
      const current = index;
      index += 1;
      if (current >= targets.length) break;
      const target = targets[current];
      try {
        // 分页拉取：单次上限 800 根，需要更长历史时从最新往前翻
        const pages = [];
        let fetched = 0;
        while (fetched < count) {
          const take = Math.min(PAGE_SIZE, count - fetched);
          connection.socket.write(buildBarsRequest({
            market: target.market,
            code: target.code,
            category,
            start: fetched,
            count: take,
          }));
          const body = await connection.readResponseBody();
          if (body.length <= 2) break;
          const page = parseBars(body, { category });
          if (page.length === 0) break;
          pages.unshift(page);
          fetched += page.length;
          if (page.length < take) break;
        }
        if (pages.length > 0) {
          results.set(target.symbol, pages.flat());
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
      done += 1;
      if (done % 500 === 0) log(`  实时拉取进度 ${done}/${targets.length}`);
    }
    connection.destroy();
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => worker(hosts[i % hosts.length])),
  );
  return { results, failed, total: targets.length };
}
