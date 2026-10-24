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
 *
 * 底部另有一条 ECharts 原生 slider 缩放条，与 inside 缩放共用同一 x 轴。
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

  // HJ_5 买点：柱顶上方一个橙色三角 + 'B'，信号稀疏，不挤占底部加速文字。
  const hj5Points = [];
  for (let i = 0; i < N; i++) {
    const row = rows[i];
    if (!row.hj5) continue;
    const a = row.hj10;
    const b = row.hj11;
    if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) continue;
    hj5Points.push([i, Math.min(92, Math.max(a, b) + 5)]);
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
      formatter: (params) => {
        const list = Array.isArray(params) ? params : [params];
        const index = list.find((item) => item && Number.isInteger(item.dataIndex))?.dataIndex;
        if (index == null) return '';
        const row = rows[index];
        if (!row) return '';
        const num = (value) => (value == null || Number.isNaN(value) ? '—' : Number(value).toFixed(2));
        const diff = row.hj10 == null || row.hj11 == null ? null : row.hj10 - row.hj11;
        const diffColor = diff == null ? '#8b949e' : diff >= 0 ? '#f85149' : '#3fb950';
        const lines = [
          `<span style="color:#8b949e">HJ10</span> <b>${num(row.hj10)}</b>`
            + `　<span style="color:#8b949e">HJ11</span> <b>${num(row.hj11)}</b>`,
          `<span style="color:#8b949e">差值</span> <b style="color:${diffColor}">`
            + `${diff == null ? '—' : `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`}</b>`,
        ];
        if (row.hj5) lines.push('<span style="color:#f5a623">▲ HJ5 买点</span>');
        if (row.accelLabel) {
          const tone = row.accelLabel[1] === 'R' ? '#f85149' : '#3fb950';
          lines.push(`<span style="color:#8b949e">加速</span> <b style="color:${tone}">${row.accelLabel[0]}</b>`);
        }
        const head = `<div style="font-weight:600;margin-bottom:3px">`
          + `${row.date ?? ''}${row.time ? ` ${row.time}` : ''}</div>`;
        return `${head}${lines.join('<br/>')}`;
      },
    },
    grid: { left: '8%', right: '5%', top: '5%', bottom: '20%' },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, start: 0, end: 100 },
      {
        type: 'slider',
        xAxisIndex: 0,
        start: 0,
        end: 100,
        height: 24,
        // ECharts 会把 slider 整体下移 moveHandleSize(7px)，12 ≈ 7 + 5px 底部留白
        bottom: 12,
        showDetail: true,
        borderColor: '#30363d',
        backgroundColor: 'rgba(22,27,34,0.6)',
        fillerColor: 'rgba(88,166,255,0.18)',
        handleStyle: { color: '#58a6ff' },
        dataBackground: {
          lineStyle: { color: '#30363d' },
          areaStyle: { color: '#21262d' },
        },
        selectedDataBackground: {
          lineStyle: { color: '#58a6ff' },
          areaStyle: { color: 'rgba(88,166,255,0.15)' },
        },
        textStyle: { color: '#8b949e', fontSize: 10 },
      },
    ],
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
        name: 'HJ5 买点',
        type: 'scatter',
        data: hj5Points,
        symbol: 'triangle',
        symbolSize: 9,
        itemStyle: { color: '#f5a623' },
        label: {
          show: true,
          position: 'top',
          formatter: 'B',
          color: '#f5a623',
          fontSize: 9,
          fontWeight: 700,
          distance: 1,
        },
        silent: true,
        tooltip: { show: false },
        z: 15,
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
