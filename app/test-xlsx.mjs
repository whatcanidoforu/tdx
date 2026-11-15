/**
 * XLSX 生成器 —— 单元测试。
 *
 * 重点验证：
 *   1. ZIP 结构合法
 *   2. 列宽足够显示日期（避免 WPS 显示 ######）
 *   3. 数值/百分比单元格类型正确
 *   4. 特殊字符转义
 */
import { buildXlsx } from './xlsx-writer.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`✔ ${label}`); } else {
    fail += 1;
    console.log(`✘ ${label}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`);
  }
}

function checkTrue(label, condition, detail = '') {
  if (condition) { pass += 1; console.log(`✔ ${label}`); } else {
    fail += 1;
    console.log(`✘ ${label} ${detail}`);
  }
}

/** 从 ZIP 中按名字提取文件内容（简易解析，仅供测试）。 */
function readZipEntry(buffer, name) {
  const nameBuf = Buffer.from(name, 'utf8');
  for (let i = 0; i < buffer.length - 30; i += 1) {
    if (buffer.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buffer.readUInt16LE(i + 8);
    const compSize = buffer.readUInt32LE(i + 18);
    const uncompSize = buffer.readUInt32LE(i + 22);
    const nameLen = buffer.readUInt16LE(i + 26);
    const extraLen = buffer.readUInt16LE(i + 28);
    const entryName = buffer.subarray(i + 30, i + 30 + nameLen);
    if (!entryName.equals(nameBuf)) continue;
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buffer.subarray(dataStart, dataStart + compSize);
    if (method === 0) return data.toString('utf8');
    if (method === 8) return inflateRawSync(data).toString('utf8');
    return null;
  }
  return null;
}

/* ---------------------------------------------- 1. 基础结构 */

const simple = buildXlsx({
  sheets: [{
    title: '测试表',
    header: ['代码', '名称', '买入时间'],
    rows: [['sh600000', '浦发银行', '2026-11-11 15:00']],
  }],
});

checkTrue('生成的是 Buffer', Buffer.isBuffer(simple));
check('ZIP 签名正确', simple.subarray(0, 4).toString('hex'), '504b0304');
checkTrue('包含 Content_Types', simple.includes(Buffer.from('[Content_Types].xml', 'utf8')));
checkTrue('包含 workbook.xml', simple.includes(Buffer.from('xl/workbook.xml', 'utf8')));

const sheetXml = readZipEntry(simple, 'xl/worksheets/sheet1.xml');
checkTrue('工作表 XML 可解压', sheetXml !== null && sheetXml.length > 0);
checkTrue('工作表含表头内容', sheetXml.includes('代码'));
checkTrue('工作表含数据内容', sheetXml.includes('sh600000'));

const workbookXml = readZipEntry(simple, 'xl/workbook.xml');
checkTrue('工作簿含 sheet 定义', workbookXml.includes('name="测试表"'));

const stylesXml = readZipEntry(simple, 'xl/styles.xml');
checkTrue('样式表存在', stylesXml !== null);
checkTrue('样式表含百分比格式', stylesXml.includes('0.00&quot;%&quot;'));

/* ---------------------------------------------- 2. 列宽（关键：防 ####） */

const dateText = '2026-11-11 15:00'; // 16 字符
const withDate = buildXlsx({
  sheets: [{
    title: 'T',
    header: ['买入时间'],
    rows: [[dateText]],
  }],
});
const dateSheet = readZipEntry(withDate, 'xl/worksheets/sheet1.xml');
const widthMatch = /<col min="1" max="1" width="([\d.]+)"/.exec(dateSheet);
checkTrue('日期列有列宽定义', widthMatch !== null);
if (widthMatch) {
  const width = Number(widthMatch[1]);
  checkTrue(`日期列宽 ${width} ≥ 16（足够显示 ${dateText}）`, width >= 16, `实际 ${width}`);
  checkTrue('列宽不超过上限 60', width <= 60, `实际 ${width}`);
}

// 长内容列应当更宽
const longText = '这是一段很长的中文内容用于测试列宽自适应';
const withLong = buildXlsx({
  sheets: [{ title: 'T', header: ['说明'], rows: [[longText]] }],
});
const longSheet = readZipEntry(withLong, 'xl/worksheets/sheet1.xml');
const longWidth = Number(/<col min="1" max="1" width="([\d.]+)"/.exec(longSheet)[1]);
checkTrue(`长文本列宽 ${longWidth} > 日期列宽`, longWidth > 16);

/* ---------------------------------------------- 3. 数值与百分比 */

const numeric = buildXlsx({
  sheets: [{
    title: 'T',
    header: ['代码', '买入价', '收益率%'],
    rows: [['sh600000', '12.72', '3.06']],
    meta: { numeric: [false, true, true], percent: [false, false, true] },
  }],
});
const numSheet = readZipEntry(numeric, 'xl/worksheets/sheet1.xml');
checkTrue('文本单元格用 inlineStr', numSheet.includes('t="inlineStr"'));
checkTrue('数值单元格无 t 属性（作为数字）', /<c r="B2" s="2"><v>12.72<\/v><\/c>/.test(numSheet));
// 百分比：原始值 3.06（表示 3.06%）应原样存储，靠 % 格式显示，
// 这样单元格值和 CSV 的 "3.06" 完全一致
const pctMatch = /<c r="C2" s="3"><v>([\d.]+)<\/v><\/c>/.exec(numSheet);
checkTrue('百分比单元格套用样式 3', pctMatch !== null);
if (pctMatch) {
  check('百分比值原样存储（与 CSV 一致）', Number(pctMatch[1]), 3.06);
}

/* ---------------------------------------------- 4. 特殊字符 */

const special = buildXlsx({
  sheets: [{
    title: 'T',
    header: ['名称', '备注'],
    rows: [['A&B <C>', '引号"测试"']],
  }],
});
const specSheet = readZipEntry(special, 'xl/worksheets/sheet1.xml');
checkTrue('& 被转义', specSheet.includes('A&amp;B'));
checkTrue('< 被转义', specSheet.includes('&lt;C&gt;'));
checkTrue('引号被转义', specSheet.includes('&quot;'));

/* ---------------------------------------------- 5. 多工作表 */

const multi = buildXlsx({
  sheets: [
    { title: '选股结果', header: ['代码'], rows: [['sh600000']] },
    { title: '收益统计', header: ['周期'], rows: [['T+1']] },
  ],
});
const wbXml = readZipEntry(multi, 'xl/workbook.xml');
checkTrue('工作簿含两个 sheet', wbXml.includes('选股结果') && wbXml.includes('收益统计'));
checkTrue('sheet2 存在', readZipEntry(multi, 'xl/worksheets/sheet2.xml') !== null);

/* ---------------------------------------------- 6. 空数据 */

const empty = buildXlsx({ sheets: [{ title: '空表', header: ['A', 'B'], rows: [] }] });
checkTrue('空数据也能生成', empty.length > 0);
const emptySheet = readZipEntry(empty, 'xl/worksheets/sheet1.xml');
checkTrue('空数据表头仍在', emptySheet.includes('<t>A</t>'));

/* ---------------------------------------------- 7. 真实文件写入 */

const tmp = mkdtempSync(join(tmpdir(), 'xlsx-'));
try {
  const file = join(tmp, 'test.xlsx');
  writeFileSync(file, simple);
  checkTrue('文件写入成功', true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
