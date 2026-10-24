/**
 * HJ 副图 ECharts 配置（通达信公式可视化）
 *
 * 对应原公式的三块可见内容：
 *   1. STICKLINE(HJ_10>HJ_11,HJ_10,HJ_11,3,1),COLORRED;
 *      STICKLINE(HJ_10<=HJ_11,HJ_10,HJ_11,3,1),COLOR000000;
 *      —— 用“透明堆叠柱 + 差值柱”复刻两线之间的柱子，红=快线在上。
 *   2. 顶:80 / 底:20 / 中:50 三条水平参考线（中轨 50 为黄色）。
 *   3. DRAWTEXT(...,0,'+'/'-') 加速/减速标记，画在 y=0：
 *      加速度变化>0 且 加速值>100 → 红色 '+'
 *      加速度变化<0 且 加速值>100 → 绿色 '-'
 *      加速度变化>0 且 加速值<100 → 绿色 '+'
 *      加速度变化<0 且 加速值<100 → 绿色 '-'
 *      accelLabel 的 '+R' / '-G' / '+G' / '-G' 即上述四种状态。
 */

/** 三条水平参考线：值、名称、颜色（暗色主题下用可读色替代原式黑色）。 */
const GUIDE_LINES = [
  { value: 80, name: '顶', color: '#ef5350' },
  { value: 50, name: '中', color: '#d29922' },
  { value: 20, name: '底', color: '#3fb950' },
];

/** accelLabel 后缀 → 文字颜色：R=红，G=绿。 */
const ACCEL_COLORS = { R: '#f85149', G: '#3fb950' };

/**
 * 构建 HJ 副图的 ECharts option。
 * @param {{rows: Array<{date: string, hj10: number|null, hj11: number|null, accelLabel?: string|null}>}} data
 * @returns {object|null}
 */
export function buildHjOption(data) {
  const rows = data?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const dates = rows.map((row) => row.date);
  const hj10 = rows.map((row) => row.hj10);
  const hj11 = rows.map((row) => row.hj11);

  const N = rows.length;
  const baseData = new Array(N);
  const diffData = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = hj10[i];
    const b = hj11[i];
    if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) {
      baseData[i] = null;
      diffData[i] = null;
    } else {
      baseData[i] = Math.min(a, b);
      diffData[i] = Math.abs(a - b);
    }
  }

  // DRAWTEXT：每根满足条件的 K 线在 y=0 放一个 '+' / '-'，颜色按原式。
  const accelPoints = [];
  for (let i = 0; i < N; i++) {
    const flag = rows[i].accelLabel;
    if (!flag) continue;
    const sign = flag[0];
    const tone = flag[1];
    accelPoints.push({
      value: [i, 0],
      text: sign,
      label: { color: ACCEL_COLORS[tone] ?? ACCEL_COLORS.G },
    });
  }

  return {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: '#58a6ff', type: 'dashed', width: 1 } },
      backgroundColor: 'rgba(22,27,34,0.95)',
      borderColor: '#30363d',
      textStyle: { color: '#e6edf3', fontSize: 12 },
    },
    grid: { left: '8%', right: '5%', top: '5%', bottom: '10%' },
    dataZoom: [{ type: 'inside', xAxisIndex: 0, start: 0, end: 100 }],
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: true,
      axisLine: { lineStyle: { color: '#30363d' } },
      axisLabel: { color: '#8b949e', fontSize: 10 },
      axisTick: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      min: 0,
      max: 100,
      axisLine: { lineStyle: { color: '#30363d' } },
      axisLabel: { color: '#8b949e', fontSize: 10 },
      splitLine: { lineStyle: { color: '#21262d' } },
    },
    series: [
      {
        name: 'Placeholder',
        type: 'bar',
        stack: 'Total',
        data: baseData,
        barWidth: '70%',
        itemStyle: {
          borderColor: 'transparent',
          color: 'transparent',
        },
        emphasis: {
          itemStyle: {
            borderColor: 'transparent',
            color: 'transparent',
          },
        },
      },
      {
        name: 'HJ',
        type: 'bar',
        stack: 'Total',
        data: diffData,
        barWidth: '70%',
        itemStyle: {
          color: function (p) {
            const a = hj10[p.dataIndex];
            const b = hj11[p.dataIndex];
            if (a == null || b == null) return 'transparent';
            return a > b ? '#ef5350' : '#3fb950';
          },
        },
        markLine: {
          silent: true,
          symbol: 'none',
          animation: false,
          label: {
            show: true,
            position: 'insideEndTop',
            formatter: '{b}{c}',
            fontSize: 9,
          },
          data: GUIDE_LINES.map(({ value, name, color }) => ({
            yAxis: value,
            name,
            lineStyle: { color, type: 'dashed', width: 1, opacity: 0.55 },
            label: { color },
          })),
        },
      },
      {
        name: '加速标记',
        type: 'scatter',
        data: accelPoints,
        symbol: 'circle',
        symbolSize: 1,
        itemStyle: { color: 'transparent' },
        label: {
          show: true,
          position: 'top',
          distance: 0,
          fontSize: 11,
          fontWeight: 700,
          formatter: (p) => p.data.text,
        },
        clip: false,
        silent: true,
        tooltip: { show: false },
        z: 10,
      },
    ],
  };
}
