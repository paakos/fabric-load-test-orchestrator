import type { NotebookParams } from './fabric';
import { maskValue } from './privacy';
import type { ChartSpec } from './charts/spec';

/** Reader of the output of AnalyzeReportPerformance_v3 (EXPORT_JSON): manifest.json plus one qNN_<topic>.json per analysis. */

export const BLOCKS: Record<string, { title: string; short: string }> = {
  A: { title: 'Overall report performance', short: 'Overall' },
  B: { title: 'Per action and journey', short: 'Actions' },
  C: { title: 'Per visual', short: 'Visuals' },
  D: { title: 'Per user (RLS identity)', short: 'Users' },
  E: { title: 'Skew from the offset and the think times', short: 'Skew' },
  F: { title: 'Test quality and regression', short: 'Quality' },
};

export type QueryStatus = 'ok' | 'no_data' | 'error';

export interface ManifestColumn { name: string; type: string }
export interface ManifestQuery {
  id: string; block: string; title: string; chart: ChartSpec | null; file: string | null;
  rows: number; columns: ManifestColumn[]; status: QueryStatus; message: string;
}
export interface ManifestAlert { query: string | null; model: string | null; level: number | null; severity: string; text: string }
export interface Manifest {
  notebook: string; notebook_version: string; analysis_id: string; generated_utc: string;
  parameters: Record<string, unknown>; focus: Record<string, number>; runs: string[];
  alerts: ManifestAlert[]; queries: ManifestQuery[];
}

export class ManifestError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new ManifestError(`manifest.json is not valid JSON: ${(e as Error).message}`); }
  if (!isObj(raw)) throw new ManifestError('manifest.json must be an object');
  if (!Array.isArray(raw.queries)) throw new ManifestError('manifest.json has no "queries" list');
  const queries: ManifestQuery[] = raw.queries.map((q, i) => {
    if (!isObj(q) || typeof q.id !== 'string') throw new ManifestError(`manifest query #${i + 1} has no id`);
    const status = (['ok', 'no_data', 'error'].includes(String(q.status)) ? q.status : 'error') as QueryStatus;
    return {
      id: q.id, block: String(q.block ?? ''), title: String(q.title ?? q.id), chart: isObj(q.chart) ? (q.chart as unknown as ChartSpec) : null,
      file: typeof q.file === 'string' ? q.file : null, rows: Number(q.rows ?? 0),
      columns: Array.isArray(q.columns) ? q.columns.filter(isObj).map((c) => ({ name: String(c.name), type: String(c.type ?? 'string') })) : [],
      status, message: String(q.message ?? ''),
    };
  });
  const alerts: ManifestAlert[] = (Array.isArray(raw.alerts) ? raw.alerts : []).filter(isObj).map((a) => ({
    query: typeof a.query === 'string' ? a.query : null, model: typeof a.model === 'string' ? a.model : null,
    level: typeof a.level === 'number' ? a.level : null, severity: String(a.severity ?? 'warning'), text: String(a.text ?? ''),
  }));
  return {
    notebook: String(raw.notebook ?? ''), notebook_version: String(raw.notebook_version ?? ''), analysis_id: String(raw.analysis_id ?? ''),
    generated_utc: String(raw.generated_utc ?? ''), parameters: isObj(raw.parameters) ? raw.parameters : {},
    focus: isObj(raw.focus) ? (raw.focus as Record<string, number>) : {}, runs: Array.isArray(raw.runs) ? raw.runs.map(String) : [],
    alerts, queries,
  };
}

export type Row = Record<string, unknown>;

/** The rows of one query, ready to show: every string goes through the UPN mask (the notebook already masks; this is a second guard). */
export function parseRows(text: string): Row[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new ManifestError(`Query file is not valid JSON: ${(e as Error).message}`); }
  if (!Array.isArray(raw)) throw new ManifestError('Query file must be an array of rows');
  return raw.filter(isObj).map((r) => maskValue(r));
}

export const queryFileProblem = (q: ManifestQuery): string | null => {
  if (q.status !== 'ok') return null;
  if (!q.file) return `${q.id}: status ok but no file`;
  if (!/^[A-Za-z0-9._-]+\.json$/.test(q.file)) return `${q.id}: unexpected file name`;
  return null;
};

export function alertSeverityRank(s: string): number {
  return s === 'high' ? 0 : s === 'warning' ? 1 : 2;
}

// ---------- running the notebook ----------

export interface AnalysisForm {
  prefix: string;
  runIds: string[];
  models: string[];
  levels: number[];
  sinceUtc: string;
  focusLevel: number | null;
  slaSec: number;
  apdexT: number;
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** `<RUN_PREFIX>-<UTC yyyymmdd-hhmmss>`: the same pattern the notebook uses when ANALYSIS_ID is None. */
export function analysisIdFor(prefix: string, now: Date): string {
  const d = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
  const t = `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
  return `${prefix}-${d}-${t}`;
}

export function analysisFormProblems(f: AnalysisForm): string[] {
  const out: string[] = [];
  if (!f.prefix.trim()) out.push('RUN_PREFIX is required.');
  else if (!/^[A-Za-z0-9._-]+$/.test(f.prefix.trim())) out.push('RUN_PREFIX may only contain letters, digits, ".", "_" and "-" (the notebook uses it in a file pattern and in SQL).');
  if (f.sinceUtc && Number.isNaN(Date.parse(f.sinceUtc))) out.push('SINCE_UTC is not a valid date.');
  if (!(f.slaSec > 0)) out.push('SLA_SEC must be greater than 0.');
  if (!(f.apdexT > 0)) out.push('APDEX_T must be greater than 0.');
  return out;
}

/**
 * Typed parameters for the Jobs API (`{"NAME": {"value": ..., "type": "string|int|float|bool"}}`).
 * Typed notebook parameters have no list type: the notebook accepts RUN_IDS, MODELS and LEVELS as STRING parameters holding a JSON list
 * text or comma-separated text. Run ids and model names go as JSON text (a model name may contain a comma); levels as "6,20,60".
 * Lists that are not set are not sent (an empty string also means "not set").
 */
export function buildNotebookParams(f: AnalysisForm, analysisId: string): NotebookParams {
  const p: NotebookParams = { RUN_PREFIX: { value: f.prefix.trim(), type: 'string' } };
  if (f.runIds.length) p.RUN_IDS = { value: JSON.stringify(f.runIds), type: 'string' };
  if (f.models.length) p.MODELS = { value: JSON.stringify(f.models), type: 'string' };
  if (f.levels.length) p.LEVELS = { value: f.levels.join(','), type: 'string' };
  if (f.sinceUtc) p.SINCE_UTC = { value: new Date(f.sinceUtc).toISOString().replace('.000Z', 'Z'), type: 'string' };
  if (f.focusLevel !== null) p.FOCUS_LEVEL = { value: f.focusLevel, type: 'int' };
  p.SLA_SEC = { value: f.slaSec, type: 'float' };
  p.APDEX_T = { value: f.apdexT, type: 'float' };
  p.MASK_UPN = { value: true, type: 'bool' };
  p.EXPORT_JSON = { value: true, type: 'bool' };
  p.ANALYSIS_ID = { value: analysisId, type: 'string' };
  return p;
}

/** "ramp-v3-SalesA-c20-20261120-101500" → prefix candidates are not derivable; the prefix is taken from the manifest or the run. */
export function levelOfRun(runId: string): number | null {
  const m = /-c(\d+)-\d{8}-\d{6}$/.exec(runId);
  return m ? Number(m[1]) : null;
}
