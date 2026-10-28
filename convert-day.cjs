/**
 * TDX 二进制行情文件 → CSV / JSON 转换脚本
 *
 * 支持格式: .day(日线) / .lc1(1分钟) / .lc5(5分钟) / .min(分钟)
 *
 * 用法:
 *   node convert-day.cjs "D:\MyTools\new_tdx\vipdoc\sh\lday\sh000001.day"
 *   node convert-day.cjs "D:\MyTools\new_tdx\vipdoc\sh\fzline\sh000001.lc5"
 *   node convert-day.cjs "D:\MyTools\new_tdx\vipdoc\sh\minline\sh000001.lc1"
 *
 *   输出自动映射到 web/vipdoc/ 对应子目录，镜像输入路径的 vipdoc 结构。
 *
 * 可选参数:
 *   --json         输出 JSON 格式
 *   -o <path>      指定输出路径
 */

const fs = require('fs');
const path = require('path');

const RECORD_BYTES = 32;
const DAY_PRICE_DIVISOR = 100;

function isValidDateInt(value) {
  if (!Number.isInteger(value) || value < 19000101 || value > 22001231) return false;
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatDateInt(value) {
  if (!isValidDateInt(value)) return null;
  const year = Math.floor(value / 10000);
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function decodePackedDate(packed) {
  if (!Number.isInteger(packed) || packed <= 0) return 0;
  const year = 2004 + Math.floor(packed / 2048);
  const remainder = packed % 2048;
  const month = Math.floor(remainder / 100);
  const day = remainder % 100;
  const value = year * 10000 + month * 100 + day;
  return isValidDateInt(value) ? value : 0;
}

function formatMinuteOfDay(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) return null;
  const hour = Math.floor(minutes / 60);
  const minute = Math.floor(minutes % 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function sniffFormat(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.day')) return 'day';
  if (lower.endsWith('.lc1') || lower.endsWith('.min')) return 'minute';
  if (lower.endsWith('.lc5')) return 'minute';
  return 'day';
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function decodeDayFile(ab) {
  const view = new DataView(ab);
  const count = ab.byteLength / RECORD_BYTES;
  const rows = new Array(count);
  let previousClose = null;

  for (let i = 0; i < count; i++) {
    const off = i * RECORD_BYTES;
    const rawDate = view.getUint32(off, true);
    const dateInt = isValidDateInt(rawDate) ? rawDate : 0;
    const open = view.getUint32(off + 4, true) / DAY_PRICE_DIVISOR;
    const high = view.getUint32(off + 8, true) / DAY_PRICE_DIVISOR;
    const low = view.getUint32(off + 12, true) / DAY_PRICE_DIVISOR;
    const close = view.getUint32(off + 16, true) / DAY_PRICE_DIVISOR;
    const rawAmount = view.getFloat32(off + 20, true);
    const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
    const volume = view.getUint32(off + 24, true);
    const changePct =
      previousClose && previousClose > 0
        ? ((close / previousClose - 1) * 100).toFixed(2)
        : null;
    const amplitudePct =
      previousClose && previousClose > 0
        ? (((high - low) / previousClose) * 100).toFixed(2)
        : null;
    previousClose = close;
    rows[i] = { date: formatDateInt(dateInt), dateInt, open, high, low, close, amount, volume, changePct, amplitudePct };
  }
  return rows;
}

function decodeMinuteFile(ab) {
  const view = new DataView(ab);
  const count = ab.byteLength / RECORD_BYTES;
  const rows = new Array(count);
  let previousClose = null;

  for (let i = 0; i < count; i++) {
    const off = i * RECORD_BYTES;
    const rawDate = view.getUint16(off, true);
    const rawTime = view.getUint16(off + 2, true);
    const dateInt = decodePackedDate(rawDate);
    const time = formatMinuteOfDay(rawTime);
    const open = round(view.getFloat32(off + 4, true), 4);
    const high = round(view.getFloat32(off + 8, true), 4);
    const low = round(view.getFloat32(off + 12, true), 4);
    const close = round(view.getFloat32(off + 16, true), 4);
    const rawAmount = view.getFloat32(off + 20, true);
    const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
    const volume = view.getUint32(off + 24, true);
    const changePct =
      previousClose && previousClose > 0
        ? ((close / previousClose - 1) * 100).toFixed(2)
        : null;
    const amplitudePct =
      previousClose && previousClose > 0
        ? (((high - low) / previousClose) * 100).toFixed(2)
        : null;
    previousClose = close;
    rows[i] = { date: formatDateInt(dateInt), dateInt, time, open, high, low, close, amount, volume, changePct, amplitudePct };
  }
  return rows;
}

function decodeFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  if (ab.byteLength === 0) throw new Error('文件为空');
  if (ab.byteLength % RECORD_BYTES !== 0) {
    throw new Error(`文件长度 ${ab.byteLength} 字节不是 ${RECORD_BYTES} 的整数倍`);
  }

  const format = sniffFormat(filePath);
  return { format, rows: format === 'day' ? decodeDayFile(ab) : decodeMinuteFile(ab) };
}

function toCsv(rows, format) {
  const isMinute = format === 'minute';
  const header = isMinute
    ? 'date,time,open,high,low,close,volume,amount,change_pct,amplitude_pct'
    : 'date,open,high,low,close,volume,amount,change_pct,amplitude_pct';
  const lines = rows.map((r) => {
    const fields = isMinute
      ? [r.date, r.time, r.open, r.high, r.low, r.close, r.volume, r.amount, r.changePct ?? '', r.amplitudePct ?? '']
      : [r.date, r.open, r.high, r.low, r.close, r.volume, r.amount, r.changePct ?? '', r.amplitudePct ?? ''];
    return fields.join(',');
  });
  return [header, ...lines].join('\n');
}

function toJson(rows) {
  return JSON.stringify(rows, null, 2);
}

function resolveOutputPath(absInput, extension) {
  const norm = absInput.replace(/\\/g, '/');
  const vipIdx = norm.search(/\/vipdoc\//i);
  if (vipIdx === -1) {
    return absInput.replace(/\.([a-z0-9]+)$/i, extension);
  }
  const relative = norm.slice(vipIdx + 1).replace(/\.([a-z0-9]+)$/i, extension);
  const out = path.resolve(__dirname, relative);
  const dir = path.dirname(out);
  fs.mkdirSync(dir, { recursive: true });
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('用法: node convert-day.cjs <文件路径> [--json] [-o <输出路径>]');
    console.log('支持: .day / .lc1 / .lc5 / .min');
    process.exit(1);
  }

  const inputPath = args[0];
  const absInput = path.resolve(inputPath);

  if (!fs.existsSync(absInput)) {
    console.error(`文件不存在: ${absInput}`);
    process.exit(1);
  }

  let outputPath = null;
  let useJson = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') {
      useJson = true;
    } else if (args[i] === '-o' && i + 1 < args.length) {
      outputPath = args[i + 1];
      i++;
    }
  }

  const ext = path.extname(absInput).toLowerCase();
  console.log(`读取: ${absInput}  (${ext === '.day' ? '日线' : ext === '.lc5' ? '5分钟' : '1分钟'})`);

  const { format, rows } = decodeFile(absInput);
  console.log(`解析: ${rows.length} 条记录`);

  if (rows.length > 0) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const timeInfo = format === 'minute'
      ? ` ${first.time} ~ ${last.time}`
      : '';
    console.log(`范围: ${first.date}${timeInfo} ~ ${last.date}${timeInfo}`);
  }

  const extension = useJson ? '.json' : '.csv';
  const dest = outputPath
    ? path.resolve(outputPath)
    : resolveOutputPath(absInput, extension);

  const content = useJson ? toJson(rows) : toCsv(rows, format);
  fs.writeFileSync(dest, content, 'utf-8');
  console.log(`输出: ${dest}`);
  console.log('完成');
}

main();