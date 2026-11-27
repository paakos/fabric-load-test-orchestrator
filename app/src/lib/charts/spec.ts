/** Drawing specification written by the notebook next to every result (the CHARTS dict of the export cell): data only, no code. */
export type ChartType =
  | 'grouped_bar' | 'line' | 'combo' | 'small_multiples' | 'hbar' | 'heatmap' | 'scatter' | 'stacked100' | 'diverging_bar';

export const CHART_TYPES: ChartType[] = ['grouped_bar', 'line', 'combo', 'small_multiples', 'hbar', 'heatmap', 'scatter', 'stacked100', 'diverging_bar'];

export interface ChartSpec {
  type: ChartType;
  group_by?: string | null;
  x?: string | string[];
  y?: string | string[];
  series?: string;
  agg?: string;
  bars?: string[];
  lines?: string[];
  /** Name of a notebook parameter (for example SLA_SEC) that is found in manifest.parameters. */
  hline?: string;
  vline?: string;
  focus?: boolean;
  label?: string;
  value?: string;
  marker?: string;
  color?: string;
  flag?: { column: string; value: unknown };
  rows?: string;
  cols?: string;
  size?: string;
  logx?: boolean;
  logy?: boolean;
  kind?: string;
}

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Every column of the result that the specification names. */
export function chartColumns(spec: ChartSpec): string[] {
  const cols = [
    spec.group_by ?? undefined, ...list(spec.x), ...list(spec.y), spec.series, ...(spec.bars ?? []), ...(spec.lines ?? []),
    spec.label, spec.value, spec.marker, spec.color, spec.flag?.column, spec.rows, spec.cols, spec.size,
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  if (spec.focus) cols.push('model', 'level');
  return [...new Set(cols)];
}

/** Names of notebook parameters that the specification draws as reference lines. */
export function chartParameters(spec: ChartSpec): string[] {
  return [spec.hline, spec.vline].filter((p): p is string => typeof p === 'string' && p.length > 0);
}
