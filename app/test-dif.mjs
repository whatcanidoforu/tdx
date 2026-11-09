/**
 * MACD DIF 条件 —— 单元测试。
 *
 * 验证：
 *   1. MACD 计算正确
 *   2. DIF 条件（前低点 DIF < 后低点 DIF）生效
 *   3. 三星新材因 DIF 不满足而被排除（对照组证明）
 */
import { computeMacd, ema } from './macd.js';
import { detectDivergence } from './hj-pivot-scan.js';
import { readLc5As15Min } from './lc5-reader.js';

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

/* ---------------------------------------------- 1. EMA 与 MACD */

// EMA 首值 = 首元素，之后递推
const e = ema([10, 11, 12], 2);
check('EMA 首值', e[0], 10);
checkTrue('EMA 递推正确', Math.abs(e[1] - (11 * (2 / 3) + 10 / 3)) < 1e-9);

// 价格单调上涨时 DIF 应为正
const rising = Array.from({ length: 60 }, (_, i) => 10 + i * 0.1);
const macdUp = computeMacd(rising);
checkTrue('单调上涨 DIF > 0', macdUp.dif[59] > 0, `实际 ${macdUp.dif[59]}`);

// 价格单调下跌时 DIF 应为负
const falling = Array.from({ length: 60 }, (_, i) => 20 - i * 0.1);
const macdDown = computeMacd(falling);
checkTrue('单调下跌 DIF < 0', macdDown.dif[59] < 0, `实际 ${macdDown.dif[59]}`);

// DIF/DEA/MACD 长度一致
check('DIF 长度', macdUp.dif.length, 60);
check('DEA 长度', macdUp.dea.length, 60);
check('MACD 长度', macdUp.macd.length, 60);

/* ---------------------------------------------- 2. 真实案例：三星新材 */

const bars = readLc5As15Min('D:\\MyTools\\new_tdx\\vipdoc\\sh\\fzline\\sh603578.lc5');
const { dif } = computeMacd(bars.map((b) => b.close));

const i1 = bars.findIndex((b) => b.date === '20261008' && b.time === '14:45');
const i3 = bars.findIndex((b) => b.date === '20261009' && b.time === '11:30');

checkTrue('找到低点1', i1 > 0);
checkTrue('找到低点2', i3 > 0);
checkTrue(`低点1 DIF ≈ -0.126（实际 ${dif[i1].toFixed(3)}）`, Math.abs(dif[i1] + 0.126) < 0.01);
checkTrue(`低点2 DIF ≈ -0.209（实际 ${dif[i3].toFixed(3)}）`, Math.abs(dif[i3] + 0.209) < 0.01);
// 用户条件：1的DIF < 3的DIF。这里 -0.126 < -0.209 为假
checkTrue('DIF1 < DIF2 不成立（-0.126 不小于 -0.209）', !(dif[i1] < dif[i3]));

// 因此启用 DIF 条件后不命中
const withDif = detectDivergence(bars, {
  threshold: 25, startDate: '20261008', endDate: '20261010', useDif: true,
});
checkTrue('启用 DIF 后 603578 不命中', !withDif.matched, withDif.reason);

// 关闭 DIF 条件后能命中（对照组）
const withoutDif = detectDivergence(bars, {
  threshold: 25, startDate: '20261008', endDate: '20261010', useDif: false,
});
checkTrue('关闭 DIF 后 603578 命中（对照组）', withoutDif.matched);

/* ---------------------------------------------- 3. 满足 DIF 条件的真实案例 */

const bars2 = readLc5As15Min('D:\\MyTools\\new_tdx\\vipdoc\\bj\\fzline\\bj920138.lc5');
const hit2 = detectDivergence(bars2, { threshold: 25, startDate: '20260918', useDif: true });
checkTrue('bj920138 满足 DIF 条件并命中', hit2.matched, hit2.reason);
if (hit2.matched) {
  const difs = hit2.chain.map((n) => n.low.dif);
  checkTrue('链上 DIF 值都有', difs.every((d) => d !== null));
  let monotone = true;
  for (let i = 1; i < difs.length; i += 1) {
    if (!(difs[i] > difs[i - 1])) monotone = false;
  }
  checkTrue(`链上 DIF 逐级抬高（${difs.join(' → ')}）`, monotone);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
