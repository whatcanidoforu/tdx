/**
 * 找出「主站有更早数据、本地缺少」的标的 —— 这才是真正可补的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BarsClient, PERIOD } from '../market-bars.js';

const TDX = 'D:\\MyTools\\new_tdx';
const listFile = process.argv[2] ?? 'analyze/need-5min.csv';
const maxCheck = Number(process.argv[3] ?? 30);

function readFirstDate(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const zip = head.readUInt16LE(0);
  const y = (zip >> 11) + 2004;
  const mo = String(Math.trunc((zip % 2048) / 100)).padStart(2, '0');
  const d = String((zip % 2048) % 100).padStart(2, '0');
  return `${y}${mo}${d}`;
}

const lines = fs.readFileSync(listFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(1);
const targets = lines.map((l) => {
  const c = l.split(',');
  return { market: c[0], code: c[1], localFirst: c[3] };
}).filter((t) => /^(sh|sz|bj)$/.test(t.market) && /^\d{6}$/.test(t.code));

const client = new BarsClient();
await client.connect();

console.log(`检查前 ${maxCheck} 个标的的主站历史深度…\n`);
console.log('标的        本地起始    主站起始    可补?   说明');
console.log('-'.repeat(72));

const fillable = [];
for (const t of targets.slice(0, maxCheck)) {
  const mk = t.market === 'sh' ? 1 : t.market === 'sz' ? 0 : 2;
  let total = 0; let earliest = '99999999';
  try {
    for (let start = 0; start < 2400; start += 800) {
      const bars = await client.fetchBars(mk, t.code, { category: PERIOD.MIN5, count: 800, start });
      if (bars.length === 0) break;
      const dates = bars.map((b) => b.date).sort();
      earliest = dates[0] < earliest ? dates[0] : earliest;
      total += bars.length;
      if (bars.length < 800) break;
    }
  } catch { /* 忽略 */ }

  const canFill = earliest < t.localFirst;
  const note = total === 0 ? '主站无数据'
    : canFill ? `可补 ${earliest}~${t.localFirst} 段`
      : '主站不比本地早';
  console.log(`${t.market}${t.code}`.padEnd(12)
    + String(t.localFirst).padStart(10)
    + String(earliest).padStart(12)
    + String(canFill ? '是' : '否').padStart(8)
    + '   ' + note);

  if (canFill) fillable.push({ ...t, serverFirst: earliest, serverCount: total });
}

client.destroy();

console.log('');
console.log(`可补的标的：${fillable.length} / ${Math.min(targets.length, maxCheck)}`);
if (fillable.length > 0) {
  const csv = ['市场,代码,本地起始,主站起始,主站记录数'];
  for (const f of fillable) csv.push([f.market, f.code, f.localFirst, f.serverFirst, f.serverCount].join(','));
  fs.writeFileSync('analyze/fillable.csv', `\uFEFF${csv.join('\r\n')}\r\n`, 'utf8');
  console.log('清单已保存：analyze/fillable.csv');
}
