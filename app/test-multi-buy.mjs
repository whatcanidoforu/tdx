/**
 * 多买点模式 —— 单元测试。
 *
 * 需求：在日期范围内，一只股票每出现一次买点就输出一条记录。
 *   例：股票 A 在 8-10 出现买点、8-11 又出现、11-05 再出现 → 输出 3 条。
 */
import { detectDivergence } from './hj-pivot-scan.js';
import { readLc5As } from './lc5-reader.js';

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

/* ---------------------------------------------------------- 真实数据 */

const bars = readLc5As('D:\\MyTools\\new_tdx\\vipdoc\\sh\\fzline\\sh688796.lc5', 3);
const params = {
  threshold: 20, minPivots: 2, minGap: 3, minDownBars: 1, reboundCap: 25, useDif: false,
};

const longRange = detectDivergence(bars, {
  ...params, startDate: '20260716', endDate: '20261111',
});
checkTrue('长范围有结果', longRange.matched, longRange.reason);

if (longRange.matched) {
  checkTrue('返回 matches 数组', Array.isArray(longRange.matches));
  checkTrue('买点数 > 1（该股在长范围内多次出现买点）', longRange.matches.length > 1,
    `实际 ${longRange.matches.length}`);

  // 每个 match 结构完整
  for (const match of longRange.matches) {
    checkTrue('match 有 buyDatetime', typeof match.buyDatetime === 'string');
    checkTrue('match 有 buyIndex', Number.isInteger(match.buyIndex));
    checkTrue('match 有 chain', Array.isArray(match.chain) && match.chain.length >= 2);
    checkTrue('match 有 hj10Rise', Number.isFinite(match.hj10Rise));
    checkTrue('match 有 priceDropPct', Number.isFinite(match.priceDropPct));
  }

  // 买点按时间倒序（最近的在前）
  let sorted = true;
  for (let i = 1; i < longRange.matches.length; i += 1) {
    if (longRange.matches[i].buyDatetime > longRange.matches[i - 1].buyDatetime) sorted = false;
  }
  checkTrue('买点按时间倒序', sorted,
    longRange.matches.map((m) => m.buyDatetime).join(', '));

  // 每个买点的买入日必须在范围内
  const inRange = longRange.matches.every(
    (m) => m.buyDate >= '20260716' && m.buyDate <= '20261111',
  );
  checkTrue('所有买点都在日期范围内', inRange);

  // 兼容性：chain 字段仍指向最近一个买点
  check('chain 指向最近买点',
    longRange.chain[longRange.chain.length - 1].turn.datetime,
    longRange.matches[0].buyDatetime);

  // onlyLatest 只返回一个
  const latestOnly = detectDivergence(bars, {
    ...params, startDate: '20260716', endDate: '20261111', onlyLatest: true,
  });
  check('onlyLatest 只返回1个买点', latestOnly.matches.length, 1);
  check('onlyLatest 取最近的那个',
    latestOnly.matches[0].buyDatetime, longRange.matches[0].buyDatetime);

  /* ---------------------------------------------------------- 单日 vs 长范围一致性 */

  // 取最近买点所在的那一天做单日扫描，应当命中且买点相同
  const lastBuyDate = longRange.matches[0].buyDate;
  const singleDay = detectDivergence(bars, {
    ...params, startDate: lastBuyDate, endDate: lastBuyDate,
  });
  checkTrue(`单日(${lastBuyDate})命中，且买点与长范围一致`,
    singleDay.matched
    && singleDay.matches[0].buyDatetime === longRange.matches[0].buyDatetime,
    `单日: ${singleDay.matched ? singleDay.matches[0].buyDatetime : singleDay.reason}`);

  // 单日扫描的买点数应少于长范围（范围内只剩当天）
  checkTrue('单日买点数 ≤ 长范围买点数',
    singleDay.matches.length <= longRange.matches.length,
    `单日 ${singleDay.matches.length} vs 长范围 ${longRange.matches.length}`);
}

/* ---------------------------------------------------------- 边界 */

// 范围很窄，可能只有 0 个买点
const narrow = detectDivergence(bars, { ...params, startDate: '20260101', endDate: '20260105' });
checkTrue('极窄范围不命中', !narrow.matched);

// 数据不足
const few = bars.slice(0, 10);
check('数据不足拒绝', detectDivergence(few, params).matched, false);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
