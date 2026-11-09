/**
 * 混合数据源 + K 线解析 —— 单元测试。
 *
 * 覆盖：
 *   1. mergeBars 合并逻辑（实时覆盖、本地保留、时间排序）
 *   2. parseBars 价格差分解码
 *   3. decodeVolume 成交量解码
 *   4. 实时数据与本地数据一致性（真实数据）
 */
import { mergeBars } from './hybrid-source.js';
import { parseBars, decodeVolume, buildBarsRequest, PERIOD } from './market-bars.js';

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

/* ---------------------------------------- 1. mergeBars */

const local = [
  { date: '20261106', time: '14:45', close: 10.04 },
  { date: '20261106', time: '15:00', close: 10.03 },
];
const tail = [
  { date: '20261106', time: '15:00', close: 10.03 },
  { date: '20261109', time: '09:45', close: 10.01 },
];

const merged = mergeBars(local, tail);
check('合并后根数', merged.length, 3);
check('末根是今天', `${merged[merged.length - 1].date} ${merged[merged.length - 1].time}`, '20261109 09:45');
checkTrue('按时间升序', merged[0].date === '20261106' && merged[0].time === '14:45');

// 实时覆盖本地同键
const local2 = [{ date: '20261109', time: '09:45', close: 9.99 }];
const tail2 = [{ date: '20261109', time: '09:45', close: 10.01 }];
const merged2 = mergeBars(local2, tail2);
check('实时覆盖同键', merged2.length, 1);
check('覆盖后的值', merged2[0].close, 10.01);

// 空数据
check('本地为空返回实时', mergeBars([], tail).length, 2);
check('实时为空返回本地', mergeBars(local, []).length, 2);
check('都为空', mergeBars([], []).length, 0);

/* ---------------------------------------- 2. 请求帧 */

const req = buildBarsRequest({ market: 1, code: '600000', category: PERIOD.MIN15, start: 0, count: 10 });
check('请求帧长度', req.length, 38);
check('帧头命令字', req.readUInt16LE(10), 0x052d);
check('帧头市场', req.readUInt16LE(12), 1);
check('代码', req.toString('latin1', 14, 20), '600000');
check('周期15分钟', req.readUInt16LE(20), 1);
check('数量', req.readUInt16LE(26), 10);

/* ---------------------------------------- 3. 成交量解码 */

// getVolume 的典型值：小成交量
checkTrue('decodeVolume 返回有限数', Number.isFinite(decodeVolume(1271433242)));
checkTrue('decodeVolume 非负', decodeVolume(1271433242) >= 0);

/* ---------------------------------------- 4. 解析真实应答 */

// 用之前抓到的真实应答体验证
const realHex = '0a0052b4b2028a9b0128324a2025214a1a88c84b52b41b03004a145418f9894af5ea2b4c52b42a0300323c4a909e644adec50e4c52b43903000a0a4ab0634d4a9d73004c52b448034a1e2800e085944a503a3a4c52b4570300141454e0696c4a065a144c52b4660354001e4a80293f4a482cf04b52b475034a0a280000c46a4a8f7f134c52b484030a540a54784da34ae2f74c4c55b44902000000000000000000000000';
const bars = parseBars(Buffer.from(realHex, 'hex'), { category: PERIOD.MIN15 });
check('解析出10根', bars.length, 10);
check('首根日期', bars[0].date, '20261106');
check('首根时间', bars[0].time, '11:30');
// 这批抓取时已包含次日 09:45 的实时 K 线
check('末根是次日的 09:45', `${bars[bars.length - 1].date} ${bars[bars.length - 1].time}`, '20261109 09:45');
checkTrue('价格合理（8~12元区间）', bars.every((b) => b.close > 8 && b.close < 12),
  `实际 ${bars.map((b) => b.close).join(',')}`);
checkTrue('OHLC 关系正确', bars.every((b) => b.high >= b.low && b.high >= b.open && b.high >= b.close && b.low <= b.open && b.low <= b.close));

// 11-06 那天应覆盖 11:30 到 15:00
const day1106 = bars.filter((b) => b.date === '20261106');
check('11-06 有 9 根', day1106.length, 9);
check('11-06 首根', day1106[0].time, '11:30');
check('11-06 末根', day1106[day1106.length - 1].time, '15:00');

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
