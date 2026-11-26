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

const file = process.argv[2];
const { header, rows } = readXlsx(file);
console.log(`文件: ${file}`);
console.log(`列数: ${header.length}, 行数: ${rows.length}`);
console.log('');
console.log('列名:');
header.forEach((h, i) => console.log(`  ${String(i + 1).padStart(2)}. ${h}`));
console.log('');

const iT1R = header.indexOf('T+1日内最高涨幅%');
const iDate = header.indexOf('买入时间');
console.log(`T+1日内最高涨幅% 列位置: ${iT1R + 1}`);
if (iT1R >= 0) {
  const vals = rows.map((r) => r[iT1R]).filter((v) => Number.isFinite(v));
  console.log(`有值的行数: ${vals.length}`);
  console.log(`平均值: ${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)}%`);
}
