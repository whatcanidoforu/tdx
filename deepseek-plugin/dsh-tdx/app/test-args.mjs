/**
 * 命令行参数解析 —— 单元测试。
 *
 * 重点覆盖：
 *   1. 短参数（--th/--md/--rc）能被正确识别
 *   2. 长参数（--threshold/--min-down/--rebound-cap）同样有效
 *   3. 未知参数会报错，不再静默忽略
 *   4. 文件名能反映真实参数
 */
import { parseArgs, buildFileBaseName, describeParams } from './hj-pivot-scanner.mjs';

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

/* ------------------------------------- 1. 短参数 */

const short = parseArgs(['--start=2026-07-16', '--end=2026-11-06', '--th=10', '--md=1', '--rc=15', '--no-dif']);
check('短参数 threshold', short.threshold, 10);
check('短参数 minDownBars', short.minDownBars, 1);
check('短参数 reboundCap', short.reboundCap, 15);
check('短参数 no-dif', short.useDif, false);
check('短参数 startDate', short.startDate, '20260716');
check('短参数 endDate', short.endDate, '20261106');
check('短参数无错误', short.errors, undefined);

/* ------------------------------------- 2. 长参数 */

const long = parseArgs([
  '--threshold=20', '--min-down=3', '--rebound-cap=30',
  '--min-pivots=4', '--min-gap=5', '--min-rise=10', '--min-drop=2',
]);
check('长参数 threshold', long.threshold, 20);
check('长参数 minDownBars', long.minDownBars, 3);
check('长参数 reboundCap', long.reboundCap, 30);
check('长参数 minPivots', long.minPivots, 4);
check('长参数 minGap', long.minGap, 5);
check('长参数 minTotalRise', long.minTotalRise, 10);
check('长参数 minDropPct', long.minDropPct, 2);

/* ------------------------------------- 3. 短长参数等价 */

const a = parseArgs(['--th=12', '--md=2', '--rc=18']);
const b = parseArgs(['--threshold=12', '--min-down=2', '--rebound-cap=18']);
check('短长参数等价 threshold', a.threshold, b.threshold);
check('短长参数等价 minDownBars', a.minDownBars, b.minDownBars);
check('短长参数等价 reboundCap', a.reboundCap, b.reboundCap);

/* ------------------------------------- 4. 未知参数报错 */

const bad = parseArgs(['--th=10', '--badopt=5']);
checkTrue('未知参数被捕获', Array.isArray(bad.errors) && bad.errors.length === 1);
checkTrue('错误信息含参数名', (bad.errors?.[0] ?? '').includes('badopt'));

const bad2 = parseArgs(['start=20260716']);
checkTrue('缺少 -- 前缀被捕获', Array.isArray(bad2.errors) && bad2.errors.length === 1);

const bad3 = parseArgs(['--th']);
checkTrue('缺值被捕获', Array.isArray(bad3.errors) && bad3.errors.length === 1);

const bad4 = parseArgs(['--no-dif=1']);
checkTrue('开关参数不接受取值', Array.isArray(bad4.errors) && bad4.errors.length === 1);

/* ------------------------------------- 5. 文件名反映参数 */

const name = buildFileBaseName(short, short.startDate, short.endDate);
checkTrue('文件名含日期范围', name.includes('20260716-20261106'), name);
checkTrue('文件名含阈值', name.includes('th10'), name);
checkTrue('文件名含连跌', name.includes('md1'), name);
checkTrue('文件名含反弹上限', name.includes('rc15'), name);
checkTrue('文件名含 nodif', name.includes('nodif'), name);
checkTrue('文件名不含默认值25', !name.includes('th25'), name);

const nameDefault = buildFileBaseName(parseArgs([]), '20260101', null);
checkTrue('默认参数文件名为 th25_md2_rc25_dif', nameDefault.includes('th25_md2_rc25_dif'), nameDefault);

/* ------------------------------------- 6. 参数描述 */

const desc = describeParams(short, short.startDate, short.endDate);
checkTrue('描述里有时间范围', desc.some(([k]) => k === '时间范围'));
checkTrue('描述里有 DIF 关闭', desc.some(([k, v]) => k === 'DIF条件' && v.includes('关闭')));
checkTrue('描述里有阈值 10', desc.some(([k, v]) => k === 'HJ10低点阈值' && v.startsWith('10')));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
