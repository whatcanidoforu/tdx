/**
 * 日线指标对比 —— 单元测试。
 *
 * 覆盖：
 *   1. 日线 HJ10 / MACD 柱的前后比较
 *   2. 连续下跌天数
 *   3. 边界情况（买入日无日线、只有一天数据）
 */
import {
  loadDailyIndicators, compareDailyAt, countDailyDecline, findDailyIndex, clearDailyCache,
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

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
