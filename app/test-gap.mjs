/**
 * 数据缺口检测与补齐 —— 单元测试。
 */
import {
  analyzeGap, applyPatch, findMissingDates, enumerateDates, filterByDates, isWeekend,
  isValidDateStr, sanitizeBars,
} from './gap-filler.js';

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

/* ------------------------- 1. 周末判断 */

check('2026-11-07 是周六', isWeekend('20261107'), true);
check('2026-11-08 是周日', isWeekend('20261108'), true);
check('2026-11-09 是周一', isWeekend('20261109'), false);
check('2026-11-10 是周二', isWeekend('20261110'), false);

/* ------------------------- 1b. 日期合法性校验 */

check('正常日期', isValidDateStr('20261110'), true);
check('2004年垃圾日期', isValidDateStr('20040000'), false);
check('月份非法', isValidDateStr('20130179'), false);
check('年份超范围', isValidDateStr('20351793'), false);
check('位数不足', isValidDateStr('2026111'), false);
check('非数字', isValidDateStr('2026-11-10'), false);
check('undefined', isValidDateStr(undefined), false);

// sanitizeBars 过滤异常日期
const dirty = [
  { date: '20261110', time: '10:00' },
  { date: '20040039', time: '05:07' },
  { date: '20130179', time: '332:39' },
  { date: '20261111', time: '10:00' },
];
check('清洗异常日期', sanitizeBars(dirty).map((b) => b.date), ['20261110', '20261111']);
check('清洗空数组', sanitizeBars([]).length, 0);
check('清洗非数组', sanitizeBars(null).length, 0);

/* ------------------------- 2. 日期枚举 */

check('枚举3天', enumerateDates('20261109', '20261111'), ['20261109', '20261110', '20261111']);
check('同一天', enumerateDates('20261109', '20261109'), ['20261109']);
check('跨月', enumerateDates('20261030', '20261102'), ['20261030', '20261031', '20261101', '20261102']);
check('倒序返回空', enumerateDates('20261111', '20261109'), []);

/* ------------------------- 3. 缺口检测 */

// 中间缺 11-10
const gap1 = analyzeGap(['20261106', '20261109', '20261111'], ['20261106', '20261109', '20261110', '20261111']);
check('检测到中间缺口', gap1.missing, ['20261110']);
check('localLast 正确', gap1.localLast, '20261111');
check('refLast 正确', gap1.refLast, '20261111');

// 无缺口
const gap2 = analyzeGap(['20261109', '20261110', '20261111'], ['20261109', '20261110', '20261111']);
check('无缺口', gap2.missing, []);

// 本地落后（结尾缺口）
const gap3 = analyzeGap(['20261106'], ['20261106', '20261109', '20261110', '20261111']);
check('结尾缺口', gap3.missing, ['20261109', '20261110', '20261111']);
check('stale 标记', gap3.stale, true);

// 本地为空
const gap4 = analyzeGap([], ['20261109', '20261110']);
check('本地为空时全部缺失', gap4.missing, ['20261109', '20261110']);

// 参考日历为空 → 无法判断，不报缺口
const gap5 = analyzeGap(['20261109'], []);
check('参考为空不报缺口', gap5.missing, []);

// 重复日期去重
const gap6 = analyzeGap(['20261109', '20261109', '20261111'], ['20261109', '20261110', '20261111']);
check('重复日期去重', gap6.missing, ['20261110']);

/* ------------------------- 4. findMissingDates 直接测 */

check('直接找缺失', findMissingDates(['20261109', '20261111'], ['20261109', '20261110', '20261111']), ['20261110']);
check('参考含周末但本地没有（正常，不报）',
  findMissingDates(['20261106', '20261109'], ['20261106', '20261107', '20261108', '20261109']),
  ['20261107', '20261108']);
// 注意：实际使用时参考日历来自主站真实数据，不含周末，所以不会误报

/* ------------------------- 5. 补丁合并 */

const localBars = [
  { date: '20261109', time: '15:00', close: 10.0 },
];
const patchBars = [
  { date: '20261110', time: '10:00', close: 10.5 },
  { date: '20261110', time: '10:15', close: 10.6 },
  { date: '20261111', time: '09:45', close: 10.8 },
];
const applied = applyPatch(localBars, patchBars);
check('补丁新增根数', applied.filled, 3);
check('合并后总数', applied.bars.length, 4);
check('按时间升序', applied.bars.map((b) => `${b.date}${b.time}`),
  ['2026110915:00', '2026111010:00', '2026111010:15', '2026111109:45']);

// 补丁覆盖同键（盘中数据更新）
const applied2 = applyPatch(
  [{ date: '20261111', time: '09:45', close: 10.0 }],
  [{ date: '20261111', time: '09:45', close: 11.0 }],
);
check('同键被覆盖', applied2.bars.length, 1);
check('覆盖后的值', applied2.bars[0].close, 11.0);
check('覆盖不计入新增', applied2.filled, 0);

// 空补丁
const applied3 = applyPatch(localBars, []);
check('空补丁不改动', applied3.bars.length, 1);
check('空补丁新增0', applied3.filled, 0);

// 空本地
const applied4 = applyPatch([], patchBars);
check('空本地时全部新增', applied4.bars.length, 3);

/* ------------------------- 6. 按日期过滤 */

const bars = [
  { date: '20261109', time: '10:00' },
  { date: '20261110', time: '10:00' },
  { date: '20261111', time: '10:00' },
];
check('过滤指定日期', filterByDates(bars, new Set(['20261110'])).map((b) => b.date), ['20261110']);
check('过滤多日期', filterByDates(bars, new Set(['20261109', '20261111'])).length, 2);
check('过滤不存在的日期', filterByDates(bars, new Set(['20260101'])).length, 0);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
