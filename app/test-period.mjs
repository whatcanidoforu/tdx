/**
 * 周期支持 —— 单元测试。
 *
 * 覆盖：
 *   1. 周期解析（5/15/30/day 及别名）
 *   2. 5 分钟线聚合到各周期
 *   3. 日线文件读取
 *   4. 各周期数据量关系
 */
import { resolvePeriod, PERIODS, periodNames } from './period.js';
import { mergeBars, readLc5, readDayFile, readLc5As } from './lc5-reader.js';
import { listKlineFiles, readKlineFile } from './hj-pivot-scanner.mjs';

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

/* --------------------------------------- 1. 周期解析 */

check('解析 5', resolvePeriod('5')?.groupSize, 1);
check('解析 15', resolvePeriod('15')?.groupSize, 3);
check('解析 30', resolvePeriod('30')?.groupSize, 6);
check('解析 day', resolvePeriod('day')?.source, 'day');
check('别名 5m', resolvePeriod('5m')?.key, '5');
check('别名 M15', resolvePeriod('M15')?.key, '15');
check('别名 日线', resolvePeriod('日线')?.key, 'day');
check('别名 d', resolvePeriod('d')?.key, 'day');
check('默认 15', resolvePeriod(null)?.key, '15');
check('未知周期返回 null', resolvePeriod('7'), null);
check('可用周期', periodNames(), ['5', '15', '30', 'day']);

// 行情主站周期码
check('5分钟主站码', PERIODS['5'].tdxCategory, 0);
check('15分钟主站码', PERIODS['15'].tdxCategory, 1);
check('30分钟主站码', PERIODS['30'].tdxCategory, 2);
check('日线主站码', PERIODS.day.tdxCategory, 9);

/* --------------------------------------- 2. 聚合逻辑 */

const LC5 = 'D:\\MyTools\\new_tdx\\vipdoc\\sh\\fzline\\sh600000.lc5';
const bars5 = readLc5(LC5);
checkTrue('5分钟原始数据足够', bars5.length > 3000, `实际 ${bars5.length}`);

const m1 = mergeBars(bars5, 1);
const m3 = mergeBars(bars5, 3);
const m6 = mergeBars(bars5, 6);

checkTrue('5分钟根数 = 原始', m1.length === bars5.length);
checkTrue(`15分钟 = 1/3（${m1.length} → ${m3.length}）`, Math.abs(m3.length - m1.length / 3) <= 20,
  `${m1.length} vs ${m3.length}`);
checkTrue(`30分钟 = 1/6（${m1.length} → ${m6.length}）`, Math.abs(m6.length - m1.length / 6) <= 20,
  `${m1.length} vs ${m6.length}`);

// 每日根数
const dayCount = (bars) => {
  const m = new Map();
  for (const b of bars) m.set(b.date, (m.get(b.date) ?? 0) + 1);
  return [...m.values()];
};
const perDay5 = dayCount(m1).filter((n) => n > 0);
const perDay15 = dayCount(m3);
const perDay30 = dayCount(m6);
checkTrue('5分钟每天最多48根', Math.max(...perDay5) <= 48, `实际 ${Math.max(...perDay5)}`);
checkTrue('15分钟每天最多16根', Math.max(...perDay15) <= 16, `实际 ${Math.max(...perDay15)}`);
checkTrue('30分钟每天最多8根', Math.max(...perDay30) <= 8, `实际 ${Math.max(...perDay30)}`);

/* --------------------------------------- 3. 聚合正确性 */

// 取第一天验证 OHLC 聚合
const day1 = m1[0].date;
const src = m1.filter((b) => b.date === day1).slice(0, 6);
const agg6 = m6.filter((b) => b.date === day1)[0];
check('30分钟开盘 = 首根开盘', agg6.open, src[0].open);
check('30分钟收盘 = 末根收盘', agg6.close, src[5].close);
check('30分钟最高 = 6根最高', agg6.high, Math.max(...src.map((b) => b.high)));
check('30分钟最低 = 6根最低', agg6.low, Math.min(...src.map((b) => b.low)));
checkTrue('30分钟成交量 = 6根之和',
  Math.abs(agg6.volume - src.reduce((s, b) => s + b.volume, 0)) < 1);

/* --------------------------------------- 4. 日线读取 */

const DAY = 'D:\\MyTools\\new_tdx\\vipdoc\\sh\\lday\\sh600000.day';
const dayBars = readDayFile(DAY);
checkTrue('日线数据足够', dayBars.length > 1000, `实际 ${dayBars.length}`);
check('日线字段完整', Object.keys(dayBars[0]).sort().join(','),
  ['amount', 'close', 'date', 'high', 'low', 'open', 'time', 'volume'].join(','));
checkTrue('日线日期格式 YYYYMMDD', /^\d{8}$/.test(dayBars[0].date), dayBars[0].date);
checkTrue('日线价格合理', dayBars[dayBars.length - 1].close > 0);

/* --------------------------------------- 5. 文件枚举 */

for (const key of ['5', '15', '30', 'day']) {
  const period = PERIODS[key];
  const files = listKlineFiles('D:\\MyTools\\new_tdx', 'sh', period);
  checkTrue(`${period.label} 找到 A 股文件`, files.length > 1000, `实际 ${files.length}`);
}

// 日线读第一只
const dayFile = listKlineFiles('D:\\MyTools\\new_tdx', 'sh', PERIODS.day)[0];
const readBack = readKlineFile(dayFile.file, PERIODS.day);
checkTrue('按周期读取日线成功', readBack.length > 100);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
