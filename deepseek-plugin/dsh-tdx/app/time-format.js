/**
 * 时间格式化工具。
 * @module dsh-tdx/app/time-format
 */

/** 格式化为 HH:mm:ss。 */
export function formatClock(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 格式化为 YYYYMMDD-HHmmss（用于文件名）。 */
export function formatStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
