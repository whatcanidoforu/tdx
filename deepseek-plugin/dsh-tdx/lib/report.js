/**
 * Human-readable report rendering for the TDX data plugin.
 *
 * Every function takes the plain report object produced by
 * `lib/actions.js` and returns a self-contained text report. Reports are
 * Chinese-first because they are shown to the user in the command plane and
 * in tool cards; the model reads the same text.
 *
 * @module dsh-tdx/lib/report
 */

import { relative } from 'node:path';

const EM_DASH = '—';

/* ----------------------------------------------------------- number format */

/** Thousands-group a fixed-decimal number. */
function grouped(value, digits) {
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(digits);
  const [whole, fraction] = fixed.split('.');
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${groupedWhole}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** Format a price with two decimals and thousands separators. */
export function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return grouped(value, 2);
}

/** Format a percentage with an explicit sign. */
export function formatPct(value, digits = 2, signed = true) {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const text = `${Math.abs(value).toFixed(digits)}%`;
  if (!signed) return text;
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${text}`;
}

/** Compact Chinese money formatting (元). */
export function formatAmount(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(2)}万亿`;
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return value.toFixed(2);
}

/** Compact Chinese volume formatting with a unit (股/手). */
export function formatVolume(value, unit = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const absolute = Math.abs(value);
  let text;
  if (absolute >= 1e12) text = `${(value / 1e12).toFixed(2)}万亿`;
  else if (absolute >= 1e8) text = `${(value / 1e8).toFixed(2)}亿`;
  else if (absolute >= 1e4) text = `${(value / 1e4).toFixed(2)}万`;
  else text = grouped(value, 0);
  return `${text}${unit}`;
}

/** Format a byte count. */
export function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

/** Format an integer count with thousands separators. */
export function formatCount(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return grouped(value, 0);
}

/** Format an indicator value or an absent warm-up slot. */
function formatIndicator(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toFixed(digits);
}

/* --------------------------------------------------------------- text table */

function isWideCodePoint(codePoint) {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

/** Terminal display width (CJK characters occupy two columns). */
export function displayWidth(text) {
  let width = 0;
  for (const character of String(text)) {
    width += isWideCodePoint(character.codePointAt(0)) ? 2 : 1;
  }
  return width;
}

/**
 * Render a fixed-width pipe table.
 * @param {string[]} headers
 * @param {Array<Array<unknown>>} rows
 * @param {Array<'l'|'r'>} [aligns]
 * @returns {string}
 */
export function tableText(headers, rows, aligns = []) {
  const widths = headers.map((header, column) => Math.max(
    displayWidth(header),
    ...rows.map((row) => displayWidth(String(row[column] ?? ''))),
  ));
  const renderRow = (cells) => headers.map((_, column) => {
    const text = String(cells[column] ?? '');
    const padding = ' '.repeat(Math.max(0, widths[column] - displayWidth(text)));
    return aligns[column] === 'r' ? padding + text : text + padding;
  }).join(' | ').trimEnd();
  const divider = widths.map((width) => '-'.repeat(width)).join('-+-');
  return [renderRow(headers), divider, ...rows.map(renderRow)].join('\n');
}

/* ------------------------------------------------------------------- parts */

function formatFormat(format) {
  return `${format.label}（${format.recordBytes ?? 32} 字节/条）`;
}

function formatRange(range) {
  if (!range?.start && !range?.end) return EM_DASH;
  return `${range.start ?? EM_DASH} ~ ${range.end ?? EM_DASH}`;
}

function formatInstrument(instrument) {
  const marketCode = instrument.market === 'unknown'
    ? instrument.code
    : `${instrument.market}${instrument.code}`;
  return `${marketCode} · ${instrument.boardLabel}（${instrument.kindLabel}） · ${instrument.marketLabel}`;
}

function formatRowLine(row, volumeUnit = '') {
  const time = row.time ? ` ${row.time}` : '';
  return `${row.date ?? EM_DASH}${time}  开 ${formatPrice(row.open)}  高 ${formatPrice(row.high)}`
    + `  低 ${formatPrice(row.low)}  收 ${formatPrice(row.close)}`
    + `  额 ${formatAmount(row.amount)}  量 ${formatVolume(row.volume, volumeUnit)}`;
}

function qualityLine(quality) {
  const checks = [
    `日期递增 ${quality.monotonic ? '✓' : '✗'}`,
    `无效日期 ${quality.invalidDates}`,
    `非递增 ${quality.nonMonotonic}`,
    `OHLC 异常 ${quality.badOhlc}`,
    `零成交 ${quality.zeroVolume}`,
  ];
  return checks.join('  ');
}

/* ------------------------------------------------------------------ reports */

/** File metadata report. */
export function infoText(report) {
  const { instrument, format, quality } = report;
  const lines = [
    '通达信行情文件',
    `路径: ${report.path}`,
    `标的: ${formatInstrument(instrument)}`,
    `格式: ${formatFormat(format)}  大小: ${formatBytes(report.sizeBytes)}  记录: ${formatCount(report.count)} 条`,
    `区间: ${formatRange(report.range)}`
      + (report.timeRange?.start ? `  时间: ${report.timeRange.start} ~ ${report.timeRange.end}` : ''),
    `首条: ${formatRowLine(report.first, instrument.volumeUnit)}`,
    `末条: ${formatRowLine(report.last, instrument.volumeUnit)}`,
    `累计: 成交额 ${formatAmount(report.totalAmount)}  成交量 ${formatVolume(report.totalVolume, instrument.volumeUnit)}`,
    `质量: ${qualityLine(quality)}`,
  ];
  if (quality.suspicious) lines.push('提示: 检测到异常字段，请确认文件与扩展名是否匹配、是否为完整下载的数据。');
  return lines.join('\n');
}

/** Summary report. */
export function summaryText(summary) {
  const { instrument } = summary;
  const ma = summary.ma;
  const returns = summary.returns.map((item) => `${item.period}日 ${formatPct(item.pct)}`).join('  ');
  const lines = [
    '通达信行情摘要',
    `文件: ${summary.file}`,
    `标的: ${formatInstrument(instrument)}`,
    `格式: ${formatFormat(summary.format)}  记录: ${formatCount(summary.count)} 条  区间: ${formatRange(summary.range)}`,
    `最新: ${summary.latest.date}${summary.latest.time ? ` ${summary.latest.time}` : ''}`
      + `  开 ${formatPrice(summary.latest.open)}  高 ${formatPrice(summary.latest.high)}`
      + `  低 ${formatPrice(summary.latest.low)}  收 ${formatPrice(summary.latest.close)}`,
    `涨跌: ${formatPct(summary.changePct)}（前收 ${formatPrice(summary.previousClose)}）  振幅: ${formatPct(summary.amplitudePct, 2, false)}`,
    `成交: 额 ${formatAmount(summary.latest.amount)}  量 ${formatVolume(summary.latest.volume, instrument.volumeUnit)}`
      + `  MA5额 ${formatAmount(summary.amountMa5)}  MA20额 ${formatAmount(summary.amountMa20)}`,
    `近${summary.windowSize}根: 高 ${formatPrice(summary.high52w)}  低 ${formatPrice(summary.low52w)}  收盘位置 ${formatPct(summary.position52w * 100, 1, false)}`,
    `均线: MA5 ${formatPrice(ma[5])}  MA10 ${formatPrice(ma[10])}  MA20 ${formatPrice(ma[20])}`
      + `  MA60 ${formatPrice(ma[60])}  MA120 ${formatPrice(ma[120])}  MA250 ${formatPrice(ma[250])}`,
    `MACD: DIF ${formatIndicator(summary.macd.dif, 3)}  DEA ${formatIndicator(summary.macd.dea, 3)}`
      + `  柱 ${formatIndicator(summary.macd.histogram, 3)}`,
    `RSI14: ${formatIndicator(summary.rsi14, 1)}  KDJ: K ${formatIndicator(summary.kdj.k, 1)}`
      + `  D ${formatIndicator(summary.kdj.d, 1)}  J ${formatIndicator(summary.kdj.j, 1)}`
      + `  ATR14: ${formatIndicator(summary.atr14, 2)}`,
    `BOLL: 上 ${formatPrice(summary.boll.upper)}  中 ${formatPrice(summary.boll.middle)}  下 ${formatPrice(summary.boll.lower)}`,
    `收益: ${returns}  年初至今 ${formatPct(summary.ytdPct)}`,
    `波动: 年化 ${formatPct(summary.volatilityPct, 2, false)}  最大回撤 ${formatPct(summary.maxDrawdownPct, 2)}（近${summary.windowSize}根）`,
    `累计: 成交额 ${formatAmount(summary.totalAmount)}  成交量 ${formatVolume(summary.totalVolume, instrument.volumeUnit)}`,
    `走势(近${summary.sparkline.length}根): ${summary.sparkline || EM_DASH}`,
  ];
  if (summary.quality.suspicious) lines.push(`质量: ${qualityLine(summary.quality)}`);
  return lines.join('\n');
}

/** Row-list report. */
export function rowsText(report) {
  const hasTime = report.rows.some((row) => row.time);
  const headers = [
    '日期',
    ...(hasTime ? ['时间'] : []),
    '开盘', '最高', '最低', '收盘', '涨跌%', '振幅%', '成交额', '成交量',
  ];
  const aligns = headers.map((_, index) => (index <= (hasTime ? 1 : 0) ? 'l' : 'r'));
  const rows = report.rows.map((row) => [
    row.date ?? EM_DASH,
    ...(hasTime ? [row.time ?? EM_DASH] : []),
    formatPrice(row.open),
    formatPrice(row.high),
    formatPrice(row.low),
    formatPrice(row.close),
    formatPct(row.changePct),
    formatPct(row.amplitudePct, 2, false),
    formatAmount(row.amount),
    formatVolume(row.volume),
  ]);
  const lines = [
    '通达信行情明细',
    `文件: ${report.file}`,
    `标的: ${formatInstrument(report.instrument)}  格式: ${report.format.label}`,
    `区间: ${formatRange(report.range)}  区间内 ${formatCount(report.filtered)} 条  显示 ${report.rows.length} 条`
      + `（${report.order === 'desc' ? '倒序' : '正序'}${report.offset ? `，偏移 ${report.offset}` : ''}）`,
    '',
    tableText(headers, rows, aligns),
  ];
  if (report.truncated) lines.push('', `提示: 结果已截断（共 ${formatCount(report.filtered)} 条），可用 start/end/limit/offset 缩小范围。`);
  return lines.join('\n');
}

/** Indicator table report. */
export function indicatorsText(report) {
  const hasTime = report.rows.some((row) => typeof row.time === 'string' && row.time.length > 0);
  const headers = [
    '日期',
    ...(hasTime ? ['时间'] : []),
    '收盘', 'MA5', 'MA10', 'MA20', 'MA60', 'DIF', 'DEA', 'MACD',
    'RSI14', 'K', 'D', 'J', 'BOLL上', 'BOLL中', 'BOLL下',
  ];
  const aligns = headers.map((header) => (header === '日期' || header === '时间' ? 'l' : 'r'));
  const rows = report.rows.map((row) => [
    row.date ?? EM_DASH,
    ...(hasTime ? [row.time ?? EM_DASH] : []),
    formatPrice(row.close),
    formatIndicator(row.ma5),
    formatIndicator(row.ma10),
    formatIndicator(row.ma20),
    formatIndicator(row.ma60),
    formatIndicator(row.dif, 3),
    formatIndicator(row.dea, 3),
    formatIndicator(row.macd, 3),
    formatIndicator(row.rsi14, 1),
    formatIndicator(row.k, 1),
    formatIndicator(row.d, 1),
    formatIndicator(row.j, 1),
    formatIndicator(row.bollUpper, 2),
    formatIndicator(row.bollMiddle, 2),
    formatIndicator(row.bollLower, 2),
  ]);
  return [
    '通达信技术指标',
    `文件: ${report.file}`,
    `标的: ${formatInstrument(report.instrument)}  格式: ${report.format.label}`,
    `区间: ${formatRange(report.range)}  显示 ${report.rows.length} 条（${report.order === 'desc' ? '倒序' : '正序'}）`,
    '',
    tableText(headers, rows, aligns),
  ].join('\n');
}

/** Resampled bar report. */
export function resampleText(report) {
  const headers = ['周期', '起始', '结束', '开盘', '最高', '最低', '收盘', '涨跌%', '成交额', '成交量'];
  const aligns = ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r'];
  const rows = report.rows.map((bar) => [
    bar.key,
    bar.startDate ?? EM_DASH,
    bar.endDate ?? EM_DASH,
    formatPrice(bar.open),
    formatPrice(bar.high),
    formatPrice(bar.low),
    formatPrice(bar.close),
    formatPct(bar.changePct),
    formatAmount(bar.amount),
    formatVolume(bar.volume, report.instrument.volumeUnit),
  ]);
  return [
    '通达信周期聚合',
    `文件: ${report.file}`,
    `标的: ${formatInstrument(report.instrument)}  周期: ${report.period === 'month' ? '月线' : '周线'}`,
    `区间: ${formatRange(report.range)}  共 ${formatCount(report.total)} 根  显示 ${report.rows.length} 根`
      + `（${report.order === 'desc' ? '倒序' : '正序'}）`,
    '',
    tableText(headers, rows, aligns),
  ].join('\n');
}

/** CSV export report. */
export function exportText(report) {
  return [
    '通达信 CSV 导出完成',
    `源文件: ${report.file}`,
    `输出: ${report.output}`,
    `记录: ${formatCount(report.count)} 条  大小: ${formatBytes(report.bytes)}  区间: ${formatRange(report.range)}`,
    `格式: UTF-8（含 BOM，Excel 可直接打开），表头 ${report.header ?? 'date,open,high,low,close,change_pct,amplitude_pct,amount,volume'}`,
  ].join('\n');
}

/** Directory scan report. */
export function scanText(report) {
  const markets = Object.entries(report.marketCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([market, count]) => `${market} ${formatCount(count)}`)
    .join(' / ');
  const filters = [];
  if (report.market) filters.push(`市场 ${report.market}`);
  if (report.pattern) filters.push(`匹配 "${report.pattern}"`);
  const rows = report.results.map((entry) => [
    entry.market,
    entry.code,
    entry.kindLabel,
    formatCount(entry.records),
    entry.firstDate ?? EM_DASH,
    entry.lastDate ?? EM_DASH,
    relative(report.dir, entry.file) || entry.file,
  ]);
  const lines = [
    '通达信数据目录扫描',
    `目录: ${report.dir}`,
    `共扫描 ${formatCount(report.scanned)} 个行情文件${markets ? `（${markets}）` : ''}`,
    `筛选: ${filters.length > 0 ? filters.join(' · ') : '无'}`,
    `匹配: ${formatCount(report.matched)} 个，显示 ${report.results.length} 个`
      + (report.truncated ? '（已截断，可用 pattern/market/limit 过滤）' : ''),
    '',
    tableText(
      ['市场', '代码', '类型', '记录', '起始', '结束', '文件'],
      rows,
      ['l', 'l', 'l', 'r', 'l', 'l', 'l'],
    ),
  ];
  return lines.join('\n');
}

/** Command help text. */
export function helpText() {
  return [
    '通达信数据读取（dsh-tdx）',
    '',
    '用法: /tdx <动作> <文件或目录> [参数]',
    '',
    '动作:',
    '  info        文件信息、记录数、日期区间、数据质量',
    '  summary     最新行情、均线、MACD/RSI/KDJ/BOLL、区间收益、波动率（默认动作）',
    '  rows        明细行情（支持日期范围、倒序、分页）',
    '  indicators  最近若干根 K 线的技术指标表',
    '  resample    周线/月线聚合',
    '  export      导出 CSV（UTF-8 BOM，Excel 可打开；导出所选日期范围内的全部记录）',
    '  scan        递归扫描目录，列出交易品种与数据覆盖',
    '',
    '参数:',
    '  --start=YYYY-MM-DD   起始日期（含）',
    '  --end=YYYY-MM-DD     结束日期（含）',
    '  --limit=N            返回条数（rows 默认 30，scan 默认 50）',
    '  --offset=N           跳过条数',
    '  --order=asc|desc     明细/指标排序（默认 desc，最新在前）',
    '  --period=week|month  聚合周期（默认 week）',
    '  --output=<路径>      CSV 输出路径（export）',
    '  --market=sh|sz|bj    市场过滤（scan）',
    '  --pattern=<文本>     代码/文件名包含过滤（scan）',
    '',
    '示例:',
    '  /tdx summary "D:\\MyTools\\new_tdx_day\\bj\\lday\\bj899050.day"',
    '  /tdx rows "D:\\MyTools\\new_tdx_day\\bj\\lday\\bj899050.day" --start=2026-01-01 --limit=10 --order=desc',
    '  /tdx resample "D:\\MyTools\\new_tdx_day\\sh\\lday\\sh600519.day" --period=month',
    '  /tdx export "D:\\MyTools\\new_tdx_day\\bj\\lday\\bj899050.day" --output=D:\\data\\bj899050.csv',
    '  /tdx scan "D:\\MyTools\\new_tdx_day" --market=bj --pattern=899',
    '',
    '代理也可以直接调用 tdx_data 工具完成同样的操作。',
  ].join('\n');
}
