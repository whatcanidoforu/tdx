#!/usr/bin/env node
/**
 * 通达信 · 盘中跌幅扫描 —— 每到 15 分钟节点扫描一次「当日跌幅超阈值的股票」。
 *
 * 用法：
 *
 *   立即扫描一次（看当前结果，不常驻）
 *     node loss-scanner.mjs --once
 *
 *   常驻，按检查点自动扫描
 *     node loss-scanner.mjs --tick
 *
 *   指定阈值 / 通达信目录 / 是否包含北交所
 *     node loss-scanner.mjs --tick --threshold=5 --tdx="D:\MyTools\new_tdx" --include-bj
 *
 *   自定义检查点
 *     node loss-scanner.mjs --tick --times=09:30,09:45,10:00,10:15
 *
 *   只看某天历史（复盘）
 *     node loss-scanner.mjs --once --date=20261106
 *
 * 输出：控制台表格 + 每次快照写入 `snapshots\YYYYMMDD-HHmmss.csv`，
 *       并覆盖写 `latest.csv`（适合用 Excel 长期挂着）。
 *
 * 数据来源：本地通达信 `vipdoc\{sh,sz,bj}\lday\*.day` 日线（当日收盘/昨收），
 *          通达信运行中会自动把这些文件刷新到当日；名称来自行情主站或本地缓存。
 *
 * @module dsh-tdx/app/loss-scanner
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanLocalVipdoc, attachNames, isSpecialName } from './market-scan.js';
import { MarketDataClient } from './market-data.js';
import { loadNameMap } from './name-service.js';
import { formatClock, formatStamp } from './time-format.js';

/** 默认检查点：含开盘 09:30、15 分钟节点、午休跳过、收盘 15:00。 */
export const DEFAULT_TIMES = Object.freeze([
  '09:30',
  '09:45', '10:00', '10:15', '10:30', '10:45',
  '11:00', '11:15', '11:30',
  '13:15', '13:30', '13:45',
  '14:00', '14:15', '14:30', '14:45',
  '15:00',
]);

/** 默认通达信目录。 */
const DEFAULT_TDX_HOME = 'D:\\MyTools\\new_tdx';

/* --------------------------------------------------------------- 参数解析 */

/**
 * 解析命令行。
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = {
    mode: 'once',
    tdxHome: DEFAULT_TDX_HOME,
    threshold: 5,
    times: [...DEFAULT_TIMES],
    includeBJ: false,
    includeST: false,
    date: null,
    outDir: null,
    delaySeconds: 3,
    quiet: false,
  };
  for (const arg of argv) {
    if (arg === '--tick') options.mode = 'tick';
    else if (arg === '--once') options.mode = 'once';
    else if (arg === '--include-bj') options.includeBJ = true;
    else if (arg === '--include-st') options.includeST = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg.startsWith('--threshold=')) options.threshold = Number(arg.slice(12));
    else if (arg.startsWith('--tdx=')) options.tdxHome = arg.slice(6);
    else if (arg.startsWith('--date=')) options.date = arg.slice(7);
    else if (arg.startsWith('--out=')) options.outDir = arg.slice(6);
    else if (arg.startsWith('--delay=')) options.delaySeconds = Number(arg.slice(8));
    else if (arg.startsWith('--times=')) {
      options.times = arg.slice(8).split(',').map((t) => t.trim()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      options.mode = 'help';
    }
  }
  return options;
}

/* ---------------------------------------------------------------- 输出 */

/**
 * 把扫描结果渲染为控制台表格。
 * @param {object[]} rows
 * @param {number} limit
 */
export function renderTable(rows, limit = 30) {
  if (rows.length === 0) return '  （无）';
  const head = ['#', '代码', '名称', '现价', '昨收', '涨跌幅', '成交额'];
  const lines = [
    `${pad('#', 4)}${pad('代码', 10)}${pad('名称', 12)}${padRight('现价', 10)}${padRight('昨收', 10)}${padRight('涨跌幅', 10)}${padRight('成交额', 12)}`,
    '-'.repeat(68),
  ];
  rows.slice(0, limit).forEach((row, index) => {
    lines.push(
      `${pad(String(index + 1), 4)}`
      + `${pad(`${row.market}${row.code}`, 10)}`
      + `${pad(row.name || '-', 12)}`
      + `${padRight(row.price.toFixed(2), 10)}`
      + `${padRight(row.lastClose.toFixed(2), 10)}`
      + `${padRight(`${row.changePct.toFixed(2)}%`, 10)}`
      + `${padRight(`${(row.amount / 1e8).toFixed(2)}亿`, 12)}`,
    );
  });
  if (rows.length > limit) lines.push(`  … 另有 ${rows.length - limit} 只未显示`);
  return lines.join('\n');
}

/** 按显示宽度左对齐补齐。 */
function pad(text, width) {
  const value = String(text ?? '');
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

/** 按显示宽度右对齐补齐。 */
function padRight(text, width) {
  const value = String(text ?? '');
  return ' '.repeat(Math.max(0, width - displayWidth(value))) + value;
}

/** 中文占两列宽。 */
function displayWidth(text) {
  let width = 0;
  for (const character of text) width += character.codePointAt(0) > 0x2e80 ? 2 : 1;
  return width;
}

/* ---------------------------------------------------------------- 主流程 */

/**
 * 执行一次扫描并落盘。
 *
 * @param {object} options parseArgs 的结果
 * @returns {Promise<object>}
 */
export async function runOnce(options) {
  const startedAt = new Date();
  const log = options.quiet ? () => {} : (line) => process.stdout.write(`${line}\n`);
  const threshold = options.threshold;

  log(`\n[${formatClock(startedAt)}] 开始扫描：当日跌幅超过 ${threshold}% 的股票`);

  // 1) 本地日线扫描
  const t0 = Date.now();
  const local = scanLocalVipdoc({
    tdxHome: options.tdxHome,
    thresholdPct: threshold,
    log,
  });
  log(`  本地日线：A 股 ${local.universe} 只，有效成交 ${local.scanned} 只，`
    + `交易日 ${local.tradeDate ?? '无'}（${Date.now() - t0}ms）`);

  // 2) 名称（缓存优先，联网刷新）
  const outDir = options.outDir ?? join(process.cwd(), 'tdx-loss-scan');
  const nameMap = await loadNameMap({
    cacheFile: join(outDir, 'names.json'),
    tdxHome: options.tdxHome,
    log,
    refresh: false,
    fetchFromServer: async () => {
      const client = new MarketDataClient({ log });
      try {
        await client.connect();
        const items = [];
        // 市场编号 → 文件名缩写：0=sz 1=sh 2=bj
        for (const [marketId, marketCode] of [[1, 'sh'], [0, 'sz'], [2, 'bj']]) {
          try {
            const list = await client.fetchListPages(marketId);
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

  // 3) 过滤：北交所 / ST
  let rows = local.rows;
  rows = rows.filter((row) => {
    if (!options.includeBJ && row.market === 'bj') return false;
    return true;
  });
  attachNames(rows, nameMap);
  if (!options.includeST) {
    rows = rows.filter((row) => !isSpecialName(row.name));
  }

  const finishedAt = new Date();
  const result = {
    startedAt,
    finishedAt,
    clock: formatClock(startedAt),
    tradeDate: local.tradeDate,
    threshold,
    universe: local.universe,
    scanned: local.scanned,
    rowCount: rows.length,
    rows,
    durationMs: finishedAt - startedAt,
  };

  // 4) 输出
  if (!options.quiet) {
    log(`\n  跌幅超 ${threshold}% 的股票：${rows.length} 只`);
    log(renderTable(rows));
  }

  // 5) 落盘
  if (!options.date || options.date === String(local.tradeDate)) {
    await mkdir(outDir, { recursive: true });
    const snapshotFile = join(outDir, `${formatStamp(startedAt)}.csv`);
    const latestFile = join(outDir, 'latest.csv');
    const content = toCsv(result);
    await writeFile(snapshotFile, content, 'utf8');
    await writeFile(latestFile, content, 'utf8');
    result.snapshotFile = snapshotFile;
    result.latestFile = latestFile;
    log(`  快照已写入：${snapshotFile}`);
    log(`  最新结果：  ${latestFile}`);
  }

  return result;
}

/**
 * 结果转 CSV（UTF-8 BOM，Excel 直接打开）。
 * @param {object} result
 */
export function toCsv(result) {
  const header = '扫描时间,交易日,代码,名称,现价,昨收,开盘,最高,最低,涨跌幅%,成交额亿元,成交量';
  const lines = [header];
  for (const row of result.rows) {
    lines.push([
      result.clock,
      row.date ?? '',
      `${row.market}${row.code}`,
      escapeCsv(row.name || ''),
      row.price.toFixed(2),
      row.lastClose.toFixed(2),
      row.open.toFixed(2),
      row.high.toFixed(2),
      row.low.toFixed(2),
      row.changePct.toFixed(2),
      (row.amount / 1e8).toFixed(2),
      row.volume,
    ].join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** CSV 字段转义。 */
function escapeCsv(text) {
  const value = String(text ?? '');
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/* ---------------------------------------------------------------- 调度 */

/**
 * 常驻调度：等到下一个检查点，等待若干秒后扫描一次。
 *
 * @param {object} options
 */
export async function runTick(options) {
  const checkpoints = [...options.times].sort();
  const log = options.quiet ? () => {} : (line) => process.stdout.write(`${line}\n`);
  log(`通达信盘中跌幅扫描已启动`);
  log(`  通达信目录：${options.tdxHome}`);
  log(`  跌幅阈值：  ${options.threshold}%`);
  log(`  检查点：    ${checkpoints.join(' ')}`);
  log(`  含北交所：  ${options.includeBJ ? '是' : '否'}`);
  log(`  含 ST：     ${options.includeST ? '是' : '否'}`);
  log('  Ctrl+C 退出\n');

  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    log('\n已收到中断，退出。');
    process.exit(0);
  });

  while (!stopped) {
    const now = new Date();
    const next = nextCheckpoint(checkpoints, now);
    if (!next) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      const waitMs = tomorrow - now + 1000;
      log(`[${formatClock(now)}] 今日检查点已全部执行，休眠 ${Math.round(waitMs / 1000)} 秒到明日`);
      await sleep(waitMs);
      continue;
    }
    const waitMs = next.at - now;
    log(`[${formatClock(now)}] 下一个检查点 ${next.label}，${formatDuration(waitMs)}后`);
    await sleep(waitMs);
    if (stopped) break;
    // 到点后再等几秒，避开整点行情跳动的瞬间
    if (options.delaySeconds > 0) await sleep(options.delaySeconds * 1000);
    try {
      await runOnceWithRetry(options, next.label, log);
    } catch (error) {
      log(`[${formatClock(new Date())}] 检查点 ${next.label} 扫描失败：${error.message}`);
    }
  }
}

/** 带重试的单次扫描。 */
async function runOnceWithRetry(options, label, log) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (attempt > 1) log(`  重试第 ${attempt} 次…`);
      return await runOnce(options);
    } catch (error) {
      lastError = error;
      log(`[${formatClock(new Date())}] 第 ${attempt} 次失败：${error.message}`);
      await sleep(3000);
    }
  }
  throw lastError;
}

/**
 * 找到下一个严格晚于 now 的检查点。
 * @param {string[]} checkpoints 升序 `HH:mm`
 * @param {Date} now
 * @returns {{label: string, at: Date}|null}
 */
export function nextCheckpoint(checkpoints, now) {
  for (const label of checkpoints) {
    const [hour, minute] = label.split(':').map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
    const at = new Date(now);
    at.setHours(hour, minute, 0, 0);
    if (at.getTime() > now.getTime()) return { label, at };
  }
  return null;
}

/** 可中断休眠。 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, ms)));
}

/** 毫秒转「X 分 Y 秒」。 */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/* ---------------------------------------------------------------- 入口 */

function printHelp() {
  process.stdout.write([
    '通达信盘中跌幅扫描',
    '',
    '用法：',
    '  node loss-scanner.mjs --once               立即扫描一次',
    '  node loss-scanner.mjs --tick               常驻，按检查点自动扫描',
    '',
    '参数：',
    '  --threshold=5       跌幅阈值（默认 5，即当日跌幅超过 5%）',
    '  --tdx=<目录>        通达信安装目录（默认 D:\\MyTools\\new_tdx）',
    '  --times=<列表>      检查点，逗号分隔（默认 09:30,09:45…11:30,13:15…15:00）',
    '  --delay=<秒>        到点后延迟多久再扫描（默认 3）',
    '  --include-bj        把北交所算进来',
    '  --include-st        把 ST 股算进来',
    '  --out=<目录>        快照输出目录（默认 ./tdx-loss-scan）',
    '  --quiet             不打印表格，只写文件',
    '  -h, --help          显示本帮助',
    '',
  ].join('\n'));
}

/** 判断本文件是否被直接执行（Windows 路径需要归一化再比较）。 */
function isMainModule() {
  if (!process.argv[1]) return false;
  const normalize = (value) => resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalize(import.meta.url.replace(/^file:\/\/\/?/, '')) === normalize(process.argv[1]);
}

if (isMainModule()) {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.tdxHome)) {
    process.stdout.write(`通达信目录不存在：${options.tdxHome}\n请用 --tdx=<目录> 指定。\n`);
    process.exit(1);
  }
  if (options.mode === 'help') {
    printHelp();
  } else if (options.mode === 'tick') {
    await runTick(options);
  } else {
    await runOnce(options);
  }
}
