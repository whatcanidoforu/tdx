/**
 * HJ10 底背离检测 —— 单元测试。
 *
 * 覆盖两个真实案例：
 *   603578 三星新材  应命中（有效的两次探底）
 *   603679 华体科技  应排除（中间已反弹 + 抖动低点）
 */
import { findTurnPairs, buildDivergenceChains, detectDivergence } from './hj-pivot-scan.js';
import { readLc5As15Min } from './lc5-reader.js';
import { computeHJ } from '../../../src/formulas/hj.js';

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

/* ------------------------------------------- 1. 拐点识别 */

// 连续下跌 3 根后上翘 → 有效拐点
const hj1 = [30, 25, 20, 15, 18].map((v) => ({ hj10: v }));
const p1 = findTurnPairs(hj1, { threshold: 25, minDownBars: 2 });
check('连跌3根后上翘 → 有效拐点', p1.map((p) => [p.lowIndex, p.turnIndex, p.downBars]), [[3, 4, 3]]);

// 只跌 1 根就上翘 → 抖动，跳过
const hj2 = [20.21, 21.51, 20.60, 21.8].map((v) => ({ hj10: v }));
const p2 = findTurnPairs(hj2, { threshold: 25, minDownBars: 2 });
check('只跌1根 → 视为抖动跳过', p2.length, 0);

// minDownBars=1 时同样的数据会命中
const p2b = findTurnPairs(hj2, { threshold: 25, minDownBars: 1 });
checkTrue('minDownBars=1 时能命中', p2b.length > 0);

// 低点超过阈值不算
const hj3 = [40, 35, 30, 33].map((v) => ({ hj10: v }));
check('低点超阈值不算', findTurnPairs(hj3, { threshold: 25, minDownBars: 2 }).length, 0);

/* ------------------------------------------- 2. 中间反弹过滤 */

// 两个低点之间没涨过 cap → 成链
const barsA = [{ close: 10 }];
const hjA = [
  { hj10: 30 }, { hj10: 20 }, { hj10: 10 }, { hj10: 12 },   // 低点2, 拐点3
  { hj10: 14 }, { hj10: 16 }, { hj10: 18 }, { hj10: 20 },   // 低点7, 拐点... 
];
const pairsA = [{ lowIndex: 2, turnIndex: 3 }, { lowIndex: 7, turnIndex: 8 }];
// 中间 12→20 涨到 20 < cap 25，应该成链
const cA = buildDivergenceChains(
  pairsA, hjA, Array.from({ length: 9 }, (_, i) => ({ close: 10 - i * 0.1 })),
  { minGap: 3, reboundCap: 25 },
);
check('中间未超 cap → 成链', cA.chains.length, 1);

// 中间涨过 cap → 断开
const hjB = [
  { hj10: 30 }, { hj10: 20 }, { hj10: 10 }, { hj10: 12 },
  { hj10: 45 }, { hj10: 40 }, { hj10: 30 }, { hj10: 20 },   // 中间涨到 45 > cap 25
];
const cB = buildDivergenceChains(
  [{ lowIndex: 2, turnIndex: 3 }, { lowIndex: 7, turnIndex: 8 }],
  hjB, Array.from({ length: 9 }, (_, i) => ({ close: 10 - i * 0.1 })),
  { minGap: 3, reboundCap: 25 },
);
check('中间超 cap → 不成链', cB.chains.length, 0);

/* ------------------------------------------- 3. 边界 */

const few = Array.from({ length: 10 }, (_, i) => ({
  date: '20261001', time: '09:45', open: 1, high: 1, low: 1, close: 1, amount: 1, volume: 1,
}));
check('数据不足拒绝', detectDivergence(few).matched, false);

/* ------------------------------------------- 4. 真实案例：603578 三星新材（应命中） */

const sz = readLc5As15Min('D:\\MyTools\\new_tdx\\vipdoc\\sh\\fzline\\sh603578.lc5');
const szHj = computeHJ(sz);

// 逐点核对用户给的数值
for (const [date, time, expHj, expClose] of [
  ['20261008', '14:45', 10.37, 13.78],
  ['20261008', '15:00', 18.17, 14.18],
  ['20261009', '11:30', 15.69, 13.27],
  ['20261009', '13:15', 16.22, 13.38],
]) {
  const idx = sz.findIndex((b) => b.date === date && b.time === time);
  checkTrue(
    `603578 ${date} ${time} HJ10=${expHj} 收=${expClose}`,
    Math.abs(szHj[idx].hj10 - expHj) < 0.005 && Math.abs(sz[idx].close - expClose) < 0.005,
    `实际 HJ10=${szHj[idx].hj10.toFixed(2)} 收=${sz[idx].close.toFixed(2)}`,
  );
}

// 注意：DIF 条件（1的DIF < 3的DIF）默认启用，而 603578 的 DIF1(-0.126) < DIF2(-0.209) 不成立，
// 所以默认参数下不再命中。这里关闭 DIF 单独验证「HJ10+价格」这两条核心判定。
const szHit = detectDivergence(sz, {
  threshold: 25, startDate: '20261008', endDate: '20261010', useDif: false,
});
checkTrue('603578 三星新材 命中底背离（关闭DIF）', szHit.matched);
if (szHit.matched) {
  check('低点数', szHit.chain.length, 2);
  const [low1, low2] = szHit.chain.map((n) => n.low);
  checkTrue('低点1 = 10-08 14:45', low1.datetime === '2026-10-08 14:45' && low1.hj10 === 10.37);
  checkTrue('低点2 = 10-09 11:30', low2.datetime === '2026-10-09 11:30' && low2.hj10 === 15.69);
  checkTrue('指标抬高', low2.hj10 > low1.hj10);
  checkTrue('价格新低', low2.close < low1.close);
}

// 默认参数（启用 DIF）下 603578 不命中，因为 DIF1 < DIF2 不成立，详见 test-dif.mjs
const szHitWithDif = detectDivergence(sz, { threshold: 25, startDate: '20261008', endDate: '20261010' });
checkTrue('603578 启用DIF后不命中', !szHitWithDif.matched, szHitWithDif.reason);

/* ------------------------------------------- 5. 真实案例：603679 华体科技（应排除） */

const ht = readLc5As15Min('D:\\MyTools\\new_tdx\\vipdoc\\sh\\fzline\\sh603679.lc5');
const htHj = computeHJ(ht);

// 11-02 10:00 低点后 HJ10 涨到 45.40，应被 reboundCap 挡住
const idx1103 = ht.findIndex((b) => b.date === '20261103' && b.time === '10:15');
checkTrue('603679 11-03 10:15 HJ10≈45.40（反弹证据）', Math.abs(htHj[idx1103].hj10 - 45.40) < 0.5,
  `实际 ${htHj[idx1103].hj10.toFixed(2)}`);

// 11-04 09:45 的低点左侧只跌 1 根（20.21→20.60 之间只有 15:00 的 21.51），应视为抖动
const idx1104 = ht.findIndex((b) => b.date === '20261104' && b.time === '09:45');
checkTrue('603679 11-04 09:45 低点存在', idx1104 > 0);

const htPairs = findTurnPairs(htHj, { threshold: 25, minDownBars: 2 })
  .filter((p) => ht[p.lowIndex].date >= '20261102');
const has1104 = htPairs.some((p) => ht[p.lowIndex].date === '20261104' && ht[p.lowIndex].time === '09:45');
check('603679 11-04 09:45 抖动低点被过滤', has1104, false);

// 加上反弹限制后不再命中
const htHit = detectDivergence(ht, {
  threshold: 25, startDate: '20261102', endDate: '20261104', reboundCap: 25,
});
checkTrue('603679 华体科技 不再命中', !htHit.matched, htHit.reason);

// 若放宽 reboundCap，11-02 那轮会被算进来（证明该规则确实起作用）
const htLoose = detectDivergence(ht, {
  threshold: 25, startDate: '20261102', endDate: '20261104', reboundCap: 999, minDownBars: 1,
});
checkTrue('放宽 reboundCap+minDownBars 后能命中（对照组）', htLoose.matched);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
