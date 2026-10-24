/**
 * Tongdaxin (通达信) binary quote file reader + local analytics.
 *
 * Supported on-disk formats (little-endian, 32 bytes per record):
 *
 *   .day  daily bar
 *     uint32 date      YYYYMMDD
 *     uint32 open      price * 100
 *     uint32 high      price * 100
 *     uint32 low       price * 100
 *     uint32 close     price * 100
 *     float32 amount   成交额（元）
 *     uint32 volume    成交量（股，指数为手）
 *     uint32 reserved
 *
 *   .lc1 / .lc5 / .min  minute bar
 *     uint16 date      (year - 2004) * 2048 + month * 100 + day
 *     uint16 time      minutes since 00:00
 *     float32 open / high / low / close
 *     float32 amount
 *     uint32 volume
 *     uint32 reserved
 *
 * This module has no dependency on the harness: it can be imported by a plain
 * Node.js process for tests, and by the Host plugin entry.
 *
 * @module dsh-tdx/lib/tdx
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

/** Bytes per record in every supported format. */
export const RECORD_BYTES = 32;
/** Refuse to slurp files larger than this (they are not TDX quote files). */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

const DAY_PRICE_DIVISOR = 100;
const WEEKDAYS_PER_YEAR = 252;
const TRADING_DAYS_52W = 250;

/** A user-facing, catchable error with a stable machine code. */
export class TdxError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'TDX_ERROR') {
    super(message);
    this.name = 'TdxError';
    this.code = code;
  }
}

const EXTENSIONS = Object.freeze({
  '.day': { format: 'day', minutes: null, label: '日线', extension: '.day' },
  '.lc1': { format: 'minute', minutes: 1, label: '1分钟线', extension: '.lc1' },
  '.lc5': { format: 'minute', minutes: 5, label: '5分钟线', extension: '.lc5' },
  '.min': { format: 'minute', minutes: 1, label: '1分钟线', extension: '.min' },
});

const MARKET_LABELS = Object.freeze({
  sh: '上海证券交易所',
  sz: '深圳证券交易所',
  bj: '北京证券交易所',
  unknown: '未知市场',
});

const BOARD_RULES = Object.freeze({
  sh: [
    [/^(000|880|881|882|883|999)/, 'index', '上证指数'],
    [/^(600|601|603|605)/, 'stock', '沪市A股'],
    [/^(688|689)/, 'stock', '科创板'],
    [/^900/, 'stock', '沪市B股'],
    [/^5/, 'fund', '沪市基金'],
    [/^(1|2)/, 'bond', '沪市债券'],
  ],
  sz: [
    [/^399/, 'index', '深证指数'],
    [/^(000|001|002|003)/, 'stock', '深市A股'],
    [/^(300|301)/, 'stock', '创业板'],
    [/^200/, 'stock', '深市B股'],
    [/^(15|16|18)/, 'fund', '深市基金'],
    [/^(1[0-9]|2[0-9])/, 'bond', '深市债券'],
  ],
  bj: [
    [/^899/, 'index', '北证指数'],
    [/^(43|83|87|88|92)/, 'stock', '北交所股票'],
  ],
});

const BOARD_KIND_LABELS = Object.freeze({
  index: '指数',
  stock: '股票',
  fund: '基金',
  bond: '债券',
  other: '其他',
});

/* ------------------------------------------------------------------ dates */

/**
 * Validate a YYYYMMDD integer as a real calendar date.
 * @param {number} value
 * @returns {boolean}
 */
export function isValidDateInt(value) {
  if (!Number.isInteger(value) || value < 19000101 || value > 22001231) return false;
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/**
 * Render a YYYYMMDD integer as `YYYY-MM-DD`.
 * @param {number} value
 * @returns {string|null}
 */
export function formatDateInt(value) {
  if (!isValidDateInt(value)) return null;
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parse a model/user supplied date (YYYYMMDD or YYYY-MM-DD / YYYY/MM/DD) to YYYYMMDD.
 * @param {unknown} value
 * @param {string} [label]
 * @returns {number|null}
 */
export function parseDateArg(value, label = '日期') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!isValidDateInt(value)) throw new TdxError(`${label}无效: ${value}（应为 YYYYMMDD，如 20261022）`, 'BAD_DATE');
    return value;
  }
  const text = String(value).trim();
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (!match) match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (!match) throw new TdxError(`${label}格式无效: ${text}（应为 YYYYMMDD 或 YYYY-MM-DD）`, 'BAD_DATE');
  const valueInt = Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
  if (!isValidDateInt(valueInt)) throw new TdxError(`${label}不是有效日期: ${text}`, 'BAD_DATE');
  return valueInt;
}

/** Decode the packed uint16 date used by minute-line files. */
function decodePackedDate(packed) {
  if (!Number.isInteger(packed) || packed <= 0) return 0;
  const year = 2004 + Math.floor(packed / 2048);
  const remainder = packed % 2048;
  const month = Math.floor(remainder / 100);
  const day = remainder % 100;
  const value = year * 10000 + month * 100 + day;
  return isValidDateInt(value) ? value : 0;
}

/** Render minutes-since-midnight as HH:MM. */
function formatMinuteOfDay(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) return null;
  const hour = Math.floor(minutes / 60);
  const minute = Math.floor(minutes % 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/* ----------------------------------------------------------- file formats */

/**
 * Describe a supported file extension.
 * @param {string} filePath
 * @returns {"day"|"minute"|undefined}
 */
export function extensionInfo(filePath) {
  return EXTENSIONS[extname(String(filePath)).toLowerCase()];
}

/**
 * Sniff an unknown extension by testing the first record against both layouts.
 * @param {string} absolute
 * @returns {{format: string, minutes: number|null, label: string, extension: string, sniffed: true}}
 */
function sniffFormat(absolute) {
  let fd;
  try {
    fd = openSync(absolute, 'r');
    const head = Buffer.alloc(64);
    const read = readSync(fd, head, 0, head.length, 0);
    if (read >= RECORD_BYTES) {
      const view = new DataView(head.buffer, head.byteOffset, read);
      const asDayDate = view.getUint32(0, true);
      if (isValidDateInt(asDayDate)) {
        return { format: 'day', minutes: null, label: '日线', extension: '', sniffed: true };
      }
      const asMinuteDate = decodePackedDate(view.getUint16(0, true));
      const asMinuteTime = view.getUint16(2, true);
      if (asMinuteDate && asMinuteTime <= 24 * 60) {
        return { format: 'minute', minutes: null, label: '分钟线', extension: '', sniffed: true };
      }
    }
  } catch {
    // fall through to the unsupported-format error below
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  throw new TdxError(
    `不支持的文件类型: ${absolute}（支持 .day/.lc1/.lc5/.min；未知扩展名需能按 32 字节记录识别）`,
    'UNSUPPORTED_FORMAT',
  );
}

/* ----------------------------------------------------------------- decode */

/**
 * Decode a daily-line buffer.
 * @param {Uint8Array|Buffer} buffer
 * @returns {Array<object>}
 */
export function decodeDayBuffer(buffer) {
  const length = buffer.byteLength ?? buffer.length;
  if (length === 0) throw new TdxError('文件为空', 'EMPTY_FILE');
  if (length % RECORD_BYTES !== 0) {
    throw new TdxError(`文件长度 ${length} 字节不是 ${RECORD_BYTES} 的整数倍，不是有效的通达信行情文件`, 'BAD_SIZE');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset ?? 0, length);
  const count = length / RECORD_BYTES;
  const rows = new Array(count);
  let previousClose = null;
  for (let index = 0; index < count; index += 1) {
    const offset = index * RECORD_BYTES;
    const rawDate = view.getUint32(offset, true);
    const dateInt = isValidDateInt(rawDate) ? rawDate : 0;
    const open = view.getUint32(offset + 4, true) / DAY_PRICE_DIVISOR;
    const high = view.getUint32(offset + 8, true) / DAY_PRICE_DIVISOR;
    const low = view.getUint32(offset + 12, true) / DAY_PRICE_DIVISOR;
    const close = view.getUint32(offset + 16, true) / DAY_PRICE_DIVISOR;
    const rawAmount = view.getFloat32(offset + 20, true);
    const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
    const volume = view.getUint32(offset + 24, true);
    const changePct = previousClose && previousClose > 0 ? (close / previousClose - 1) * 100 : null;
    const amplitudePct = previousClose && previousClose > 0 ? ((high - low) / previousClose) * 100 : null;
    previousClose = close;
    rows[index] = {
      date: formatDateInt(dateInt),
      dateInt,
      open,
      high,
      low,
      close,
      amount,
      volume,
      changePct,
      amplitudePct,
    };
  }
  return rows;
}

/**
 * Decode a minute-line buffer (.lc1/.lc5/.min).
 * @param {Uint8Array|Buffer} buffer
 * @returns {Array<object>}
 */
export function decodeMinuteBuffer(buffer) {
  const length = buffer.byteLength ?? buffer.length;
  if (length === 0) throw new TdxError('文件为空', 'EMPTY_FILE');
  if (length % RECORD_BYTES !== 0) {
    throw new TdxError(`文件长度 ${length} 字节不是 ${RECORD_BYTES} 的整数倍，不是有效的通达信行情文件`, 'BAD_SIZE');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset ?? 0, length);
  const count = length / RECORD_BYTES;
  const rows = new Array(count);
  let previousClose = null;
  for (let index = 0; index < count; index += 1) {
    const offset = index * RECORD_BYTES;
    const rawDate = view.getUint16(offset, true);
    const rawTime = view.getUint16(offset + 2, true);
    const dateInt = decodePackedDate(rawDate);
    const time = formatMinuteOfDay(rawTime);
    const open = round(view.getFloat32(offset + 4, true), 4);
    const high = round(view.getFloat32(offset + 8, true), 4);
    const low = round(view.getFloat32(offset + 12, true), 4);
    const close = round(view.getFloat32(offset + 16, true), 4);
    const rawAmount = view.getFloat32(offset + 20, true);
    const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
    const volume = view.getUint32(offset + 24, true);
    const changePct = previousClose && previousClose > 0 ? (close / previousClose - 1) * 100 : null;
    const amplitudePct = previousClose && previousClose > 0 ? ((high - low) / previousClose) * 100 : null;
    previousClose = close;
    rows[index] = {
      date: formatDateInt(dateInt),
      dateInt,
      time,
      timeInt: rawTime,
      open,
      high,
      low,
      close,
      amount,
      volume,
      changePct,
      amplitudePct,
    };
  }
  return rows;
}

/** Round to a fixed number of decimals without accumulating binary noise. */
function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* --------------------------------------------------------------- read file */

/**
 * Read and decode one TDX quote file.
 * @param {string} filePath
 * @returns {object} loaded file: path, size, count, format, instrument, quality, rows
 */
export function readTdxFile(filePath) {
  const absolute = resolve(String(filePath));
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new TdxError(`文件不存在或无法访问: ${absolute}`, 'NO_FILE');
  }
  if (!stat.isFile()) throw new TdxError(`不是文件: ${absolute}`, 'NOT_FILE');
  if (stat.size === 0) throw new TdxError(`文件为空: ${absolute}`, 'EMPTY_FILE');
  if (stat.size > MAX_FILE_BYTES) {
    throw new TdxError(`文件过大（${stat.size} 字节），超过 ${MAX_FILE_BYTES} 字节上限`, 'FILE_TOO_LARGE');
  }
  if (stat.size % RECORD_BYTES !== 0) {
    throw new TdxError(
      `文件大小 ${stat.size} 字节不是 ${RECORD_BYTES} 的整数倍，不是有效的通达信行情文件: ${absolute}`,
      'BAD_SIZE',
    );
  }
  const format = extensionInfo(absolute) ?? sniffFormat(absolute);
  let buffer;
  try {
    buffer = readFileSync(absolute);
  } catch (error) {
    throw new TdxError(`读取文件失败: ${absolute}（${error?.message ?? error}）`, 'READ_FAILED');
  }
  const rows = format.format === 'day' ? decodeDayBuffer(buffer) : decodeMinuteBuffer(buffer);
  const quality = inspectQuality(rows, format);
  const invalidRatio = rows.length === 0 ? 1 : quality.invalidDates / rows.length;
  if (rows.length === 0 || invalidRatio > 0.2) {
    throw new TdxError(
      `日期字段大面积无效（${quality.invalidDates}/${rows.length}），该文件不像是 ${format.label} 行情文件: ${absolute}`,
      'BAD_CONTENT',
    );
  }
  return {
    path: absolute,
    sizeBytes: stat.size,
    recordBytes: RECORD_BYTES,
    count: rows.length,
    format,
    instrument: describeInstrument(absolute),
    quality,
    rows,
  };
}

/** Collect structural quality counters for a decoded file. */
function inspectQuality(rows, format) {
  let invalidDates = 0;
  let nonMonotonic = 0;
  let badOhlc = 0;
  let zeroVolume = 0;
  let previousKey = null;
  for (const row of rows) {
    if (!row.dateInt) {
      invalidDates += 1;
      continue;
    }
    const key = format.format === 'minute'
      ? row.dateInt * 10000 + (row.timeInt ?? 0)
      : row.dateInt;
    if (previousKey !== null && key <= previousKey) nonMonotonic += 1;
    previousKey = key;
    if (!(row.volume > 0)) zeroVolume += 1;
    const upperBound = Math.max(row.open, row.close);
    const lowerBound = Math.min(row.open, row.close);
    if (!(row.open > 0 && row.close > 0 && row.high >= row.low
      && row.high + 1e-6 >= upperBound && row.low - 1e-6 <= lowerBound)) {
      badOhlc += 1;
    }
  }
  return {
    invalidDates,
    nonMonotonic,
    badOhlc,
    zeroVolume,
    monotonic: nonMonotonic === 0,
    suspicious: invalidDates + badOhlc > 0,
  };
}

/* -------------------------------------------------------------- instrument */

/**
 * Infer market, code and board from the file name (and path segments).
 * @param {string} filePath
 * @returns {object}
 */
export function describeInstrument(filePath) {
  const absolute = resolve(String(filePath));
  const base = basename(absolute, extname(absolute));
  const named = /^(sh|sz|bj)(\d{6})$/i.exec(base);
  let market = named ? named[1].toLowerCase() : undefined;
  let code = named ? named[2] : undefined;
  if (!code) {
    const bare = /^(\d{6})$/.exec(base);
    if (bare) code = bare[1];
  }
  if (!market) {
    const segments = absolute.toLowerCase().split(/[\\/]+/);
    market = segments.find((segment) => segment === 'sh' || segment === 'sz' || segment === 'bj');
  }
  const resolvedMarket = market ?? 'unknown';
  const board = classifyBoard(resolvedMarket, code);
  return {
    market: resolvedMarket,
    marketLabel: MARKET_LABELS[resolvedMarket] ?? MARKET_LABELS.unknown,
    code: code ?? base,
    board,
    boardLabel: board.label,
    kind: board.kind,
    kindLabel: BOARD_KIND_LABELS[board.kind] ?? BOARD_KIND_LABELS.other,
    volumeUnit: board.kind === 'index' ? '手' : '股',
  };
}

function classifyBoard(market, code) {
  if (code) {
    for (const [pattern, kind, label] of BOARD_RULES[market] ?? []) {
      if (pattern.test(code)) return { kind, label };
    }
  }
  return { kind: 'other', label: '未分类' };
}

/* --------------------------------------------------------------- selectors */

/**
 * Keep rows inside an inclusive date range.
 * @param {Array<object>} rows
 * @param {{startInt?: number|null, endInt?: number|null}} range
 * @returns {Array<object>}
 */
export function filterRows(rows, range = {}) {
  const startInt = range.startInt ?? null;
  const endInt = range.endInt ?? null;
  if (startInt === null && endInt === null) return rows;
  return rows.filter((row) => row.dateInt
    && (startInt === null || row.dateInt >= startInt)
    && (endInt === null || row.dateInt <= endInt));
}

/**
 * Order (asc/desc), offset and limit a selected row list.
 * @param {Array<object>} rows
 * @param {{order?: 'asc'|'desc', offset?: number, limit?: number}} options
 * @returns {{rows: Array<object>, total: number, truncated: boolean}}
 */
export function sliceRows(rows, options = {}) {
  const ordered = options.order === 'desc' ? [...rows].reverse() : rows;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.floor(options.limit ?? 30));
  return {
    rows: ordered.slice(offset, offset + limit),
    total: ordered.length,
    truncated: offset + limit < ordered.length,
  };
}

/* -------------------------------------------------------------- indicators */

/** Simple moving average series; null until the window is full. */
export function smaSeries(values, period) {
  const result = new Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    if (index >= period - 1) result[index] = sum / period;
  }
  return result;
}

/** Exponential moving average series seeded with the first value. */
export function emaSeries(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length === 0) return result;
  const alpha = 2 / (period + 1);
  let previous = values[0];
  result[0] = previous;
  for (let index = 1; index < values.length; index += 1) {
    previous = alpha * values[index] + (1 - alpha) * previous;
    result[index] = previous;
  }
  return result;
}

/** Wilder-smoothed RSI. */
export function rsiSeries(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = closes[index] - closes[index - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < closes.length; index += 1) {
    const delta = closes[index] - closes[index - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    result[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

/** TDX-style KDJ (9,3,3) with an EMA(1/3) smoothing pass. */
export function kdjSeries(rows, period = 9) {
  const k = new Array(rows.length).fill(null);
  const d = new Array(rows.length).fill(null);
  const j = new Array(rows.length).fill(null);
  let previousK = 50;
  let previousD = 50;
  for (let index = 0; index < rows.length; index += 1) {
    const start = Math.max(0, index - period + 1);
    let highest = -Infinity;
    let lowest = Infinity;
    for (let cursor = start; cursor <= index; cursor += 1) {
      highest = Math.max(highest, rows[cursor].high);
      lowest = Math.min(lowest, rows[cursor].low);
    }
    const rsv = highest === lowest ? 50 : ((rows[index].close - lowest) / (highest - lowest)) * 100;
    previousK = (2 / 3) * previousK + (1 / 3) * rsv;
    previousD = (2 / 3) * previousD + (1 / 3) * previousK;
    k[index] = previousK;
    d[index] = previousD;
    j[index] = 3 * previousK - 2 * previousD;
  }
  return { k, d, j };
}

/** Bollinger bands (20, 2) with population standard deviation. */
export function bollSeries(closes, period = 20, multiple = 2) {
  const middle = smaSeries(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let index = period - 1; index < closes.length; index += 1) {
    const mean = middle[index];
    let squared = 0;
    for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
      squared += (closes[cursor] - mean) ** 2;
    }
    const deviation = Math.sqrt(squared / period);
    upper[index] = mean + multiple * deviation;
    lower[index] = mean - multiple * deviation;
  }
  return { middle, upper, lower };
}

/** Wilder ATR. */
export function atrSeries(rows, period = 14) {
  const result = new Array(rows.length).fill(null);
  if (rows.length === 0) return result;
  const trueRanges = rows.map((row, index) => {
    if (index === 0) return row.high - row.low;
    const previousClose = rows[index - 1].close;
    return Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose),
    );
  });
  let sum = 0;
  for (let index = 0; index < trueRanges.length; index += 1) {
    sum += trueRanges[index];
    if (index === period - 1) {
      result[index] = sum / period;
    } else if (index >= period) {
      result[index] = (result[index - 1] * (period - 1) + trueRanges[index]) / period;
    }
  }
  return result;
}

/**
 * Compute every indicator the plugin reports.
 * @param {Array<object>} rows
 * @returns {object}
 */
export function computeIndicators(rows) {
  const closes = rows.map((row) => row.close);
  const ma = {};
  for (const period of [5, 10, 20, 30, 60, 120, 250]) ma[period] = smaSeries(closes, period);
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const dif = closes.map((_, index) => ema12[index] - ema26[index]);
  const dea = emaSeries(dif, 9);
  const histogram = dif.map((value, index) => 2 * (value - dea[index]));
  return {
    ma,
    macd: { dif, dea, histogram },
    rsi14: rsiSeries(closes, 14),
    kdj: kdjSeries(rows, 9),
    boll: bollSeries(closes, 20, 2),
    atr14: atrSeries(rows, 14),
  };
}

/* ----------------------------------------------------------------- summary */

function lastValue(values) {
  return values.length > 0 ? values[values.length - 1] : null;
}

function percentChange(current, base) {
  return base ? (current / base - 1) * 100 : null;
}

/**
 * Build the full summary report for a loaded file.
 * @param {object} loaded
 * @returns {object}
 */
export function buildSummary(loaded) {
  const rows = loaded.rows.filter((row) => row.dateInt);
  if (rows.length === 0) throw new TdxError('文件中没有有效行情记录', 'NO_ROWS');
  const closes = rows.map((row) => row.close);
  const count = rows.length;
  const latest = rows[count - 1];
  const previous = count > 1 ? rows[count - 2] : null;
  const indicators = computeIndicators(rows);
  const window = rows.slice(-TRADING_DAYS_52W);
  const highWindow = Math.max(...window.map((row) => row.high));
  const lowWindow = Math.min(...window.map((row) => row.low));
  const position = highWindow === lowWindow ? 0.5 : (latest.close - lowWindow) / (highWindow - lowWindow);
  const returns = [1, 5, 20, 60, 120, 250].map((period) => ({
    period,
    pct: count > period ? percentChange(latest.close, closes[count - 1 - period]) : null,
  }));
  const latestYear = Math.floor(latest.dateInt / 10000);
  let yearBase = null;
  for (let index = count - 1; index >= 0; index -= 1) {
    if (Math.floor(rows[index].dateInt / 10000) < latestYear) {
      yearBase = rows[index].close;
      break;
    }
  }
  if (yearBase === null) yearBase = rows[0].close;
  const dailyReturns = [];
  for (let index = 1; index < window.length; index += 1) {
    if (window[index - 1].close > 0 && window[index].close > 0) {
      dailyReturns.push(Math.log(window[index].close / window[index - 1].close));
    }
  }
  let volatilityPct = null;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1);
    volatilityPct = Math.sqrt(variance) * Math.sqrt(WEEKDAYS_PER_YEAR) * 100;
  }
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const row of window) {
    peak = Math.max(peak, row.close);
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, row.close / peak - 1);
  }
  const recent = (values, countToTake) => values.slice(-countToTake);
  const sumField = (sourceRows, field, countToTake) => recent(sourceRows, countToTake)
    .reduce((sum, row) => sum + (row[field] ?? 0), 0);
  const meanField = (sourceRows, field, countToTake) => {
    const slice = recent(sourceRows, countToTake);
    return slice.length === 0 ? null : slice.reduce((sum, row) => sum + (row[field] ?? 0), 0) / slice.length;
  };
  const compactRows = (sourceRows) => sourceRows.map((row) => ({
    date: row.date,
    ...(row.time ? { time: row.time } : {}),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    changePct: row.changePct,
    amplitudePct: row.amplitudePct,
    amount: row.amount,
    volume: row.volume,
  }));
  return {
    file: loaded.path,
    instrument: loaded.instrument,
    format: loaded.format,
    count,
    range: { start: rows[0].date, end: latest.date },
    latest: compactRows([latest])[0],
    previousClose: previous ? previous.close : null,
    changePct: previous ? percentChange(latest.close, previous.close) : null,
    amplitudePct: previous ? ((latest.high - latest.low) / previous.close) * 100 : null,
    high52w: highWindow,
    low52w: lowWindow,
    position52w: position,
    windowSize: window.length,
    ma: Object.fromEntries(Object.entries(indicators.ma).map(([period, series]) => [period, lastValue(series)])),
    macd: {
      dif: lastValue(indicators.macd.dif),
      dea: lastValue(indicators.macd.dea),
      histogram: lastValue(indicators.macd.histogram),
    },
    rsi14: lastValue(indicators.rsi14),
    kdj: {
      k: lastValue(indicators.kdj.k),
      d: lastValue(indicators.kdj.d),
      j: lastValue(indicators.kdj.j),
    },
    boll: {
      upper: lastValue(indicators.boll.upper),
      middle: lastValue(indicators.boll.middle),
      lower: lastValue(indicators.boll.lower),
    },
    atr14: lastValue(indicators.atr14),
    returns,
    ytdPct: percentChange(latest.close, yearBase),
    volatilityPct,
    maxDrawdownPct: maxDrawdown * 100,
    amountMa5: meanField(rows, 'amount', 5),
    amountMa20: meanField(rows, 'amount', 20),
    amountSum5: sumField(rows, 'amount', 5),
    amountSum20: sumField(rows, 'amount', 20),
    volumeMa5: meanField(rows, 'volume', 5),
    volumeMa20: meanField(rows, 'volume', 20),
    totalAmount: rows.reduce((sum, row) => sum + (row.amount ?? 0), 0),
    totalVolume: rows.reduce((sum, row) => sum + (row.volume ?? 0), 0),
    sparkline: sparkline(closes.slice(-60)),
    quality: loaded.quality,
  };
}

/** Unicode block sparkline over a small series. */
export function sparkline(values) {
  if (!values || values.length === 0) return '';
  const characters = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return characters[3].repeat(values.length);
  return values.map((value) => {
    const ratio = (value - min) / (max - min);
    const index = Math.min(characters.length - 1, Math.max(0, Math.round(ratio * (characters.length - 1))));
    return characters[index];
  }).join('');
}

/* ---------------------------------------------------------------- resample */

function monthKey(dateInt) {
  const year = Math.floor(dateInt / 10000);
  const month = Math.floor(dateInt / 100) % 100;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function isoWeekKey(dateInt) {
  const year = Math.floor(dateInt / 10000);
  const month = Math.floor(dateInt / 100) % 100;
  const day = dateInt % 100;
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Aggregate daily rows into weekly or monthly bars.
 * @param {Array<object>} rows
 * @param {'week'|'month'} period
 * @returns {Array<object>}
 */
export function resampleRows(rows, period = 'week') {
  const bars = [];
  let current = null;
  for (const row of rows) {
    if (!row.dateInt) continue;
    const key = period === 'month' ? monthKey(row.dateInt) : isoWeekKey(row.dateInt);
    if (current === null || current.key !== key) {
      if (current !== null) bars.push(current);
      current = {
        key,
        startDate: row.date,
        endDate: row.date,
        dateInt: row.dateInt,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        amount: row.amount ?? 0,
        volume: row.volume ?? 0,
      };
    } else {
      current.endDate = row.date;
      current.dateInt = row.dateInt;
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.amount += row.amount ?? 0;
      current.volume += row.volume ?? 0;
    }
  }
  if (current !== null) bars.push(current);
  return bars.map((bar, index) => {
    const previous = index > 0 ? bars[index - 1] : null;
    return {
      ...bar,
      changePct: previous && previous.close ? (bar.close / previous.close - 1) * 100 : null,
      amplitudePct: previous && previous.close ? ((bar.high - bar.low) / previous.close) * 100 : null,
    };
  });
}

/* -------------------------------------------------------------------- CSV */

/**
 * Build CSV text (with UTF-8 BOM) for the given rows.
 * @param {Array<object>} rows
 * @returns {{text: string, header: string}}
 */
export function buildCsvText(rows) {
  const hasTime = rows.some((row) => typeof row.time === 'string');
  const header = hasTime
    ? 'date,time,open,high,low,close,change_pct,amplitude_pct,amount,volume'
    : 'date,open,high,low,close,change_pct,amplitude_pct,amount,volume';
  const lines = rows.map((row) => {
    const fields = [
      row.date ?? '',
      ...(hasTime ? [row.time ?? ''] : []),
      row.open.toFixed(2),
      row.high.toFixed(2),
      row.low.toFixed(2),
      row.close.toFixed(2),
      row.changePct === null || row.changePct === undefined ? '' : row.changePct.toFixed(4),
      row.amplitudePct === null || row.amplitudePct === undefined ? '' : row.amplitudePct.toFixed(4),
      Number(row.amount ?? 0).toFixed(2),
      String(row.volume ?? 0),
    ];
    return fields.join(',');
  });
  const body = lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '';
  return { text: `\uFEFF${header}\r\n${body}`, header };
}

/**
 * Write a CSV export file (creating parent directories when needed).
 * @param {Array<object>} rows
 * @param {string} outPath
 * @returns {{path: string, bytes: number, rows: number}}
 */
export function exportCsvFile(rows, outPath) {
  if (rows.length === 0) throw new TdxError('没有可导出的行情记录', 'NO_ROWS');
  const absolute = resolve(String(outPath));
  const csv = buildCsvText(rows);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, csv.text, 'utf8');
  } catch (error) {
    throw new TdxError(`写入 CSV 失败: ${absolute}（${error?.message ?? error}）`, 'WRITE_FAILED');
  }
  return { path: absolute, bytes: Buffer.byteLength(csv.text, 'utf8'), rows: rows.length, header: csv.header };
}

/* ------------------------------------------------------------------- scan */

/** Read only the date of the first record in a record buffer. */
function quickRecordDate(buffer, format) {
  if (buffer.length < RECORD_BYTES) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const dateInt = format.format === 'day'
    ? view.getUint32(0, true)
    : decodePackedDate(view.getUint16(0, true));
  return isValidDateInt(dateInt) ? formatDateInt(dateInt) : null;
}

/** Stat one file and read the first/last record dates without decoding the body. */
function readCoverage(fullPath, format) {
  const coverage = { bytes: 0, records: 0, firstDate: null, lastDate: null };
  try {
    const fileStat = statSync(fullPath);
    coverage.bytes = fileStat.size;
    coverage.records = Math.floor(fileStat.size / RECORD_BYTES);
    if (coverage.records > 0 && fileStat.size % RECORD_BYTES === 0) {
      const descriptor = openSync(fullPath, 'r');
      try {
        const head = Buffer.alloc(RECORD_BYTES);
        readSync(descriptor, head, 0, RECORD_BYTES, 0);
        const tail = Buffer.alloc(RECORD_BYTES);
        readSync(descriptor, tail, 0, RECORD_BYTES, fileStat.size - RECORD_BYTES);
        coverage.firstDate = quickRecordDate(head, format);
        coverage.lastDate = quickRecordDate(tail, format);
      } finally {
        closeSync(descriptor);
      }
    }
  } catch {
    // keep the file listed with the counters we could read
  }
  return coverage;
}

/**
 * Recursively find TDX quote files and report their coverage without reading
 * full bodies.
 * @param {string} directory
 * @param {{market?: string, pattern?: string, limit?: number}} [options]
 * @returns {object}
 */
export function scanTdxFiles(directory, options = {}) {
  const absolute = resolve(String(directory));
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new TdxError(`目录不存在或无法访问: ${absolute}`, 'NO_DIR');
  }
  if (!stat.isDirectory()) throw new TdxError(`不是目录: ${absolute}`, 'NOT_DIR');
  const marketFilter = options.market ? String(options.market).toLowerCase() : null;
  if (marketFilter !== null && !['sh', 'sz', 'bj'].includes(marketFilter)) {
    throw new TdxError(`market 只能是 sh/sz/bj，收到: ${options.market}`, 'BAD_MARKET');
  }
  const pattern = options.pattern ? String(options.pattern).toLowerCase() : null;
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
  const candidates = [];
  const marketCounts = {};
  let scanned = 0;
  let matched = 0;
  const stack = [absolute];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const format = extensionInfo(entry.name);
      if (!format) continue;
      scanned += 1;
      const instrument = describeInstrument(fullPath);
      marketCounts[instrument.market] = (marketCounts[instrument.market] ?? 0) + 1;
      if (marketFilter !== null && instrument.market !== marketFilter) continue;
      if (pattern !== null
        && !instrument.code.toLowerCase().includes(pattern)
        && !entry.name.toLowerCase().includes(pattern)) {
        continue;
      }
      matched += 1;
      candidates.push({ file: fullPath, instrument, format });
    }
  }
  const marketOrder = { bj: 0, sh: 1, sz: 2, unknown: 3 };
  candidates.sort((left, right) => (marketOrder[left.instrument.market] ?? 9) - (marketOrder[right.instrument.market] ?? 9)
    || left.instrument.code.localeCompare(right.instrument.code));
  // Only the reported page pays for stat/open; a whole-tree count stays cheap.
  const results = candidates.slice(0, limit).map((candidate) => {
    const coverage = readCoverage(candidate.file, candidate.format);
    const { instrument } = candidate;
    return {
      market: instrument.market,
      marketLabel: instrument.marketLabel,
      code: instrument.code,
      kind: instrument.kind,
      kindLabel: instrument.kindLabel,
      boardLabel: instrument.boardLabel,
      format: candidate.format.format,
      formatLabel: candidate.format.label,
      extension: candidate.format.extension,
      records: coverage.records,
      bytes: coverage.bytes,
      firstDate: coverage.firstDate,
      lastDate: coverage.lastDate,
      file: candidate.file,
    };
  });
  return {
    dir: absolute,
    scanned,
    matched,
    results,
    marketCounts,
    truncated: matched > results.length,
    limit,
  };
}
