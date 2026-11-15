/**
 * 验证「最近交易日」推算。
 */
import { resolveTradingDate } from './intraday-monitor.mjs';

const cases = [
  [new Date(2026, 10, 15), '2026-11-15 周日', '2026-11-13'],
  [new Date(2026, 10, 16), '2026-11-16 周一', '2026-11-16'],
  [new Date(2026, 10, 17), '2026-11-17 周二', '2026-11-17'],
  [new Date(2026, 10, 20), '2026-11-20 周五', '2026-11-20'],
  [new Date(2026, 10, 21), '2026-11-21 周六', '2026-11-20'],
  [new Date(2026, 10, 22), '2026-11-22 周日', '2026-11-20'],
  [new Date(2026, 10, 23), '2026-11-23 周一', '2026-11-23'],
];

let pass = 0;
let fail = 0;
for (const [date, label, expected] of cases) {
  const result = resolveTradingDate(date);
  const ok = result.dateDash === expected;
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? '✔' : '✘'} ${label.padEnd(18)} → ${result.dateDash}`
    + `  (isToday=${result.isToday})${ok ? '' : `  期望 ${expected}`}`);
}

console.log('');
console.log(`结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
