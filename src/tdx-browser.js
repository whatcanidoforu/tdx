/**
 * 通达信 (TDX) 浏览器端解析器
 *
 * 从 Node.js lib/tdx.js 提取所有纯计算逻辑，将文件 I/O 替换为 FileReader API。
 * 可在浏览器中直接解析 .day / .lc1 / .lc5 / .min 二进制行情文件。
 */

const RECORD_BYTES = 32;
const DAY_PRICE_DIVISOR = 100;
const WEEKDAYS_PER_YEAR = 252;
const TRADING_DAYS_52W = 250;

const EXTENSIONS = Object.freeze({
  '.day': { format: 'day', minutes: null, label: '日线', extension: '.day' },
  '.lc1': { format: 'minute', minutes: 1, label: '1分钟线', extension: '.lc1' },
  '.lc5': { format: 'minute', minutes: 5, label: '5分钟线', extension: '.lc5' },
  '.min': { format: 'minute', minutes: 1, label: '1分钟线', extension: '.min' },
});

const MARKET_LABELS = { sh: '上海证券交易所', sz: '深圳证券交易所', bj: '北京证券交易所', unknown: '未知市场' };

const BOARD_RULES = {
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
};

const BOARD_KIND_LABELS = { index: '指数', stock: '股票', fund: '基金', bond: '债券', other: '其他' };

/* ------------------------------------------------------------------ dates */

export function isValidDateInt(value) {
  if (!Number.isInteger(value) || value < 19000101 || value > 22001231) return false;
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function formatDateInt(value) {
  if (!isValidDateInt(value)) return null;
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function decodePackedDate(packed) {
  if (!Number.isInteger(packed) || packed <= 0) return 0;
  const year = 2004 + Math.floor(packed / 2048);
  const remainder = packed % 2048;
  const month = Math.floor(remainder / 100);
  const day = remainder % 100;
  const value = year * 10000 + month * 100 + day;
  return isValidDateInt(value) ? value : 0;
}

function formatMinuteOfDay(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) return null;
  const hour = Math.floor(minutes / 60);
  const minute = Math.floor(minutes % 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* -------------------------------------------------------------- instrument */

function extensionInfo(filePath) {
  const lower = String(filePath).toLowerCase();
  for (const [ext, info] of Object.entries(EXTENSIONS)) {
    if (lower.endsWith(ext)) return info;
  }
  return undefined;
}

function sniffFormat(buffer) {
  if (buffer.byteLength < RECORD_BYTES) {
    throw new Error('文件太小，无法识别格式');
  }
  const view = new DataView(buffer);
  const asDayDate = view.getUint32(0, true);
  if (isValidDateInt(asDayDate)) {
    return { format: 'day', minutes: null, label: '日线', extension: '', sniffed: true };
  }
  const asMinuteDate = decodePackedDate(view.getUint16(0, true));
  const asMinuteTime = view.getUint16(2, true);
  if (asMinuteDate && asMinuteTime <= 24 * 60) {
    return { format: 'minute', minutes: null, label: '分钟线', extension: '', sniffed: true };
  }
  throw new Error('不支持的文件格式（需要 .day/.lc1/.lc5/.min）');
}

function describeInstrument(filePath) {
  const base = filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const named = /^(sh|sz|bj)(\d{6})$/i.exec(base);
  let market = named ? named[1].toLowerCase() : undefined;
  let code = named ? named[2] : undefined;
  if (!code) {
    const bare = /^(\d{6})$/.exec(base);
    if (bare) code = bare[1];
  }
  if (!market) {
    const segments = filePath.toLowerCase().split(/[\\/]+/);
    market = segments.find((s) => s === 'sh' || s === 'sz' || s === 'bj');
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

/* ----------------------------------------------------------------- decode */

function decodeDayBuffer(buffer) {
  const length = buffer.byteLength ?? buffer.length;
  if (length === 0) throw new Error('文件为空');
  if (length % RECORD_BYTES !== 0) throw new Error(`文件长度 ${length} 字节不是 ${RECORD_BYTES} 的整数倍`);
  const view = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, length);
  const count = length / RECORD_BYTES;
  const rows = new Array(count);
  let previousClose = null;
  for (let i = 0; i < count; i++) {
    const off = i * RECORD_BYTES;
    const rawDate = view.getUint32(off, true);
    const dateInt = isValidDateInt(rawDate) ? rawDate : 0;
    const open = view.getUint32(off + 4, true) / DAY_PRICE_DIVISOR;
    const high = view.getUint32(off + 8, true) / DAY_PRICE_DIVISOR;
    const low = view.getUint32(off + 12, true) / DAY_PRICE_DIVISOR;
    const close = view.getUint32(off + 16, true) / DAY_PRICE_DIVISOR;
    const rawAmount = view.getFloat32(off + 20, true);
    const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
    const volume = view.getUint32(off + 24, true);
    const changePct = previousClose && previousClose > 0 ? (close / previousClose - 1) * 100 : null;
    const amplitudePct = previousClose && previousClose > 0 ? ((high - low) / previousClose) * 100 : null;
    previousClose = close;
    rows[i] = { date: formatDateInt(dateInt), dateInt, open, high, low, close, amount, volume, changePct, amplitudePct };
  }
  return rows;
}

function decodeMinuteBuffer(buffer) {
  const length = buffer.byteLength ?? buffer.length;
  if (length === 0) throw new Error('文件为空');
  if (length % RECORD_BYTES !== 0) throw new Error(`文件长度 ${length} 字节不是 ${RECORD_BYTES} 的整数倍`);
  const view = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, length);
  const count = length / RECORD_BYTES;
  const rows = new Array(count);
  let previousClose = null;
  for (let i = 0; i < count; i++) {
    const off = i * RECORD_BYTES;
    const rawDate = view.getUint16(off, true);
    const rawTime = view.getUint16(off + 2, true);
    const dateInt = decodePackedDate(rawDate);
    const time = formatMinuteOfDay(rawTime);
    const open = round(view.getFloat32(off + 4, true), 4);
    const high = round(view.getFloat32(off + 8, true), 4);
    const low = round(view.getFloat32(off + 12, true), 4);
    const close = round(view.getFloat32(off + 16, true), 4);
    const rawAmount = view.getFloat32(off + 20, true);
    const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
    const volume = view.getUint32(off + 24, true);
    const changePct = previousClose && previousClose > 0 ? (close / previousClose - 1) * 100 : null;
    const amplitudePct = previousClose && previousClose > 0 ? ((high - low) / previousClose) * 100 : null;
    previousClose = close;
    rows[i] = { date: formatDateInt(dateInt), dateInt, time, timeInt: rawTime, open, high, low, close, amount, volume, changePct, amplitudePct };
  }
  return rows;
}

function inspectQuality(rows, format) {
  let invalidDates = 0, nonMonotonic = 0, badOhlc = 0, zeroVolume = 0, previousKey = null;
  for (const row of rows) {
    if (!row.dateInt) { invalidDates++; continue; }
    const key = format.format === 'minute' ? row.dateInt * 10000 + (row.timeInt ?? 0) : row.dateInt;
    if (previousKey !== null && key <= previousKey) nonMonotonic++;
    previousKey = key;
    if (!(row.volume > 0)) zeroVolume++;
    const upper = Math.max(row.open, row.close), lower = Math.min(row.open, row.close);
    if (!(row.open > 0 && row.close > 0 && row.high >= row.low && row.high + 1e-6 >= upper && row.low - 1e-6 <= lower)) badOhlc++;
  }
  return { invalidDates, nonMonotonic, badOhlc, zeroVolume, monotonic: nonMonotonic === 0, suspicious: invalidDates + badOhlc > 0 };
}

/* ------------------------------------------------------ browser file loader */

/**
 * 浏览器端解析 TDX 文件
 * @param {string} name - 文件名（如 "sh600519.day"）
 * @param {ArrayBuffer} arrayBuffer - 文件内容
 * @returns {object}
 */
export function parseTdxFile(name, arrayBuffer) {
  if (arrayBuffer.byteLength === 0) throw new Error('文件为空');
  if (arrayBuffer.byteLength > 512 * 1024 * 1024) throw new Error('文件过大');
  if (arrayBuffer.byteLength % RECORD_BYTES !== 0) throw new Error(`文件大小 ${arrayBuffer.byteLength} 字节不是 ${RECORD_BYTES} 的整数倍`);

  const format = extensionInfo(name) ?? sniffFormat(arrayBuffer);
  const buffer = new Uint8Array(arrayBuffer);
  const rows = format.format === 'day' ? decodeDayBuffer(buffer) : decodeMinuteBuffer(buffer);
  const quality = inspectQuality(rows, format);
  const invalidRatio = rows.length === 0 ? 1 : quality.invalidDates / rows.length;
  if (rows.length === 0 || invalidRatio > 0.2) {
    throw new Error(`日期字段大面积无效（${quality.invalidDates}/${rows.length}），不像 ${format.label} 行情文件`);
  }
  return {
    path: name,
    sizeBytes: arrayBuffer.byteLength,
    recordBytes: RECORD_BYTES,
    count: rows.length,
    format,
    instrument: describeInstrument(name),
    quality,
    rows,
  };
}

/* ------------------------------------------------------ scan (browser) */

/**
 * 浏览器端批量扫描文件
 * @param {Array<{name: string, arrayBuffer: ArrayBuffer}>} files
 * @returns {object}
 */
export function scanFiles(files) {
  const results = [];
  const marketCounts = {};
  for (const file of files) {
    try {
      const parsed = parseTdxFile(file.name, file.arrayBuffer);
      const first = parsed.rows[0];
      const last = parsed.rows[parsed.rows.length - 1];
      const market = parsed.instrument.market;
      marketCounts[market] = (marketCounts[market] || 0) + 1;
      results.push({
        market,
        marketLabel: parsed.instrument.marketLabel,
        code: parsed.instrument.code,
        kind: parsed.instrument.kind,
        kindLabel: parsed.instrument.kindLabel,
        boardLabel: parsed.instrument.boardLabel,
        format: parsed.format.format,
        formatLabel: parsed.format.label,
        extension: parsed.format.extension,
        records: parsed.count,
        bytes: parsed.sizeBytes,
        firstDate: first?.date ?? null,
        lastDate: last?.date ?? null,
        file: file.name,
        _loaded: parsed,
      });
    } catch {
      // skip unparseable files
    }
  }
  return { dir: '', scanned: files.length, matched: results.length, marketCounts, results, truncated: false };
}

/* -------------------------------------------------------------- indicators */

export function smaSeries(values, period) {
  const result = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

export function emaSeries(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length === 0) return result;
  const alpha = 2 / (period + 1);
  let prev = values[0];
  result[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    result[i] = prev;
  }
  return result;
}

export function rsiSeries(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta; else losses -= delta;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (delta > 0 ? delta : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (delta < 0 ? -delta : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

export function kdjSeries(rows, period = 9) {
  const k = new Array(rows.length).fill(null);
  const d = new Array(rows.length).fill(null);
  const j = new Array(rows.length).fill(null);
  let prevK = 50, prevD = 50;
  for (let i = 0; i < rows.length; i++) {
    const start = Math.max(0, i - period + 1);
    let highest = -Infinity, lowest = Infinity;
    for (let c = start; c <= i; c++) { highest = Math.max(highest, rows[c].high); lowest = Math.min(lowest, rows[c].low); }
    const rsv = highest === lowest ? 50 : ((rows[i].close - lowest) / (highest - lowest)) * 100;
    prevK = (2 / 3) * prevK + (1 / 3) * rsv;
    prevD = (2 / 3) * prevD + (1 / 3) * prevK;
    k[i] = prevK; d[i] = prevD; j[i] = 3 * prevK - 2 * prevD;
  }
  return { k, d, j };
}

export function bollSeries(closes, period = 20, multiple = 2) {
  const middle = smaSeries(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const mean = middle[i];
    let squared = 0;
    for (let c = i - period + 1; c <= i; c++) squared += (closes[c] - mean) ** 2;
    const dev = Math.sqrt(squared / period);
    upper[i] = mean + multiple * dev;
    lower[i] = mean - multiple * dev;
  }
  return { middle, upper, lower };
}

export function atrSeries(rows, period = 14) {
  const result = new Array(rows.length).fill(null);
  if (rows.length === 0) return result;
  const tr = rows.map((row, i) => {
    if (i === 0) return row.high - row.low;
    const pc = rows[i - 1].close;
    return Math.max(row.high - row.low, Math.abs(row.high - pc), Math.abs(row.low - pc));
  });
  let sum = 0;
  for (let i = 0; i < tr.length; i++) {
    sum += tr[i];
    if (i === period - 1) result[i] = sum / period;
    else if (i >= period) result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }
  return result;
}

export function computeIndicators(rows) {
  const closes = rows.map((r) => r.close);
  const ma = {};
  for (const p of [5, 10, 20, 30, 60, 120, 250]) ma[p] = smaSeries(closes, p);
  const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
  const dif = closes.map((_, i) => ema12[i] - ema26[i]);
  const dea = emaSeries(dif, 9);
  const histogram = dif.map((v, i) => 2 * (v - dea[i]));
  return { ma, macd: { dif, dea, histogram }, rsi14: rsiSeries(closes, 14), kdj: kdjSeries(rows, 9), boll: bollSeries(closes, 20, 2), atr14: atrSeries(rows, 14) };
}

/* ----------------------------------------------------------------- summary */

function lastValue(values) { return values.length > 0 ? values[values.length - 1] : null; }
function percentChange(current, base) { return base ? (current / base - 1) * 100 : null; }

export function buildSummary(loaded) {
  const rows = loaded.rows.filter((r) => r.dateInt);
  if (rows.length === 0) throw new Error('文件中没有有效行情记录');
  const closes = rows.map((r) => r.close);
  const count = rows.length;
  const latest = rows[count - 1];
  const previous = count > 1 ? rows[count - 2] : null;
  const indicators = computeIndicators(rows);
  const window = rows.slice(-TRADING_DAYS_52W);
  const highW = Math.max(...window.map((r) => r.high));
  const lowW = Math.min(...window.map((r) => r.low));
  const position = highW === lowW ? 0.5 : (latest.close - lowW) / (highW - lowW);
  const returns = [1, 5, 20, 60, 120, 250].map((p) => ({ period: p, pct: count > p ? percentChange(latest.close, closes[count - 1 - p]) : null }));
  const latestYear = Math.floor(latest.dateInt / 10000);
  let yearBase = null;
  for (let i = count - 1; i >= 0; i--) { if (Math.floor(rows[i].dateInt / 10000) < latestYear) { yearBase = rows[i].close; break; } }
  if (yearBase === null) yearBase = rows[0].close;
  const dailyReturns = [];
  for (let i = 1; i < window.length; i++) { if (window[i - 1].close > 0 && window[i].close > 0) dailyReturns.push(Math.log(window[i].close / window[i - 1].close)); }
  let volPct = null;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyReturns.length - 1);
    volPct = Math.sqrt(variance) * Math.sqrt(WEEKDAYS_PER_YEAR) * 100;
  }
  let peak = -Infinity, maxDD = 0;
  for (const r of window) { peak = Math.max(peak, r.close); if (peak > 0) maxDD = Math.min(maxDD, r.close / peak - 1); }
  const recent = (vals, n) => vals.slice(-n);
  const meanField = (src, field, n) => { const s = recent(src, n); return s.length === 0 ? null : s.reduce((sum, r) => sum + (r[field] ?? 0), 0) / s.length; };
  const sumField = (src, field, n) => recent(src, n).reduce((sum, r) => sum + (r[field] ?? 0), 0);
  return {
    file: loaded.path, instrument: loaded.instrument, format: loaded.format, count,
    range: { start: rows[0].date, end: latest.date },
    latest: { date: latest.date, time: latest.time, open: latest.open, high: latest.high, low: latest.low, close: latest.close, changePct: latest.changePct, amplitudePct: latest.amplitudePct, amount: latest.amount, volume: latest.volume },
    previousClose: previous ? previous.close : null,
    changePct: previous ? percentChange(latest.close, previous.close) : null,
    amplitudePct: previous ? ((latest.high - latest.low) / previous.close) * 100 : null,
    high52w: highW, low52w: lowW, position52w: position, windowSize: window.length,
    ma: Object.fromEntries(Object.entries(indicators.ma).map(([p, s]) => [p, lastValue(s)])),
    macd: { dif: lastValue(indicators.macd.dif), dea: lastValue(indicators.macd.dea), histogram: lastValue(indicators.macd.histogram) },
    rsi14: lastValue(indicators.rsi14),
    kdj: { k: lastValue(indicators.kdj.k), d: lastValue(indicators.kdj.d), j: lastValue(indicators.kdj.j) },
    boll: { upper: lastValue(indicators.boll.upper), middle: lastValue(indicators.boll.middle), lower: lastValue(indicators.boll.lower) },
    atr14: lastValue(indicators.atr14), returns, ytdPct: percentChange(latest.close, yearBase),
    volatilityPct: volPct, maxDrawdownPct: maxDD * 100,
    amountMa5: meanField(rows, 'amount', 5), amountMa20: meanField(rows, 'amount', 20),
    amountSum5: sumField(rows, 'amount', 5), amountSum20: sumField(rows, 'amount', 20),
    volumeMa5: meanField(rows, 'volume', 5), volumeMa20: meanField(rows, 'volume', 20),
    totalAmount: rows.reduce((s, r) => s + (r.amount ?? 0), 0),
    totalVolume: rows.reduce((s, r) => s + (r.volume ?? 0), 0),
    quality: loaded.quality,
  };
}

/* -------------------------------------------------------------- selectors */

export function filterRows(rows, startInt, endInt) {
  if (startInt == null && endInt == null) return rows;
  return rows.filter((r) => r.dateInt && (startInt == null || r.dateInt >= startInt) && (endInt == null || r.dateInt <= endInt));
}

export function sliceRows(rows, offset = 0, limit = 30, order = 'desc') {
  const ordered = order === 'desc' ? [...rows].reverse() : rows;
  const off = Math.max(0, Math.floor(offset));
  const lim = Math.max(1, Math.floor(limit));
  return { rows: ordered.slice(off, off + lim), total: ordered.length, truncated: off + lim < ordered.length };
}