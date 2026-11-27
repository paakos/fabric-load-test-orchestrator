export const PALETTE = ['#4c78a8', '#f58518', '#54a24b', '#b279a2', '#72b7b2', '#9d755d', '#eeca3b', '#79706e'];
export const RED = '#c0392b';
export const GREEN = '#2e8b57';
export const AXIS = '#5b6472';
export const GRID = '#e3e6ec';

/** About `count` round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { max = min + (min === 0 ? 1 : Math.abs(min) * 0.1); }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export function logTicks(min: number, max: number): number[] {
  const out: number[] = [];
  const lo = Math.floor(Math.log10(Math.max(min, 1e-12)));
  const hi = Math.ceil(Math.log10(Math.max(max, 1e-12)));
  for (let e = lo; e <= hi; e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= min * 0.999 && v <= max * 1.001) out.push(v); }
  return out.length >= 2 ? out : [min, max];
}

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 100000) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return String(Math.round(v));
  if (a >= 100) return String(Math.round(v * 10) / 10);
  if (a >= 1) return String(Math.round(v * 100) / 100);
  if (a === 0) return '0';
  return String(Math.round(v * 1000) / 1000);
}

export interface Scale { (v: number): number; domain: [number, number]; ticks: number[] }

export function linear(d0: number, d1: number, r0: number, r1: number, tickCount = 5): Scale {
  const ticks = niceTicks(d0, d1, tickCount);
  const lo = Math.min(d0, ticks[0] ?? d0);
  const hi = Math.max(d1, ticks[ticks.length - 1] ?? d1);
  const f = ((v: number) => (hi === lo ? (r0 + r1) / 2 : r0 + ((v - lo) / (hi - lo)) * (r1 - r0))) as Scale;
  f.domain = [lo, hi];
  f.ticks = ticks;
  return f;
}

export function logScale(d0: number, d1: number, r0: number, r1: number): Scale {
  const lo = Math.log10(d0); const hi = Math.log10(d1);
  const f = ((v: number) => (hi === lo ? (r0 + r1) / 2 : r0 + ((Math.log10(v) - lo) / (hi - lo)) * (r1 - r0))) as Scale;
  f.domain = [d0, d1];
  f.ticks = logTicks(d0, d1);
  return f;
}

/** Sequential yellow → red colour for the heat map and the colour-coded bars. */
export function heatColor(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  const stops = [[255, 247, 188], [254, 196, 79], [244, 109, 67], [165, 0, 38]];
  const p = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p));
  const f = p - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export const heatText = (t: number) => (t > 0.6 ? '#fff' : '#1b2330');

export const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
