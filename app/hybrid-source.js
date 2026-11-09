/**
 * 混合数据源 —— 本地历史 + 实时当日。
 *
 * 设计依据（用户的实际工作流）：
 *   · 每天收盘后手动更新本地 `vipdoc\...\fzline\*.lc5`（5 分钟线）
 *   · 盘中只想补「当天」的 K 线
 *
 * 因此无需每次从主站拉全部历史：
 *   1. 本地读全量历史（快，毫秒级）
 *   2. 主站只拉最近 N 根（N 小则快），把其中「晚于本地最新日期」的补齐
 *   3. 两者拼接 → 得到完整的最新序列
 *
 * 好处：全市场只需「本地读 + 每只一次小请求」，比拉 1216 根历史快一个数量级。
 *
 * @module dsh-tdx/app/hybrid-source
 */

import { readLc5As15Min } from './lc5-reader.js';
import { TdxConnection } from './tdx-protocol.js';
import { buildBarsRequest, parseBars, PERIOD } from './market-bars.js';

/** 单次请求根数上限。 */
const PAGE_SIZE = 800;

/** 每次只补当天，请求 16 根足够覆盖（一天 16 根 15 分钟 K 线 + 边界）。 */
const DEFAULT_TAIL = 16;

/** K 线连接只发 SetupCmd1。 */
const SETUP_ONLY = Buffer.from('0c0218930001030003000d0001', 'hex');

/** 默认主站池。 */
export const HYBRID_HOSTS = Object.freeze([
  '110.41.2.72',
  '101.33.225.16',
  '175.178.112.197',
  '43.139.95.83',
  '111.231.113.208',
  '175.178.128.227',
]);

/** 建一条 K 线连接。 */
async function openConnection(host, port = 7709) {
  const connection = new TdxConnection(host, port, { timeoutMs: 10000 });
  await connection.connect();
  connection.socket.write(SETUP_ONLY);
  await connection.readResponseBody();
  return connection;
}

/**
 * 把「实时尾部」合并进「本地历史」。
 *
 * 规则：以日期+时间为键，实时数据覆盖本地同键记录（盘中最后一根可能还在变动）；
 *       本地已有、实时没有的保留；最终按时间升序。
 *
 * @param {object[]} local 本地历史（升序）
 * @param {object[]} tail 主站返回的最近若干根（升序）
 * @returns {object[]}
 */
export function mergeBars(local, tail) {
  if (!tail || tail.length === 0) return local;
  if (!local || local.length === 0) return tail;

  const map = new Map();
  for (const bar of local) map.set(`${bar.date}${bar.time}`, bar);
  for (const bar of tail) map.set(`${bar.date}${bar.time}`, bar);

  return [...map.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
  });
}

/**
 * 混合模式批量取数。
 *
 * @param {{
 *   targets: {market: number, code: string, symbol: string, file?: string}[],
 *   hosts?: string[],
 *   concurrency?: number,
 *   tailCount?: number,
 *   today?: string,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{results: Map<string, object[]>, failed: number, merged: number, localOnly: number}>}
 */
export async function fetchBarsHybrid(options) {
  const targets = options.targets;
  const hosts = options.hosts ?? [...HYBRID_HOSTS];
  const concurrency = Math.min(options.concurrency ?? 5, hosts.length);
  const tailCount = options.tailCount ?? DEFAULT_TAIL;
  const today = options.today ?? localToday();
  const log = options.log ?? (() => {});

  const results = new Map();
  let index = 0;
  let done = 0;
  let failed = 0;
  let merged = 0;
  let localOnly = 0;

  /** 单连接顺序补当天。 */
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

      // 1) 读本地历史
      let local = [];
      if (target.file) {
        try {
          local = readLc5As15Min(target.file);
        } catch {
          local = [];
        }
      }

      // 2) 只拉最近几根
      let tail = [];
      try {
        connection.socket.write(buildBarsRequest({
          market: target.market,
          code: target.code,
          category: PERIOD.MIN15,
          start: 0,
          count: tailCount,
        }));
        const body = await connection.readResponseBody();
        if (body.length > 2) tail = parseBars(body, { category: PERIOD.MIN15 });
      } catch {
        failed += 1;
      }

      // 3) 合并
      const combined = mergeBars(local, tail);
      if (combined.length > 0) results.set(target.symbol, combined);
      if (local.length > 0 && tail.length > 0) merged += 1;
      else if (local.length > 0) localOnly += 1;

      done += 1;
      if (done % 500 === 0) log(`  混合拉取进度 ${done}/${targets.length}（本地 ${localOnly}，已补实时 ${merged}）`);
    }
    connection.destroy();
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => worker(hosts[i % hosts.length])),
  );

  return { results, failed, merged, localOnly, today };
}

/** 本机今天的 YYYYMMDD。 */
function localToday() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}
