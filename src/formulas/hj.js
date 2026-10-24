/**
 * HJ 指标公式
 *
 * 原通达信公式:
 *   HJ_1:=(CLOSE-LLV(LOW,20))/(HHV(HIGH,20)-LLV(LOW,20))*100;
 *   HJ_2:=SMA(SMA(HJ_1,3,1),3,1)/28.57;
 *   HJ_3:=EMA(HJ_2,5);
 *   HJ_4:=3*HJ_2-2*HJ_3;
 *   HJ_5:=CROSS(HJ_4,HJ_2) AND HJ_2<2.1 AND CLOSE>OPEN;
 *   HJ_7:=(2*CLOSE+HIGH+LOW)/4;
 *   HJ_8:=LLV(LOW,13);
 *   HJ_9:=HHV(HIGH,13);
 *   HJ_10:=EMA((HJ_7-HJ_8)/(HJ_9-HJ_8)*100,13);
 *   HJ_11:=EMA(0.667*REF(HJ_10,1)+0.333*HJ_10,2);
 *   加速值:=HJ_10/REF(HJ_10,1)*100;
 *   加速度变化:=加速值-REF(加速值,1);
 *
 * 返回:
 *   hj10 / hj11     主振荡线及信号线
 *   h5              买入信号(0/1)
 *   buyMarker       买入标记(买入日为1)
 *   accelLabel      加速标记('+','-',null)
 */

import {
  col, LLV, HHV, EMA, SMA, REF, CROSS, MAX, ABS,
  mul, add, sub, div, gt, IF,
} from './engine.js';

export function computeHJ(rows) {
  const CLOSE = col(rows, 'close');
  const OPEN = col(rows, 'open');
  const HIGH = col(rows, 'high');
  const LOW = col(rows, 'low');
  const LEN = rows.length;

  const out = new Array(LEN);

  // HJ_7:=(2*CLOSE+HIGH+LOW)/4;
  const HJ_7 = div(add(add(mul(CLOSE, 2), HIGH), LOW), 4);

  // HJ_8:=LLV(LOW,13);
  const HJ_8 = LLV(LOW, 13);

  // HJ_9:=HHV(HIGH,13);
  const HJ_9 = HHV(HIGH, 13);

  // HJ_10:=EMA((HJ_7-HJ_8)/(HJ_9-HJ_8)*100,13);
  const denom = sub(HJ_9, HJ_8);
  const ratio = div(sub(HJ_7, HJ_8), denom);
  const hj10Raw = ratio.map((v, i) => {
    if (isNaN(v) || denom[i] === 0) return 50;
    return v * 100;
  });
  const HJ_10 = EMA(hj10Raw, 13);

  // HJ_11:=EMA(0.667*REF(HJ_10,1)+0.333*HJ_10,2);
  const refHj10 = REF(HJ_10, 1);
  const hj11Raw = add(mul(refHj10, 0.667), mul(HJ_10, 0.333));
  const HJ_11 = EMA(hj11Raw, 2);

  // HJ_1:=(CLOSE-LLV(LOW,20))/(HHV(HIGH,20)-LLV(LOW,20))*100;
  const LLV_20 = LLV(LOW, 20);
  const HHV_20 = HHV(HIGH, 20);
  const denom20 = sub(HHV_20, LLV_20);
  const ratio20 = div(sub(CLOSE, LLV_20), denom20);
  const HJ_1 = ratio20.map((v, i) => {
    if (isNaN(v) || denom20[i] === 0) return 50;
    return v * 100;
  });

  // HJ_2:=SMA(SMA(HJ_1,3,1),3,1)/28.57;
  const HJ_2 = mul(SMA(SMA(HJ_1, 3, 1), 3, 1), 1 / 28.57);

  // HJ_3:=EMA(HJ_2,5);
  const HJ_3 = EMA(HJ_2, 5);

  // HJ_4:=3*HJ_2-2*HJ_3;
  const HJ_4 = sub(mul(HJ_2, 3), mul(HJ_3, 2));

  // HJ_5:=CROSS(HJ_4,HJ_2) AND HJ_2<2.1 AND CLOSE>OPEN;
  const HM5 = CROSS(HJ_4, HJ_2);
  const cond5 = HM5.map((v, i) => v && HJ_2[i] < 2.1 && CLOSE[i] > OPEN[i] ? 1 : 0);

  // 加速值:=HJ_10/REF(HJ_10,1)*100;
  const 加速值 = mul(div(HJ_10, REF(HJ_10, 1)), 100);

  // 加速度变化:=加速值-REF(加速值,1);
  const ref加速值 = REF(加速值, 1);
  const 加速度变化 = sub(加速值, ref加速值);

  for (let i = 0; i < LEN; i++) {
    const acc = 加速值[i];
    const accChg = 加速度变化[i];

    let accelLabel = null;
    if (!isNaN(accChg) && !isNaN(acc)) {
      if (accChg > 0 && acc > 100) accelLabel = '+R';        // 上涨加速, 红色+
      else if (accChg < 0 && acc > 100) accelLabel = '-G';    // 上涨减速, 绿色-
      else if (accChg > 0 && acc < 100) accelLabel = '+G';    // 下跌减缓, 绿色+
      else if (accChg < 0 && acc < 100) accelLabel = '-G';    // 下跌加速, 绿色-
    }

    out[i] = {
      hj10: HJ_10[i] ?? null,
      hj11: HJ_11[i] ?? null,
      hj5: cond5[i] ?? 0,
      accelLabel,
    };
  }

  return out;
}