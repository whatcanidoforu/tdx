/**
 * 按文件名精确对比两个 xlsx 的股票列表。
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/** 读 xlsx 第一张表为二维数组。 */
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
  if (!sheetXml) throw new Error(`${file} 里找不到 sheet1`);

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

const fileA = process.argv[2];
const fileB = process.argv[3];

const a = readXlsx(fileA);
const b = readXlsx(fileB);

const iCodeA = a.header.indexOf('代码');
const iCodeB = b.header.indexOf('代码');

const listA = a.rows.map((r) => r[iCodeA]).filter(Boolean);
const listB = b.rows.map((r) => r[iCodeB]).filter(Boolean);

console.log(`文件 A: ${fileA}`);
console.log(`  表头列数 ${a.header.length}，数据 ${listA.length} 行`);
console.log('');
console.log(`文件 B: ${fileB}`);
console.log(`  表头列数 ${b.header.length}，数据 ${listB.length} 行`);
console.log('');

console.log('A 表头:', a.header.join(','));
console.log('');
console.log('B 表头:', b.header.join(','));
console.log('');

const same = JSON.stringify(listA) === JSON.stringify(listB);
console.log(`股票列表完全一致: ${same ? '✔ 是' : '✘ 否'}`);
if (!same) {
  const setA = new Set(listA);
  const setB = new Set(listB);
  const onlyA = listA.filter((c) => !setB.has(c));
  const onlyB = listB.filter((c) => !setA.has(c));
  console.log(`  只在 A 里: ${onlyA.length} 个 ${onlyA.slice(0, 10).join(',')}`);
  console.log(`  只在 B 里: ${onlyB.length} 个 ${onlyB.slice(0, 10).join(',')}`);
}
