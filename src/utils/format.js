export function formatPrice(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatPct(value, digits = 2, signed = true) {
  if (value == null || !Number.isFinite(value)) return '—';
  const text = `${Math.abs(value).toFixed(digits)}%`;
  if (!signed) return text;
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${text}`;
}

export function formatAmount(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}万亿`;
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return value.toFixed(2);
}

export function formatVolume(value, unit = '') {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  let text;
  if (abs >= 1e12) text = `${(value / 1e12).toFixed(2)}万亿`;
  else if (abs >= 1e8) text = `${(value / 1e8).toFixed(2)}亿`;
  else if (abs >= 1e4) text = `${(value / 1e4).toFixed(2)}万`;
  else text = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${text}${unit}`;
}

export function formatCount(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}