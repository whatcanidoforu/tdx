/**
 * 日线指标对比 —— 单元测试。
 *
 * 覆盖：
 *   1. 日线 HJ10 / MACD 柱的前后比较
 *   2. 连续下跌天数
 *   3. 边界情况（买入日无日线、只有一天数据）
 *   4. 日线滞后补齐（合并主站补丁后重算）
 */
import {
  loadDailyIndicators, compareDailyAt, countDailyDecline, findDailyIndex, clearDailyCache,
  loadDailyBars, localDailyLastDate, mergeDailyBars, buildDailyIndicators,
} from './daily-context.js';

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

const TDX = 'D:\\MyTools\\new_tdx';

/* ------------------------------- 1. 加载日线指标 */

clearDailyCache();
const daily = loadDailyIndicators(TDX, 'sh', '600000');
checkTrue('日线日期非空', daily.dates.length > 1000, `实际 ${daily.dates.length}`);
checkTrue('HJ10 与日期等长', daily.hj10.length === daily.dates.length);
checkTrue('MACD 与日期等长', daily.macd.length === daily.dates.length);
checkTrue('HJ10 有有效值', daily.hj10.filter(Number.isFinite).length > 900);

// 缓存生效（第二次是同一对象）
const daily2 = loadDailyIndicators(TDX, 'sh', '600000');
checkTrue('缓存返回同一对象', daily === daily2);

/* ------------------------------- 2. 查找下标 */

check('查找存在的日期', findDailyIndex(daily.dates, daily.dates[daily.dates.length - 1]),
  daily.dates.length - 1);
check('查找未来日期返回最后一天', findDailyIndex(daily.dates, '20991231'), daily.dates.length - 1);
check('查找过早日期返回 -1', findDailyIndex(daily.dates, '19900101'), -1);
check('查找周末返回前一个交易日', findDailyIndex(['20261106', '20261109'], '20261108'), 0);

/* ------------------------------- 3. 前后比较 */

const cmp = compareDailyAt(daily, '20261106');
checkTrue('对比有结果', cmp !== null);
if (cmp) {
  check('对比日期正确', cmp.date, '20261106');
  checkTrue('HJ10 是数值', Number.isFinite(cmp.hj10));
  checkTrue('前一日 HJ10 是数值', Number.isFinite(cmp.hj10Prev));
  check('HJ10是否下降 是布尔', typeof cmp.hj10Lower, 'boolean');
  checkTrue('MACD柱 是数值', Number.isFinite(cmp.macdHist));
  check('MACD是否缩小 是布尔', typeof cmp.macdLower, 'boolean');
  // 验证判断逻辑正确
  check('HJ10判断正确', cmp.hj10Lower, cmp.hj10 < cmp.hj10Prev);
  check('MACD判断正确', cmp.macdLower, cmp.macdHist < cmp.macdHistPrev);
}

// 买入日正好是周末时，应取前一个交易日
const cmpWeekend = compareDailyAt(daily, '20261108');
checkTrue('周末取前一日', cmpWeekend !== null && cmpWeekend.date === '20261106',
  cmpWeekend?.date);

// 找到 HJ10 上升的那天，验证 hj10Lower=false
const n = daily.dates.length;
let upIndex = -1;
for (let i = n - 1; i > n - 60; i -= 1) {
  if (Number.isFinite(daily.hj10[i]) && Number.isFinite(daily.hj10[i - 1])
    && daily.hj10[i] > daily.hj10[i - 1]) { upIndex = i; break; }
}
checkTrue('存在 HJ10 上升的交易日', upIndex > 0, `未找到`);
if (upIndex > 0) {
  const up = compareDailyAt(daily, daily.dates[upIndex]);
  check('HJ10 上升日 hj10Lower=false', up.hj10Lower, false);
}

/* ------------------------------- 4. 连续下跌天数 */

// 构造合成数据
const fake = {
  dates: ['20261101', '20261102', '20261103', '20261104', '20261105'],
  hj10: [50, 45, 40, 35, 30],
  macd: [1, 0.5, 0, -0.5, -1],
};
// 5 个数据点只有 4 次相邻比较，所以最多连跌 4 天
check('连跌4天（5点）', countDailyDecline(fake, '20261105').days, 4);
check('第3天连跌2', countDailyDecline(fake, '20261103').days, 2);
check('第一天连跌0', countDailyDecline(fake, '20261101').days, 0);

const fake2 = {
  dates: ['20261101', '20261102', '20261103', '20261104'],
  hj10: [30, 35, 33, 31],
  macd: [0, 0, 0, 0],
};
check('中间有上升则断裂', countDailyDecline(fake2, '20261104').days, 2);

const fake3 = {
  dates: ['20261101', '20261102', '20261103'],
  hj10: [30, 35, 40],
  macd: [0, 0, 0],
};
check('全部上升连跌0', countDailyDecline(fake3, '20261103').days, 0);

/* ------------------------------- 5. 边界 */

check('空数据返回 null', compareDailyAt({ dates: [], hj10: [], macd: [] }, '20261106'), null);
check('只有一天返回 null',
  compareDailyAt({ dates: ['20261106'], hj10: [50], macd: [1] }, '20261106'), null);
check('过早日期返回 null', compareDailyAt(daily, '19900101'), null);
check('空数据连跌为0', countDailyDecline({ dates: [], hj10: [], macd: [] }, '20261106').days, 0);

/* ------------------------------- 6. 日线滞后补齐 */

// 本地日线最后日期
const lastDate = localDailyLastDate(TDX, 'sz', '000007');
checkTrue('本地日线最后日期是 8 位数字', /^\d{8}$/.test(lastDate ?? ''), String(lastDate));

const localBars = loadDailyBars(TDX, 'sz', '000007');
checkTrue('本地日线有数据', localBars.length > 1000, `实际 ${localBars.length}`);
checkTrue('loadDailyBars 缓存返回同一引用', loadDailyBars(TDX, 'sz', '000007') === localBars);

// mergeDailyBars：补丁覆盖同日、并追加新日期
const fakeLocal = [
  { date: '20261110', close: 10 },
  { date: '20261111', close: 11 },
];
const fakeTail = [
  { date: '20261111', close: 11.5 }, // 同日，补丁应覆盖
  { date: '20261112', close: 12 }, // 新日期，应追加
];
const mergedFake = mergeDailyBars(fakeLocal, fakeTail);
check('合并后3天', mergedFake.length, 3);
check('补丁覆盖同日', mergedFake[1].close, 11.5);
check('补丁追加新日期', mergedFake[2].date, '20261112');
check('合并后按日期升序', mergedFake.map((b) => b.date), ['20261110', '20261111', '20261112']);

// 空补丁原样返回
check('空补丁不改动', mergeDailyBars(fakeLocal, []).length, 2);
check('空本地直接用补丁', mergeDailyBars([], fakeTail).length, 2);

// 补丁让买入日能匹配到当天（关键修复点）
const tailBars = [{ date: '20261231', open: 12, high: 13, low: 11, close: 12.5, amount: 0, volume: 0 }];
const withTail = loadDailyIndicators(TDX, 'sz', '000007', tailBars);
check('补丁后最后日期是新日期', withTail.dates[withTail.dates.length - 1], '20261231');
checkTrue('补丁后能查到新日期',
  findDailyIndex(withTail.dates, '20261231') === withTail.dates.length - 1);

// buildDailyIndicators 与直接长度一致
const built = buildDailyIndicators(fakeLocal);
check('指标日期数与K线数一致', built.dates.length, 2);
check('指标hj10与日期等长', built.hj10.length, 2);
check('指标macd与日期等长', built.macd.length, 2);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
