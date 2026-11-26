/**
 * 5分钟数据覆盖度体检 —— 找出需要补充的股票。
 *
 * 用法：node analyze/check-5min-coverage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const TDX = 'D:\\MyTools\\new_tdx';

/** 读 .lc5 首尾记录日期（只读 32 字节）。 */
function readRange(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  const count = Math.floor(size / 32);
  if (count === 0) return null;
  const head = Buffer.alloc(4);
  const tail = Buffer.alloc(4);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.readSync(fd, tail, 0, 4, (count - 1) * 32);
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }

  const decode = (buf) => {
    const zip = buf.readUInt16LE(0);
    const year = (zip >> 11) + 2004;
    const month = Math.trunc((zip % 2048) / 100);
    const day = (zip % 2048) % 100;
    if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  };
  return { first: decode(head), last: decode(tail), count };
}

/** 读 .day 首尾日期。 */
function readDayRange(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  const count = Math.floor(size / 32);
  if (count === 0) return null;
  const head = Buffer.alloc(4);
  const tail = Buffer.alloc(4);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.readSync(fd, tail, 0, 4, (count - 1) * 32);
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
  const decode = (buf) => {
    const v = buf.readUInt32LE(0);
    const y = Math.trunc(v / 10000);
    const m = Math.trunc((v % 10000) / 100);
    const d = v % 100;
    if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return String(v);
  };
  return { first: decode(head), last: decode(tail), count };
}

/** 是否 A 股/ETF（排除指数）-- */
function isStockCode(market, code) {
  if (market === 'sh') {
    if (/^(60\d|68\d|900)/.test(code)) return code.startsWith('60') || code.startsWith('68');
    return false;
  }
  if (market === 'sz') {
    return /^(00\d|30\d)/.test(code);
  }
  if (market === 'bj') {
    return /^(43\d|83\d|87\d|92\d)/.test(code);
  }
  return false;
}

/** 是否 ETF */
function isEtfCode(market, code) {
  if (market === 'sh') return /^(51\d|52\d|56\d|58\d)/.test(code);
  if (market === 'sz') return /^15\d/.test(code);
  return false;
}

// 5分钟数据（15分钟由它聚合）
const LC5_START_TARGET = '20260716'; // 期望最早
const REQUIRED_LAST = process.argv[2] ?? null; // 期望最新日期（不传则取全局最新）

const markets = ['sh', 'sz', 'bj'];
const buckets = {
  // 按「5分钟起始日 vs 上市日」分类
  full: [],        // 从上市日就有（完整）
  partial: [],     // 上市后 2 个月内才开始（部分缺失）
  late: [],        // 上市很久后才有（严重缺失）
  empty: [],       // 无 5 分钟数据
  unknown: [],     // 无日线参照，无法判断
  stale: [],       // 仍在交易但 5 分钟结束日落后
  delisted: [],    // 已退市/长期停牌
};

let globalLatest = '00000000';
const allStocks = [];

/**
 * 判断 5 分钟数据的起始日是否「等于上市日」。
 *
 * 上市日 = 日线文件的起始日（当天开始有交易）。
 * 5 分钟数据如果是完整的，起始日应当与上市日相近（同日或之后 1~2 个交易日，
 * 因为通达信可能从上市次日才开始记录分钟线）。
 *
 * 允许的容差：日线起始日 <= 5分钟起始日 <= 日线起始日 + 10 个交易日（约 2 周）。
 * 超出这个范围说明中间有真实的缺口。
 */
const TOLERANCE_DAYS = 10;

/** 把 YYYYMMDD 字符串往后推 N 个自然日（近似交易日，保守估计）。 */
function addDays(dateStr, days) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6)) - 1;
  const d = Number(dateStr.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
}

for (const market of markets) {
  const dir5 = path.join(TDX, 'vipdoc', market, 'fzline');
  const dirDay = path.join(TDX, 'vipdoc', market, 'lday');
  let names;
  try { names = fs.readdirSync(dir5); } catch { continue; }

  for (const name of names) {
    if (!name.endsWith('.lc5')) continue;
    const m = /^([a-z]{2})(\d{6})\.lc5$/i.exec(name);
    if (!m) continue;
    const code = m[2];
    if (!isStockCode(market, code) && !isEtfCode(market, code)) continue;

    const range = readRange(path.join(dir5, name));
    const dayRange = readDayRange(path.join(dirDay, `${market}${code}.day`));
    const isEtf = isEtfCode(market, code);

    if (!range) {
      buckets.empty.push({ market, code, isEtf, dayFirst: dayRange?.first ?? null, dayLast: dayRange?.last ?? null });
      continue;
    }
    if (range.last > globalLatest) globalLatest = range.last;

    const item = {
      market, code, isEtf,
      first: range.first, last: range.last, count: range.count,
      dayFirst: dayRange?.first ?? null,
      dayLast: dayRange?.last ?? null,
    };
    allStocks.push(item);

    if (range.first === null) { buckets.empty.push(item); continue; }

    // 按「5分钟起始日 vs 上市日」判断完整性
    if (!item.dayFirst) {
      // 没有日线文件作为参照，退回按绝对日期判断
      if (range.first <= '20260716') buckets.full.push(item);
      else buckets.unknown.push(item);
      continue;
    }
    const toleranceEnd = addDays(item.dayFirst, TOLERANCE_DAYS);
    if (range.first <= toleranceEnd) {
      buckets.full.push(item);           // 从上市日就有 → 完整
    } else if (range.first <= addDays(item.dayFirst, 60)) {
      buckets.partial.push(item);        // 上市后 2 个月内才开始 → 部分缺失
    } else {
      buckets.late.push(item);           // 上市很久后才有 → 严重缺失
    }
  }
}

const expectedLast = REQUIRED_LAST ?? globalLatest;

// 统计结束日落后（排除已退市的：日线最后日期也落后）
const DAY_STALE_THRESHOLD = addDays(expectedLast, -10);
for (const item of allStocks) {
  if (item.last >= expectedLast) continue;
  // 日线也停在老日期 → 已退市/长期停牌，不算数据缺失
  if (item.dayLast && item.dayLast < DAY_STALE_THRESHOLD) {
    buckets.delisted.push(item);
    continue;
  }
  buckets.stale.push(item);
}

const total = allStocks.length + buckets.empty.length;
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;

console.log('='.repeat(78));
console.log('5分钟数据覆盖度体检');
console.log('='.repeat(78));
console.log(`全局最新 5分钟日期：${globalLatest}`);
console.log(`期望最新日期：${expectedLast}`);
console.log(`有效标的总数：${allStocks.length}`);
console.log('');
console.log('完整度判断标准：5分钟起始日 是否 ≈ 上市日（日线起始日）');
console.log('='.repeat(78));
console.log('');

console.log('── 完整性分类 ──');
console.log(`  ✔ 完整（从上市日就有）    ${String(buckets.full.length).padStart(5)}  ${pct(buckets.full.length).padStart(6)}`);
console.log(`  ⚠ 部分（上市后才有）      ${String(buckets.partial.length).padStart(5)}  ${pct(buckets.partial.length).padStart(6)}`);
console.log(`  ✘ 严重缺失（很晚才有）    ${String(buckets.late.length).padStart(5)}  ${pct(buckets.late.length).padStart(6)}`);
console.log(`  ✘ 无5分钟数据            ${String(buckets.empty.length).padStart(5)}  ${pct(buckets.empty.length).padStart(6)}`);
if (buckets.unknown.length > 0) {
  console.log(`  ? 无日线参照             ${String(buckets.unknown.length).padStart(5)}  ${pct(buckets.unknown.length).padStart(6)}`);
}
console.log('');

console.log('── 结束日停更 ──');
console.log(`  仍在交易但5分钟落后 ${expectedLast}：${buckets.stale.length} 个  ← 这些需要补最新`);
console.log(`  已退市/长期停牌（日线也停）：${buckets.delisted.length} 个  ← 无需处理`);
console.log('');

// 统计需要补的：真实缺口 + 停更（排除退市）
const needFix = new Set();
for (const item of [...buckets.partial, ...buckets.late, ...buckets.empty]) {
  needFix.add(`${item.market}${item.code}`);
}
for (const item of buckets.stale) needFix.add(`${item.market}${item.code}`);
for (const item of buckets.stale) needFix.add(`${item.market}${item.code}`);

console.log('='.repeat(78));
console.log(`合计需要处理的标的：${needFix.size} 个（占 ${((needFix.size / total) * 100).toFixed(1)}%）`);
console.log('='.repeat(78));
console.log('');

// 分市场统计
console.log('── 各市场需要处理的数量 ──');
for (const market of markets) {
  const need = [...needFix].filter((s) => s.startsWith(market));
  const stocks = need.filter((s) => isStockCode(market, s.slice(2))).length;
  const etfs = need.filter((s) => isEtfCode(market, s.slice(2))).length;
  console.log(`  ${market.toUpperCase()}: 共 ${String(need.length).padStart(5)}（股票 ${stocks}，ETF ${etfs}）`);
}
console.log('');

// 起始日分布
const firstDist = new Map();
for (const item of allStocks) {
  firstDist.set(item.first, (firstDist.get(item.first) ?? 0) + 1);
}
console.log('── 起始日分布（前 15）──');
for (const [d, c] of [...firstDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${d}  ${String(c).padStart(5)} 个  ${((c / total) * 100).toFixed(1)}%`);
}
console.log('');

// 导出需要处理的清单
const listFile = path.join('analyze', 'need-5min.csv');
const lines = ['市场,代码,类型,上市日,现起始日,缺失起始日,现结束日,现有记录数,问题'];
for (const symbol of [...needFix].sort()) {
  const market = symbol.slice(0, 2);
  const code = symbol.slice(2);
  const item = allStocks.find((s) => s.market === market && s.code === code);
  const isEtf = isEtfCode(market, code);
  let problem = '';
  if (!item) problem = '无5分钟数据';
  else if (item.last < expectedLast && item.dayLast && item.dayLast >= DAY_STALE_THRESHOLD) problem = '停更';
  else if (item.first && item.dayFirst && item.first > addDays(item.dayFirst, 60)) problem = '严重缺失';
  else problem = '部分缺失';
  lines.push([
    market, code, isEtf ? 'ETF' : '股票',
    item?.dayFirst ?? '(无)',
    item?.first ?? '(无)',
    item?.dayFirst ?? '(无)',   // 建议从上市日补起
    item?.last ?? '(无)',
    item?.count ?? 0,
    problem,
  ].join(','));
}
fs.writeFileSync(listFile, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
console.log(`需要补充的清单已导出：${listFile}`);
console.log('');

// 示例：部分缺失/严重缺失的前几个
const samples = [...buckets.partial, ...buckets.late].slice(0, 12);
if (samples.length > 0) {
  console.log('── 缺口示例（前 12）──');
  console.log('标的        上市日      5分钟起始   缺口天数  类型');
  for (const s of samples) {
    const days = Math.round((new Date(Number(s.first.slice(0, 4)), Number(s.first.slice(4, 6)) - 1, Number(s.first.slice(6, 8)))
      - new Date(Number(s.dayFirst.slice(0, 4)), Number(s.dayFirst.slice(4, 6)) - 1, Number(s.dayFirst.slice(6, 8)))) / 86400000);
    const type = buckets.late.includes(s) ? '严重缺失' : '部分缺失';
    console.log(`${s.market}${s.code}`.padEnd(12)
      + String(s.dayFirst).padStart(10)
      + String(s.first).padStart(12)
      + String(days).padStart(9) + ' 天'
      + '  ' + type);
  }
  console.log('');
}
