/**
 * 数据体检工具 —— 单元测试。
 */
import { readFileRange, scanMarket, summarize } from './data-check.mjs';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

/* ------------------------- 1. 真实文件读取 */

const TDX = 'D:\\MyTools\\new_tdx';

const lc5 = readFileRange(join(TDX, 'vipdoc', 'sh', 'fzline', 'sh600000.lc5'), { compressedDate: true });
checkTrue('5分钟文件有起始日', lc5.first !== null, String(lc5.first));
checkTrue('5分钟文件有结束日', lc5.last !== null);
checkTrue('5分钟记录数合理', lc5.count > 1000, `实际 ${lc5.count}`);
checkTrue('起始日格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(lc5.first), lc5.first);
checkTrue('起始日不早于 2004', lc5.first.slice(0, 4) >= '2004', lc5.first);
checkTrue('起始日早于结束日', lc5.first < lc5.last);

const day = readFileRange(join(TDX, 'vipdoc', 'sh', 'lday', 'sh600000.day'), { compressedDate: false });
checkTrue('日线文件有起始日', day.first !== null);
checkTrue('日线记录数合理', day.count > 5000, `实际 ${day.count}`);
checkTrue('日线起始日在 1999 前后', day.first.startsWith('1999'), day.first);
checkTrue('日线起始日早于结束日', day.first < day.last);

/* ------------------------- 2. 损坏/空文件 */

const tmp = mkdtempSync(join(tmpdir(), 'dc-'));
try {
  // 空文件
  const empty = join(tmp, 'empty.lc5');
  writeFileSync(empty, '');
  const emptyRange = readFileRange(empty, { compressedDate: true });
  check('空文件记录数为0', emptyRange.count, 0);
  check('空文件无起始日', emptyRange.first, null);

  // 不足一条记录
  const tiny = join(tmp, 'tiny.lc5');
  writeFileSync(tiny, Buffer.alloc(16));
  const tinyRange = readFileRange(tiny, { compressedDate: true });
  check('不足一条记录返回0', tinyRange.count, 0);

  // 不存在的文件
  const missingRange = readFileRange(join(tmp, 'nope.lc5'), { compressedDate: true });
  check('不存在文件返回null', [missingRange.first, missingRange.last, missingRange.count], [null, null, 0]);

  // 构造合法 .lc5 记录：2026-11-11 → (2026-2004)*2048 + 11*100 + 11
  const zip = (2026 - 2004) * 2048 + 11 * 100 + 11;
  const record = Buffer.alloc(32);
  record.writeUInt16LE(zip, 0);
  record.writeUInt16LE(10 * 60, 2); // 10:00
  const fake = join(tmp, 'fake.lc5');
  writeFileSync(fake, Buffer.concat([record, record]));
  const fakeRange = readFileRange(fake, { compressedDate: true });
  check('合成 lc5 起始日', fakeRange.first, '2026-11-11');
  check('合成 lc5 记录数', fakeRange.count, 2);

  // 构造合法 .day 记录：20261111
  const dayRecord = Buffer.alloc(32);
  dayRecord.writeUInt32LE(20261111, 0);
  const fakeDay = join(tmp, 'fake.day');
  writeFileSync(fakeDay, Buffer.concat([dayRecord, dayRecord, dayRecord]));
  const fakeDayRange = readFileRange(fakeDay, { compressedDate: false });
  check('合成日线起始日', fakeDayRange.first, '2026-11-11');
  check('合成日线记录数', fakeDayRange.count, 3);

  // 非法日期（年份越界）应返回 null
  const badRecord = Buffer.alloc(32);
  badRecord.writeUInt32LE(19000101, 0);
  const badDay = join(tmp, 'bad.day');
  writeFileSync(badDay, Buffer.concat([badRecord]));
  const badRange = readFileRange(badDay, { compressedDate: false });
  check('年份越界返回 null', badRange.first, null);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------- 3. 目录扫描 */

const scanResult = scanMarket(TDX, 'sh', { dir: 'fzline', ext: '.lc5', compressedDate: true }, { limit: 20 });
check('扫描限制条数', scanResult.files.length, 20);
checkTrue('扫描结果有代码', scanResult.files.every((f) => /^\d{6}$/.test(f.code)));
checkTrue('扫描结果有日期', scanResult.files.every((f) => f.first && f.last));

// 单只过滤
const single = scanMarket(TDX, 'sh', { dir: 'fzline', ext: '.lc5', compressedDate: true }, { code: '600000' });
check('单只过滤结果数', single.files.length, 1);
check('单只代码正确', single.files[0].code, '600000');

// 不存在的目录
const noDir = scanMarket(TDX, 'xx', { dir: 'fzline', ext: '.lc5', compressedDate: true });
check('不存在的市场返回 missing', noDir.missing, true);

/* ------------------------- 4. 汇总统计 */

const fakeFiles = [
  { market: 'sh', code: '600000', first: '2026-07-16', last: '2026-11-11', count: 1000 },
  { market: 'sh', code: '600001', first: '2026-07-16', last: '2026-11-11', count: 1200 },
  { market: 'sh', code: '600002', first: '2026-08-01', last: '2026-11-10', count: 800 },
];
const summary = summarize(fakeFiles);
check('汇总文件数', summary.count, 3);
check('最早起始日', summary.earliest, '2026-07-16');
check('最晚结束日', summary.latest, '2026-11-11');
check('最小记录数', summary.minBars, 800);
check('最大记录数', summary.maxBars, 1200);
check('起始日分布第一位', summary.firstDist[0], ['2026-07-16', 2]);
check('结束日分布第一位', summary.lastDist[0], ['2026-11-11', 2]);

// 空汇总
const emptySummary = summarize([]);
check('空数据汇总', emptySummary.count, 0);
check('空数据无最早日期', emptySummary.earliest, null);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
