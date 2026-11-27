import type { ActivityRun, JobInstance, PathEntry } from './fabric';
import { maskText } from './privacy';

/**
 * Progress of a run of PL_PerfTest_MultiModel_v3, computed from what Fabric and the lakehouse expose:
 *  - the activity runs of the parent pipeline (one ExecutePipeline per model) and of each child (one notebook run per level),
 *  - the run folders Files/PerfScenarios/logs/<prefix>-<model_key>-c<N>-<timestamp>/ (CSV per finished user, error.log, summary.json),
 *  - the heartbeat Files/PerfScenarios/progress/<loadtest_id>/user_<k>.json written by RunPerfScenario_v3 at every iteration.
 * This module is pure: the service gathers the inputs, this computes the numbers.
 */

export const FINAL_JOB_STATES = ['Completed', 'Failed', 'Cancelled', 'Deduped'];
export const ACTIVE_JOB_STATES = ['NotStarted', 'InProgress'];
export const isFinal = (status: string) => FINAL_JOB_STATES.includes(status);

export interface RunSummary {
  loadtest_id?: string; status?: string; users_with_results?: number; missing_users?: number; queries?: number;
  failed_queries?: number; expected_queries?: number; error_rate?: number; p50_s?: number | null; p90_s?: number | null;
  p95_s?: number | null; qps?: number | null; duration_s?: number; error_log_lines?: number; run_error?: string | null;
  concurrent_threads?: number; model?: string;
}

export interface Heartbeat {
  loadtest_id?: string; thread_id: number; status: 'running' | 'done' | 'failed'; iteration: number; iterations: number;
  queries_done: number; queries_total: number; updated_utc?: string;
}

export interface RunFolder { name: string; model_key: string; level: number; stamp: string; lastModified: string }

export interface FolderDetails {
  files: PathEntry[];
  summary?: RunSummary;
  errorLog?: ErrorLogInfo;
}

export interface ErrorLogInfo {
  lines: number;
  /** "user N query error: ..." lines: one per failed query. */
  queryErrors: number;
  /** Any other line: a virtual user that failed (its connection string and error). */
  userFailures: number;
  truncated: boolean;
  /** A few lines with every e-mail-like text masked. */
  sample: string[];
}

export interface HeartbeatInfo { items: Heartbeat[]; total: number }

export interface ProgressInputs {
  job: JobInstance;
  prefix: string | null;
  parentActivities: ActivityRun[];
  childActivities: Record<string, ActivityRun[]>;
  plan?: { models: { model_key: string; dataset?: string; levels: number[] }[] };
  folders: RunFolder[];
  details: Record<string, FolderDetails>;
  /** By loadtest_id (= folder name). Missing = no progress folder for that run. */
  heartbeats: Record<string, HeartbeatInfo>;
}

export type LevelStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type ModelStatus = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';

export interface LevelProgress {
  level: number;
  folder?: string;
  status: LevelStatus;
  usersTotal: number;
  usersDone: number;
  usersFailed: number;
  failedQueries: number | null;
  failedQueriesSource: 'summary' | 'error.log' | null;
  errorRate: number | null;
  fraction: number;
  /** 1-based iteration range of the virtual users and the number of iterations; null = no heartbeat for this level. */
  iteration: { min: number; max: number; of: number; sampled: number; users: number } | null;
  summary?: RunSummary;
  message?: string;
  errorLog?: ErrorLogInfo;
}

export interface ModelProgress {
  model_key: string;
  dataset?: string;
  levels: number[];
  levelsKnown: boolean;
  levelProgress: LevelProgress[];
  currentIndex: number;
  /** 0..1, or null when the number of levels is not known. */
  fraction: number | null;
  status: ModelStatus;
  activityStatus?: string;
  message?: string;
  heartbeatSeen: boolean;
}

export interface RunProgress {
  jobStatus: string;
  finished: boolean;
  models: ModelProgress[];
  fraction: number | null;
  activities: { name: string; type: string; status: string }[];
  loadtestIds: string[];
}

// ---------- parsing helpers (the exact shape of activity inputs and outputs is Fabric's: search, do not assume) ----------

function deepFind(obj: unknown, key: string, depth = 0): unknown {
  if (obj === null || obj === undefined || depth > 6) return undefined;
  if (typeof obj === 'string') {
    const t = obj.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.includes(`"${key}"`)) {
      try { return deepFind(JSON.parse(t), key, depth + 1); } catch { return undefined; }
    }
    return undefined;
  }
  if (typeof obj !== 'object') return undefined;
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = deepFind(v, key, depth + 1); if (r !== undefined) return r; }
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  if (key in rec) return rec[key];
  for (const v of Object.values(rec)) { const r = deepFind(v, key, depth + 1); if (r !== undefined) return r; }
  return undefined;
}

/** Notebook activity parameters look like {value: 5, type: 'int'}; expression results may be wrapped the same way. */
const unwrap = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object) ? unwrap((v as { value: unknown }).value) : v);

export function modelKeyOf(a: ActivityRun): string | null {
  const v = unwrap(deepFind(a.input, 'model_key'));
  return typeof v === 'string' && v ? v : null;
}

export function levelOf(a: ActivityRun): number | null {
  const v = unwrap(deepFind(a.input, 'concurrent_threads'));
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function rampLevelsOf(a: ActivityRun): number[] | null {
  let v = unwrap(deepFind(a.input, 'ramp_levels'));
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (Array.isArray(v) && v.length && v.every((x) => Number.isInteger(Number(x)))) return v.map(Number);
  return null;
}

export function childRunIdOf(a: ActivityRun): string | null {
  const v = deepFind(a.output, 'pipelineRunId');
  return typeof v === 'string' && v ? v : null;
}

export function exitSummaryOf(a: ActivityRun): RunSummary | null {
  const v = deepFind(a.output, 'exitValue');
  if (typeof v !== 'string') return null;
  try { const s = JSON.parse(v); return s && typeof s === 'object' ? (s as RunSummary) : null; } catch { return null; }
}

export function prefixOf(parent: ActivityRun[]): string | null {
  for (const a of parent) {
    const v = unwrap(deepFind(a.input, 'test_name_prefix'));
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

export const isModelActivity = (a: ActivityRun) => a.activityType === 'ExecutePipeline' || a.activityName === 'Run_Ramp_For_Model';
export const isLevelActivity = (a: ActivityRun) => /^TridentNotebook$|Notebook/i.test(a.activityType) || /RunLoadTest/i.test(a.activityName);

const STATUS_DONE = ['Succeeded'];
const STATUS_FAILED = ['Failed', 'TimedOut'];
const STATUS_CANCELLED = ['Cancelled', 'Canceled'];

/** `<prefix>-<model_key>-c<N>-<yyyymmdd-hhmmss>`; the model key is what sits between the prefix and `-c<N>-`. */
export function parseRunFolder(name: string, prefix: string): { model_key: string; level: number; stamp: string } | null {
  if (!name.startsWith(`${prefix}-`)) return null;
  const m = /^(.+)-c(\d+)-(\d{8}-\d{6})$/.exec(name.slice(prefix.length + 1));
  return m ? { model_key: m[1], level: Number(m[2]), stamp: m[3] } : null;
}

/** Parses error.log: query errors are "user N query error: ...", anything else is a failed user. Every line is masked. */
export function parseErrorLog(text: string, truncated = false): ErrorLogInfo {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const queryErrors = lines.filter((l) => /^user \d+ query error:/.test(l)).length;
  return {
    lines: lines.length, queryErrors, userFailures: lines.length - queryErrors, truncated,
    sample: lines.slice(0, 5).map((l) => maskText(l).replace(/Data Source=[^;]*;?/gi, '').slice(0, 300)),
  };
}

export function heartbeatFraction(h: Heartbeat): number {
  if (h.status === 'done') return 1;
  if (h.queries_total > 0) return Math.min(0.99, Math.max(0, h.queries_done / h.queries_total));
  return h.iterations > 0 ? Math.min(0.99, h.iteration / h.iterations) : 0;
}

function levelProgress(
  level: number, folder: RunFolder | undefined, activity: ActivityRun | undefined, inputs: ProgressInputs, jobFinal: string | null,
): LevelProgress {
  const details = folder ? inputs.details[folder.name] : undefined;
  const summary = details?.summary ?? (activity ? exitSummaryOf(activity) ?? undefined : undefined);
  const errorLog = details?.errorLog;
  const files = details?.files ?? [];
  const csvUsers = files.filter((f) => !f.isDirectory && /_user_\d+\.csv$/i.test(f.name)).length;
  const hb = folder ? inputs.heartbeats[folder.name] : undefined;

  let status: LevelStatus = 'pending';
  const act = activity?.status;
  if (act && STATUS_FAILED.includes(act)) status = 'failed';
  else if (act && STATUS_CANCELLED.includes(act)) status = 'cancelled';
  else if (summary && (summary.status === 'failed' || (summary.run_error ?? null))) status = 'failed';
  else if (summary || (act && STATUS_DONE.includes(act))) status = 'done';
  else if (folder || act) status = 'running';
  if (status === 'running' && jobFinal) status = jobFinal === 'Cancelled' ? 'cancelled' : 'failed';

  const usersDone = summary?.users_with_results ?? csvUsers;
  const usersFailed = summary?.missing_users !== undefined && status !== 'running' ? summary.missing_users : errorLog?.userFailures ?? 0;
  const failedQueries = summary?.failed_queries ?? errorLog?.queryErrors ?? null;

  let iteration: LevelProgress['iteration'] = null;
  let fraction = 0;
  if (hb && hb.items.length) {
    const items = hb.items;
    const of = Math.max(...items.map((h) => h.iterations || 0), 1);
    const shown = items.map((h) => (h.status === 'done' ? of : Math.min(of, h.iteration + 1)));
    iteration = { min: Math.min(...shown), max: Math.max(...shown), of, sampled: items.length, users: hb.total };
    const started = level > 0 ? Math.min(1, hb.total / level) : 1; // users without a progress file have not started yet
    const heartbeatMean = (items.reduce((s, h) => s + heartbeatFraction(h), 0) / items.length) * started;
    const fromCsv = level > 0 ? usersDone / level : 0;
    fraction = Math.max(heartbeatMean, fromCsv);
  } else if (level > 0) fraction = usersDone / level;
  if (status === 'done') fraction = 1;
  else if (status === 'pending') fraction = 0;
  else fraction = Math.min(fraction, 0.99);
  if (status === 'done' && iteration) iteration = { ...iteration, min: iteration.of, max: iteration.of };

  const message = activity?.error?.message ? maskText(activity.error.message) : summary?.run_error ? maskText(summary.run_error) : undefined;
  return {
    level, folder: folder?.name, status, usersTotal: level, usersDone, usersFailed, failedQueries,
    failedQueriesSource: summary?.failed_queries !== undefined ? 'summary' : errorLog ? 'error.log' : null,
    errorRate: summary?.error_rate ?? null, fraction, iteration, summary, message, errorLog,
  };
}

export function computeProgress(inputs: ProgressInputs): RunProgress {
  const jobStatus = inputs.job.status;
  const jobFinal = isFinal(jobStatus) && jobStatus !== 'Completed' ? jobStatus : null;
  const parent = inputs.parentActivities;
  const modelActivities = parent.filter(isModelActivity);

  // Ordered model keys: the plan, then the activities, then whatever the folders show
  const order: string[] = [];
  const push = (k: string | null) => { if (k && !order.includes(k)) order.push(k); };
  inputs.plan?.models.forEach((m) => push(m.model_key));
  modelActivities.forEach((a) => push(modelKeyOf(a)));
  inputs.folders.forEach((f) => push(f.model_key));

  const models: ModelProgress[] = order.map((key) => {
    const act = modelActivities.find((a) => modelKeyOf(a) === key);
    const planned = inputs.plan?.models.find((m) => m.model_key === key);
    const children = act ? inputs.childActivities[childRunIdOf(act) ?? ''] ?? [] : [];
    const levelActs = children.filter(isLevelActivity).filter((a) => levelOf(a) !== null)
      .sort((a, b) => (a.activityRunStart ?? '').localeCompare(b.activityRunStart ?? ''));
    const folders = inputs.folders.filter((f) => f.model_key === key).sort((a, b) => a.stamp.localeCompare(b.stamp));

    const fromActivity = act ? rampLevelsOf(act) : null;
    const known = planned?.levels ?? fromActivity ?? null;
    let levels: number[];
    if (known) levels = known;
    else {
      const seen: number[] = [];
      [...levelActs.map((a) => levelOf(a) as number), ...folders.map((f) => f.level)].forEach((l) => { if (!seen.includes(l)) seen.push(l); });
      levels = seen;
    }

    const used = new Map<number, number>();
    const levelProgressList = levels.map((level) => {
      const k = used.get(level) ?? 0;
      used.set(level, k + 1);
      const folder = folders.filter((f) => f.level === level)[k];
      const activity = levelActs.filter((a) => levelOf(a) === level)[k];
      return levelProgress(level, folder, activity, inputs, jobFinal);
    });
    const running = levelProgressList.findIndex((l) => l.status === 'running');
    const lastDone = levelProgressList.reduce((acc, l, i) => (l.status === 'done' ? i : acc), -1);
    const currentIndex = running >= 0 ? running : Math.min(lastDone + 1, levelProgressList.length - 1);

    const actStatus = act?.status;
    let status: ModelStatus;
    if (levelProgressList.some((l) => l.status === 'failed') || (actStatus && STATUS_FAILED.includes(actStatus))) status = 'failed';
    else if (levelProgressList.some((l) => l.status === 'cancelled') || (actStatus && STATUS_CANCELLED.includes(actStatus))) status = 'cancelled';
    else if (actStatus && STATUS_DONE.includes(actStatus)) status = 'done';
    else if (levelProgressList.length && levelProgressList.every((l) => l.status === 'done') && known) status = 'done';
    else if (levelProgressList.some((l) => l.status !== 'pending') || actStatus) status = 'running';
    else status = 'waiting';
    if (status === 'running' && jobFinal) status = jobFinal === 'Cancelled' ? 'cancelled' : 'failed';
    if (status === 'done') levelProgressList.forEach((l) => { if (l.status === 'pending' || l.status === 'running') { l.status = 'done'; l.fraction = 1; } });

    const fraction = known && levelProgressList.length ? levelProgressList.reduce((s, l) => s + l.fraction, 0) / levelProgressList.length : null;
    const message = act?.error?.message ? maskText(act.error.message) : levelProgressList.find((l) => l.message)?.message;
    const heartbeatSeen = folders.some((f) => inputs.heartbeats[f.name]?.items.length);
    return {
      model_key: key, dataset: planned?.dataset, levels, levelsKnown: Boolean(known), levelProgress: levelProgressList, currentIndex,
      fraction: status === 'done' ? 1 : fraction, status, activityStatus: actStatus, message, heartbeatSeen,
    };
  });

  const known = models.filter((m) => m.fraction !== null);
  return {
    jobStatus, finished: isFinal(jobStatus), models,
    fraction: known.length && known.length === models.length ? known.reduce((s, m) => s + (m.fraction as number), 0) / known.length : null,
    activities: parent.map((a) => ({ name: a.activityName, type: a.activityType, status: a.status })),
    loadtestIds: inputs.folders.map((f) => f.name),
  };
}

export function levelSentence(m: ModelProgress): string {
  if (!m.levels.length) return 'Level: waiting for the first level';
  const i = Math.max(0, m.currentIndex);
  const l = m.levels[i];
  return m.levelsKnown ? `Level ${i + 1} of ${m.levels.length} · ${l} user${l === 1 ? '' : 's'}` : `Level ${i + 1} · ${l} user${l === 1 ? '' : 's'}`;
}

export function iterationSentence(l: LevelProgress | undefined, heartbeatSeen: boolean): string {
  if (!l || l.status === 'pending') return 'Iteration: not started';
  if (!l.iteration && l.status === 'done') return 'Iteration: all completed'; // finished levels are read from summary.json, not from the heartbeat
  if (!l.iteration) return heartbeatSeen ? 'Iteration: waiting for the first progress file' : 'Iteration: not available';
  const { min, max, of } = l.iteration;
  return min === max ? `Iteration ${min} of ${of}` : `Iteration ${min}–${max} of ${of}`;
}
