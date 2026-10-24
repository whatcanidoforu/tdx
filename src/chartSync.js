/**
 * 图表联动同步模块
 * - 十字光标 / tooltip 同步（showtip/hidetip 事件 + dispatchAction）
 * - dataZoom 范围同步（datazoom 事件 + dispatchAction）
 */
import * as echarts from 'echarts';

const instances = new Set();
let syncing = false;

export function register(chart) {
  instances.add(chart);

  chart.on('datazoom', function (params) {
    if (syncing) return;
    syncing = true;
    const batch = params.batch || [params];
    const first = batch[0];
    if (first && first.start != null && first.end != null) {
      instances.forEach((c) => {
        if (c !== chart && !c.isDisposed()) {
          c.dispatchAction({ type: 'dataZoom', start: first.start, end: first.end });
        }
      });
    }
    syncing = false;
  });

  chart.on('showtip', function (params) {
    if (syncing) return;
    syncing = true;
    instances.forEach((c) => {
      if (c !== chart && !c.isDisposed()) {
        c.dispatchAction({
          type: 'showTip',
          seriesIndex: 0,
          dataIndex: params.dataIndex,
        });
      }
    });
    syncing = false;
  });

  chart.on('hidetip', function () {
    if (syncing) return;
    syncing = true;
    instances.forEach((c) => {
      if (c !== chart && !c.isDisposed()) {
        c.dispatchAction({ type: 'hideTip' });
      }
    });
    syncing = false;
  });
}

export function unregister(chart) {
  instances.delete(chart);
}

export function connectAll() {
  echarts.connect('tdx-group');
}

export function reconnect() {
  echarts.disconnect('tdx-group');
  connectAll();
}