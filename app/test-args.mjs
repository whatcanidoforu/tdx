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

// 开关型参数现在也接受 =true/false（--no-dif 语义相反：true 表示关闭 DIF 条件）
const bad4 = parseArgs(['--no-dif=1']);
check('--no-dif=1 关闭DIF条件', bad4.useDif, false);
check('--no-dif=1 无错误', bad4.errors, undefined);
const bad5 = parseArgs(['--no-dif=false']);
check('--no-dif=false 保持DIF条件', bad5.useDif, true);
// 但非法取值仍要报错
const bad6 = parseArgs(['--no-dif=maybe']);
checkTrue('开关非法取值报错', Array.isArray(bad6.errors) && bad6.errors.length === 1,
  JSON.stringify(bad6.errors));

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

/* ------------------------------------- 7. 日线筛选条件（三态：null/true/false） */

const defaults = parseArgs([]);
check('不传参数时 dailyHj10Down 为 null', defaults.dailyHj10Down, null);
check('不传参数时 dailyMacdDown 为 null', defaults.dailyMacdDown, null);

// 三态核心：false 也是筛选条件，不是"关闭"
check('--daily-hj10-down=false（筛选不下降）', parseArgs(['--daily-hj10-down=false']).dailyHj10Down, false);
check('--daily-hj10-down=true（筛选下降）', parseArgs(['--daily-hj10-down=true']).dailyHj10Down, true);
check('--daily-macd-down=false', parseArgs(['--daily-macd-down=false']).dailyMacdDown, false);
check('--daily-macd-down=true', parseArgs(['--daily-macd-down=true']).dailyMacdDown, true);

// 大小写不敏感
check('大写 TRUE', parseArgs(['--daily-hj10-down=TRUE']).dailyHj10Down, true);
check('大写 False', parseArgs(['--daily-hj10-down=False']).dailyHj10Down, false);

// 数字写法
check('取值 1 视为 true', parseArgs(['--daily-hj10-down=1']).dailyHj10Down, true);
check('取值 0 视为 false', parseArgs(['--daily-hj10-down=0']).dailyHj10Down, false);

// 不带值视为 true（等同于 --daily-hj10-down=true）
check('不带值视为 true', parseArgs(['--daily-hj10-down']).dailyHj10Down, true);

// 非法值报错
const badDaily = parseArgs(['--daily-hj10-down=abc']);
checkTrue('非法取值被捕获', Array.isArray(badDaily.errors) && badDaily.errors.length === 1,
  JSON.stringify(badDaily.errors));

// 两个条件独立
const combo = parseArgs(['--daily-hj10-down=true', '--daily-macd-down=false']);
check('组合：HJ10=true MACD=false', [combo.dailyHj10Down, combo.dailyMacdDown], [true, false]);
const combo2 = parseArgs(['--daily-hj10-down=true', '--daily-macd-down=true']);
check('组合：两个都 true', [combo2.dailyHj10Down, combo2.dailyMacdDown], [true, true]);
const combo3 = parseArgs(['--daily-hj10-down=false', '--daily-macd-down=false']);
check('组合：两个都 false', [combo3.dailyHj10Down, combo3.dailyMacdDown], [false, false]);

// 只传一个时，另一个保持 null（表示不筛选）
const onlyHj = parseArgs(['--daily-hj10-down=true']);
check('只传HJ10时 MACD 为 null', [onlyHj.dailyHj10Down, onlyHj.dailyMacdDown], [true, null]);
const onlyMacd = parseArgs(['--daily-macd-down=false']);
check('只传MACD时 HJ10 为 null', [onlyMacd.dailyHj10Down, onlyMacd.dailyMacdDown], [null, false]);

// 不带值的 --daily-hj10-down 视为 true（已在上方验证），此处验证不带 -down 的旧名不可用
const oldStyle = parseArgs(['--daily-hj10']);
checkTrue('无 -down 后缀的形式不支持', Array.isArray(oldStyle.errors) && oldStyle.errors.length === 1,
  JSON.stringify(oldStyle.errors));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
