/**
 * 收益回测 —— 单元测试。
 *
 * 核心验证 603578 三星新材：
 *   买入 = 最后拐点 10-09 13:15 收盘 13.38
 *   T+0  = 买入后当日最高 13.79  → +3.06%
 *   T+1  = 10-12(周一) 最高 13.90 → +3.89%
 *   T+2  = 10-13 最高 14.91      → +11.43%
 */
import { backtestSignal, bucketOf, summarize } from './backtest.js';
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

/* ---------------------------------------------- 1. 真实案例 603578 */

const bars = readLc5As15Min('D:\\MyTools\\new_tdx\\vipdoc\\sh\\fzline\\sh603578.lc5');
const buyIdx = bars.findIndex((b) => b.date === '20261009' && b.time === '13:15');
checkTrue('找到买入K线 10-09 13:15', buyIdx > 0);

const perf = backtestSignal(bars, buyIdx);
checkTrue('回测有结果', perf !== null);
if (perf) {
  check('买入日', perf.buyDate, '20261009');
  check('买入时间', perf.buyTime, '13:15');
  check('买入价 = 拐点收盘 13.38', perf.buyPrice, 13.38);
  check('T+0 最高 13.79', perf.t0High, 13.79);
  check('T+0 收益 +3.06%', perf.t0, 3.06);
  check('T+1 最高 13.90（跳过周六）', perf.t1High, 13.9);
  check('T+1 收益 +3.89%', perf.t1, 3.89);
  check('T+2 最高 14.91', perf.t2High, 14.91);
  check('T+2 收益 +11.43%', perf.t2, 11.43);
}

/* ---------------------------------------------- 2. 边界：最后一天买入 */

const lastIdx = bars.length - 1;
const perfLast = backtestSignal(bars, lastIdx);
checkTrue('最后一天买入返回结果', perfLast !== null);
if (perfLast) {
  checkTrue('最后一天没有 T+1', perfLast.t1 === null, `实际 ${perfLast.t1}`);
  checkTrue('最后一天没有 T+2', perfLast.t2 === null);
}

/* ---------------------------------------------- 3. 分段 */

check('0.5% 落入 0~1 段', bucketOf(0.5)?.label, '0~1%');
check('1.5% 落入 1~2 段', bucketOf(1.5)?.label, '1~2%');
check('-0.5% 落入 -1~0 段', bucketOf(-0.5)?.label, '-1~0%');
check('-2.3% 落入 -3~-2 段', bucketOf(-2.3)?.label, '-3~-2%');
check('3.0% 落入 3~4 段', bucketOf(3.0)?.label, '3~4%');

/* ---------------------------------------------- 4. 汇总 */

const summary = summarize([
  { t0: 1.5, t1: 2.5, t2: -1.5 },
  { t0: 0.5, t1: 2.5, t2: null },
  { t0: -0.5, t1: null, t2: null },
]);
check('T+0 样本数', summary.t0.count, 3);
check('T+1 样本数', summary.t1.count, 2);
check('T+2 样本数', summary.t2.count, 1);
check('T+0 平均', summary.t0.avg, 0.5);
check('T+0 胜率 66.67%', summary.t0.winRate, 66.67);
check('T+0 最大', summary.t0.max, 1.5);
check('T+0 最小', summary.t0.min, -0.5);
checkTrue('T+0 分段有 0~1% 和 1~2%', summary.t0.buckets.length === 3,
  `实际 ${JSON.stringify(summary.t0.buckets.map((b) => b.label))}`);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
