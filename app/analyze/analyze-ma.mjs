/**
 * 分析 T+1日内最高涨幅% 与日线/15分钟均线的关系。
 *
 * 用法：node analyze/analyze-ma.mjs <扫描结果.xlsx>
 *
 * 输出：
 *   1. 日线级别 MA5/10/20/60 偏离度与 T+1涨幅的相关性
 *   2. 15分钟级别 MA5/10/20/60 偏离度与 T+1涨幅的相关性
 *   3. 各均线的「站上/跌破」二分类对比
 *   4. 组合筛选效果
 */

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { readDayFile, readLc5As } from '../lc5-reader.js';

/* ---------------------------------------------------------- 读 xlsx */

function readXlsx(file) {
  const buffer = readFileSync(file);
  const entries = new Map();
  let i = 0;
  while (i < buffer.length - 4) {
    if (buffer.readUInt32LE(i) !== 0x04034b50) { i += 1; continue; }
    const method = buffer.readUInt16LE(i + 8);
    const compSize = buffer.readUInt32LE(i + 18);
    const nameLen = buffer.readUInt16LE(i + 26);
    const extraLen = buffer.readUInt16LE(i + 28);
    const name = buffer.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const raw = buffer.subarray(start, start + compSize);
    const content = method === 0 ? raw.toString('utf8')
      : method === 8 ? inflateRawSync(raw).toString('utf8') : undefined;
    if (content !== undefined) entries.set(name, content);
    i = start + compSize;
  }
  const sheetXml = entries.get('xl/worksheets/sheet1.xml');
  const rows = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRegex.exec(sheetXml)) !== null) {
    const cells = [];
    const cellRegex = /<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cellRegex.exec(rm[1])) !== null) {
      let col = 0;
      for (const ch of cm[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      col -= 1;
      const inner = cm[4];
      const v = /<v>([^<]*)<\/v>/.exec(inner);
      const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
      if (v) cells[col] = Number(v[1]);
      else if (t) cells[col] = t[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    }
    rows.push(cells);
  }
  return { header: rows[0], rows: rows.slice(1) };
}

/* ---------------------------------------------------------- 统计工具 */

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pearson = (xs, ys) => {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs); const my = mean(ys);
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx; const b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
};

function stat(values) {
  if (values.length === 0) return null;
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    win: (values.filter((v) => v > 0).length / values.length) * 100,
    gt3: (values.filter((v) => v >= 3).length / values.length) * 100,
  };
}

/* ---------------------------------------------------------- 均线计算 */

/** 简单移动平均，返回与 bars 等长的数组（前 period-1 个为 null）。 */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/* ---------------------------------------------------------- 主流程 */

const TDX = 'D:\\MyTools\\new_tdx';
const file = process.argv[2];

const { header, rows } = readXlsx(file);
const idx = (n) => header.indexOf(n);
const C = {
  code: idx('代码'),
  buyTime: idx('买入时间'),
  t1Rise: idx('T+1日内最高涨幅%'),
  tClose: idx('T日收盘价'),
  tDayChange: idx('T日收盘涨跌幅%'),
};

const hits = rows
  .map((r) => ({
    code: r[C.code],
    buyTime: r[C.buyTime],
    t1Rise: r[C.t1Rise],
    tClose: r[C.tClose],
    tDayChange: r[C.tDayChange],
  }))
  .filter((h) => typeof h.code === 'string' && /^[a-z]{2}\d{6}$/.test(h.code)
    && Number.isFinite(h.t1Rise) && typeof h.buyTime === 'string');

console.log(`\n样本：${hits.length} 个买点\n`);

// 按股票分组，避免重复读文件
const byStock = new Map();
for (const hit of hits) {
  if (!byStock.has(hit.code)) byStock.set(hit.code, []);
  byStock.get(hit.code).push(hit);
}
console.log(`涉及 ${byStock.size} 只股票，开始计算均线…\n`);

const enriched = [];
let processed = 0;
let failed = 0;

for (const [code, list] of byStock) {
  const mk = code.slice(0, 2);
  const num = code.slice(2);

  // ---- 日线 ----
  let dayBars = [];
  try {
    dayBars = readDayFile(`${TDX}\\vipdoc\\${mk}\\lday\\${mk}${num}.day`);
  } catch { dayBars = []; }
  if (dayBars.length < 60) { failed += list.length; continue; }

  const dayDates = dayBars.map((b) => b.date);
  const dayClose = dayBars.map((b) => b.close);
  const dayHigh = dayBars.map((b) => b.high);
  const dayMa = {
    5: sma(dayClose, 5),
    10: sma(dayClose, 10),
    20: sma(dayClose, 20),
    60: sma(dayClose, 60),
  };

  // ---- 15分钟 ----
  let bars15 = [];
  try {
    bars15 = readLc5As(`${TDX}\\vipdoc\\${mk}\\fzline\\${mk}${num}.lc5`, 3);
  } catch { bars15 = []; }

  const close15 = bars15.map((b) => b.close);
  const ma15 = bars15.length >= 60 ? {
    5: sma(close15, 5),
    10: sma(close15, 10),
    20: sma(close15, 20),
    60: sma(close15, 60),
  } : null;

  for (const hit of list) {
    const tDate = hit.buyTime.slice(0, 10).replace(/-/g, '');

    // 日线：找 T 日
    const di = dayDates.lastIndexOf(tDate);
    if (di < 0) { failed += 1; continue; }

    const rec = { ...hit };

    // 日线均线偏离度：(T日收盘 - MA) / MA × 100
    rec.dayDev = {};
    rec.dayAbove = {};
    for (const p of [5, 10, 20, 60]) {
      const ma = dayMa[p][di];
      if (ma === null) continue;
      rec.dayDev[p] = Number((((dayClose[di] - ma) / ma) * 100).toFixed(2));
      rec.dayAbove[p] = dayClose[di] > ma;
    }
    // 日线最高价相对 MA
    rec.dayHighDev = {};
    for (const p of [5, 10, 20, 60]) {
      const ma = dayMa[p][di];
      if (ma === null) continue;
      rec.dayHighDev[p] = Number((((dayHigh[di] - ma) / ma) * 100).toFixed(2));
    }

    // 15分钟：找 T 日最后一根 K 线
    if (ma15) {
      let last15 = -1;
      for (let i = 0; i < bars15.length; i += 1) {
        if (bars15[i].date === tDate) last15 = i;
      }
      if (last15 >= 0) {
        rec.dev15 = {};
        rec.above15 = {};
        for (const p of [5, 10, 20, 60]) {
          const ma = ma15[p][last15];
          if (ma === null) continue;
          rec.dev15[p] = Number((((close15[last15] - ma) / ma) * 100).toFixed(2));
          rec.above15[p] = close15[last15] > ma;
        }
      }
    }

    enriched.push(rec);
    processed += 1;
  }
}

console.log(`成功计算 ${processed} 个样本，失败 ${failed} 个\n`);

const t1 = enriched.map((r) => r.t1Rise);
console.log('='.repeat(76));
console.log(`基准：T+1日内最高涨幅%  平均 ${mean(t1).toFixed(2)}%  中位 ${median(t1).toFixed(2)}%  >0占 ${(t1.filter((v) => v > 0).length / t1.length * 100).toFixed(0)}%`);
console.log('='.repeat(76));

/* ---------- 1. 日线均线偏离度相关性 ---------- */

console.log('\n【1. 日线级别：T日收盘价相对均线的偏离度】');
console.log('偏离度 = (T日收盘 - MA) / MA × 100  —— 正数表示在均线上方\n');
console.log('均线     样本   Pearson相关   偏离度<0时T+1    偏离度>0时T+1   差值');
console.log('-'.repeat(80));
const dayCorrs = [];
for (const p of [5, 10, 20, 60]) {
  const pairs = enriched.filter((r) => Number.isFinite(r.dayDev?.[p]));
  if (pairs.length < 20) continue;
  const xs = pairs.map((r) => r.dayDev[p]);
  const ys = pairs.map((r) => r.t1Rise);
  const corr = pearson(xs, ys);

  // 分组：站上 vs 跌破
  const above = pairs.filter((r) => r.dayAbove[p]).map((r) => r.t1Rise);
  const below = pairs.filter((r) => !r.dayAbove[p]).map((r) => r.t1Rise);
  const a = stat(above); const b = stat(below);
  if (!a || !b) continue;

  dayCorrs.push({ p, corr, above: a, below: b });
  console.log(`MA${p}`.padEnd(9) + String(pairs.length).padStart(5)
    + `${corr.toFixed(3).padStart(13)}`
    + `${b.mean.toFixed(2).padStart(14)}%`
    + `${a.mean.toFixed(2).padStart(15)}%`
    + `${(a.mean - b.mean).toFixed(2).padStart(8)}%`);
}

/* ---------- 2. 15分钟均线偏离度相关性 ---------- */

console.log('\n【2. 15分钟级别：T日最后一根K线收盘价相对均线的偏离度】\n');
console.log('均线     样本   Pearson相关   偏离度<0时T+1    偏离度>0时T+1   差值');
console.log('-'.repeat(80));
const min15Corrs = [];
for (const p of [5, 10, 20, 60]) {
  const pairs = enriched.filter((r) => Number.isFinite(r.dev15?.[p]));
  if (pairs.length < 20) continue;
  const xs = pairs.map((r) => r.dev15[p]);
  const ys = pairs.map((r) => r.t1Rise);
  const corr = pearson(xs, ys);

  const above = pairs.filter((r) => r.above15[p]).map((r) => r.t1Rise);
  const below = pairs.filter((r) => !r.above15[p]).map((r) => r.t1Rise);
  const a = stat(above); const b = stat(below);
  if (!a || !b) continue;

  min15Corrs.push({ p, corr, above: a, below: b });
  console.log(`MA${p}`.padEnd(9) + String(pairs.length).padStart(5)
    + `${corr.toFixed(3).padStart(13)}`
    + `${b.mean.toFixed(2).padStart(14)}%`
    + `${a.mean.toFixed(2).padStart(15)}%`
    + `${(a.mean - b.mean).toFixed(2).padStart(8)}%`);
}

/* ---------- 3. 按偏离度分档 ---------- */

console.log('\n【3. 偏离度分档（看是否单调）】\n');

const bucketDefs = [
  ['<-5%', (v) => v < -5],
  ['-5~-2%', (v) => v >= -5 && v < -2],
  ['-2~0%', (v) => v >= -2 && v < 0],
  ['0~2%', (v) => v >= 0 && v < 2],
  ['2~5%', (v) => v >= 2 && v < 5],
  ['>5%', (v) => v >= 5],
];

function printBuckets(label, getValue) {
  const pairs = enriched.filter((r) => Number.isFinite(getValue(r)));
  if (pairs.length < 50) return;
  console.log(`${label}：`);
  for (const [name, test] of bucketDefs) {
    const sub = pairs.filter((r) => test(getValue(r)));
    const s = stat(sub.map((r) => r.t1Rise));
    if (!s || s.n < 10) continue;
    console.log(`  ${name.padEnd(9)}n=${String(s.n).padStart(4)}`
      + `  平均 ${s.mean.toFixed(2).padStart(6)}%`
      + `  中位 ${s.median.toFixed(2).padStart(6)}%`
      + `  >0占 ${s.win.toFixed(0).padStart(3)}%`
      + `  ≥3%占 ${s.gt3.toFixed(0).padStart(3)}%`);
  }
  console.log('');
}

for (const p of [20, 60]) printBuckets(`日线 MA${p} 偏离度`, (r) => r.dayDev?.[p]);
for (const p of [20, 60]) printBuckets(`15分钟 MA${p} 偏离度`, (r) => r.dev15?.[p]);

/* ---------- 4. 组合筛选 ---------- */

console.log('【4. 组合筛选效果（目标是最大化 T+1平均）】\n');
console.log('筛选条件                              样本   T+1平均   T+1中位  >0占  ≥3%占');
console.log('-'.repeat(86));

const cos = [
  ['基准（全部）', () => true],
  ['日线 MA20 上方', (r) => r.dayAbove?.[20] === true],
  ['日线 MA20 下方', (r) => r.dayAbove?.[20] === false],
  ['日线 MA60 上方', (r) => r.dayAbove?.[60] === true],
  ['日线 MA60 下方', (r) => r.dayAbove?.[60] === false],
  ['15分 MA20 上方', (r) => r.above15?.[20] === true],
  ['15分 MA20 下方', (r) => r.above15?.[20] === false],
  ['15分 MA60 上方', (r) => r.above15?.[60] === true],
  ['15分 MA60 下方', (r) => r.above15?.[60] === false],
  ['日MA20上 + 15分MA20下', (r) => r.dayAbove?.[20] === true && r.above15?.[20] === false],
  ['日MA20下 + 15分MA20上', (r) => r.dayAbove?.[20] === false && r.above15?.[20] === true],
  ['日MA60下 + 15分MA60下', (r) => r.dayAbove?.[60] === false && r.above15?.[60] === false],
  ['日MA20偏离<-2%', (r) => Number.isFinite(r.dayDev?.[20]) && r.dayDev[20] < -2],
  ['日MA20偏离>+2%', (r) => Number.isFinite(r.dayDev?.[20]) && r.dayDev[20] > 2],
];

for (const [label, test] of cos) {
  const sub = enriched.filter(test);
  const s = stat(sub.map((r) => r.t1Rise));
  if (!s) continue;
  console.log(`${label.padEnd(36)}${String(s.n).padStart(5)}`
    + `${s.mean.toFixed(2).padStart(9)}%${s.median.toFixed(2).padStart(9)}%`
    + `${s.win.toFixed(0).padStart(6)}%${s.gt3.toFixed(0).padStart(7)}%`);
}

console.log('');
