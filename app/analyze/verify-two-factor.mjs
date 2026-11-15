/**
 * 验证【独立因子】组合：末DIF（MACD深度） × 价格跌幅（背离深度）
 * 两者相关性仅 0.31，是独立因子，组合应比单因子更稳。
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

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

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const { header, rows } = readXlsx(process.argv[2]);
const col = (n) => header.indexOf(n);
const C = { lastDif: col('末DIF'), priceDrop: col('价格跌幅%'), buyTime: col('买入时间'), t1: col('T+1最高收益%') };
const data = rows.filter((r) => Number.isFinite(r[C.t1]));

const stat = (sub) => {
  const t1 = sub.map((r) => r[C.t1]);
  return {
    n: t1.length, mean: mean(t1), median: median(t1),
    win: (t1.filter((v) => v > 0).length / t1.length) * 100,
    gt5: (t1.filter((v) => v >= 5).length / t1.length) * 100,
    gt10: (t1.filter((v) => v >= 10).length / t1.length) * 100,
  };
};

console.log('\n===== 双因子网格：末DIF × 价格跌幅 =====');
console.log('格子内是 T+1平均%（样本数）\n');

const difCuts = [-99, -2, -1, -0.5, -0.1];
const dropCuts = [-99, -4, -2, -1, 0];
const difLabels = ['DIF<-2', '-2~-1', '-1~-0.5', '-0.5~-0.1', 'DIF>-0.1'];
const dropLabels = ['跌>4%', '跌2~4%', '跌1~2%', '跌<1%'];

console.log('                 ' + dropLabels.map((l) => l.padEnd(16)).join(''));
for (let i = 0; i < difLabels.length; i += 1) {
  let line = difLabels[i].padEnd(17);
  for (let j = 0; j < dropLabels.length; j += 1) {
    const loDif = difCuts[i];
    const hiDif = i === difLabels.length - 1 ? 999 : difCuts[i + 1];
    const loDrop = dropCuts[j];
    const hiDrop = j === dropLabels.length - 1 ? 999 : dropCuts[j + 1];
    const sub = data.filter((r) => {
      const d = r[C.lastDif]; const p = r[C.priceDrop];
      if (!Number.isFinite(d) || !Number.isFinite(p)) return false;
      const difOk = i === 0 ? d < hiDif : (d >= loDif && d < hiDif);
      const dropOk = j === 0 ? p <= -4 : (p > loDrop && p <= hiDrop);
      return difOk && dropOk;
    });
    if (sub.length === 0) { line += '—'.padEnd(16); continue; }
    const s = stat(sub);
    line += `${s.mean.toFixed(1)}% (${s.n})`.padEnd(16);
  }
  console.log(line);
}

console.log('\n===== 候选规则稳健性对比 =====');
const withDate = data.map((r) => ({ r, d: String(r[C.buyTime]).slice(0, 10) }))
  .filter((x) => x.d.length === 10).sort((a, b) => a.d.localeCompare(b.d));
const mid = Math.floor(withDate.length / 2);
const h1 = withDate.slice(0, mid).map((x) => x.r);
const h2 = withDate.slice(mid).map((x) => x.r);
const baseA = mean(h1.map((r) => r[C.t1]));
const baseB = mean(h2.map((r) => r[C.t1]));

const rules = [
  ['末DIF ≤ -1', (r) => r[C.lastDif] <= -1],
  ['末DIF ≤ -2', (r) => r[C.lastDif] <= -2],
  ['跌幅 ≤ -4%', (r) => r[C.priceDrop] <= -4],
  ['跌幅 ≤ -2%', (r) => r[C.priceDrop] <= -2],
  ['DIF≤-1 且 跌幅≤-2%', (r) => r[C.lastDif] <= -1 && r[C.priceDrop] <= -2],
  ['DIF≤-1 或 跌幅≤-4%', (r) => r[C.lastDif] <= -1 || r[C.priceDrop] <= -4],
  ['DIF≤-2 且 跌幅≤-4%', (r) => r[C.lastDif] <= -2 && r[C.priceDrop] <= -4],
];

console.log(`前半段基准 ${baseA.toFixed(2)}%，后半段基准 ${baseB.toFixed(2)}%\n`);
console.log('规则                      全样本(n/均值)     前半段(n/均值)     后半段(n/均值)   两段都提升');
console.log('-'.repeat(104));
for (const [label, test] of rules) {
  const all = stat(data.filter(test));
  const a = stat(h1.filter(test));
  const b = stat(h2.filter(test));
  if (all.n === 0) continue;
  const both = a.mean > baseA && b.mean > baseB && a.n >= 20 && b.n >= 20;
  console.log(`${label.padEnd(24)}${String(all.n).padStart(4)} ${all.mean.toFixed(2).padStart(6)}%`
    + `    ${String(a.n).padStart(4)} ${a.mean.toFixed(2).padStart(6)}%`
    + `    ${String(b.n).padStart(4)} ${b.mean.toFixed(2).padStart(6)}%`
    + `        ${both ? '✔' : (a.n < 20 || b.n < 20 ? '样本少' : '✘')}`);
}

console.log('\n===== 推荐规则详细表现 =====');
for (const [label, test] of rules) {
  const s = stat(data.filter(test));
  if (s.n < 30) continue;
  console.log(`\n${label}（n=${s.n}，占全样本 ${(s.n / data.length * 100).toFixed(0)}%）`);
  console.log(`  T+1平均 ${s.mean.toFixed(2)}%  |  中位 ${s.median.toFixed(2)}%  |  胜率 ${s.win.toFixed(0)}%`);
  console.log(`  ≥5% 占 ${s.gt5.toFixed(0)}%  |  ≥10% 占 ${s.gt10.toFixed(0)}%`);
}
