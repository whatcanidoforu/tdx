/**
 * 检查生成的 xlsx 内容是否与预期一致。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const dir = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith('.xlsx'));
if (files.length === 0) {
  console.log('没找到 xlsx');
  process.exit(1);
}
const file = `${dir}/${files[0]}`;
console.log(`文件：${file}`);
console.log('');

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

const header = rows[0];
const iCode = header.indexOf('代码');
const iName = header.indexOf('名称');
const iBuy = header.indexOf('买入时间');
console.log(`共 ${rows.length - 1} 行数据`);
console.log('');
console.log('代码        名称        买入时间');
console.log('-'.repeat(45));
for (const row of rows.slice(1)) {
  console.log(`${String(row[iCode]).padEnd(12)}${String(row[iName] ?? '').padEnd(12)}${row[iBuy] ?? ''}`);
}

console.log('');
const expected = ['sz003029', 'sz002117', 'sh603232', 'sh603042', 'sz301004'];
const actual = rows.slice(1).map((r) => r[iCode]).sort();
console.log('预期:', expected.sort().join(' '));
console.log('实际:', actual.join(' '));
console.log(JSON.stringify(actual) === JSON.stringify(expected.sort()) ? '✔ 完全一致' : '✘ 不一致');
