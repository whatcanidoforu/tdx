/**
 * 选股结果分析器 —— 从 xlsx/csv 里找与「T+1 最高收益」相关的指标。
 *
 * 用法：
 *   node analyze-result.mjs <xlsx或csv路径>
 *
 * 输出：
 *   1. 各指标与 T+1 收益的相关系数
 *   2. 按 T+0 收益分档的 T+1 表现（每 1%）
 *   3. T+0 表现一般时，哪些指标仍能预测 T+1
 *   4. 波动率假说检验（区分「波动大」还是「趋势延续」）
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/* -------------------------------------------------- 读取 */

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
  if (!sheetXml) throw new Error('找不到 sheet1');

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
      else if (t) {
        cells[col] = t[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      }
    }
    rows.push(cells);
  }
  return { header: rows[0], rows: rows.slice(1) };
}

function parseCsvLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function readData(file) {
  if (file.toLowerCase().endsWith('.xlsx')) return readXlsx(file);
  const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  return {
    header: parseCsvLine(lines[0]),
    rows: lines.slice(1).map((line) => parseCsvLine(line).map((v) => {
      const n = Number(v);
      return v !== '' && Number.isFinite(n) ? n : v;
    })),
  };
}

/* -------------------------------------------------- 统计 */

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
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

/* -------------------------------------------------- 主流程 */

const file = process.argv[2];
if (!file) {
  console.log('用法: node analyze-result.mjs <xlsx或csv路径>');
  process.exit(1);
}

const { header, rows } = readData(file);
const col = (name) => header.indexOf(name);
const C = {
  code: col('代码'), points: col('低点数'),
  firstHj: col('首HJ10'), firstDif: col('首DIF'), firstClose: col('首收盘'),
  lastHj: col('末HJ10'), lastDif: col('末DIF'), lastClose: col('末收盘'),
  hj10Rise: col('HJ10抬高'), priceDrop: col('价格跌幅%'),
  buyTime: col('买入时间'), buyPrice: col('买入价'),
  t0: col('T+0最高收益%'), t1: col('T+1最高收益%'), t2: col('T+2最高收益%'),
  decline: col('日线HJ10连跌天数'), dailyHj: col('日线HJ10'), dailyMacd: col('日线MACD柱'),
  dailyHjDown: col('日线HJ10是否下降'), dailyMacdDown: col('日线MACD柱是否缩小'),
};

const data = rows.filter((r) => Number.isFinite(r[C.t1]));
if (data.length === 0) {
  console.log('没有有效的 T+1 数据');
  process.exit(1);
}

console.log(`\n样本：${data.length} 个买点`);
const t1All = data.map((r) => r[C.t1]);
console.log(`T+1 最高收益：平均 ${mean(t1All).toFixed(2)}%，中位 ${median(t1All).toFixed(2)}%，`
  + `>0 占比 ${((t1All.filter((v) => v > 0).length / t1All.length) * 100).toFixed(1)}%`);

/* 1. 相关性 */
console.log('\n===== 1. 与 T+1 收益的相关性 =====');
const features = [
  ['T+0最高收益%', C.t0], ['价格跌幅%', C.priceDrop], ['末DIF', C.lastDif],
  ['首DIF', C.firstDif], ['日线MACD柱', C.dailyMacd], ['首HJ10', C.firstHj],
  ['末HJ10', C.lastHj], ['日线HJ10', C.dailyHj], ['买入价', C.buyPrice],
  ['HJ10抬高', C.hj10Rise], ['日线连跌天数', C.decline], ['低点数', C.points],
];
const corrs = [];
for (const [name, c] of features) {
  if (c < 0) continue;
  const pairs = data.map((r) => [r[c], r[C.t1]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const r = pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  if (r !== null) corrs.push({ name, r, n: pairs.length });
}
corrs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
for (const { name, r, n } of corrs) {
  const tag = Math.abs(r) > 0.3 ? '强' : Math.abs(r) > 0.15 ? '中' : Math.abs(r) > 0.05 ? '弱' : '无';
  console.log(`  ${name.padEnd(16)} r=${r.toFixed(3).padStart(7)}  (n=${n}) ${tag}`);
}

/* 2. T+0 分档 */
const withT0 = data.filter((r) => Number.isFinite(r[C.t0]));
if (withT0.length > 0) {
  console.log('\n===== 2. 按 T+0 收益分档（每 1%）=====');
  console.log('档位        样本   占比   T+1平均  T+1中位  离散度   胜率  T+1减T+0');
  console.log('-'.repeat(76));
  const buckets = new Map();
  for (const r of withT0) {
    const v = r[C.t0];
    const key = v < 0 ? '负' : `${Math.floor(v)}~${Math.floor(v) + 1}%`;
    const lower = v < 0 ? -Infinity : Math.floor(v);
    if (!buckets.has(key)) buckets.set(key, { key, lower, rows: [] });
    buckets.get(key).rows.push(r);
  }
  for (const g of [...buckets.values()].sort((a, b) => a.lower - b.lower)) {
    const t1 = g.rows.map((r) => r[C.t1]);
    const delta = g.rows.map((r) => r[C.t1] - r[C.t0]);
    const pct = ((g.rows.length / withT0.length) * 100).toFixed(1);
    console.log(`${g.key.padEnd(12)}${String(g.rows.length).padStart(5)}${pct.padStart(7)}%`
      + `${mean(t1).toFixed(2).padStart(9)}%${median(t1).toFixed(2).padStart(9)}%`
      + `${(std(t1) ?? 0).toFixed(2).padStart(8)}`
      + `${((t1.filter((v) => v > 0).length / t1.length * 100).toFixed(0) + '%').padStart(7)}`
      + `${mean(delta).toFixed(2).padStart(10)}%`);
  }

  /* 3. 波动率 vs 趋势 */
  console.log('\n===== 3. 波动率假说检验 =====');
  console.log('离散度随 T+0 增大 → 部分原因是波动率放大；');
  console.log('「增量」也随 T+0 增大 → 说明确实有趋势延续效应。');
  const lowGroup = withT0.filter((r) => r[C.t0] < 2);
  const highGroup = withT0.filter((r) => r[C.t0] >= 8);
  if (lowGroup.length > 5 && highGroup.length > 5) {
    console.log(`  T+0<2%  (n=${lowGroup.length}): T+1离散度 ${(std(lowGroup.map((r) => r[C.t1])) ?? 0).toFixed(2)}`
      + `, 增量 ${mean(lowGroup.map((r) => r[C.t1] - r[C.t0])).toFixed(2)}%`);
    console.log(`  T+0≥8%  (n=${highGroup.length}): T+1离散度 ${(std(highGroup.map((r) => r[C.t1])) ?? 0).toFixed(2)}`
      + `, 增量 ${mean(highGroup.map((r) => r[C.t1] - r[C.t0])).toFixed(2)}%`);
  }

  /* 4. 低 T+0 组内的可用指标 */
  const dull = withT0.filter((r) => r[C.t0] < 3);
  if (dull.length > 30) {
    console.log(`\n===== 4. T+0<3% 组（n=${dull.length}）里还有区分度的指标 =====`);
    console.log(`  对照：该组 T+1 平均 ${mean(dull.map((r) => r[C.t1])).toFixed(2)}%，`
      + `胜率 ${((dull.filter((r) => r[C.t1] > 0).length / dull.length) * 100).toFixed(0)}%`);

    const slotGroups = [
      ['09:xx', (h) => h < 10], ['10:xx', (h) => h >= 10 && h < 11],
      ['11:xx', (h) => h >= 11 && h < 12], ['13:xx', (h) => h >= 13 && h < 14],
      ['14:xx', (h) => h >= 14],
    ];
    console.log('\n  买入时段:');
    for (const [label, test] of slotGroups) {
      const sub = dull.filter((r) => {
        const hm = String(r[C.buyTime]).split(' ')[1] ?? '';
        const h = Number(hm.split(':')[0]);
        return Number.isFinite(h) && test(h);
      });
      if (sub.length < 5) continue;
      const t1 = sub.map((r) => r[C.t1]);
      console.log(`    ${label.padEnd(8)}n=${String(sub.length).padStart(4)}`
        + `  T+1平均 ${mean(t1).toFixed(2).padStart(6)}%`
        + `  中位 ${median(t1).toFixed(2).padStart(6)}%`
        + `  胜率 ${(t1.filter((v) => v > 0).length / t1.length * 100).toFixed(0)}%`);
    }

    const dropGroups = [
      ['跌<1%', (v) => v > -1], ['跌1~2%', (v) => v <= -1 && v > -2],
      ['跌2~4%', (v) => v <= -2 && v > -4], ['跌4%+', (v) => v <= -4],
    ];
    console.log('\n  价格跌幅:');
    for (const [label, test] of dropGroups) {
      const sub = dull.filter((r) => Number.isFinite(r[C.priceDrop]) && test(r[C.priceDrop]));
      if (sub.length < 5) continue;
      const t1 = sub.map((r) => r[C.t1]);
      console.log(`    ${label.padEnd(8)}n=${String(sub.length).padStart(4)}`
        + `  T+1平均 ${mean(t1).toFixed(2).padStart(6)}%`
        + `  中位 ${median(t1).toFixed(2).padStart(6)}%`
        + `  胜率 ${(t1.filter((v) => v > 0).length / t1.length * 100).toFixed(0)}%`);
    }
  }
}

/* 5. 分布提醒 */
console.log('\n===== 5. 收益分布与提醒 =====');
const sorted = [...t1All].sort((a, b) => a - b);
const q = (p) => sorted[Math.floor(sorted.length * p)];
console.log(`  分位数：10%=${q(0.1).toFixed(2)}%  25%=${q(0.25).toFixed(2)}%  50%=${q(0.5).toFixed(2)}%`
  + `  75%=${q(0.75).toFixed(2)}%  90%=${q(0.9).toFixed(2)}%`);
console.log('  ⚠ T+1 是「最高价」收益，要求每次都卖在当日最高点，实际做不到。');
console.log('    真实胜率远低于这里显示的数字。');
