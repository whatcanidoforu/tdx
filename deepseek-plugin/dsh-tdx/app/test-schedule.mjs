/**
 * 调度逻辑单元测试 —— 不需要真实时间，纯函数验证。
 */
import { nextCheckpoint, DEFAULT_TIMES } from './loss-scanner.mjs';

const cases = [
  ['08:00:00', '09:30'],
  ['09:30:00', '09:45'],   // 刚好到点应推到下一个
  ['09:30:01', '09:45'],
  ['11:30:00', '13:15'],   // 午休跳过
  ['12:00:00', '13:15'],
  ['14:45:30', '15:00'],
  ['15:00:01', null],      // 收盘后没有下一个
  ['23:00:00', null],
];

let pass = 0;
let fail = 0;
for (const [time, expect] of cases) {
  const [h, m, s] = time.split(':').map(Number);
  const now = new Date(2026, 10, 6, h, m, s);
  const next = nextCheckpoint([...DEFAULT_TIMES], now);
  const actual = next?.label ?? null;
  const ok = actual === expect;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? '✔' : '✘'} ${time} -> ${actual ?? 'null'}（期望 ${expect ?? 'null'}）`);
}

// 验证检查点覆盖
const need = ['09:30', '09:45', '10:00', '10:15', '10:30', '10:45',
  '11:00', '11:15', '11:30', '13:15', '13:30', '13:45',
  '14:00', '14:15', '14:30', '14:45', '15:00'];
const missing = need.filter((t) => !DEFAULT_TIMES.includes(t));
console.log(`\n检查点总数 ${DEFAULT_TIMES.length}，缺少：${missing.length ? missing.join(',') : '无'}`);

// 验证跳过的午休时段
const badTimes = DEFAULT_TIMES.filter((t) => {
  const [h, m] = t.split(':').map(Number);
  const minutes = h * 60 + m;
  return minutes > 11 * 60 + 30 && minutes < 13 * 60 + 15;
});
console.log(`午休时段被误加的检查点：${badTimes.length ? badTimes.join(',') : '无'}`);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 && missing.length === 0 && badTimes.length === 0 ? 0 : 1);
