/** Synthetic analysis written by AnalyzeReportPerformance_v3 over synthetic logs (tools/make_synthetic_logs.py): no real names, ids or users. */
const files = import.meta.glob('./analysis/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export const DEMO_ANALYSIS_ID = 'ramp-v3-20261120-101500';

/** file name → raw JSON text */
export const DEMO_ANALYSIS_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.split('/').pop() as string, text]),
);
