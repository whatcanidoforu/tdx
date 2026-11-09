/**
 * ETF 支持与流动性过滤 —— 单元测试。
 *
 * 覆盖：
 *   1. 标的分类（股票 / ETF / 排除）
 *   2. 价格还原倍数
 *   3. 流动性过滤逻辑
 *   4. 真实 ETF 数据处理
 */
import { classifySecurity, SECURITY_KIND, priceScale, kindLabel } from './security-type.js';
import { checkLiquidity, listKlineFiles, readKlineFile } from './hj-pivot-scanner.mjs';
import { resolvePeriod } from './period.js';

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

/* ------------------------------- 1. 分类 */

check('588200 是 ETF', classifySecurity('sh', '588200'), SECURITY_KIND.ETF);
check('520980 是 ETF', classifySecurity('sh', '520980'), SECURITY_KIND.ETF);
check('510300 是 ETF', classifySecurity('sh', '510300'), SECURITY_KIND.ETF);
check('560010 是 ETF', classifySecurity('sh', '560010'), SECURITY_KIND.ETF);
check('159915 是 ETF', classifySecurity('sz', '159915'), SECURITY_KIND.ETF);
check('600000 是股票', classifySecurity('sh', '600000'), SECURITY_KIND.STOCK);
check('688981 是股票', classifySecurity('sh', '688981'), SECURITY_KIND.STOCK);
check('000001 是股票', classifySecurity('sz', '000001'), SECURITY_KIND.STOCK);
check('510050 是ETF', classifySecurity('sh', '510050'), SECURITY_KIND.ETF);
check('sh000001 是指数(排除)', classifySecurity('sh', '000001'), null);
check('sh113050 是债券(排除)', classifySecurity('sh', '113050'), null);
check('sz123456 是债券(排除)', classifySecurity('sz', '123456'), null);
check('非法代码', classifySecurity('sh', '12345'), null);

/* ------------------------------- 2. 价格倍数 */

check('ETF 价格倍数', priceScale(SECURITY_KIND.ETF), 10);
check('股票价格倍数', priceScale(SECURITY_KIND.STOCK), 1);
check('ETF 标签', kindLabel(SECURITY_KIND.ETF), 'ETF');
check('股票标签', kindLabel(SECURITY_KIND.STOCK), '股票');

/* ------------------------------- 3. 流动性过滤 */

const makeBars = (amounts) => amounts.map((amount, i) => ({ date: `2026110${i}`, amount }));

check('无门槛全部通过', checkLiquidity(makeBars([1]), 0).pass, true);
check('达标通过', checkLiquidity(makeBars([2e7, 2e7, 2e7]), 1e7).pass, true);
check('不达标拦截', checkLiquidity(makeBars([1e6, 1e6, 1e6]), 1e7).pass, false);
check('空数据拦截', checkLiquidity([], 1e7).pass, false);
check('平均值计算', Math.round(checkLiquidity(makeBars([2e7, 4e7]), 1e7).avgAmount), 3e7);
check('只看最近N根', checkLiquidity(makeBars([1e9, 1e6, 1e6, 1e6]), 1e7, 2).pass, false);

/* ------------------------------- 4. 文件枚举 */

const p15 = resolvePeriod('15');
const withETF = listKlineFiles('D:\\MyTools\\new_tdx', 'sh', p15, { includeETF: true });
const withoutETF = listKlineFiles('D:\\MyTools\\new_tdx', 'sh', p15, { includeETF: false });

checkTrue('不含ETF时排除588200', !withoutETF.some((f) => f.code === '588200'));
checkTrue('含ETF时能找到588200', withETF.some((f) => f.code === '588200'));
checkTrue('含ETF时文件更多', withETF.length > withoutETF.length,
  `${withoutETF.length} vs ${withETF.length}`);
checkTrue('股票数量不变',
  withETF.filter((f) => f.kind === SECURITY_KIND.STOCK).length === withoutETF.length);

const etfFiles = withETF.filter((f) => f.kind === SECURITY_KIND.ETF);
checkTrue('识别出 ETF 文件', etfFiles.length > 100, `实际 ${etfFiles.length}`);

/* ------------------------------- 5. 真实 ETF 数据 */

for (const code of ['588200', '520980']) {
  const entry = withETF.find((f) => f.code === code);
  checkTrue(`找到 ${code}`, Boolean(entry));
  if (!entry) continue;
  const bars = readKlineFile(entry.file, p15);
  checkTrue(`${code} 有15分钟数据`, bars.length > 100, `实际 ${bars.length}`);
  checkTrue(`${code} 价格在合理区间（0.1~50）`,
    bars.every((b) => b.close > 0.1 && b.close < 50),
    `范围 ${Math.min(...bars.map((b) => b.close)).toFixed(3)}~${Math.max(...bars.map((b) => b.close)).toFixed(3)}`);
  checkTrue(`${code} OHLC 关系正确`,
    bars.every((b) => b.high >= b.low && b.high >= b.close && b.low <= b.close));
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
