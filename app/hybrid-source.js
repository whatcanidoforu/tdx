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

import { readLc5As, readDayFile } from './lc5-reader.js';
import { TdxConnection } from './tdx-protocol.js';
import { buildBarsRequest, parseBars, PERIOD } from './market-bars.js';
import { analyzeGap, applyPatch, filterByDates, sanitizeBars } from './gap-filler.js';

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
  const category = options.category ?? PERIOD.MIN15;
  const groupSize = options.groupSize === undefined ? 3 : options.groupSize;
  const today = options.today ?? localToday();
  const log = options.log ?? (() => {});

  const results = new Map();
  let index = 0;
  let done = 0;
  let failed = 0;
  let merged = 0;
  let localOnly = 0;

  // 缺口统计
  const gapStats = {
    filled: 0,
    staleOnly: 0,
    missingDates: new Set(),
    filledDates: new Set(),
    filledSamples: [],
  };

  // 探测窗口：要足够覆盖缺口。15 分钟一天 16 根，5 天 = 80 根，取 400 更保险
  const gapProbeCount = options.gapProbeCount ?? 400;

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

      // 1) 读本地历史（按周期聚合）
      let local = [];
      if (target.file) {
        try {
          local = groupSize === null ? readDayFile(target.file) : readLc5As(target.file, groupSize);
        } catch {
          local = [];
        }
      }

      // 2) 先拉一段足够覆盖「缺口 + 当天」的数据
      //    缺口的判断需要拿到主站的日期序列，所以第一次先多拉一些
      const probeCount = Math.max(tailCount, gapProbeCount);
      let probe = [];
      try {
        connection.socket.write(buildBarsRequest({
          market: target.market,
          code: target.code,
          category,
          start: 0,
          count: probeCount,
        }));
        const body = await connection.readResponseBody();
        if (body.length > 2) probe = sanitizeBars(parseBars(body, { category }));
      } catch {
        failed += 1;
      }

      // 3) 检测缺口并用主站数据补齐
      let combined = local;
      let patched = 0;
      const localDates = local.map((bar) => bar.date);
      const probeDates = probe.map((bar) => bar.date);
      const gap = analyzeGap(localDates, probeDates);

      if (gap.missing.length > 0) {
        // 主站数据里已经包含缺口日期，直接整段合并即可
        const patchDates = new Set(gap.missing);
        const patchBars = filterByDates(probe, patchDates);
        const applied = applyPatch(local, patchBars);
        combined = applied.bars;
        patched = gap.missing.length;
        gapStats.filled += 1;
        gapStats.filledDates.add(gap.missing.join(','));
        if (gapStats.filledSamples.length < 5) {
          gapStats.filledSamples.push(`${target.symbol}: 补 ${gap.missing.join(',')}（${patchBars.length} 根）`);
        }
      } else if (gap.stale && local.length > 0 && probe.length > 0) {
        // 本地落后但没有「中间缺口」（可能只是当天还没落盘），记录但不算问题
        gapStats.staleOnly += 1;
      }

      // 4) 合并当天最新数据
      combined = mergeBars(combined, probe);
      if (combined.length > 0) results.set(target.symbol, combined);
      if (local.length > 0 && probe.length > 0) merged += 1;
      else if (local.length > 0) localOnly += 1;
      if (patched > 0) {
        const missingSet = new Set(gap.missing);
        for (const date of missingSet) gapStats.missingDates.add(date);
      }

      done += 1;
      if (done % 500 === 0) {
        log(`  混合拉取进度 ${done}/${targets.length}（本地 ${localOnly}，已补实时 ${merged}，补缺口 ${gapStats.filled}）`);
      }
    }
    connection.destroy();
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => worker(hosts[i % hosts.length])),
  );

  return {
    results,
    failed,
    merged,
    localOnly,
    today,
    gap: {
      filled: gapStats.filled,
      staleOnly: gapStats.staleOnly,
      missingDates: [...gapStats.missingDates].sort(),
      samples: gapStats.filledSamples,
    },
  };
}

/** 本机今天的 YYYYMMDD。 */
function localToday() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}
