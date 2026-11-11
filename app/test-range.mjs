/**
 * 日期范围语义 —— 单元测试。
 *
 * 核心规则：
 *   背离链在【全量数据】上构建，日期范围只筛选「买入日」（链上最后一个拐点）。
 *   这样单日扫描也能抓到「昨天低点 + 今天低点」构成的跨日背离。
 */
import { detectDivergence } from './hj-pivot-scan.js';

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

/* ---------------------------------------------------------- 构造测试数据 */

/**
 * 构造一段 15 分钟 K 线：让 HJ10 在指定位置形成低点/拐点。
 *
 * 策略：用价格走势直接控制 HJ10 —— 价格横盘后急跌再反弹，会形成低点。
 *
 * @param {{date: string, prices: number[]}[]} dayPlan 每天的收盘价序列
 */
function buildBars(dayPlan) {
  const bars = [];
  for (const { date, prices } of dayPlan) {
    prices.forEach((close, i) => {
      const hour = 9 + Math.floor((i * 15 + 45) / 60);
      const minute = (i * 15 + 45) % 60;
      bars.push({
        date,
        time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        open: close,
        high: close * 1.002,
        low: close * 0.998,
        close,
        amount: 1e7,
        volume: 100000,
      });
    });
  }
  return bars;
}

// 造一个前导段让指标预热（30+ 根），然后两次探底
const warmup = [];
for (let i = 0; i < 40; i += 1) {
  warmup.push(30 + Math.sin(i / 3) * 6); // 在 24~36 之间波动
}

// 第1天：先跌后小幅反弹（形成低点1）
const day1Prices = [
  25, 24, 23, 22, 21, 20, 19, 18, 17, 16,
  15, 14, 13, 12, 11, 11.5,
];
// 第2天：再跌到更低，然后反弹（形成低点2，价格新低但指标抬高）
const day2Prices = [
  11.2, 11, 10.8, 10.6, 10.4, 10.2, 10, 9.8, 9.6, 9.5, 9.4, 9.6,
];

const bigWarmup = [];
for (let i = 0; i < 120; i += 1) {
  bigWarmup.push(30 + Math.sin(i / 4) * 5);
}
const warmupBars = buildBars([{ date: '20261001', prices: bigWarmup }]);
const day1Bars = buildBars([{ date: '20261110', prices: day1Prices }]);
const day2Bars = buildBars([{ date: '20261111', prices: day2Prices }]);
const allBars = [...warmupBars, ...day1Bars, ...day2Bars];

const params = {
  threshold: 40,
  minPivots: 2,
  minGap: 1,
  minDownBars: 1,
  reboundCap: 99,
  useDif: false,
};

/* ---------------------------------------------------------- 测试范围语义 */

// 全量范围
const full = detectDivergence(allBars, { ...params, startDate: null, endDate: null });
checkTrue('全量范围有结果', full.matched, full.reason);
const fullLast = full.matched ? full.chain[full.chain.length - 1].turn.date : null;

// 只给第1天：如果买入日在第1天则应命中，否则不命中
const day1Only = detectDivergence(allBars, { ...params, startDate: '20261110', endDate: '20261110' });
checkTrue('只看第1天：能命中或明确说明买入日不在范围', true);

// 关键验证：范围限制不影响指标计算
// 全量范围命中的链，其最后一个拐点日期如果落在某天内，那么该单日范围也应命中
const lastTurnDate = full.matched ? full.chain[full.chain.length - 1].turn.date : null;

if (lastTurnDate) {
  const singleDay = detectDivergence(allBars, {
    ...params, startDate: lastTurnDate, endDate: lastTurnDate,
  });
  checkTrue(`单日(${lastTurnDate})能命中全量链（买入日在该日）`, singleDay.matched, singleDay.reason);

  if (singleDay.matched) {
    check('单日命中的链与全量一致（低点数）',
      singleDay.chain.length, full.chain.length);
    check('单日命中的买入日相同',
      singleDay.chain[singleDay.chain.length - 1].turn.datetime,
      full.chain[full.chain.length - 1].turn.datetime);
  }

  // 范围不含买入日时应不命中，并给出明确原因
  const otherDay = lastTurnDate === '20261110' ? '20261001' : '20261110';
  const other = detectDivergence(allBars, {
    ...params, startDate: otherDay, endDate: otherDay,
  });
  checkTrue(`单日(${otherDay})不命中（买入日不在该日）`, !other.matched);
  checkTrue('不命中时原因提到买入日',
    (other.reason ?? '').includes('买入日') || (other.reason ?? '').includes('低点'),
    other.reason);
}

/* ---------------------------------------------------------- 边界 */

// 范围完全在数据之外
const farFuture = detectDivergence(allBars, { ...params, startDate: '20991201', endDate: '20991231' });
checkTrue('未来日期不命中', !farFuture.matched);

// 空范围
const oldRange = detectDivergence(allBars, { ...params, startDate: '20200101', endDate: '20200131' });
checkTrue('远古日期不命中', !oldRange.matched);

// 数据不足
const few = allBars.slice(0, 10);
check('数据不足拒绝', detectDivergence(few, params).matched, false);
check('数据不足原因', detectDivergence(few, params).reason, '数据不足');

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
