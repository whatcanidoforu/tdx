/**
 * 目标优化：最大化「T+1最高收益%」（= T+1最高价 / 买入价 - 1）。
 *
 * 只用【买入时可知】的指标做筛选，T+0 收益不参与（买入后才知道）。
 *
 * 方法：
 *   1. 单指标分位扫描（每个指标切 5 档，看是否单调）
 *   2. 贪心组合：逐步加入最有效的筛选条件
 *   3. 输出最终规则的样本数 / 收益 / 胜率
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/* ------------------------------------------------ 读取 xlsx */

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

/* ------------------------------------------------ 统计 */

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

function summarize(rows, colT1) {
  const t1 = rows.map((r) => r[colT1]).filter(Number.isFinite);
  if (t1.length === 0) return null;
  const sorted = [...t1].sort((a, b) => a - b);
  return {
    n: t1.length,
    mean: mean(t1),
    median: median(t1),
    win: (t1.filter((v) => v > 0).length / t1.length) * 100,
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    gt5: (t1.filter((v) => v >= 5).length / t1.length) * 100,
    gt10: (t1.filter((v) => v >= 10).length / t1.length) * 100,
  };
}

/* ------------------------------------------------ 主流程 */

const file = process.argv[2];
const { header, rows } = readXlsx(file);
const col = (n) => header.indexOf(n);

const C = {
  points: col('低点数'), firstHj: col('首HJ10'), firstDif: col('首DIF'),
  firstClose: col('首收盘'), lastHj: col('末HJ10'), lastDif: col('末DIF'),
  lastClose: col('末收盘'), hj10Rise: col('HJ10抬高'), priceDrop: col('价格跌幅%'),
  buyTime: col('买入时间'), buyPrice: col('买入价'), t1: col('T+1最高收益%'),
  t2: col('T+2最高收益%'), decline: col('日线HJ10连跌天数'), dailyHj: col('日线HJ10'),
  dailyMacd: col('日线MACD柱'),
};

const data = rows.filter((r) => Number.isFinite(r[C.t1]));
console.log(`\n样本：${data.length} 个买点`);
const base = summarize(data, C.t1);
console.log(`基准（不筛选）：T+1平均 ${base.mean.toFixed(2)}%，中位 ${base.median.toFixed(2)}%，`
  + `胜率 ${base.win.toFixed(0)}%，≥5%占 ${base.gt5.toFixed(0)}%，≥10%占 ${base.gt10.toFixed(0)}%`);

/* ---------- 1. 单指标分位扫描 ---------- */

console.log('\n===== 1. 单指标分位扫描（各指标切5档）=====');
console.log('看哪一档的 T+1 平均最高，以及是否单调。\n');

const features = [
  ['价格跌幅%', C.priceDrop],
  ['末DIF', C.lastDif],
  ['首DIF', C.firstDif],
  ['日线MACD柱', C.dailyMacd],
  ['末HJ10', C.lastHj],
  ['首HJ10', C.firstHj],
  ['HJ10抬高', C.hj10Rise],
  ['买入价', C.buyPrice],
  ['末收盘', C.lastClose],
  ['日线HJ10', C.dailyHj],
  ['日线连跌天数', C.decline],
  ['低点数', C.points],
];

const scanResults = [];
for (const [name, c] of features) {
  const valid = data.filter((r) => Number.isFinite(r[c]));
  if (valid.length < 50) continue;
  const values = valid.map((r) => r[c]).sort((a, b) => a - b);
  const cuts = [0.2, 0.4, 0.6, 0.8].map((p) => quantile(values, p));
  const groups = [[], [], [], [], []];
  for (const r of valid) {
    const v = r[c];
    let bucket = 0;
    while (bucket < 4 && v > cuts[bucket]) bucket += 1;
    groups[bucket].push(r);
  }
  const stats = groups.map((g) => summarize(g, C.t1));
  const means = stats.map((s) => (s ? s.mean : NaN));
  const best = Math.max(...means.filter(Number.isFinite));
  const bestIdx = means.indexOf(best);
  const worst = Math.min(...means.filter(Number.isFinite));
  console.log(`${name}（分位切点 ${cuts.map((v) => v.toFixed(2)).join(' / ')}）`);
  console.log('   档位       样本   T+1平均   T+1中位   ≥5%占  ≥10%占');
  const labels = ['低20%', '20-40%', '40-60%', '60-80%', '高20%'];
  stats.forEach((s, i) => {
    if (!s) return;
    const mark = i === bestIdx ? ' ←最佳' : '';
    console.log(`   ${labels[i].padEnd(9)}${String(s.n).padStart(5)}`
      + `${s.mean.toFixed(2).padStart(9)}%${s.median.toFixed(2).padStart(9)}%`
      + `${s.gt5.toFixed(0).padStart(7)}%${s.gt10.toFixed(0).padStart(7)}%${mark}`);
  });
  scanResults.push({ name, c, best, bestIdx, worst, spread: best - worst, cuts, stats, labels });
  console.log('');
}

/* ---------- 2. 按提升幅度排序 ---------- */

console.log('===== 2. 哪个指标「最佳档」提升最大 =====');
console.log('指标              最佳档    该档T+1   基准T+1   提升    样本');
const baseMean = base.mean;
const ranked = scanResults
  .map((s) => ({
    name: s.name,
    label: s.labels[s.bestIdx],
    mean: s.best,
    lift: s.best - baseMean,
    n: s.stats[s.bestIdx].n,
    spread: s.spread,
  }))
  .sort((a, b) => b.lift - a.lift);
for (const r of ranked) {
  console.log(`${r.name.padEnd(18)}${r.label.padEnd(9)}`
    + `${r.mean.toFixed(2).padStart(8)}%${baseMean.toFixed(2).padStart(9)}%`
    + `${('+' + r.lift.toFixed(2) + '%').padStart(9)}${String(r.n).padStart(6)}`);
}

/* ---------- 3. 买入时段 ---------- */

console.log('\n===== 3. 买入时段 =====');
console.log('时段     样本   T+1平均   T+1中位  ≥5%占  ≥10%占');
const slots = [
  ['09:45-10:00', (h, m) => h === 9 || (h === 10 && m === 0)],
  ['10:00-11:00', (h, m) => h === 10 && m > 0],
  ['11:00-11:30', (h) => h === 11],
  ['13:00-14:00', (h) => h === 13],
  ['14:00-15:00', (h) => h >= 14],
];
for (const [label, test] of slots) {
  const sub = data.filter((r) => {
    const hm = String(r[C.buyTime]).split(' ')[1] ?? '';
    const [h, m] = hm.split(':').map(Number);
    return Number.isFinite(h) && test(h, m);
  });
  const s = summarize(sub, C.t1);
  if (!s) continue;
  console.log(`${label.padEnd(14)}${String(s.n).padStart(5)}`
    + `${s.mean.toFixed(2).padStart(9)}%${s.median.toFixed(2).padStart(9)}%`
    + `${s.gt5.toFixed(0).padStart(7)}%${s.gt10.toFixed(0).padStart(7)}%`);
}

/* ---------- 4. 贪心组合 ---------- */

console.log('\n===== 4. 贪心组合：逐步叠加最强条件 =====');
console.log('每一步加入「能让平均 T+1 提升最多」的条件，要求样本 ≥60。\n');

const candidateRules = [];

// 数值型：最佳档的筛选规则
for (const s of scanResults) {
  if (['低点数', '日线连跌天数'].includes(s.name)) continue;
  const ci = s.bestIdx;
  const values = data.filter((r) => Number.isFinite(r[s.c])).map((r) => r[s.c]).sort((a, b) => a - b);
  const cuts = [0.2, 0.4, 0.6, 0.8].map((p) => quantile(values, p));
  // 如果最佳档是「低20%」，规则是 value <= cuts[0]；高20% 则是 value > cuts[3]
  let test;
  let desc;
  if (ci === 0) { test = (r) => Number.isFinite(r[s.c]) && r[s.c] <= cuts[0]; desc = `${s.name} ≤ ${cuts[0].toFixed(2)}`; }
  else if (ci === 4) { test = (r) => Number.isFinite(r[s.c]) && r[s.c] > cuts[3]; desc = `${s.name} > ${cuts[3].toFixed(2)}`; }
  else if (ci === 1) { test = (r) => Number.isFinite(r[s.c]) && r[s.c] > cuts[0] && r[s.c] <= cuts[1]; desc = `${s.name} 在 ${cuts[0].toFixed(2)}~${cuts[1].toFixed(2)}`; }
  else if (ci === 2) { test = (r) => Number.isFinite(r[s.c]) && r[s.c] > cuts[1] && r[s.c] <= cuts[2]; desc = `${s.name} 在 ${cuts[1].toFixed(2)}~${cuts[2].toFixed(2)}`; }
  else { test = (r) => Number.isFinite(r[s.c]) && r[s.c] > cuts[2] && r[s.c] <= cuts[3]; desc = `${s.name} 在 ${cuts[2].toFixed(2)}~${cuts[3].toFixed(2)}`; }
  candidateRules.push({ desc, test });
}

// 时段规则
for (const [label, test] of slots) {
  const t = (r) => {
    const hm = String(r[C.buyTime]).split(' ')[1] ?? '';
    const [h, m] = hm.split(':').map(Number);
    return Number.isFinite(h) && test(h, m);
  };
  candidateRules.push({ desc: `时段 ${label}`, test: t });
}

let current = data;
const applied = [];
console.log('步骤  条件                                 样本   T+1平均   提升   ≥10%占');
console.log('-'.repeat(88));
let currentStat = summarize(current, C.t1);
console.log(`  0   基准（不筛选）                     ${String(currentStat.n).padStart(5)}`
  + `${currentStat.mean.toFixed(2).padStart(9)}%${'—'.padStart(7)}`
  + `${currentStat.gt10.toFixed(0).padStart(7)}%`);

for (let step = 1; step <= 3; step += 1) {
  let bestPick = null;
  for (const rule of candidateRules) {
    if (applied.some((a) => a.desc === rule.desc)) continue;
    const sub = current.filter(rule.test);
    if (sub.length < 60) continue;
    const s = summarize(sub, C.t1);
    if (!s) continue;
    const gain = s.mean - currentStat.mean;
    if (!bestPick || gain > bestPick.gain) bestPick = { ...rule, sub, stat: s, gain };
  }
  if (!bestPick || bestPick.gain <= 0.1) break;
  applied.push(bestPick);
  current = bestPick.sub;
  currentStat = bestPick.stat;
  console.log(`  ${step}   ${bestPick.desc.padEnd(36)}${String(currentStat.n).padStart(5)}`
    + `${currentStat.mean.toFixed(2).padStart(9)}%`
    + `${('+' + bestPick.gain.toFixed(2) + '%').padStart(8)}`
    + `${currentStat.gt10.toFixed(0).padStart(7)}%`);
}

console.log('');
console.log('===== 最终组合效果对比 =====');
console.log('                   样本   T+1平均   T+1中位  胜率  ≥5%占  ≥10%占');
const finalStat = summarize(current, C.t1);
const pctOf = (n) => ((n / data.length) * 100).toFixed(0);
console.log(`基准（全部）        ${String(base.n).padStart(5)}`
  + `${base.mean.toFixed(2).padStart(9)}%${base.median.toFixed(2).padStart(9)}%`
  + `${base.win.toFixed(0).padStart(5)}%${base.gt5.toFixed(0).padStart(6)}%${base.gt10.toFixed(0).padStart(7)}%`);
console.log(`筛选后（${pctOf(finalStat.n)}%样本）${String(finalStat.n).padStart(5)}`
  + `${finalStat.mean.toFixed(2).padStart(9)}%${finalStat.median.toFixed(2).padStart(9)}%`
  + `${finalStat.win.toFixed(0).padStart(5)}%${finalStat.gt5.toFixed(0).padStart(6)}%${finalStat.gt10.toFixed(0).padStart(7)}%`);
console.log('');
console.log('最终规则：');
applied.forEach((a, i) => console.log(`  ${i + 1}. ${a.desc}`));
