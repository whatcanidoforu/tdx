#!/usr/bin/env node
/**
 * 通达信 · HJ10 底背离扫描（15 分钟级别）
 *
 * 判定口径（以 603578 三星新材 2026-10-08/09 为例）：
 *
 *   低点1  10-08 14:45  HJ10=10.37  收=13.78
 *   拐点1  10-08 15:00  HJ10=18.17  收=14.18   ← HJ10 比低点抬高，即成拐点
 *   低点2  10-09 11:30  HJ10=15.69  收=13.27
 *   拐点2  10-09 13:15  HJ10=16.22  收=13.38   ← HJ10 比低点抬高，即成拐点
 *
 *   判定：低点2.HJ10(15.69) > 低点1.HJ10(10.37)  → 指标抬高
 *         低点2.收盘(13.27)  < 低点1.收盘(13.78)  → 价格创新低
 *         两个低点 HJ10 都 < 25
 *         → 底背离成立
 *
 * 用法：
 *
 *   扫描全部 A 股（默认最近 30 个交易日）
 *     node hj-pivot-scanner.mjs
 *
 *   指定时间范围
 *     node hj-pivot-scanner.mjs --start=2026-10-01 --end=2026-11-06
 *
 *   只看某只股票
 *     node hj-pivot-scanner.mjs --code=sh603578 --start=2026-10-08 --end=2026-10-10
 *
 * 输出：控制台表格 + `hj-pivot-scan\result-<时间戳>.csv` + `hj-pivot-scan\latest.csv`
 *
 * @module dsh-tdx/app/hj-pivot-scanner
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listLc5Files, readLc5As15Min } from './lc5-reader.js';
import { detectDivergence } from './hj-pivot-scan.js';
import { backtestSignal, summarize } from './backtest.js';
import { loadNameMap } from './name-service.js';
import { formatStamp } from './time-format.js';

/** 默认通达信目录。 */
const DEFAULT_TDX_HOME = 'D:\\MyTools\\new_tdx';

/* --------------------------------------------------------------- 参数解析 */

/** 把 `2026-09-01` / `20260901` / `2026/09/01` 统一成 `YYYYMMDD`。 */
function normalizeDate(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^\d]/g, '');
  return digits.length === 8 ? digits : null;
}

/**
 * 解析命令行。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    tdxHome: DEFAULT_TDX_HOME,
    threshold: 25,
    minPivots: 2,
    minGap: 3,
    minDownBars: 2,
    reboundCap: 25,
    useDif: true,
    minTotalRise: 0,
    minDropPct: 0,
    startDate: null,
    endDate: null,
    markets: ['sh', 'sz', 'bj'],
    code: null,
    outDir: null,
    verbose: false,
    limit: null,
    includeST: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (arg === '--include-st') options.includeST = true;
    else if (arg.startsWith('--threshold=')) options.threshold = Number(arg.slice(12));
    else if (arg.startsWith('--min-pivots=')) options.minPivots = Number(arg.slice(13));
    else if (arg.startsWith('--min-gap=')) options.minGap = Number(arg.slice(10));
    else if (arg.startsWith('--min-down=')) options.minDownBars = Number(arg.slice(11));
    else if (arg.startsWith('--rebound-cap=')) options.reboundCap = Number(arg.slice(14));
    else if (arg === '--no-dif') options.useDif = false;
    else if (arg.startsWith('--min-rise=')) options.minTotalRise = Number(arg.slice(11));
    else if (arg.startsWith('--min-drop=')) options.minDropPct = Number(arg.slice(11));
    else if (arg.startsWith('--start=')) options.startDate = normalizeDate(arg.slice(8));
    else if (arg.startsWith('--end=')) options.endDate = normalizeDate(arg.slice(6));
    else if (arg.startsWith('--tdx=')) options.tdxHome = arg.slice(6);
    else if (arg.startsWith('--out=')) options.outDir = arg.slice(6);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--code=')) options.code = arg.slice(7).trim();
    else if (arg.startsWith('--market=')) {
      options.markets = arg.slice(9).split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
    }
  }
  return options;
}

/* ---------------------------------------------------------------- 输出 */

const EW = (text) => {
  let width = 0;
  for (const ch of String(text ?? '')) width += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return width;
};
const pad = (text, width) => String(text ?? '') + ' '.repeat(Math.max(0, width - EW(text)));
const padR = (text, width) => ' '.repeat(Math.max(0, width - EW(text))) + String(text ?? '');

/**
 * 渲染结果表格。
 * @param {object[]} hits
 * @param {boolean} verbose
 */
export function renderTable(hits, verbose = false) {
  if (hits.length === 0) return '  （没有符合条件的股票）';
  const lines = [];
  lines.push(
    `${pad('#', 4)}${pad('代码', 10)}${pad('名称', 12)}`
    + `${pad('低点数', 8)}${padR('HJ10', 18)}${padR('跌幅', 9)}  ${pad('区间', 30)}`,
  );
  lines.push('-'.repeat(94));
  hits.forEach((hit, index) => {
    const first = hit.chain[0].low;
    const last = hit.chain[hit.chain.length - 1].low;
    lines.push(
      `${pad(String(index + 1), 4)}`
      + `${pad(`${hit.market}${hit.code}`, 10)}`
      + `${pad(hit.name || '-', 12)}`
      + `${pad(String(hit.chain.length), 8)}`
      + `${padR(`${first.hj10}→${last.hj10}`, 18)}`
      + `${padR(`${hit.priceDropPct.toFixed(2)}%`, 9)}  `
      + `${pad(`${first.datetime} ~ ${last.datetime}`, 30)}`,
    );
    if (verbose) {
      for (const node of hit.chain) {
        const difText = node.low.dif === null || node.low.dif === undefined ? '' : ` DIF=${node.low.dif.toFixed(3)}`;
        lines.push(
          `      低点 ${pad(node.low.datetime, 18)} HJ10=${padR(node.low.hj10.toFixed(2), 7)}${pad(difText, 14)} 收=${padR(node.low.close.toFixed(2), 8)}`
          + `  → 拐点 ${pad(node.turn.datetime, 18)} HJ10=${padR(node.turn.hj10.toFixed(2), 7)}`,
        );
      }
    }
  });
  return lines.join('\n');
}

/* ---------------------------------------------------------------- 主流程 */

/**
 * 执行扫描。
 * @param {object} options
 */
export async function scan(options) {
  const startedAt = new Date();
  const log = (line) => process.stdout.write(`${line}\n`);

  log(`\nHJ10 底背离扫描（15 分钟）`);
  log(`  通达信目录：${options.tdxHome}`);
  log(`  口径：HJ10<${options.threshold} 的低点，连续 ≥${options.minPivots} 个，后低点 HJ10 抬高 + 收盘价新低`);

  // 候选池
  let candidates = [];
  if (options.code) {
    const match = /^([a-z]{2})(\d{6})$/i.exec(options.code);
    if (!match) {
      log(`  --code 格式错误，应为 sh603578 这种形式`);
      return { hits: [], scanned: 0, skipped: 0 };
    }
    const market = match[1].toLowerCase();
    const found = listLc5Files(options.tdxHome, market).find((f) => f.code === match[2]);
    if (!found) {
      log(`  找不到 ${options.code} 的 15 分钟数据`);
      return { hits: [], scanned: 0, skipped: 0 };
    }
    candidates = [found];
    log(`  只扫描：${options.code}`);
  } else {
    for (const market of options.markets) {
      candidates.push(...listLc5Files(options.tdxHome, market));
    }
    if (options.limit) candidates.splice(options.limit);
  }

  // 未指定范围 → 最近 30 个交易日
  let startDate = options.startDate;
  const endDate = options.endDate;
  if (!startDate && !endDate && candidates.length > 0) {
    const probe = readLc5As15Min(candidates[0].file);
    const days = [...new Set(probe.map((b) => b.date))].sort();
    startDate = days[Math.max(0, days.length - 30)];
    log(`  未指定范围，自动取最近 30 个交易日：${startDate} 起`);
  }
  if (startDate || endDate) log(`  范围：${startDate ?? '最早'} ~ ${endDate ?? '最新'}`);
  log(`  候选股票：${candidates.length} 只\n`);

  const hits = [];
  let scanned = 0;
  let skipped = 0;
  const t0 = Date.now();

  for (const candidate of candidates) {
    let bars;
    try {
      bars = readLc5As15Min(candidate.file);
    } catch {
      skipped += 1;
      continue;
    }
    if (bars.length < 30) {
      skipped += 1;
      continue;
    }
    const result = detectDivergence(bars, {
      threshold: options.threshold,
      minPivots: options.minPivots,
      minGap: options.minGap,
      minDownBars: options.minDownBars,
      reboundCap: options.reboundCap,
      useDif: options.useDif,
      minHj10Rise: options.minHj10Rise ?? 0,
      minTotalRise: options.minTotalRise,
      minDropPct: options.minDropPct,
      startDate,
      endDate,
    });
    scanned += 1;
    if (result.matched) {
      // 回测：用最后一个拐点的收盘价买入
      const lastTurnIndex = result.chain[result.chain.length - 1].turnIndex;
      const perf = backtestSignal(bars, lastTurnIndex);
      hits.push({
        market: candidate.market,
        code: candidate.code,
        name: '',
        chain: result.chain,
        hj10Rise: result.hj10Rise,
        priceDropPct: result.priceDropPct,
        reason: result.reason,
        perf,
      });
    }
  }

  log(`  已扫描 ${scanned} 只（跳过 ${skipped} 只无数据），耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

  // 补名称
  const outDir = options.outDir ?? join(process.cwd(), 'hj-pivot-scan');
  if (hits.length > 0) {
    const nameMap = await loadNameMap({
      cacheFile: join(outDir, 'names.json'),
      tdxHome: options.tdxHome,
      log,
      refresh: false,
      fetchFromServer: async () => {
        const { MarketDataClient } = await import('./market-data.js');
        const client = new MarketDataClient({ log });
        try {
          await client.connect();
          const items = [];
          for (const [id, marketCode] of [[1, 'sh'], [0, 'sz'], [2, 'bj']]) {
            try {
              const list = await client.fetchListPages(id);
              for (const item of list) items.push({ market: marketCode, code: item.code, name: item.name });
            } catch (error) {
              log(`  ${marketCode} 名称获取失败：${error.message}`);
            }
          }
          return items;
        } finally {
          await client.disconnect();
        }
      },
    });
    for (const hit of hits) hit.name = nameMap.get(`${hit.market}${hit.code}`) ?? '';
  }

  // ST 过滤
  const beforeFilter = hits.length;
  const kept = options.includeST ? hits : hits.filter((hit) => !/ST|\*|退/.test(hit.name ?? ''));
  hits.length = 0;
  hits.push(...kept);

  // 排序：低点数多的优先，其次 HJ10 抬升大的
  hits.sort((a, b) => (b.chain.length - a.chain.length) || (b.hj10Rise - a.hj10Rise));

  log(`\n  符合条件：${hits.length} 只`);
  if (!options.includeST && beforeFilter > hits.length) {
    log(`  （已过滤 ${beforeFilter - hits.length} 只 ST/退市股，加 --include-st 可保留）`);
  }
  log('');
  log(renderTable(hits, options.verbose));

  // 收益统计
  const stats = summarize(hits.map((hit) => hit.perf).filter(Boolean));
  log('');
  log(renderStats(stats));

  // 落盘：文件名用参数拼
  if (hits.length > 0) {
    await mkdir(outDir, { recursive: true });
    const baseName = buildFileBaseName(options, startDate, endDate);
    const resultFile = join(outDir, `${baseName}.csv`);
    const statsFile = join(outDir, `${baseName}_统计.csv`);
    await writeFile(resultFile, toCsv(hits), 'utf8');
    await writeFile(statsFile, toStatsCsv(hits, stats, options, startDate, endDate), 'utf8');
    log(`\n  选股结果：${resultFile}`);
    log(`  收益统计：${statsFile}`);
  }

  return { hits, stats, scanned, skipped, startDate, endDate, startedAt };
}

/**
 * 用指令参数拼文件名。
 * 例：hj_20261008_20261106_md2_rc25_mr0_md0p0
 */
export function buildFileBaseName(options, startDate, endDate) {
  const parts = ['hj'];
  parts.push(startDate ?? 'all');
  if (endDate) parts.push(`to${endDate}`);
  if (options.code) parts.push(options.code);
  if (options.markets && options.markets.length < 3 && !options.code) {
    parts.push(options.markets.join('+'));
  }
  parts.push(`th${options.threshold}`);
  parts.push(`md${options.minDownBars}`);
  parts.push(`rc${options.reboundCap}`);
  if (!options.useDif) parts.push('nodif');
  parts.push(`gp${options.minGap}`);
  if (options.minTotalRise > 0) parts.push(`rise${options.minTotalRise}`);
  if (options.minDropPct > 0) parts.push(`drop${String(options.minDropPct).replace('.', 'p')}`);
  if (options.includeST) parts.push('st');
  return parts.join('_');
}

/** 结果转 CSV（含买入与 T+0/T+1/T+2 收益）。 */
export function toCsv(hits) {
  const header = '代码,名称,低点数,首个低点,首HJ10,首DIF,首收盘,末个低点,末HJ10,末DIF,末收盘,HJ10抬高,价格跌幅%,'
    + '买入时间,买入价,T+0最高,T+0收益%,T+1最高,T+1收益%,T+2最高,T+2收益%,拐点明细';
  const lines = [header];
  for (const hit of hits) {
    const first = hit.chain[0].low;
    const last = hit.chain[hit.chain.length - 1].low;
    const lastTurn = hit.chain[hit.chain.length - 1].turn;
    const perf = hit.perf ?? {};
    const detail = hit.chain
      .map((n) => `低点${n.low.datetime}(HJ10=${n.low.hj10.toFixed(2)},收=${n.low.close.toFixed(2)}`
        + `${n.low.dif === null || n.low.dif === undefined ? '' : `,DIF=${n.low.dif.toFixed(3)}`})`
        + `→拐点${n.turn.datetime}(HJ10=${n.turn.hj10.toFixed(2)})`)
      .join(' | ');
    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '');
    const fmtDif = (v) => (Number.isFinite(v) ? v.toFixed(3) : '');
    lines.push([
      `${hit.market}${hit.code}`,
      escapeCsv(hit.name || ''),
      hit.chain.length,
      first.datetime,
      first.hj10.toFixed(2),
      fmtDif(first.dif),
      first.close.toFixed(2),
      last.datetime,
      last.hj10.toFixed(2),
      fmtDif(last.dif),
      last.close.toFixed(2),
      hit.hj10Rise.toFixed(2),
      hit.priceDropPct.toFixed(2),
      lastTurn.datetime,
      fmt(perf.buyPrice),
      fmt(perf.t0High),
      fmt(perf.t0),
      fmt(perf.t1High),
      fmt(perf.t1),
      fmt(perf.t2High),
      fmt(perf.t2),
      escapeCsv(detail),
    ].join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * 收益统计 CSV。
 *
 * 结构：
 *   1. 汇总行（T+0/T+1/T+2 的样本数、平均、最大、最小、胜率）
 *   2. 分段明细（1% 一段：区间、笔数、占比）
 *   3. 逐笔明细
 */
export function toStatsCsv(hits, stats, options, startDate, endDate) {
  const lines = [];
  lines.push('HJ10底背离 收益统计');
  lines.push(`范围,${startDate ?? '全部'} ~ ${endDate ?? '最新'}`);
  lines.push(`参数,HJ10阈值=${options.threshold},左侧连跌=${options.minDownBars},反弹上限=${options.reboundCap},`
    + `DIF条件=${options.useDif ? '开启' : '关闭'},`
    + `间隔=${options.minGap},信号数=${hits.length}`);
  lines.push('买入价,最后一个拐点收盘价');
  lines.push('');
  lines.push('周期,样本数,平均收益%,最大%,最小%,胜率%');
  for (const [key, label] of [['t0', 'T+0（买入当日）'], ['t1', 'T+1（次日）'], ['t2', 'T+2（第三日）']]) {
    const s = stats[key];
    lines.push([
      label,
      s.count,
      s.avg ?? '',
      s.max ?? '',
      s.min ?? '',
      s.winRate ?? '',
    ].join(','));
  }
  lines.push('');
  lines.push('分段明细（1% 一段）');
  lines.push('区间,T+0笔数,T+0占比%,T+1笔数,T+1占比%,T+2笔数,T+2占比%');
  // 收集所有出现过的分段
  const labels = new Set();
  for (const key of ['t0', 't1', 't2']) {
    for (const bucket of stats[key].buckets) labels.add(bucket.label);
  }
  const sortedLabels = [...labels].sort((a, b) => Number(a.split('~')[0]) - Number(b.split('~')[0]));
  for (const label of sortedLabels) {
    const cells = [label];
    for (const key of ['t0', 't1', 't2']) {
      const bucket = stats[key].buckets.find((b) => b.label === label);
      cells.push(bucket ? bucket.count : 0);
      cells.push(bucket ? Number(bucket.ratio.toFixed(2)) : 0);
    }
    lines.push(cells.join(','));
  }
  lines.push('');
  lines.push('逐笔明细');
  lines.push('代码,名称,买入时间,买入价,T+0收益%,T+1收益%,T+2收益%');
  for (const hit of hits) {
    const perf = hit.perf;
    if (!perf) continue;
    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '');
    lines.push([
      `${hit.market}${hit.code}`,
      escapeCsv(hit.name || ''),
      `${perf.buyDate} ${perf.buyTime}`,
      perf.buyPrice.toFixed(2),
      fmt(perf.t0),
      fmt(perf.t1),
      fmt(perf.t2),
    ].join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** 控制台渲染收益统计。 */
export function renderStats(stats) {
  const lines = ['  收益统计（买入价 = 最后一个拐点收盘价）'];
  lines.push('  周期      样本数    平均     最大     最小    胜率');
  for (const [key, label] of [['t0', 'T+0'], ['t1', 'T+1'], ['t2', 'T+2']]) {
    const s = stats[key];
    const f = (v) => (v === null ? '-' : `${v.toFixed(2)}%`);
    lines.push(
      `  ${pad(label, 8)}${padR(String(s.count), 8)}${padR(f(s.avg), 10)}${padR(f(s.max), 9)}`
      + `${padR(f(s.min), 9)}${padR(s.winRate === null ? '-' : `${s.winRate.toFixed(1)}%`, 8)}`,
    );
  }
  return lines.join('\n');
}

function escapeCsv(text) {
  const value = String(text ?? '');
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/* ---------------------------------------------------------------- 入口 */

function printHelp() {
  process.stdout.write([
    '通达信 · HJ10 底背离扫描（15 分钟级别）',
    '',
    '判定：HJ10<25 的低点，连续 >=2 个，后一个低点的 HJ10 抬高、收盘价创新低',
    '',
    '用法：',
    '  node hj-pivot-scanner.mjs                                       扫描全部A股（最近30个交易日）',
    '  node hj-pivot-scanner.mjs --start=2026-10-01 --end=2026-11-06   指定时间范围',
    '  node hj-pivot-scanner.mjs --code=sh603578 --verbose             只看单只股票',
    '',
    '参数：',
    '  --start=YYYY-MM-DD   起始日期（含）',
    '  --end=YYYY-MM-DD     结束日期（含）',
    '  --code=sh603578      只扫描指定股票',
    '  --threshold=25       低点 HJ10 阈值（默认 25）',
    '  --min-pivots=2       最少低点数（默认 2）',
    '  --min-down=2         低点左侧最小连续下跌根数（小于此视为抖动，默认 2）',
    '  --min-gap=3          相邻低点最小间隔（根，默认 3）',
    '  --rebound-cap=25     两个低点之间 HJ10 最高不能超过该值（超过=已反弹，默认 25）',
    '  --no-dif             关闭 DIF 条件（默认要求 前低点DIF < 后低点DIF）',
    '  --min-rise=0         整链 HJ10 最小抬升量（默认 0，调大更严格）',
    '  --min-drop=0         整链最小跌幅百分比（默认 0，调大更严格）',
    '  --market=sh,sz,bj    只扫指定市场（默认全部）',
    '  --include-st         包含 ST 股（默认排除）',
    '  --tdx=<目录>         通达信目录（默认 D:\\MyTools\\new_tdx）',
    '  --out=<目录>         输出目录（默认 ./hj-pivot-scan）',
    '  --limit=N            只扫前 N 只（调试用）',
    '  -v, --verbose        打印每个低点/拐点明细',
    '  -h, --help           显示帮助',
    '',
  ].join('\n'));
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const norm = (v) => resolve(v).replace(/\\/g, '/').toLowerCase();
  return norm(import.meta.url.replace(/^file:\/\/\/?/, '')) === norm(process.argv[1]);
}

if (isMainModule()) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else if (!existsSync(options.tdxHome)) {
    process.stdout.write(`通达信目录不存在：${options.tdxHome}\n`);
    process.exit(1);
  } else {
    await scan(options);
    process.exit(0);
  }
}
