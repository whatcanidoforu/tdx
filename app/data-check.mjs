#!/usr/bin/env node
/**
 * 通达信数据体检工具 —— 检查本地 5 分钟线与日线的起始/结束日期。
 *
 * 用途：确认本地数据覆盖范围、发现停更或缺口、对比各市场同步情况。
 *
 * 特性：
 *   · 只读每个文件的首尾记录（不整文件加载），全量扫描 5 万+ 文件也很快
 *   · 按市场 × 周期分别统计起始日/结束日分布
 *   · 支持只查某市场、某周期、某只股票
 *   · 支持把明细导出 CSV
 *
 * 用法：
 *   node data-check.mjs                     检查全部（5分钟 + 日线）
 *   node data-check.mjs --period=5min       只查 5 分钟线
 *   node data-check.mjs --period=day        只查日线
 *   node data-check.mjs --market=sh         只查沪市
 *   node data-check.mjs --code=sh600000     只查单只
 *   node data-check.mjs --export            导出明细到 CSV
 *
 * @module app/data-check
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_TDX_HOME = 'D:\\MyTools\\new_tdx';
const RECORD_BYTES = 32;

/** 周期定义。 */
const PERIODS = {
  '5min': { key: '5min', label: '5分钟', dir: 'fzline', ext: '.lc5', compressedDate: true },
  day: { key: 'day', label: '日线', dir: 'lday', ext: '.day', compressedDate: false },
};

const MARKETS = ['sh', 'sz', 'bj'];

/* ------------------------------------------------------------ 解析日期 */

/** 解码 .lc5 的压缩日期：（年-2004）*2048 + 月*100 + 日。 */
function decodeCompressedDate(value) {
  const year = (value >> 11) + 2004;
  const month = Math.trunc((value % 2048) / 100);
  const day = (value % 2048) % 100;
  return formatDate(year, month, day);
}

/** 解码 .day 的 YYYYMMDD 整数。 */
function decodePlainDate(value) {
  const year = Math.trunc(value / 10000);
  const month = Math.trunc((value % 10000) / 100);
  const day = value % 100;
  return formatDate(year, month, day);
}

function formatDate(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 读取一个文件的首尾记录日期（只读 32 字节 × 2，不加载全文）。
 *
 * @param {string} file
 * @param {{compressedDate: boolean}} period
 * @returns {{first: string|null, last: string|null, count: number}}
 */
export function readFileRange(file, period) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return { first: null, last: null, count: 0 };
  }
  const count = Math.floor(size / RECORD_BYTES);
  if (count === 0) return { first: null, last: null, count: 0 };

  const head = Buffer.alloc(4);
  const tail = Buffer.alloc(4);
  let fd;
  try {
    fd = openSync(file, 'r');
    readSync(fd, head, 0, 4, 0);
    readSync(fd, tail, 0, 4, (count - 1) * RECORD_BYTES);
  } catch {
    return { first: null, last: null, count };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const decode = period.compressedDate
    ? (buf) => decodeCompressedDate(buf.readUInt16LE(0))
    : (buf) => decodePlainDate(buf.readUInt32LE(0));

  return {
    first: decode(head),
    last: decode(tail),
    count,
  };
}

/* ------------------------------------------------------------ 参数解析 */

function parseArgs(argv) {
  const options = {
    tdxHome: DEFAULT_TDX_HOME,
    periods: ['5min', 'day'],
    markets: [...MARKETS],
    code: null,
    export: false,
    outDir: null,
    limit: null,
    top: 10,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--export') options.export = true;
    else if (arg.startsWith('--period=')) {
      const value = arg.slice(9).toLowerCase();
      const key = value === '5' || value === '5min' || value === '5m' ? '5min'
        : value === 'day' || value === 'd' || value === '日线' ? 'day' : null;
      options.periods = key ? [key] : [];
      options.periodError = key ? null : value;
    } else if (arg.startsWith('--market=')) {
      options.markets = arg.slice(9).split(',').map((m) => m.trim().toLowerCase()).filter((m) => MARKETS.includes(m));
    } else if (arg.startsWith('--code=')) {
      const match = /^([a-z]{2})(\d{6})$/i.exec(arg.slice(7).trim());
      if (match) {
        options.code = { market: match[1].toLowerCase(), code: match[2] };
        options.markets = [options.code.market];
      } else {
        options.codeError = arg.slice(7);
      }
    } else if (arg.startsWith('--tdx=')) {
      options.tdxHome = arg.slice(6);
    } else if (arg.startsWith('--out=')) {
      options.outDir = arg.slice(6);
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.slice(8));
    } else if (arg.startsWith('--top=')) {
      options.top = Number(arg.slice(6));
    }
  }
  return options;
}

/* ------------------------------------------------------------ 统计输出 */

const EW = (text) => {
  let width = 0;
  for (const ch of String(text ?? '')) width += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return width;
};
const pad = (text, width) => String(text ?? '') + ' '.repeat(Math.max(0, width - EW(text)));
const padR = (text, width) => ' '.repeat(Math.max(0, width - EW(text))) + String(text ?? '');

/**
 * 扫描一个市场一个周期的全部文件。
 *
 * @param {string} tdxHome
 * @param {string} market
 * @param {object} period
 * @param {{code?: string, limit?: number}} [options]
 * @returns {{files: object[], errors: number}}
 */
export function scanMarket(tdxHome, market, period, options = {}) {
  const dir = join(tdxHome, 'vipdoc', market, period.dir);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { files: [], errors: 0, missing: true };
  }

  const results = [];
  let errors = 0;
  for (const name of names) {
    if (!name.endsWith(period.ext)) continue;
    const match = /^[a-z]{2}(\d{6})\.(?:lc5|day)$/i.exec(name);
    if (!match) continue;
    const code = match[1];
    if (options.code && code !== options.code) continue;
    const range = readFileRange(join(dir, name), period);
    if (range.first === null || range.last === null) {
      errors += 1;
      continue;
    }
    results.push({ market, code, ...range });
    if (options.limit && results.length >= options.limit) break;
  }
  return { files: results, errors };
}

/** 汇总统计：起始日/结束日分布。 */
export function summarize(files) {
  if (files.length === 0) {
    return { count: 0, firstDist: [], lastDist: [], earliest: null, latest: null, minBars: 0, maxBars: 0 };
  }
  const firstDist = new Map();
  const lastDist = new Map();
  let earliest = null;
  let latest = null;
  let minBars = Infinity;
  let maxBars = 0;

  for (const file of files) {
    firstDist.set(file.first, (firstDist.get(file.first) ?? 0) + 1);
    lastDist.set(file.last, (lastDist.get(file.last) ?? 0) + 1);
    if (!earliest || file.first < earliest) earliest = file.first;
    if (!latest || file.last > latest) latest = file.last;
    if (file.count < minBars) minBars = file.count;
    if (file.count > maxBars) maxBars = file.count;
  }

  const toSorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  return {
    count: files.length,
    firstDist: toSorted(firstDist),
    lastDist: toSorted(lastDist),
    earliest,
    latest,
    minBars,
    maxBars,
  };
}

/** 渲染一个市场一个周期的报告。 */
function renderMarketPeriod(market, period, summary, errors, top) {
  const lines = [];
  const title = `${market.toUpperCase()} ${period.label}`;
  if (summary.count === 0) {
    return [`  ${pad(title, 14)}（无数据${errors > 0 ? `，${errors} 个文件损坏` : ''}）`];
  }

  const latestFirst = summary.firstDist.reduce(
    (acc, [date]) => (date > acc ? date : acc),
    summary.earliest ?? '',
  );

  lines.push(`  ${pad(title, 14)}共 ${padR(String(summary.count), 6)} 个文件`
    + `${errors > 0 ? `，${errors} 个异常` : ''}`);
  lines.push(`  ${' '.repeat(14)}起始日范围：${summary.earliest} ~ ${latestFirst}`
    + `${summary.earliest === latestFirst ? '（全部相同）' : ''}`);
  lines.push(`  ${' '.repeat(14)}结束日范围：${summary.lastDist.length > 1
    ? `${summary.lastDist.reduce((acc, [d]) => (d < acc ? d : acc), summary.latest)} ~ ${summary.latest}`
    : summary.latest}`);
  lines.push(`  ${' '.repeat(14)}记录数     ：${summary.minBars} ~ ${summary.maxBars} 条`);

  // 起始日分布（前 top 个）
  const firstTop = summary.firstDist.slice(0, top);
  lines.push(`  ${' '.repeat(14)}起始日分布（前 ${firstTop.length} 类）：`);
  for (const [date, count] of firstTop) {
    const pct = ((count / summary.count) * 100).toFixed(1);
    lines.push(`  ${' '.repeat(16)}${pad(date, 12)}${padR(String(count), 7)} 个  ${padR(`${pct}%`, 7)}`);
  }

  // 结束日分布
  const lastTop = summary.lastDist.slice(0, top);
  if (lastTop.length > 1) {
    lines.push(`  ${' '.repeat(14)}结束日分布：`);
    for (const [date, count] of lastTop) {
      const pct = ((count / summary.count) * 100).toFixed(1);
      lines.push(`  ${' '.repeat(16)}${pad(date, 12)}${padR(String(count), 7)} 个  ${padR(`${pct}%`, 7)}`);
    }
  }
  return lines;
}

/** 渲染单只股票的明细。 */
function renderSingle(file, period) {
  return [
    `  ${file.market}${file.code}`,
    `    ${period.label}：${file.first} ~ ${file.last}，共 ${file.count} 条`,
  ];
}

/* ------------------------------------------------------------ 主流程 */

function printHelp() {
  process.stdout.write([
    '通达信数据体检 —— 检查本地 5分钟线与日线的起止日期',
    '',
    '用法：',
    '  node data-check.mjs                      检查全部（5分钟 + 日线）',
    '  node data-check.mjs --period=5min        只查 5 分钟线',
    '  node data-check.mjs --period=day         只查日线',
    '  node data-check.mjs --market=sh          只查沪市',
    '  node data-check.mjs --code=sh600000      只查单只',
    '  node data-check.mjs --export             导出明细 CSV',
    '',
    '参数：',
    '  --period=5min|day   周期（默认两个都查）',
    '  --market=sh,sz,bj   市场（默认全部）',
    '  --code=sh600000     只查单只股票',
    '  --tdx=<目录>        通达信目录（默认 D:\\MyTools\\new_tdx）',
    '  --out=<目录>        导出目录（默认 ./data-check）',
    '  --export            导出每个文件的起止日期明细',
    '  --top=10            每个分布表显示前 N 类',
    '  --limit=100         每个市场只查前 N 个文件（调试用）',
    '',
  ].join('\n'));
}

/**
 * 执行检查。
 * @param {object} options
 */
export async function runCheck(options) {
  const log = (line) => process.stdout.write(`${line}\n`);
  const startedAt = Date.now();
  const t0 = Date.now();

  log(`\n通达信数据体检`);
  log(`  目录：${options.tdxHome}`);
  const periodNames = options.periods.map((key) => PERIODS[key].label).join(' + ');
  log(`  检查：${periodNames}，市场：${options.markets.join('/')}`);
  if (options.code) log(`  只查：${options.code.market}${options.code.code}`);
  log('');

  const allFiles = [];

  for (const periodKey of options.periods) {
    const period = PERIODS[periodKey];
    log(`── ${period.label} ──`);
    const { writeFile, mkdir } = await import('node:fs/promises');

    for (const market of options.markets) {
      const scanStart = Date.now();
      const { files, errors, missing } = scanMarket(options.tdxHome, market, period, {
        code: options.code?.code,
        limit: options.limit,
      });
      if (missing) {
        log(`  ${market.toUpperCase()} 目录不存在，跳过`);
        continue;
      }
      const summary = summarize(files);
      const elapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
      if (options.code) {
        for (const file of files) log(renderSingle(file, period).join('\n'));
      } else {
        for (const line of renderMarketPeriod(market, period, summary, errors, options.top)) log(line);
      }
      log(`  ${' '.repeat(14)}（扫描耗时 ${elapsed} 秒）`);
      allFiles.push(...files.map((file) => ({ ...file, period: period.label })));
    }
    log('');
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`  总计 ${allFiles.length} 个文件，耗时 ${elapsed} 秒`);

  // 导出
  if (options.export && allFiles.length > 0) {
    const outDir = options.outDir ?? join(process.cwd(), 'data-check');
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const file = join(outDir, `data-check-${stamp}.csv`);
    const lines = ['周期,市场,代码,起始日,结束日,记录数'];
    for (const item of allFiles) {
      lines.push([item.period, item.market, `${item.market}${item.code}`, item.first, item.last, item.count].join(','));
    }
    await writeFile(file, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
    log(`  明细已导出：${file}`);
  }

  return { files: allFiles, elapsedMs: Date.now() - startedAt };
}

/* ------------------------------------------------------------ 入口 */

function isMainModule() {
  if (!process.argv[1]) return false;
  const normalize = (value) => resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalize(import.meta.url.replace(/^file:\/\/\/?/, '')) === normalize(process.argv[1]);
}

if (isMainModule()) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else if (options.periodError) {
    process.stdout.write(`无法识别的周期：${options.periodError}（可用：5min / day）\n`);
    process.exit(2);
  } else if (options.codeError) {
    process.stdout.write(`代码格式错误：${options.codeError}（应为 sh600000 这种形式）\n`);
    process.exit(2);
  } else if (options.periods.length === 0) {
    process.stdout.write('周期参数无效\n');
    process.exit(2);
  } else {
    await runCheck(options);
  }
}
