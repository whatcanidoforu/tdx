/**
 * 轻量 XLSX 生成器 —— 不依赖第三方库，用 Node 内置 zlib 手写 OOXML。
 *
 * 为什么需要：CSV 打开后列宽是默认值，日期列会显示成 ######，用户得手动调整。
 * XLSX 可以内嵌列宽、单元格类型和格式，WPS / Excel 打开即用。
 *
 * 支持：
 *   · 自动列宽（按内容宽度估算，中文按 2 字符算）
 *   · 数值列右对齐、文本列左对齐
 *   · 表头加粗 + 冻结首行 + 自动筛选
 *   · 百分比列带 % 格式
 *   · 斑马纹（可选）
 *
 * @module app/xlsx-writer
 */

import { deflateRawSync } from 'node:zlib';

/* ---------------------------------------------------------------- ZIP */

/** CRC32 查找表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 打包成 ZIP（仅 deflate 与 store 两种方式）。
 *
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // 签名
    localHeader.writeUInt16LE(20, 4); // 版本
    localHeader.writeUInt16LE(0x0800, 6); // 标志：UTF-8 文件名
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // 修改时间
    localHeader.writeUInt16LE(0x21, 12); // 修改日期（1980-01-01）
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra 长度

    localParts.push(localHeader, nameBuffer, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // 签名
    centralHeader.writeUInt16LE(20, 4); // 创建版本
    centralHeader.writeUInt16LE(20, 6); // 需要版本
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // 磁盘号
    centralHeader.writeUInt16LE(0, 36); // 内部属性
    centralHeader.writeUInt32LE(0, 38); // 外部属性
    centralHeader.writeUInt32LE(offset, 42); // 本地头偏移

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

/* ---------------------------------------------------------------- XML */

/** 转义 XML 特殊字符并移除非法控制字符。 */
function escapeXml(value) {
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 列号转字母：0→A, 25→Z, 26→AA。 */
function columnLetter(index) {
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/** 估算显示宽度（中文按 2 个字符）。 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? '')) {
    width += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  }
  return width;
}

/* ---------------------------------------------------------------- 样式 */

/**
 * 样式索引约定：
 *   0 = 默认（左对齐）
 *   1 = 表头（加粗、灰底、居中、边框）
 *   2 = 数字（右对齐）
 *   3 = 百分比（右对齐，显示 2 位小数 + %）
 *   4 = 文本居中
 */
const STYLE = { DEFAULT: 0, HEADER: 1, NUMBER: 2, PERCENT: 3, CENTER: 4 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00&quot;%&quot;"/></numFmts>
<fonts count="2">
<font><sz val="11"/><name val="微软雅黑"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD0D0D0"/></left><right style="thin"><color rgb="FFD0D0D0"/></right><top style="thin"><color rgb="FFD0D0D0"/></top><bottom style="thin"><color rgb="FFD0D0D0"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/* ---------------------------------------------------------------- 工作表 */

/** 判断字符串是否应作为数值写入。 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || !/^-?\d+(\.\d+)?$/.test(text)) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/**
 * 生成一个工作表的 XML。
 *
 * @param {object} sheet
 * @param {string} sheet.title 工作表名
 * @param {string[]} sheet.header 表头
 * @param {Array<Array<string|number>>} sheet.rows 数据行
 * @param {{numeric?: boolean[], percent?: boolean[], widths?: number[]}} [sheet.meta] 列类型提示
 * @param {boolean} [sheet.freeze] 冻结首行
 * @param {boolean} [sheet.autoFilter] 自动筛选
 * @returns {{xml: string, colsXml: string}}
 */
function buildSheetXml(sheet) {
  const header = sheet.header ?? [];
  const rows = sheet.rows ?? [];
  const meta = sheet.meta ?? {};
  const columnCount = Math.max(header.length, ...rows.map((r) => r.length), 1);

  // 计算列宽：取表头与数据的前 200 行，估算最大显示宽度
  const widths = [];
  for (let col = 0; col < columnCount; col += 1) {
    let maxWidth = displayWidth(header[col] ?? '');
    const limit = Math.min(rows.length, 200);
    for (let i = 0; i < limit; i += 1) {
      const width = displayWidth(rows[i]?.[col] ?? '');
      if (width > maxWidth) maxWidth = width;
    }
    // 留 2 字符余量，限制在 8~60 之间
    widths.push(Math.min(60, Math.max(8, maxWidth + 2)));
  }
  if (Array.isArray(meta.widths)) {
    meta.widths.forEach((w, i) => { if (w) widths[i] = w; });
  }

  const colsXml = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');

  const rowXmlList = [];

  // 表头
  if (header.length > 0) {
    const cells = header.map((text, col) => {
      const ref = `${columnLetter(col)}1`;
      return `<c r="${ref}" s="${STYLE.HEADER}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`;
    }).join('');
    rowXmlList.push(`<row r="1" ht="22" customHeight="1">${cells}</row>`);
  }

  // 数据行
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = [];
    for (let col = 0; col < columnCount; col += 1) {
      const value = row[col];
      if (value === undefined || value === null || value === '') continue;
      const ref = `${columnLetter(col)}${rowNumber}`;
      const num = toNumber(value);

      if (num !== null && meta.numeric?.[col] !== false) {
        // 数值列
        const isPercent = meta.percent?.[col] === true;
        const style = isPercent ? STYLE.PERCENT : STYLE.NUMBER;
        // 百分比列：原始值本身就是百分数（3.06 表示 3.06%），直接存原值，
        // 靠格式 "0.00\"%\"" 显示成 3.06%。这样单元格值和 CSV 完全一致。
        cells.push(`<c r="${ref}" s="${style}"><v>${num}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" s="${STYLE.DEFAULT}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`);
      }
    }
    rowXmlList.push(`<row r="${rowNumber}">${cells.join('')}</row>`);
  });

  const lastRow = rows.length + 1;
  const lastCol = columnLetter(columnCount - 1);
  const dimension = `A1:${lastCol}${Math.max(1, lastRow)}`;

  const freeze = sheet.freeze !== false
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

  const autoFilter = sheet.autoFilter && rows.length > 0
    ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="${dimension}"/>
${freeze}
<sheetFormatPr defaultRowHeight="16"/>
<cols>${colsXml}</cols>
<sheetData>${rowXmlList.join('')}</sheetData>
${autoFilter}
</worksheet>`;
  return { xml };
}

/* ---------------------------------------------------------------- 入口 */

/**
 * 生成 XLSX 文件内容。
 *
 * @param {{
 *   sheets: {
 *     title: string,
 *     header?: string[],
 *     rows?: Array<Array<string|number>>,
 *     meta?: {numeric?: boolean[], percent?: boolean[], widths?: number[]},
 *     freeze?: boolean,
 *     autoFilter?: boolean,
 *   }[],
 * }} workbook
 * @returns {Buffer}
 */
export function buildXlsx(workbook) {
  const sheets = workbook.sheets ?? [];

  const sheetEntries = sheets.map((sheet, index) => {
    const { xml } = buildSheetXml(sheet);
    return {
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(xml, 'utf8'),
    };
  });

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${sheets.map((sheet, index) => `<sheet name="${escapeXml((sheet.title ?? `Sheet${index + 1}`).slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('\n')}
</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    ...sheetEntries,
  ]);
}
