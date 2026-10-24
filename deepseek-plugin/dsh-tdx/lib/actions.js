/**
 * Action runner shared by the `tdx_data` agent tool and the `/tdx` command.
 *
 * One implementation, two callers: both normalize the same action arguments,
 * call the same core reader, and receive the same `{ action, text, data }`
 * report. The text is what the user/model sees; `data` is structured payload.
 *
 * @module dsh-tdx/lib/actions
 */

import { join, resolve } from 'node:path';
import {
  TdxError,
  buildSummary,
  computeIndicators,
  exportCsvFile,
  filterRows,
  parseDateArg,
  readTdxFile,
  resampleRows,
  scanTdxFiles,
  sliceRows,
} from './tdx.js';
import * as report from './report.js';

/** Actions accepted by the tool. */
export const ACTIONS = Object.freeze([
  'info',
  'summary',
  'rows',
  'indicators',
  'resample',
  'export',
  'scan',
]);

const ACTION_SET = new Set(ACTIONS);

function resolveInputPath(value, env) {
  const base = env.cwd || process.cwd();
  return resolve(base, String(value));
}

function toInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TdxError(`${name} 必须是数字，收到: ${value}`, 'BAD_ARGUMENT');
  const integer = Math.trunc(parsed);
  if (integer < min || integer > max) {
    throw new TdxError(`${name} 超出范围（${min} ~ ${max}），收到: ${value}`, 'BAD_ARGUMENT');
  }
  return integer;
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/**
 * Normalize raw tool/command arguments into the canonical action shape.
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeActionArgs(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const action = String(input.action ?? '').trim().toLowerCase();
  if (!ACTION_SET.has(action)) {
    throw new TdxError(
      `未知动作: ${String(input.action ?? '')}（可用: ${ACTIONS.join(' / ')}）`,
      'BAD_ACTION',
    );
  }
  const args = {
    action,
    path: optionalString(input.path),
    dir: optionalString(input.dir),
    startInt: parseDateArg(input.start, 'start'),
    endInt: parseDateArg(input.end, 'end'),
    offset: toInteger(input.offset, 'offset', { min: 0, fallback: 0 }),
    order: optionalString(input.order)?.toLowerCase() ?? 'desc',
    period: optionalString(input.period)?.toLowerCase() ?? 'week',
    output: optionalString(input.output),
    market: optionalString(input.market)?.toLowerCase(),
    pattern: optionalString(input.pattern),
    limit: undefined,
  };
  if (!['asc', 'desc'].includes(args.order)) throw new TdxError('order 只能是 asc 或 desc', 'BAD_ARGUMENT');
  if (!['week', 'month'].includes(args.period)) throw new TdxError('period 只能是 week 或 month', 'BAD_ARGUMENT');
  if (args.market !== undefined && !['sh', 'sz', 'bj'].includes(args.market)) {
    throw new TdxError('market 只能是 sh / sz / bj', 'BAD_ARGUMENT');
  }
  if (args.startInt !== null && args.endInt !== null && args.startInt > args.endInt) {
    throw new TdxError(`起始日期 ${args.startInt} 晚于结束日期 ${args.endInt}`, 'BAD_RANGE');
  }
  if (action === 'scan') {
    if (!args.dir) throw new TdxError('scan 动作需要 dir 参数（要扫描的目录）', 'MISSING_DIR');
    args.limit = toInteger(input.limit, 'limit', { min: 1, max: 500, fallback: 50 });
  } else {
    if (!args.path) throw new TdxError(`${action} 动作需要 path 参数（行情文件路径）`, 'MISSING_PATH');
    const limitMax = action === 'rows' ? 1000 : 500;
    const fallback = action === 'rows' ? 30 : action === 'indicators' ? 15 : action === 'resample' ? 60 : 30;
    args.limit = toInteger(input.limit, 'limit', { min: 1, max: limitMax, fallback });
  }
  return args;
}

function dateRangeOf(rows) {
  if (rows.length === 0) return { start: null, end: null };
  return { start: rows[0].date ?? null, end: rows[rows.length - 1].date ?? null };
}

function compactRow(row) {
  if (!row) return null;
  return {
    date: row.date ?? null,
    ...(row.time ? { time: row.time } : {}),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    changePct: row.changePct ?? null,
    amplitudePct: row.amplitudePct ?? null,
    amount: row.amount ?? 0,
    volume: row.volume ?? 0,
  };
}

function defaultExportPath(env, instrument) {
  let base = env.cwd || process.cwd();
  const directory = env.ctx?.get?.('workingDirectory');
  if (directory && env.agent) {
    try {
      const sessionDirectory = directory.get(env.agent.session);
      if (sessionDirectory) base = sessionDirectory;
    } catch {
      // fall back to the process/working-directory hint
    }
  }
  const now = env.now instanceof Date ? env.now : new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
    + `${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}`
    + `${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return join(base, `tdx-${instrument.market}${instrument.code}-${stamp}.csv`);
}

function assertNotAborted(env) {
  if (env?.exec?.signal?.aborted) throw new TdxError('操作已取消', 'ABORTED');
}

/**
 * Execute one normalized action.
 * @param {unknown} rawArgs
 * @param {{cwd?: string, ctx?: object, agent?: object, exec?: object, now?: Date}} [env]
 * @returns {Promise<{action: string, text: string, data: object}>}
 */
export async function executeTdxAction(rawArgs, env = {}) {
  const args = normalizeActionArgs(rawArgs);
  assertNotAborted(env);
  switch (args.action) {
    case 'info': return runInfo(args, env);
    case 'summary': return runSummary(args, env);
    case 'rows': return runRows(args, env);
    case 'indicators': return runIndicators(args, env);
    case 'resample': return runResample(args, env);
    case 'export': return runExport(args, env);
    case 'scan': return runScan(args, env);
    /* c8 ignore next -- ACTIONS is closed and validated above */
    default: throw new TdxError(`未实现的动作: ${args.action}`, 'BAD_ACTION');
  }
}

function runInfo(args, env) {
  const loaded = readTdxFile(resolveInputPath(args.path, env));
  const first = loaded.rows[0] ?? null;
  const last = loaded.rows[loaded.rows.length - 1] ?? null;
  const data = {
    path: loaded.path,
    sizeBytes: loaded.sizeBytes,
    recordBytes: loaded.recordBytes,
    count: loaded.count,
    format: {
      format: loaded.format.format,
      label: loaded.format.label,
      extension: loaded.format.extension,
      minutes: loaded.format.minutes ?? null,
    },
    instrument: loaded.instrument,
    quality: loaded.quality,
    range: dateRangeOf(loaded.rows),
    timeRange: loaded.format.format === 'minute'
      ? { start: first?.time ?? null, end: last?.time ?? null }
      : null,
    first: compactRow(first),
    last: compactRow(last),
    totalAmount: loaded.rows.reduce((sum, row) => sum + (row.amount ?? 0), 0),
    totalVolume: loaded.rows.reduce((sum, row) => sum + (row.volume ?? 0), 0),
  };
  return { action: 'info', text: report.infoText(data), data };
}

function runSummary(args, env) {
  const loaded = readTdxFile(resolveInputPath(args.path, env));
  const summary = buildSummary(loaded);
  return { action: 'summary', text: report.summaryText(summary), data: summary };
}

function runRows(args, env) {
  const loaded = readTdxFile(resolveInputPath(args.path, env));
  const filtered = filterRows(loaded.rows, args);
  if (filtered.length === 0) throw new TdxError('指定日期范围内没有行情记录', 'NO_ROWS');
  const sliced = sliceRows(filtered, args);
  const data = {
    file: loaded.path,
    instrument: loaded.instrument,
    format: { label: loaded.format.label, format: loaded.format.format },
    range: dateRangeOf(filtered),
    filtered: filtered.length,
    order: args.order,
    offset: args.offset,
    rows: sliced.rows.map(compactRow),
    truncated: sliced.truncated,
  };
  return { action: 'rows', text: report.rowsText(data), data };
}

function runIndicators(args, env) {
  const loaded = readTdxFile(resolveInputPath(args.path, env));
  const indicators = computeIndicators(loaded.rows);
  const combined = loaded.rows.map((row, index) => ({
    date: row.date,
    dateInt: row.dateInt,
    time: row.time,
    close: row.close,
    ma5: indicators.ma[5][index],
    ma10: indicators.ma[10][index],
    ma20: indicators.ma[20][index],
    ma60: indicators.ma[60][index],
    dif: indicators.macd.dif[index],
    dea: indicators.macd.dea[index],
    macd: indicators.macd.histogram[index],
    rsi14: indicators.rsi14[index],
    k: indicators.kdj.k[index],
    d: indicators.kdj.d[index],
    j: indicators.kdj.j[index],
    bollUpper: indicators.boll.upper[index],
    bollMiddle: indicators.boll.middle[index],
    bollLower: indicators.boll.lower[index],
  }));
  const filtered = filterRows(combined, args);
  if (filtered.length === 0) throw new TdxError('指定日期范围内没有行情记录', 'NO_ROWS');
  const sliced = sliceRows(filtered, { order: args.order, offset: args.offset, limit: args.limit });
  const data = {
    file: loaded.path,
    instrument: loaded.instrument,
    format: { label: loaded.format.label, format: loaded.format.format },
    range: dateRangeOf(filtered),
    order: args.order,
    rows: sliced.rows.map((row) => ({
      date: row.date,
      time: row.time,
      close: row.close,
      ma5: row.ma5,
      ma10: row.ma10,
      ma20: row.ma20,
      ma60: row.ma60,
      dif: row.dif,
      dea: row.dea,
      macd: row.macd,
      rsi14: row.rsi14,
      k: row.k,
      d: row.d,
      j: row.j,
      bollUpper: row.bollUpper,
      bollMiddle: row.bollMiddle,
      bollLower: row.bollLower,
    })),
  };
  return { action: 'indicators', text: report.indicatorsText(data), data };
}

function runResample(args, env) {
  const loaded = readTdxFile(resolveInputPath(args.path, env));
  if (loaded.format.format !== 'day') {
    throw new TdxError('resample 仅支持日线 .day 文件（分钟线请直接用 rows/indicators）', 'BAD_FORMAT');
  }
  const bars = resampleRows(loaded.rows, args.period);
  const filtered = filterRows(bars, args);
  if (filtered.length === 0) throw new TdxError('指定日期范围内没有行情记录', 'NO_ROWS');
  const sliced = sliceRows(filtered, { order: args.order, offset: args.offset, limit: args.limit });
  const data = {
    file: loaded.path,
    instrument: loaded.instrument,
    period: args.period,
    range: {
      start: filtered[0]?.startDate ?? null,
      end: filtered[filtered.length - 1]?.endDate ?? null,
    },
    total: filtered.length,
    order: args.order,
    rows: sliced.rows.map((bar) => ({
      key: bar.key,
      startDate: bar.startDate,
      endDate: bar.endDate,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      changePct: bar.changePct,
      amount: bar.amount,
      volume: bar.volume,
    })),
  };
  return { action: 'resample', text: report.resampleText(data), data };
}

function runExport(args, env) {
  const loaded = readTdxFile(resolveInputPath(args.path, env));
  const filtered = filterRows(loaded.rows, args);
  if (filtered.length === 0) throw new TdxError('指定日期范围内没有行情记录，未导出', 'NO_ROWS');
  const output = args.output
    ? resolveInputPath(args.output, env)
    : defaultExportPath(env, loaded.instrument);
  const written = exportCsvFile(filtered, output);
  const data = {
    file: loaded.path,
    output: written.path,
    count: written.rows,
    bytes: written.bytes,
    header: written.header,
    range: dateRangeOf(filtered),
    format: { label: loaded.format.label },
  };
  return { action: 'export', text: report.exportText(data), data };
}

function runScan(args, env) {
  const result = scanTdxFiles(resolveInputPath(args.dir, env), {
    market: args.market,
    pattern: args.pattern,
    limit: args.limit,
  });
  const data = { ...result, market: args.market ?? null, pattern: args.pattern ?? null };
  return { action: 'scan', text: report.scanText(data), data };
}

/* -------------------------------------------------------------- command line */

/**
 * Split a command line into tokens. Quotes may wrap a whole token or only part
 * of one (`--output="D:\out dir\b.csv"`); the quote characters are removed and
 * whitespace inside quotes is preserved.
 * @param {string} rawInput
 * @returns {string[]}
 */
export function tokenizeCommandLine(rawInput) {
  const text = String(rawInput ?? '');
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const character of text) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Strip one pair of wrapping quotes from a flag value. */
function unquoteValue(value) {
  if (typeof value !== 'string' || value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse the `/tdx` command grammar into action arguments.
 * @param {string} rawInput
 * @returns {object} action args, or `{ action: 'help' }`
 */
export function parseCommandLine(rawInput) {
  const tokens = tokenizeCommandLine(rawInput);
  if (tokens.length === 0) return { action: 'help' };
  const first = tokens[0].toLowerCase();
  if (first === 'help' || first === '-h' || first === '--help') return { action: 'help' };
  let action;
  let rest;
  if (ACTION_SET.has(first)) {
    action = first;
    rest = tokens.slice(1);
  } else {
    action = 'summary';
    rest = tokens;
  }
  const positional = [];
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      if (equals >= 0) {
        flags[token.slice(2, equals).toLowerCase()] = unquoteValue(token.slice(equals + 1));
      } else {
        const next = rest[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[token.slice(2).toLowerCase()] = next;
          index += 1;
        } else {
          flags[token.slice(2).toLowerCase()] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }
  const args = { action };
  if (action === 'scan') {
    args.dir = unquoteValue(flags.dir ?? positional[0]);
  } else {
    args.path = unquoteValue(flags.path ?? positional[0]);
    if (flags.start === undefined && positional[1] !== undefined) args.start = positional[1];
    if (flags.end === undefined && positional[2] !== undefined) args.end = positional[2];
    if (flags.limit === undefined && positional[3] !== undefined) args.limit = positional[3];
  }
  for (const key of ['start', 'end', 'limit', 'offset', 'order', 'period', 'output', 'market', 'pattern', 'dir', 'path']) {
    if (flags[key] !== undefined && flags[key] !== true) args[key] = unquoteValue(flags[key]);
  }
  return args;
}

/**
 * Run one `/tdx` command line and settle a command result.
 * @param {string} rawInput
 * @param {{cwd?: string, ctx?: object, agent?: object, exec?: object, now?: Date}} [env]
 * @returns {Promise<{kind: 'success'|'error', text: string}>}
 */
export async function runCommand(rawInput, env = {}) {
  const args = parseCommandLine(rawInput);
  if (args.action === 'help') return { kind: 'success', text: report.helpText() };
  try {
    const result = await executeTdxAction(args, env);
    return { kind: 'success', text: result.text };
  } catch (error) {
    const message = error?.message ?? String(error);
    return { kind: 'error', text: `通达信数据读取失败: ${message}` };
  }
}
