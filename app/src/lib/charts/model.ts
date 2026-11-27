import type { ChartSpec, ChartType } from './spec';

/** Turns a chart specification plus the rows of a result into drawable panels. Pure and DOM-free (tested without a browser). */

type Row = Record<string, unknown>;

export interface Series { name: string; values: (number | null)[] }
export interface PointSeries { name: string; points: { x: number; y: number }[] }
export interface RefLine { value: number; label: string }

export type Panel =
  | { kind: 'bars'; title: string; categories: string[]; series: Series[]; refLines: RefLine[] }
  | { kind: 'lines'; title: string; series: PointSeries[]; refLines: RefLine[]; logx: boolean }
  | { kind: 'combo'; title: string; categories: string[]; bars: Series[]; lines: Series[] }
  | { kind: 'multi'; title: string; scatter: boolean; plots: { label: string; series: PointSeries[] }[] }
  | { kind: 'hbar'; title: string; items: { label: string; value: number; marker: number | null; color: number | null; flagged: boolean }[]; refLine: RefLine | null; colorLabel: string; markerLabel: string }
  | { kind: 'heat'; title: string; rows: string[]; cols: string[]; values: (number | null)[][]; valueLabel: string }
  | { kind: 'scatter'; title: string; points: { x: number; y: number; size: number; label: string }[]; logx: boolean; logy: boolean; xLabel: string; yLabel: string }
  | { kind: 'stack'; title: string; categories: string[]; parts: Series[]; lines: Series[] }
  | { kind: 'diverging'; title: string; items: { label: string; value: number }[]; valueLabel: string };

export interface ChartModel { type: ChartType; panels: Panel[]; notes: string[] }

export interface ChartContext {
  /** manifest.parameters: where hline / vline find their value. */
  parameters: Record<string, unknown>;
  /** manifest.focus: the focus level of every model. */
  focus: Record<string, number>;
}

const MAX_ITEMS = 25;
const MAX_GROUPS = 8;

export const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v));
const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function partition(rows: Row[], key: string | null | undefined): [string, Row[]][] {
  if (!key) return [['', rows]];
  const map = new Map<string, Row[]>();
  for (const r of rows) { const k = text(r[key]); const arr = map.get(k); if (arr) arr.push(r); else map.set(k, [r]); }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
}

const sortBy = (rows: Row[], key: string): Row[] => [...rows].sort((a, b) => (num(a[key]) ?? 0) - (num(b[key]) ?? 0));
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

function ref(spec: string | undefined, ctx: ChartContext): RefLine | null {
  if (!spec) return null;
  const v = num(ctx.parameters[spec]);
  return v === null ? null : { value: v, label: `${spec} = ${v}` };
}

function uniqueSorted(values: unknown[]): string[] {
  const set = [...new Set(values.map(text))];
  return set.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function barsPanel(title: string, rows: Row[], spec: ChartSpec, ctx: ChartContext): Panel {
  const ys = list(spec.y);
  const x = list(spec.x)[0] ?? '';
  const refs = [ref(spec.hline, ctx)].filter((r): r is RefLine => r !== null);
  if (spec.series) {
    const cats = uniqueSorted(rows.map((r) => r[x]));
    const names = uniqueSorted(rows.map((r) => r[spec.series as string]));
    const y = ys[0];
    const series = names.map((n) => ({
      name: n,
      values: cats.map((c) => mean(rows.filter((r) => text(r[x]) === c && text(r[spec.series as string]) === n).map((r) => num(r[y])).filter((v): v is number => v !== null))),
    }));
    return { kind: 'bars', title, categories: cats, series, refLines: refs };
  }
  if (spec.agg) {
    const cats = uniqueSorted(rows.map((r) => r[x]));
    const series = ys.map((y) => ({ name: y, values: cats.map((c) => mean(rows.filter((r) => text(r[x]) === c).map((r) => num(r[y])).filter((v): v is number => v !== null))) }));
    return { kind: 'bars', title, categories: cats, series, refLines: refs };
  }
  const ordered = rows.length && num(rows[0][x]) !== null ? sortBy(rows, x) : rows;
  return { kind: 'bars', title, categories: ordered.map((r) => text(r[x])), series: ys.map((y) => ({ name: y, values: ordered.map((r) => num(r[y])) })), refLines: refs };
}

function linePanel(title: string, rows: Row[], spec: ChartSpec, ctx: ChartContext): Panel {
  const x = list(spec.x)[0] ?? '';
  const ys = list(spec.y);
  const groups = spec.series ? partition(rows, spec.series) : [['', rows] as [string, Row[]]];
  const series: PointSeries[] = [];
  for (const [g, rs] of groups) {
    for (const y of ys) {
      const points = sortBy(rs, x).map((r) => ({ x: num(r[x]), y: num(r[y]) })).filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
      series.push({ name: g ? (ys.length > 1 ? `${g} · ${y}` : g) : y, points });
    }
  }
  const xs = series.flatMap((s) => s.points.map((p) => p.x)).filter((v) => v > 0);
  const logx = xs.length > 1 && Math.min(...xs) > 0 && Math.max(...xs) / Math.min(...xs) > 20;
  return { kind: 'lines', title, series, refLines: [ref(spec.hline, ctx)].filter((r): r is RefLine => r !== null), logx };
}

function comboPanel(title: string, rows: Row[], spec: ChartSpec): Panel {
  const x = list(spec.x)[0] ?? '';
  const ordered = rows.length && num(rows[0][x]) !== null ? sortBy(rows, x) : rows;
  const col = (c: string): Series => ({ name: c, values: ordered.map((r) => num(r[c])) });
  return { kind: 'combo', title, categories: ordered.map((r) => text(r[x])), bars: (spec.bars ?? []).map(col), lines: (spec.lines ?? []).map(col) };
}

function multiPanel(title: string, rows: Row[], spec: ChartSpec): Panel {
  const x = list(spec.x)[0] ?? '';
  const ys = list(spec.y);
  const sorted = sortBy(rows, x);
  const pts = (y: string): PointSeries => ({ name: y, points: sorted.map((r) => ({ x: num(r[x]), y: num(r[y]) })).filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null) });
  const scatter = spec.kind === 'scatter';
  return { kind: 'multi', title, scatter, plots: scatter ? [{ label: ys.join(' · '), series: ys.map(pts) }] : ys.map((y) => ({ label: y, series: [pts(y)] })) };
}

function hbarPanel(title: string, rows: Row[], spec: ChartSpec, ctx: ChartContext): Panel {
  const label = spec.label ?? '';
  const value = spec.value ?? '';
  let rs = rows;
  if (spec.focus && Object.keys(ctx.focus).length) rs = rows.filter((r) => ctx.focus[text(r.model)] === num(r.level));
  const items = rs.slice(0, MAX_ITEMS).map((r) => ({
    label: text(r[label]), value: num(r[value]) ?? 0, marker: spec.marker ? num(r[spec.marker]) : null,
    color: spec.color ? num(r[spec.color]) : null,
    flagged: !!spec.flag && text(r[spec.flag.column]) === text(spec.flag.value),
  }));
  return { kind: 'hbar', title, items, refLine: ref(spec.vline, ctx), colorLabel: spec.color ?? '', markerLabel: spec.marker ?? '' };
}

function heatPanel(title: string, rows: Row[], spec: ChartSpec): Panel {
  const rk = spec.rows ?? ''; const ck = spec.cols ?? ''; const vk = spec.value ?? '';
  const rowNames: string[] = [];
  rows.forEach((r) => { const n = text(r[rk]); if (!rowNames.includes(n)) rowNames.push(n); });
  const cols = uniqueSorted(rows.map((r) => r[ck]));
  const values = rowNames.map((rn) => cols.map((c) => {
    const hit = rows.find((r) => text(r[rk]) === rn && text(r[ck]) === c);
    return hit ? num(hit[vk]) : null;
  }));
  return { kind: 'heat', title, rows: rowNames.slice(0, 40), cols, values: values.slice(0, 40), valueLabel: vk };
}

function scatterPanel(title: string, rows: Row[], spec: ChartSpec): Panel {
  const x = list(spec.x)[0] ?? ''; const y = list(spec.y)[0] ?? '';
  const points = rows.map((r) => ({ x: num(r[x]), y: num(r[y]), size: spec.size ? num(r[spec.size]) ?? 1 : 1, label: spec.label ? text(r[spec.label]) : '' }))
    .filter((p): p is { x: number; y: number; size: number; label: string } => p.x !== null && p.y !== null && (!spec.logx || p.x > 0) && (!spec.logy || p.y > 0));
  return { kind: 'scatter', title, points, logx: !!spec.logx, logy: !!spec.logy, xLabel: x, yLabel: y };
}

function stackPanel(title: string, rows: Row[], spec: ChartSpec): Panel {
  const xs = list(spec.x);
  const col = (c: string): Series => ({ name: c, values: rows.map((r) => num(r[c])) });
  return { kind: 'stack', title, categories: rows.map((r) => xs.map((k) => text(r[k])).join(' · ')), parts: list(spec.y).map(col), lines: (spec.lines ?? []).map(col) };
}

function divergingPanel(title: string, rows: Row[], spec: ChartSpec): Panel {
  return { kind: 'diverging', title, items: rows.slice(0, MAX_ITEMS).map((r) => ({ label: text(r[spec.label ?? '']), value: num(r[spec.value ?? '']) ?? 0 })), valueLabel: spec.value ?? '' };
}

export function buildChartModel(spec: ChartSpec, rows: Row[], ctx: ChartContext): ChartModel {
  const notes: string[] = [];
  const groups = partition(rows, spec.group_by);
  if (groups.length > MAX_GROUPS) notes.push(`Showing ${MAX_GROUPS} of ${groups.length} charts.`);
  const panels: Panel[] = [];
  for (const [g, rs] of groups.slice(0, MAX_GROUPS)) {
    switch (spec.type) {
      case 'grouped_bar': panels.push(barsPanel(g, rs, spec, ctx)); break;
      case 'line': panels.push(linePanel(g, rs, spec, ctx)); break;
      case 'combo': panels.push(comboPanel(g, rs, spec)); break;
      case 'small_multiples': panels.push(multiPanel(g, rs, spec)); break;
      case 'hbar': {
        const p = hbarPanel(g, rs, spec, ctx);
        if (p.kind === 'hbar' && rs.length > MAX_ITEMS) notes.push(`Showing the first ${MAX_ITEMS} of ${rs.length} rows${g ? ` of ${g}` : ''}; the table has all of them.`);
        panels.push(p); break;
      }
      case 'heatmap': panels.push(heatPanel(g, rs, spec)); break;
      case 'scatter': panels.push(scatterPanel(g, rs, spec)); break;
      case 'stacked100': panels.push(stackPanel(g, rs, spec)); break;
      case 'diverging_bar': panels.push(divergingPanel(g, rs, spec)); break;
      default: notes.push(`Unknown chart type "${String(spec.type)}": only the table is shown.`);
    }
  }
  return { type: spec.type, panels, notes };
}

/** Does the panel have anything to draw? */
export function panelHasData(p: Panel): boolean {
  switch (p.kind) {
    case 'bars': case 'combo': case 'stack': return p.categories.length > 0;
    case 'lines': return p.series.some((s) => s.points.length > 0);
    case 'multi': return p.plots.some((pl) => pl.series.some((s) => s.points.length > 0));
    case 'hbar': case 'diverging': return p.items.length > 0;
    case 'heat': return p.rows.length > 0;
    case 'scatter': return p.points.length > 0;
  }
}
