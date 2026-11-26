/**
 * 5分钟数据覆盖度详表 —— 只列实际情况，不做「完整/缺失」判断。
 *
 * 因为通达信对分钟数据的保留期有限（约 5 个月），
 * 老股票的 5 分钟数据不可能追溯到上市日，所以不做简单判断，
 * 而是把「上市日 / 5分钟起始日 / 可用区间」如实列出，由使用者判断。
 *
 * 用法：
 *   node analyze/coverage-detail.mjs                     # 汇总 + 导出全表
 *   node analyze/coverage-detail.mjs --market=sh         # 只看沪市
 *   node analyze/coverage-detail.mjs --type=stock        # 只看股票
 *   node analyze/coverage-detail.mjs --sort=gap          # 按缺口天数排序
 */

import fs from 'node:fs';
import path from 'node:path';

const TDX = 'D:\\MyTools\\new_tdx';

/* ---------------------------------------------------------- 参数 */

function parseArgs(argv) {
  const o = { market: null, type: null, sort: 'code', limit: null, export: true };
  for (const arg of argv) {
    if (arg.startsWith('--market=')) o.market = arg.slice(9);
    else if (arg.startsWith('--type=')) o.type = arg.slice(7);
    else if (arg.startsWith('--sort=')) o.sort = arg.slice(7);
    else if (arg.startsWith('--limit=')) o.limit = Number(arg.slice(8));
    else if (arg === '--no-export') o.export = false;
  }
  return o;
}

/* ---------------------------------------------------------- 读取工具 */

/** 读 .lc5 首尾日期（只读 4 字节 × 2）。 */
function readLc5Range(file) {
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

  const decodeZip = (buf) => {
    const zip = buf.readUInt16LE(0);
    const y = (zip >> 11) + 2004;
    const mo = Math.trunc((zip % 2048) / 100);
    const d = (zip % 2048) % 100;
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}${String(mo).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  };
  return { first: decodeZip(head), last: decodeZip(tail), count };
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

/* ---------------------------------------------------------- 类型判断 */

function codeType(market, code) {
  if (market === 'sh') {
    if (/^(600|601|603|605|688|689)\d/.test(code)) return '股票';
    if (/^(510|511|512|513|515|517|518|520|526|560|561|562|563|588|589)\d/.test(code)) return 'ETF';
    if (/^(900)\d/.test(code)) return 'B股';
    if (/^(000|880|999|950)\d/.test(code)) return '指数';
    return '其他';
  }
  if (market === 'sz') {
    if (/^(000|001|002|003|300|301)\d/.test(code)) return '股票';
    if (/^(159|160|161|162|163|164|165|166|167|168|169)\d/.test(code)) return 'ETF';
    if (/^(200)\d/.test(code)) return 'B股';
    if (/^(399)\d/.test(code)) return '指数';
    return '其他';
  }
  if (market === 'bj') {
    if (/^(43|83|87|92)\d/.test(code)) return '股票';
    if (/^(899)\d/.test(code)) return '指数';
    return '其他';
  }
  return '其他';
}

/* ---------------------------------------------------------- 扫描 */

const opt = parseArgs(process.argv.slice(2));
const markets = opt.market ? [opt.market] : ['sh', 'sz', 'bj'];
const rows = [];

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
    const type = codeType(market, code);
    if (type === '指数' || type === '其他') continue;
    if (opt.type && opt.type !== type) continue;

    const range5 = readLc5Range(path.join(dir5, name));
    const rangeDay = readDayRange(path.join(dirDay, `${market}${code}.day`));

    rows.push({
      symbol: `${market}${code}`,
      market, code, type,
      dayFirst: rangeDay?.first ?? null,
      dayLast: rangeDay?.last ?? null,
      dayCount: rangeDay?.count ?? 0,
      min5First: range5?.first ?? null,
      min5Last: range5?.last ?? null,
      min5Count: range5?.count ?? 0,
    });
  }
}

if (rows.length === 0) {
  console.log('没有找到数据');
  process.exit(0);
}

// 全局基准
const globalMin5First = rows
  .map((r) => r.min5First)
  .filter(Boolean)
  .sort()[0] ?? null;
const globalMin5Last = rows
  .map((r) => r.min5Last)
  .filter(Boolean)
  .sort()
  .pop() ?? null;

/* ---------------------------------------------------------- 计算派生字段 */

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(4, 6)) - 1, Number(a.slice(6, 8)));
  const db = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(4, 6)) - 1, Number(b.slice(6, 8)));
  return Math.round((db - da) / 86400000);
}

/*
 * 正确的判断基准：
 *
 * 通达信对分钟数据的保留期有限（约 5 个月），所以：
 *   · 老股票（上市早于保留期起点）→ 5 分钟只能从保留期起点开始，不是缺失
 *   · 新股票（上市晚于保留期起点）→ 5 分钟应从上市日开始，晚了才是缺失
 *
 * 因此 应覆盖起点 = max(分钟数据保留期起点, 上市日)
 *      分钟保留期起点 = 全局 5 分钟最早日（20241219 或 20260716，取决于标的）
 *
 * 但这里有个陷阱：不同标的的保留期起点可能不同（有的 20241219，有的 20260716）。
 * 所以更稳妥的做法是取「该标的同类标的的多数起点」作为保留期基准。
 */

// 计算「保留期基准」：取所有标的中出现最多的 5 分钟起始日
const firstDist = new Map();
for (const r of rows) {
  if (!r.min5First) continue;
  firstDist.set(r.min5First, (firstDist.get(r.min5First) ?? 0) + 1);
}
const retentionBase = [...firstDist.entries()]
  .sort((a, b) => b[1] - a[1])[0][0]; // 最常见的起始日

console.log(`分钟数据保留期基准（最常见起始日）：${retentionBase}`);
console.log(`  分布前 5：${[...firstDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  .map(([d, c]) => `${d}(${c})`).join('  ')}`);
console.log('');

for (const r of rows) {
  // 该标的应覆盖的起点 = max(保留期基准, 上市日)
  r.retentionBase = retentionBase;
  r.expectedStart = (r.dayFirst && r.dayFirst > retentionBase) ? r.dayFirst : retentionBase;
  // 起始缺口：实际起始日晚于应覆盖起点
  r.gapDays = daysBetween(r.expectedStart, r.min5First);
  if (r.gapDays !== null && r.gapDays < 0) r.gapDays = 0;
  // 停更天数
  r.staleDays = daysBetween(r.min5Last, globalMin5Last);
  if (r.staleDays !== null && r.staleDays < 0) r.staleDays = 0;
  // 日线是否也停了（退市判断）
  r.delisted = Boolean(r.dayLast && daysBetween(r.dayLast, globalMin5Last) > 30);
}

/* ---------------------------------------------------------- 输出汇总 */

const total = rows.length;
const pctOf = (n) => `${((n / total) * 100).toFixed(1)}%`;

console.log('='.repeat(84));
console.log('5分钟数据覆盖度详表');
console.log('='.repeat(84));
console.log(`全局 5 分钟数据区间：${globalMin5First} ~ ${globalMin5Last}`);
console.log(`（通达信对分钟线保留期有限，老股票也只能回溯到这里）`);
console.log('');
console.log(`标的总数：${total}`);
console.log('');
console.log('说明：「应覆盖起点」= max(全局最早日, 该标的上市日)');
console.log('      「起始缺口」= 实际5分钟起始日 - 应覆盖起点（0 表示无缺口）');
console.log('='.repeat(84));
console.log('');

// 按类型统计
const byType = new Map();
for (const r of rows) {
  if (!byType.has(r.type)) byType.set(r.type, []);
  byType.get(r.type).push(r);
}

console.log('── 按标的类型 ──');
console.log('类型      总数   零缺口   有缺口   最大缺口天数');
for (const [type, list] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const noGap = list.filter((r) => r.gapDays === 0).length;
  const hasGap = list.filter((r) => r.gapDays > 0).length;
  const maxGap = Math.max(0, ...list.map((r) => r.gapDays ?? 0));
  console.log(`${type.padEnd(9)}${String(list.length).padStart(6)}`
    + `${String(noGap).padStart(8)}  ${pctOf(noGap).padStart(7)}`
    + `${String(hasGap).padStart(8)}  ${pctOf(hasGap).padStart(7)}`
    + `${String(maxGap).padStart(14)} 天`);
}
console.log('');

// 按缺口天数分布
console.log('── 缺口天数分布 ──');
const gapBuckets = [
  ['0 天（无缺口）', (g) => g === 0],
  ['1~5 天', (g) => g > 0 && g <= 5],
  ['6~20 天', (g) => g > 5 && g <= 20],
  ['21~60 天', (g) => g > 20 && g <= 60],
  ['>60 天', (g) => g > 60],
];
for (const [label, test] of gapBuckets) {
  const n = rows.filter((r) => r.gapDays !== null && test(r.gapDays)).length;
  console.log(`  ${label.padEnd(16)}${String(n).padStart(6)}  ${pctOf(n).padStart(7)}`);
}
console.log('');

// 停更统计
const stale = rows.filter((r) => r.staleDays > 5 && !r.delisted);
const delisted = rows.filter((r) => r.delisted);
console.log('── 停更情况 ──');
console.log(`  5分钟数据停更（日线仍在更新）：${stale.length} 个  ← 需要补最新`);
console.log(`  已退市/长期停牌（日线也停）：  ${delisted.length} 个  ← 无需处理`);
console.log('');

/* ---------------------------------------------------------- 排序输出 */

let sorted = [...rows];
switch (opt.sort) {
  case 'gap':
    sorted.sort((a, b) => (b.gapDays ?? 0) - (a.gapDays ?? 0));
    break;
  case 'stale':
    sorted.sort((a, b) => (b.staleDays ?? 0) - (a.staleDays ?? 0));
    break;
  default:
    sorted.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const show = opt.limit ? sorted.slice(0, opt.limit) : sorted;

console.log('='.repeat(84));
console.log(`明细（按 ${opt.sort} 排序，共 ${show.length} 行）`);
console.log('='.repeat(84));
console.log('标的        类型   上市日      日线最后    5分钟起始   5分钟最后   记录数  起始缺口  停更');
console.log('-'.repeat(96));
for (const r of show) {
  const gapText = r.gapDays === 0 ? '—' : `${r.gapDays}天`;
  const staleText = r.staleDays > 5 ? `${r.staleDays}天` : '—';
  console.log(
    `${r.symbol}`.padEnd(12)
    + `${r.type}`.padEnd(6)
    + `${r.dayFirst ?? '(无)'}`.padStart(10)
    + `${r.dayLast ?? '(无)'}`.padStart(12)
    + `${r.min5First ?? '(无)'}`.padStart(12)
    + `${r.min5Last ?? '(无)'}`.padStart(12)
    + String(r.min5Count).padStart(8)
    + gapText.padStart(10)
    + staleText.padStart(7),
  );
}

/* ---------------------------------------------------------- 导出 CSV */

if (opt.export) {
  const listFile = path.join('analyze', 'coverage-detail.csv');
  const header = ['标的', '市场', '代码', '类型', '上市日', '日线最后', '日线记录数',
    '5分钟起始', '5分钟最后', '5分钟记录数', '应覆盖起点', '起始缺口天数', '停更天数', '已退市'];
  const lines = [header.join(',')];
  for (const r of sorted) {
    lines.push([
      r.symbol, r.market, r.code, r.type,
      r.dayFirst ?? '', r.dayLast ?? '', r.dayCount,
      r.min5First ?? '', r.min5Last ?? '', r.min5Count,
      r.expectedStart ?? '', r.gapDays ?? '', r.staleDays ?? '',
      r.delisted ? '是' : '否',
    ].join(','));
  }
  fs.writeFileSync(listFile, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  console.log('');
  console.log(`完整明细已导出：${listFile}（${sorted.length} 行，可用 Excel 筛选）`);
}
