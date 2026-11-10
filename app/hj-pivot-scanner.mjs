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
import { listLc5Files, readLc5As, readDayFile } from './lc5-reader.js';
import { readdirSync } from 'node:fs';
import { resolvePeriod, periodNames } from './period.js';
import { classifySecurity, SECURITY_KIND, priceScale, kindLabel } from './security-type.js';
import { attachDailyContext } from './daily-context.js';
import { detectDivergence } from './hj-pivot-scan.js';
import { backtestSignal, summarize } from './backtest.js';
import { loadNameMap } from './name-service.js';
import { fetchBarsConcurrently } from './live-source.js';
import { fetchBarsHybrid } from './hybrid-source.js';
import { formatStamp } from './time-format.js';

/** ETF 默认流动性门槛：近 20 期平均成交额 1000 万元。 */
const DEFAULT_ETF_MIN_AMOUNT = 1000 * 1e4;

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
/**
 * 参数别名表：长名 + 短名 → 内部字段。
 *
 * 短名是为了手敲方便（--th=10 等价于 --threshold=10）。
 * 注意：无法识别的参数会直接报错，不再静默忽略——否则手滑写错一个参数，
 * 结果会悄悄按默认值跑，文件和内容都对不上。
 */
const OPTION_ALIASES = new Map([
  ['threshold', 'threshold'], ['th', 'threshold'],
  ['minpivots', 'minPivots'], ['min-pivots', 'minPivots'], ['mp', 'minPivots'],
  ['mingap', 'minGap'], ['min-gap', 'minGap'], ['gp', 'minGap'],
  ['mindown', 'minDownBars'], ['min-down', 'minDownBars'], ['md', 'minDownBars'],
  ['reboundcap', 'reboundCap'], ['rebound-cap', 'reboundCap'], ['rc', 'reboundCap'],
  ['minrise', 'minTotalRise'], ['min-rise', 'minTotalRise'], ['rise', 'minTotalRise'],
  ['mindrop', 'minDropPct'], ['min-drop', 'minDropPct'], ['drop', 'minDropPct'],
  ['start', 'startDate'],
  ['end', 'endDate'],
  ['tdx', 'tdxHome'],
  ['out', 'outDir'],
  ['limit', 'limit'],
  ['tail-count', 'tailCount'], ['tail', 'tailCount'],
  ['period', 'period'], ['p', 'period'],
  ['min-amount', 'minAmount'], ['liquidity', 'minAmount'],
  ['lookback', 'liquidityLookback'],
  ['concurrency', 'concurrency'], ['jobs', 'concurrency'],
  ['code', 'code'],
  ['market', 'markets'],
]);

/** 开关型参数（不带值）。 */
const FLAG_ALIASES = new Map([
  ['help', 'help'], ['h', 'help'],
  ['verbose', 'verbose'], ['v', 'verbose'],
  ['include-st', 'includeST'],
  ['no-dif', 'noDif'],
  ['live', 'live'],
  ['local', 'local'],
  ['include-etf', 'includeETF'], ['etf', 'includeETF'],
  ['hybrid', 'hybrid'],
]);

/** 参数说明，用于报错提示。 */
const KNOWN_OPTIONS_HINT = '--start --end --code --market --threshold/--th --min-down/--md '
  + '--rebound-cap/--rc --min-gap/--gp --min-rise --min-drop --min-pivots --no-dif '
  + '--include-st --tdx --out --limit --verbose';

export function parseArgs(argv) {
  const options = {
    tdxHome: DEFAULT_TDX_HOME,
    threshold: 25,
    minPivots: 2,
    minGap: 3,
    minDownBars: 2,
    reboundCap: 25,
    useDif: true,
    source: 'hybrid',
    period: '15',
    includeETF: false,
    minAmount: null,
    liquidityLookback: 20,
    concurrency: 5,
    tailCount: 16,
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

  const errors = [];
  const applyValue = (field, value, rawArg) => {
    switch (field) {
      case 'threshold': options.threshold = Number(value); break;
      case 'minPivots': options.minPivots = Number(value); break;
      case 'minGap': options.minGap = Number(value); break;
      case 'minDownBars': options.minDownBars = Number(value); break;
      case 'reboundCap': options.reboundCap = Number(value); break;
      case 'minTotalRise': options.minTotalRise = Number(value); break;
      case 'minDropPct': options.minDropPct = Number(value); break;
      case 'startDate': options.startDate = normalizeDate(value); break;
      case 'endDate': options.endDate = normalizeDate(value); break;
      case 'tdxHome': options.tdxHome = value; break;
      case 'outDir': options.outDir = value; break;
      case 'limit': options.limit = Number(value); break;
      case 'tailCount': options.tailCount = Number(value); break;
      case 'period': options.period = String(value).toLowerCase(); break;
      case 'minAmount': options.minAmount = Number(value) * 1e4; break;
      case 'liquidityLookback': options.liquidityLookback = Number(value); break;
      case 'concurrency': options.concurrency = Number(value); break;
      case 'code': options.code = String(value).trim(); break;
      case 'markets':
        options.markets = String(value).split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
        break;
      default: break;
    }
    if (value === '' || value === undefined) {
      errors.push(`参数 ${rawArg} 缺少取值`);
    }
  };

  for (const arg of argv) {
    // 支持 -v / -h 这类单横线开关
    if (arg === '-v' || arg === '-h') {
      if (arg === '-v') options.verbose = true;
      else options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      errors.push(`无法识别的参数: ${arg}（参数要以 -- 开头）`);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    const name = (equals >= 0 ? body.slice(0, equals) : body).toLowerCase();

    // 开关型
    const flag = FLAG_ALIASES.get(name);
    if (flag) {
      if (equals >= 0) {
        errors.push(`参数 --${name} 不接受取值`);
        continue;
      }
      if (flag === 'help') options.help = true;
      else if (flag === 'verbose') options.verbose = true;
      else if (flag === 'includeST') options.includeST = true;
      else if (flag === 'noDif') options.useDif = false;
      else if (flag === 'live') options.source = 'live';
      else if (flag === 'local') options.source = 'local';
      else if (flag === 'includeETF') options.includeETF = true;
      else if (flag === 'hybrid') options.source = 'hybrid';
      continue;
    }

    // 取值型
    const field = OPTION_ALIASES.get(name);
    if (!field) {
      errors.push(`无法识别的参数: --${name}`);
      continue;
    }
    const value = equals >= 0 ? body.slice(equals + 1) : undefined;
    if (value === undefined) {
      errors.push(`参数 --${name} 需要用 = 给值，例如 --${name}=10`);
      continue;
    }
    applyValue(field, value, `--${name}`);
  }

  if (errors.length > 0) {
    options.errors = errors;
    options.errorHint = `可用参数：${KNOWN_OPTIONS_HINT}`;
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
    + `${pad('低点数', 8)}${padR('HJ10', 18)}${padR('跌幅', 9)}${padR('买入价', 10)}${padR('日线连跌', 10)}`
    + `${padR('日HJ10降', 10)}${padR('日MACD降', 10)}  ${pad('区间', 30)}`,
  );
  lines.push('-'.repeat(136));
  hits.forEach((hit, index) => {
    const first = hit.chain[0].low;
    const last = hit.chain[hit.chain.length - 1].low;
    // 买入价 = 最后一个拐点的收盘价（看到拐点才能确认信号）
    const scale = hit.scale ?? 1;
    const buyPrice = hit.perf?.buyPrice;
    const buyText = Number.isFinite(buyPrice) ? (buyPrice * scale).toFixed(3) : '-';
    // 日线 HJ10 连跌天数
    const dailyText = Number.isFinite(hit.dailyDecline) ? `${hit.dailyDecline}天` : '-';
    // 日线指标：买入日 vs 前一交易日
    const dc = hit.dailyCompare;
    const hj10LowerText = dc?.hj10Lower === true ? '是' : dc?.hj10Lower === false ? '否' : '-';
    const macdLowerText = dc?.macdLower === true ? '是' : dc?.macdLower === false ? '否' : '-';
    lines.push(
      `${pad(String(index + 1), 4)}`
      + `${pad(`${hit.market}${hit.code}`, 10)}`
      + `${pad(hit.name || '-', 12)}`
      + `${pad(String(hit.chain.length), 8)}`
      + `${padR(`${first.hj10}→${last.hj10}`, 18)}`
      + `${padR(`${hit.priceDropPct.toFixed(2)}%`, 9)}`
      + `${padR(buyText, 10)}`
      + `${padR(dailyText, 10)}`
      + `${padR(hj10LowerText, 10)}`
      + `${padR(macdLowerText, 10)}  `
      + `${pad(`${first.datetime} ~ ${last.datetime}`, 30)}`,
    );
    if (verbose) {
      for (const node of hit.chain) {
        const difText = node.low.dif === null || node.low.dif === undefined ? '' : ` DIF=${node.low.dif.toFixed(3)}`;
        lines.push(
          `      低点 ${pad(node.low.datetime, 18)} HJ10=${padR(node.low.hj10.toFixed(2), 7)}${pad(difText, 14)} 收=${padR((node.low.close * scale).toFixed(3), 8)}`
          + `  → 拐点 ${pad(node.turn.datetime, 18)} HJ10=${padR(node.turn.hj10.toFixed(2), 7)}`,
        );
      }
    }
  });
  return lines.join('\n');
}

/* ---------------------------------------------------------------- 周期数据 */

/**
 * 枚举某个市场、某个周期的所有可用标的文件。
 *
 * @param {string} tdxHome
 * @param {string} market sh/sz/bj
 * @param {object} period 周期定义
 * @param {{includeETF?: boolean}} [options] 是否包含 ETF
 */
export function listKlineFiles(tdxHome, market, period, options = {}) {
  const includeETF = options.includeETF ?? false;

  /** 判断代码是否纳入。 */
  const accept = (code) => {
    const kind = classifySecurity(market, code);
    if (kind === SECURITY_KIND.STOCK) return true;
    if (kind === SECURITY_KIND.ETF) return includeETF;
    return false;
  };

  if (period.source === 'day') {
    const dir = join(tdxHome, 'vipdoc', market, 'lday');
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const fileName of files) {
      const match = /^[a-z]{2}(\d{6})\.day$/i.exec(fileName);
      if (!match) continue;
      if (!accept(match[1])) continue;
      out.push({
        market,
        code: match[1],
        file: join(dir, fileName),
        size: 1,
        kind: classifySecurity(market, match[1]),
      });
    }
    return out;
  }

  return listLc5Files(tdxHome, market)
    .filter((item) => accept(item.code))
    .map((item) => ({
      ...item,
      size: period.groupSize,
      kind: classifySecurity(market, item.code),
    }));
}

/**
 * 读本地文件，按周期聚合。
 *
 * @param {string} file
 * @param {object} period 周期定义
 */
export function readKlineFile(file, period) {
  if (period.source === 'day') return readDayFile(file);
  return readLc5As(file, period.groupSize);
}

/**
 * 流动性过滤：按最近 N 根 K 线的平均成交额筛选。
 *
 * 成交额单位是元。日线取最近 20 个交易日，分钟级取最近 N 根。
 * 只针对 ETF 生效（股票不筛，避免误杀），除非显式指定 --min-amount 用于全部标的。
 *
 * @param {object[]} bars K 线（升序）
 * @param {number} minAmount 日均成交额下限（元）
 * @param {number} lookback 取最近多少根
 * @returns {{pass: boolean, avgAmount: number}}
 */
export function checkLiquidity(bars, minAmount, lookback = 20) {
  if (!(minAmount > 0)) return { pass: true, avgAmount: Number.NaN };
  if (!bars || bars.length === 0) return { pass: false, avgAmount: 0 };
  const recent = bars.slice(-lookback);
  let total = 0;
  let counted = 0;
  for (const bar of recent) {
    const amount = Number(bar.amount);
    if (Number.isFinite(amount) && amount > 0) {
      total += amount;
      counted += 1;
    }
  }
  if (counted === 0) return { pass: false, avgAmount: 0 };
  const avgAmount = total / counted;
  return { pass: avgAmount >= minAmount, avgAmount };
}

/** A 股代码判定。 */
function isAShareCode(market, code) {
  if (market === 'sh') return /^(600|601|603|605|688|689)/.test(code);
  if (market === 'sz') return /^(000|001|002|003|300|301)/.test(code);
  if (market === 'bj') return /^(43\d|83\d|87\d|89\d|92\d)/.test(code);
  return false;
}

/* ---------------------------------------------------------------- 主流程 */

/**
 * 执行扫描。
 * @param {object} options
 */
export async function scan(options) {
  const startedAt = new Date();
  const log = (line) => process.stdout.write(`${line}\n`);

  const period = options.periodDef ?? resolvePeriod(options.period ?? '15');
  if (!period) {
    log(`  无法识别的周期：${options.period}（可用：${periodNames().join(' / ')}）`);
    return { hits: [], scanned: 0, skipped: 0 };
  }
  const periodLabel = period.label;

  log(`\nHJ10 底背离扫描（${periodLabel}）`);
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
    // 显式指定代码时无条件支持（含 ETF），不受 --include-etf 限制
    const found = listKlineFiles(options.tdxHome, market, period, { includeETF: true })
      .find((f) => f.code === match[2]);
    if (!found) {
      log(`  找不到 ${options.code} 的 ${periodLabel} 数据`);
      return { hits: [], scanned: 0, skipped: 0 };
    }
    candidates = [found];
    log(`  只扫描：${options.code}（${kindLabel(found.kind ?? SECURITY_KIND.STOCK)}）`);
  } else {
    for (const market of options.markets) {
      candidates.push(...listKlineFiles(options.tdxHome, market, period, {
        includeETF: options.includeETF,
      }));
    }
    if (options.limit) candidates.splice(options.limit);
    const etfCount = candidates.filter((c) => c.kind === SECURITY_KIND.ETF).length;
    if (etfCount > 0) log(`  其中 ETF ${etfCount} 只（--include-etf）`);
  }

  // 未指定范围 → 最近 30 个交易日
  let startDate = options.startDate;
  const endDate = options.endDate;
  if (!startDate && !endDate && candidates.length > 0) {
    const probe = readKlineFile(candidates[0].file, period);
    const days = [...new Set(probe.map((b) => b.date))].sort();
    startDate = days[Math.max(0, days.length - 30)];
    log(`  未指定范围，自动取最近 30 个交易日：${startDate} 起`);
  }
  if (startDate || endDate) log(`  范围：${startDate ?? '最长'} ~ ${endDate ?? '最新'}`);
  if (options.minAmount > 0) {
    log(`  流动性过滤：ETF 近 ${options.liquidityLookback ?? 20} 期均价成交额 ≥ `
      + `${(options.minAmount / 1e4).toFixed(0)} 万元`);
  }
  log(`  候选标的：${candidates.length} 只\n`);

  const hits = [];
  let scanned = 0;
  let skipped = 0;
  let illiquid = 0;
  const t0 = Date.now();

  // 数据源选择：
  //   hybrid（默认）本地历史 + 主站补当天
  //   live          全部从主站拉
  //   local         只读本地文件
  let liveBars = null;
  let dataSource = 'local';
  if (options.source === 'hybrid') {
    dataSource = 'hybrid';
    const targets = candidates.map((candidate) => ({
      market: candidate.market === 'sh' ? 1 : candidate.market === 'sz' ? 0 : 2,
      code: candidate.code,
      symbol: `${candidate.market}${candidate.code}`,
      file: candidate.file,
    }));
    log(`  混合模式：本地历史 + 主站补当天（${targets.length} 只，${periodLabel}）…`);
    const fetched = await fetchBarsHybrid({
      targets,
      concurrency: options.concurrency ?? 5,
      tailCount: options.tailCount ?? Math.max(period.barsPerDay * 2, 16),
      category: period.tdxCategory,
      groupSize: period.source === 'day' ? null : period.groupSize,
      log,
    });
    liveBars = fetched.results;
    log(`  数据就绪：${liveBars.size} 只（含本地历史 ${fetched.localOnly + fetched.merged} 只，`
      + `其中补了实时 ${fetched.merged} 只），耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  } else if (options.source === 'live') {
    dataSource = 'live';
    const targets = candidates.map((candidate) => ({
      market: candidate.market === 'sh' ? 1 : candidate.market === 'sz' ? 0 : 2,
      code: candidate.code,
      symbol: `${candidate.market}${candidate.code}`,
    }));
    log(`  正在从行情主站实时拉取 ${targets.length} 只股票的 ${periodLabel} K 线…`);
    const fetched = await fetchBarsConcurrently({
      targets,
      concurrency: options.concurrency ?? 5,
      count: options.liveCount ?? Math.max(period.barsPerDay * 76, 400),
      category: period.tdxCategory,
      log,
    });
    liveBars = fetched.results;
    log(`  实时数据就绪：成功 ${liveBars.size} 只，失败 ${fetched.failed} 只，`
      + `耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  }

  for (const candidate of candidates) {
    let bars;
    if (liveBars) {
      bars = liveBars.get(`${candidate.market}${candidate.code}`);
      if (!bars || bars.length === 0) {
        skipped += 1;
        continue;
      }
    } else {
      try {
        bars = readKlineFile(candidate.file, period);
      } catch {
        skipped += 1;
        continue;
      }
    }
    if (bars.length < 30) {
      skipped += 1;
      continue;
    }
    // 流动性过滤：ETF 默认过滤，股票只在显式指定 --min-amount 时过滤
    const kind = candidate.kind ?? SECURITY_KIND.STOCK;
    const minAmount = kind === SECURITY_KIND.ETF
      ? (options.minAmount ?? DEFAULT_ETF_MIN_AMOUNT)
      : (options.stockMinAmount ?? 0);
    if (minAmount > 0) {
      const liquidity = checkLiquidity(bars, minAmount, options.liquidityLookback ?? 20);
      if (!liquidity.pass) {
        illiquid += 1;
        continue;
      }
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
        kind,
        scale: priceScale(kind),
        chain: result.chain,
        hj10Rise: result.hj10Rise,
        priceDropPct: result.priceDropPct,
        reason: result.reason,
        perf,
      });
    }
  }

  log(`  已扫描 ${scanned} 只（跳过 ${skipped} 只无数据`
    + `${illiquid > 0 ? `，${illiquid} 只流动性不足` : ''}），耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

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

  // 大周期背景：日线 HJ10 连续下跌天数（用来看大周期方向对小周期信号的影响）
  attachDailyContext(hits, options.tdxHome);

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

  // 按日线连跌天数分组，观察大周期影响
  const dailyBreakdown = renderDailyBreakdown(hits);
  if (dailyBreakdown) {
    log('');
    log(dailyBreakdown);
  }

  // 按买入日指标状态分组
  const metricBreakdown = renderMetricBreakdown(hits);
  if (metricBreakdown) {
    log('');
    log(metricBreakdown);
  }

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
/**
 * 用指令参数拼文件名。
 *
 * 每个参数都带上完整的短名标识，便于一眼看出跑的什么配置：
 *   hj_20260716-20261106_th10_md1_rc15_nodif_gp3
 *   └ 日期范围 ┘      └阈值┘└连跌┘└反弹上限┘└DIF┘└间隔┘
 */
export function buildFileBaseName(options, startDate, endDate) {
  const parts = ['hj'];
  const rangeStart = startDate ?? 'all';
  parts.push(endDate ? `${rangeStart}-${endDate}` : rangeStart);
  if (options.code) parts.push(options.code);
  if (options.markets && options.markets.length < 3 && !options.code) {
    parts.push(options.markets.join('+'));
  }
  // 周期：15 分钟是默认值，其它级别显式标出
  const periodKey = options.periodDef?.key ?? options.period ?? '15';
  parts.push(periodKey === 'day' ? 'day' : `p${periodKey}`);
  parts.push(`th${options.threshold}`);
  parts.push(`md${options.minDownBars}`);
  parts.push(`rc${options.reboundCap}`);
  parts.push(options.useDif ? 'dif' : 'nodif');
  parts.push(`gp${options.minGap}`);
  if (options.minPivots !== 2) parts.push(`mp${options.minPivots}`);
  if (options.minTotalRise > 0) parts.push(`rise${options.minTotalRise}`);
  if (options.minDropPct > 0) parts.push(`drop${String(options.minDropPct).replace('.', 'p')}`);
  if (options.includeST) parts.push('st');
  return parts.join('_');
}

/**
 * 生成参数的完整文字描述，用于统计文件。
 *
 * 每个参数写清楚「名称 + 当前值 + 默认值」，方便日后回看当时的配置。
 */
export function describeParams(options, startDate, endDate) {
  const rows = [
    ['K线周期', options.periodDef?.label ?? `${options.period ?? '15'}分钟`],
    ['时间范围', endDate ? `${startDate ?? '最早'} ~ ${endDate}` : `${startDate ?? '最近30个交易日'} ~ 最新`],
    ['市场', options.code ? `单只 ${options.code}` : (options.markets ?? ['sh', 'sz', 'bj']).join('/')],
    ['HJ10低点阈值', `${options.threshold}（低于此值的点才作低点）`],
    ['左侧连跌根数', `${options.minDownBars}（小于此值视为抖动，跳过）`],
    ['反弹上限', `${options.reboundCap}（两低点之间 HJ10 涨过此值即算已反弹）`],
    ['DIF条件', options.useDif ? '开启（前低点DIF < 后低点DIF）' : '关闭（--no-dif）'],
    ['相邻低点最小间隔', `${options.minGap} 根（每根 ${options.periodDef?.label ?? (options.period ?? "15") + "分钟"}）`],
    ['最少低点数', `${options.minPivots}`],
    ['整链HJ10最小抬升', options.minTotalRise > 0 ? `${options.minTotalRise}` : '不限制'],
    ['整链最小跌幅', options.minDropPct > 0 ? `${options.minDropPct}%` : '不限制'],
    ['ST股', options.includeST ? '包含' : '排除'],
  ];
  return rows;
}

/** 结果转 CSV（含买入与 T+0/T+1/T+2 收益）。 */
export function toCsv(hits) {
  const header = '代码,名称,类型,低点数,首个低点,首HJ10,首DIF,首收盘,末个低点,末HJ10,末DIF,末收盘,HJ10抬高,价格跌幅%,'
    + '买入时间,买入价,T+0最高,T+0收益%,T+1最高,T+1收益%,T+2最高,T+2收益%,'
    + '日线HJ10连跌天数,日线HJ10,前一日线HJ10,日线HJ10是否下降,日线MACD柱,前一日线MACD柱,日线MACD柱是否缩小,拐点明细';
  const lines = [header];
  for (const hit of hits) {
    const first = hit.chain[0].low;
    const last = hit.chain[hit.chain.length - 1].low;
    const lastTurn = hit.chain[hit.chain.length - 1].turn;
    const perf = hit.perf ?? {};
    // ETF 的分钟线价格是真实价的 1/10，展示时还原
    const scale = hit.scale ?? 1;
    const detail = hit.chain
      .map((n) => `低点${n.low.datetime}(HJ10=${n.low.hj10.toFixed(2)},收=${(n.low.close * scale).toFixed(3)}`
        + `${n.low.dif === null || n.low.dif === undefined ? '' : `,DIF=${n.low.dif.toFixed(3)}`})`
        + `→拐点${n.turn.datetime}(HJ10=${n.turn.hj10.toFixed(2)})`)
      .join(' | ');
    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : '');
    const fmtPrice = (v) => (Number.isFinite(v) ? (v * scale).toFixed(3) : '');
    const fmtDif = (v) => (Number.isFinite(v) ? v.toFixed(3) : '');
    lines.push([
      `${hit.market}${hit.code}`,
      escapeCsv(hit.name || ''),
      kindLabel(hit.kind ?? SECURITY_KIND.STOCK),
      hit.chain.length,
      first.datetime,
      first.hj10.toFixed(2),
      fmtDif(first.dif),
      fmtPrice(first.close),
      last.datetime,
      last.hj10.toFixed(2),
      fmtDif(last.dif),
      fmtPrice(last.close),
      hit.hj10Rise.toFixed(2),
      hit.priceDropPct.toFixed(2),
      lastTurn.datetime,
      fmtPrice(perf.buyPrice),
      fmtPrice(perf.t0High),
      fmt(perf.t0),
      fmtPrice(perf.t1High),
      fmt(perf.t1),
      fmtPrice(perf.t2High),
      fmt(perf.t2),
      Number.isFinite(hit.dailyDecline) ? hit.dailyDecline : '',
      Number.isFinite(hit.dailyHj10) ? hit.dailyHj10.toFixed(2) : '',
      Number.isFinite(hit.dailyCompare?.hj10Prev) ? hit.dailyCompare.hj10Prev.toFixed(2) : '',
      hit.dailyCompare?.hj10Lower === true ? '是' : hit.dailyCompare?.hj10Lower === false ? '否' : '',
      Number.isFinite(hit.dailyCompare?.macdHist) ? hit.dailyCompare.macdHist.toFixed(4) : '',
      Number.isFinite(hit.dailyCompare?.macdHistPrev) ? hit.dailyCompare.macdHistPrev.toFixed(4) : '',
      hit.dailyCompare?.macdLower === true ? '是' : hit.dailyCompare?.macdLower === false ? '否' : '',
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
  lines.push('');
  lines.push('【运行参数】');
  lines.push('参数项,取值,说明');
  for (const [name, value, note] of describeParams(options, startDate, endDate)) {
    const [mainValue, ...rest] = String(value).split('（');
    const inlineNote = rest.length > 0 ? rest.join('（').replace(/）$/, '') : '';
    lines.push([name, mainValue, note ?? inlineNote].join(','));
  }
  lines.push(`实际信号数,${hits.length},符合条件的股票数`);
  lines.push('');
  lines.push('【收益口径】');
  lines.push('项目,说明');
  lines.push('买入价,最后一个拐点的收盘价（看到拐点才能确认信号）');
  lines.push('T+0,买入之后同一交易日剩余15分钟K线的最高价');
  lines.push('T+1,下一个交易日的最高价');
  lines.push('T+2,再下一个交易日的最高价');
  lines.push('收益公式,（卖出最高价 - 买入价） / 买入价 x 100%');
  lines.push('');
  lines.push('【周期汇总】');
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
  lines.push('【分段明细】1% 一段');
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
  lines.push('【逐笔明细】');
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

/**
 * 按「日线 HJ10 连跌天数」分组统计收益。
 *
 * 用来观察大周期方向对小周期信号胜率的影响：
 *   日线连跌越久，说明大周期跌得越深，小周期的底背离信号是否更弱？
 *
 * @param {object[]} hits
 * @returns {string} 渲染好的表格
 */
export function renderDailyBreakdown(hits) {
  const valid = hits.filter((hit) => hit.perf && Number.isFinite(hit.dailyDecline));
  if (valid.length === 0) return '';

  // 分组：0天 / 1-2天 / 3-5天 / 6-10天 / 11天以上
  const groups = [
    { label: '0天（日线走强或走平）', test: (d) => d === 0 },
    { label: '1-2天', test: (d) => d >= 1 && d <= 2 },
    { label: '3-5天', test: (d) => d >= 3 && d <= 5 },
    { label: '6-10天', test: (d) => d >= 6 && d <= 10 },
    { label: '11天以上（日线持续走弱）', test: (d) => d >= 11 },
  ];

  const lines = ['  按日线 HJ10 连跌天数分组（看大周期影响）'];
  lines.push('  日线连跌    样本   T+1平均    T+1胜率   T+2平均    T+2胜率');
  let printed = 0;
  for (const group of groups) {
    const subset = valid.filter((hit) => group.test(hit.dailyDecline));
    if (subset.length === 0) continue;
    const t1 = subset.map((h) => h.perf.t1).filter((v) => Number.isFinite(v));
    const t2 = subset.map((h) => h.perf.t2).filter((v) => Number.isFinite(v));
    const avg = (arr) => (arr.length === 0 ? '-' : `${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)}%`);
    const win = (arr) => (arr.length === 0 ? '-' : `${((arr.filter((v) => v > 0).length / arr.length) * 100).toFixed(1)}%`);
    lines.push(
      `  ${pad(group.label, 24)}${padR(String(subset.length), 6)}`
      + `${padR(avg(t1), 10)}${padR(win(t1), 10)}`
      + `${padR(avg(t2), 10)}${padR(win(t2), 10)}`,
    );
    printed += 1;
  }
  if (printed === 0) return '';
  return lines.join('\n');
}

/**
 * 按买入日指标状态分组统计（HJ10 是否下降、MACD柱是否缩小）。
 *
 * 观察：买入时指标本身还在走弱，是否影响后续胜率？
 *
 * @param {object[]} hits
 * @returns {string}
 */
export function renderMetricBreakdown(hits) {
  const valid = hits.filter((hit) => hit.perf && hit.dailyCompare);
  if (valid.length === 0) return '';

  const groups = [
    { label: '日线双降（HJ10+MACD）', test: (m) => m.hj10Lower === true && m.macdLower === true },
    { label: '仅日线HJ10降', test: (m) => m.hj10Lower === true && m.macdLower === false },
    { label: '仅日线MACD降', test: (m) => m.hj10Lower === false && m.macdLower === true },
    { label: '日线双升（都不降）', test: (m) => m.hj10Lower === false && m.macdLower === false },
  ];

  const lines = ['  按买入日的【日线】指标状态分组（买入日 vs 前一交易日）'];
  lines.push('  分组                     样本   T+1平均    T+1胜率   T+2平均    T+2胜率');
  let printed = 0;
  for (const group of groups) {
    const subset = valid.filter((hit) => group.test(hit.dailyCompare));
    if (subset.length === 0) continue;
    const t1 = subset.map((h) => h.perf.t1).filter((v) => Number.isFinite(v));
    const t2 = subset.map((h) => h.perf.t2).filter((v) => Number.isFinite(v));
    const avg = (arr) => (arr.length === 0 ? '-' : `${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)}%`);
    const win = (arr) => (arr.length === 0 ? '-' : `${((arr.filter((v) => v > 0).length / arr.length) * 100).toFixed(1)}%`);
    lines.push(
      `  ${pad(group.label, 26)}${padR(String(subset.length), 6)}`
      + `${padR(avg(t1), 10)}${padR(win(t1), 10)}`
      + `${padR(avg(t2), 10)}${padR(win(t2), 10)}`,
    );
    printed += 1;
  }
  if (printed === 0) return '';
  return lines.join('\n');
}

function escapeCsv(text) {
  const value = String(text ?? '');
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/* ---------------------------------------------------------------- 入口 */

function printHelp() {
  process.stdout.write([
    '通达信 · HJ10 底背离扫描（支持 5/15/30 分钟 与 日线）',
    '',
    '判定：HJ10<25 的低点，连续 >=2 个，后一个低点的 HJ10 抬高、收盘价创新低',
    '',
    '用法：',
    '  node hj-pivot-scanner.mjs --period=5                       5分钟级别',
    '  node hj-pivot-scanner.mjs --period=30                      30分钟级别',
    '  node hj-pivot-scanner.mjs --period=day                     日线级别',
    '  node hj-pivot-scanner.mjs                                       扫描全部A股（最近30个交易日）',
    '  node hj-pivot-scanner.mjs --start=2026-10-01 --end=2026-11-06   指定时间范围',
    '  node hj-pivot-scanner.mjs --code=sh603578 --verbose             只看单只股票',
    '',
    '参数：',
    '  --start=YYYY-MM-DD   起始日期（含）',
    '  --end=YYYY-MM-DD     结束日期（含）',
    '  --code=sh603578      只扫描指定股票',
    '  --period=15          K线周期：5 / 15 / 30 / day（默认 15，可简写 --p）',
    '  --threshold=25       低点 HJ10 阈值（默认 25，可简写 --th）',
    '  --min-pivots=2       最少低点数（默认 2，可简写 --mp）',
    '  --min-down=2         低点左侧最小连续下跌根数（默认 2，可简写 --md）',
    '  --min-gap=3          相邻低点最小间隔（根，默认 3，可简写 --gp）',
    '  --rebound-cap=25     两低点之间 HJ10 上限（默认 25，可简写 --rc）',
    '  --no-dif             关闭 DIF 条件（默认要求 前低点DIF < 后低点DIF）',
    '',
    '数据源（默认 --hybrid）:',
    '  --hybrid             本地历史 + 主站补当天（推荐，盘中用这个）',
    '  --local              只读本地 .lc5 文件（盘后，最快约 7 秒）',
    '  --live               全部从行情主站拉历史（约 85 秒）',
    '  --jobs=5             并发连接数（配合 hybrid/live）',
    '  --tail=16            混合模式每只补多少根实时K线（默认16）',
    '  --min-rise=0         整链 HJ10 最小抬升量（默认 0，调大更严格）',
    '  --min-drop=0         整链最小跌幅百分比（默认 0，调大更严格）',
    '  --market=sh,sz,bj    只扫指定市场（默认全部）',
    '  --include-st         包含 ST 股（默认排除）',
    '  --include-etf        包含 ETF（默认只扫股票，ETF 受流动性过滤）',
    '  --min-amount=1000    ETF 流动性门槛：近20期平均成交额（万元，默认1000）',
    '  --lookback=20        流动性统计取最近多少根',
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
  } else if (options.errors && options.errors.length > 0) {
    process.stdout.write('参数有误：\n');
    for (const error of options.errors) process.stdout.write(`  · ${error}\n`);
    process.stdout.write(`\n${options.errorHint}\n`);
    process.exit(2);
  } else if (!existsSync(options.tdxHome)) {
    process.stdout.write(`通达信目录不存在：${options.tdxHome}\n`);
    process.exit(1);
  } else {
    await scan(options);
    process.exit(0);
  }
}
