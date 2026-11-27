import { countStatus, type StatusCount } from './csv';
import type { ActivityRun, Item, JobInstance, PathEntry } from './fabric';
import type { EffectiveModel, Params } from './generate';
import { launchBody, newJobCandidates } from './launch';
import {
  ANALYSIS_DIR, LAKEHOUSE_PREFIX, LOGS_DIR, PROGRESS_DIR, QUERIES_DIR, USERS_DIR, fromLakehousePath, toLakehousePath,
  PIPELINE_NAME, REPORT_NOTEBOOK_NAME,
} from './parameters';
import {
  childRunIdOf, isModelActivity, parseErrorLog, parseRunFolder, prefixOf, type FolderDetails, type Heartbeat, type HeartbeatInfo,
  type ProgressInputs, type RunFolder, type RunSummary,
} from './progress';
import { analysisFormProblems, analysisIdFor, buildNotebookParams, parseManifest, parseRows, type AnalysisForm, type Manifest, type Row } from './reports';
import type { Backend } from './service';
import { parseUtc } from './time';

/** Operations on top of the backend primitives. Everything here works the same against Fabric and the demo backend. */

export interface Target { ws: string; lh: string }

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export interface Timing { sleep: (ms: number) => Promise<void>; pollMs: number; attempts: number }
export const REAL_TIMING: Timing = { sleep: sleepReal, pollMs: 3000, attempts: 12 };

// ---------- environment ----------

export interface Discovery { pipeline?: Item; notebook?: Item; lakehouses: Item[]; models: Item[] }

export async function discover(b: Backend, ws: string): Promise<Discovery> {
  const [pipelines, notebooks, lakehouses, models] = await Promise.all(
    ['DataPipeline', 'Notebook', 'Lakehouse', 'SemanticModel'].map((t) => b.items(ws, t).catch(() => [] as Item[])));
  return {
    pipeline: pipelines.find((i) => i.displayName === PIPELINE_NAME), notebook: notebooks.find((i) => i.displayName === REPORT_NOTEBOOK_NAME),
    lakehouses, models,
  };
}

const PERF_ROOT = 'Files/PerfScenarios';
export const REQUIRED_FOLDERS = [QUERIES_DIR, USERS_DIR, LOGS_DIR, PROGRESS_DIR, ANALYSIS_DIR];
const OPTIONAL_FOLDERS = new Set([PROGRESS_DIR, ANALYSIS_DIR, LOGS_DIR]);

export interface FolderStatus { path: string; exists: boolean; optional: boolean }

export async function checkFolders(b: Backend, t: Target): Promise<FolderStatus[]> {
  const children = await b.list(t.ws, t.lh, PERF_ROOT);
  const names = new Set(children.filter((c) => c.isDirectory).map((c) => c.name));
  return REQUIRED_FOLDERS.map((p) => ({ path: p, exists: names.has(p.split('/').pop() as string), optional: OPTIONAL_FOLDERS.has(p) }));
}

export async function createFolders(b: Backend, t: Target, paths: string[]): Promise<void> {
  for (const p of paths) await b.mkdir(t.ws, t.lh, p);
}

/** Does this lakehouse hold Files/PerfScenarios? Used to suggest the lakehouse of the test. */
export async function hasPerfScenarios(b: Backend, ws: string, lh: string): Promise<boolean> {
  try { return (await b.list(ws, lh, PERF_ROOT)).length > 0; } catch { return false; }
}

// ---------- files ----------

export interface LakeFile { name: string; path: string; size: number; modified: string }

export async function listFiles(b: Backend, t: Target, dir: string, ext: RegExp): Promise<LakeFile[]> {
  const entries = await b.list(t.ws, t.lh, dir);
  return entries.filter((e) => !e.isDirectory && ext.test(e.name))
    .map((e) => ({ name: e.name, path: toLakehousePath(`${dir}/${e.name}`), size: e.contentLength, modified: e.lastModified }))
    .sort((a, c) => Date.parse(c.modified || '0') - Date.parse(a.modified || '0'));
}

export async function uploadFile(b: Backend, t: Target, dir: string, name: string, content: string | Blob): Promise<string> {
  await b.write(t.ws, t.lh, `${dir}/${name}`, content);
  return toLakehousePath(`${dir}/${name}`);
}

/** Lakehouse paths (/lakehouse/default/...) that do not exist. Each directory is listed once. */
export async function missingFiles(b: Backend, t: Target, paths: string[]): Promise<string[]> {
  const byDir = new Map<string, string[]>();
  const missing: string[] = [];
  for (const p of paths) {
    const rel = fromLakehousePath(p);
    if (rel === null || !rel.includes('/')) { missing.push(p); continue; }
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
  }
  for (const [dir, list] of byDir) {
    const names = new Set((await b.list(t.ws, t.lh, dir)).filter((e) => !e.isDirectory).map((e) => e.name));
    for (const p of list) if (!names.has(p.slice(p.lastIndexOf('/') + 1))) missing.push(p);
  }
  return missing;
}

// ---------- semantic models ----------

export interface DatasetCheck { missing: string[]; unverifiable: string[] }

export async function checkDatasets(b: Backend, ws: string, models: EffectiveModel[]): Promise<DatasetCheck> {
  const missing: string[] = [];
  const unverifiable: string[] = [];
  let workspaces: Awaited<ReturnType<Backend['workspaces']>> | null = null;
  const cache = new Map<string, Item[] | null>();
  const itemsOf = async (id: string): Promise<Item[] | null> => {
    if (!cache.has(id)) cache.set(id, await b.items(id, 'SemanticModel').catch(() => null));
    return cache.get(id) ?? null;
  };
  for (const m of models) {
    if (!m.dataset) continue;
    let wsId = ws;
    let wsLabel = 'the test workspace';
    if (m.workspace) {
      wsLabel = `workspace "${m.workspace}"`;
      try { workspaces ??= await b.workspaces(); } catch { unverifiable.push(`${m.dataset} (${wsLabel})`); continue; }
      const found = workspaces.find((w) => w.displayName === m.workspace);
      if (!found) { missing.push(`workspace "${m.workspace}" not found or not visible to you (model ${m.dataset})`); continue; }
      wsId = found.id;
    }
    const items = await itemsOf(wsId);
    if (!items) { unverifiable.push(`${m.dataset} (${wsLabel})`); continue; }
    if (!items.some((i) => i.displayName === m.dataset)) {
      const near = items.find((i) => i.displayName.toLowerCase() === m.dataset.toLowerCase());
      missing.push(`"${m.dataset}" in ${wsLabel}${near ? ` (similar: "${near.displayName}")` : ''}`);
    }
  }
  return { missing, unverifiable };
}

// ---------- launching and locating jobs ----------

export interface Located { launchedAt: Date; candidates: JobInstance[] }

async function locate(b: Backend, ws: string, itemId: string, before: Set<string>, launchedAt: Date, timing: Timing): Promise<JobInstance[]> {
  for (let i = 0; i < timing.attempts; i++) {
    await timing.sleep(timing.pollMs);
    const found = newJobCandidates(before, await b.jobs(ws, itemId).catch(() => []), launchedAt);
    if (found.length) return found;
  }
  return [];
}

export async function launchPipeline(b: Backend, ws: string, pipelineId: string, params: Params, timing: Timing = REAL_TIMING): Promise<Located> {
  const before = new Set((await b.jobs(ws, pipelineId)).map((j) => j.id));
  const launchedAt = new Date();
  await b.runPipeline(ws, pipelineId, launchBody(params));
  return { launchedAt, candidates: await locate(b, ws, pipelineId, before, launchedAt, timing) };
}

// ---------- progress ----------

export interface ProgressCache { finished: Map<string, FolderDetails> }
export const newProgressCache = (): ProgressCache => ({ finished: new Map() });

export const HEARTBEAT_SAMPLE = 40;
const ERROR_LOG_BYTES = 64 * 1024;

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const parseTime = parseUtc;

function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

async function readJson<T>(b: Backend, t: Target, path: string): Promise<T | null> {
  try { const text = await b.read(t.ws, t.lh, path); return text ? (JSON.parse(text) as T) : null; } catch { return null; }
}

export async function fetchProgressInputs(
  b: Backend, t: Target, pipelineId: string, jobId: string,
  opts: { plan?: ProgressInputs['plan']; prefix?: string; cache: ProgressCache; now?: number },
): Promise<ProgressInputs> {
  const job = await b.job(t.ws, pipelineId, jobId);
  const start = job.startTimeUtc ? new Date(parseTime(job.startTimeUtc)) : new Date((opts.now ?? Date.now()) - 3600_000);
  const parent = await b.activityRuns(t.ws, jobId, start).catch(() => [] as ActivityRun[]);

  const childIds = [...new Set(parent.filter(isModelActivity).map(childRunIdOf).filter((x): x is string => !!x))].slice(0, 12);
  const childActivities: Record<string, ActivityRun[]> = {};
  await pool(childIds, 4, async (id) => { childActivities[id] = await b.activityRuns(t.ws, id, start).catch(() => []); });

  const prefix = opts.prefix ?? prefixOf(parent);
  const folders: RunFolder[] = [];
  if (prefix) {
    const from = parseTime(job.startTimeUtc) - 120_000;
    const to = job.endTimeUtc ? parseTime(job.endTimeUtc) + 300_000 : Infinity;
    for (const e of await b.list(t.ws, t.lh, LOGS_DIR)) {
      if (!e.isDirectory) continue;
      const p = parseRunFolder(e.name, prefix);
      if (!p) continue;
      const modified = parseTime(e.lastModified);
      if (!Number.isNaN(modified) && (modified < from || modified > to)) continue;
      folders.push({ name: e.name, ...p, lastModified: e.lastModified });
    }
  }

  const details: Record<string, FolderDetails> = {};
  await pool(folders, 4, async (f) => {
    const cached = opts.cache.finished.get(f.name);
    if (cached) { details[f.name] = cached; return; }
    const files = await b.list(t.ws, t.lh, `${LOGS_DIR}/${f.name}`).catch(() => [] as PathEntry[]);
    const d: FolderDetails = { files };
    if (files.some((x) => x.name === 'summary.json')) d.summary = (await readJson<RunSummary>(b, t, `${LOGS_DIR}/${f.name}/summary.json`)) ?? undefined;
    const log = files.find((x) => x.name === 'error.log');
    if (log && log.contentLength > 0) {
      const text = await b.read(t.ws, t.lh, `${LOGS_DIR}/${f.name}/error.log`, ERROR_LOG_BYTES).catch(() => null);
      if (text) d.errorLog = parseErrorLog(text, log.contentLength > ERROR_LOG_BYTES);
    }
    if (d.summary) opts.cache.finished.set(f.name, d);
    details[f.name] = d;
  });

  const heartbeats: Record<string, HeartbeatInfo> = {};
  const progressFolders = new Set((await b.list(t.ws, t.lh, PROGRESS_DIR).catch(() => [])).filter((e) => e.isDirectory).map((e) => e.name));
  await pool(folders.filter((f) => progressFolders.has(f.name) && !details[f.name]?.summary), 4, async (f) => {
    const files = (await b.list(t.ws, t.lh, `${PROGRESS_DIR}/${f.name}`)).filter((e) => !e.isDirectory && /^user_\d+\.json$/.test(e.name));
    const items = (await pool(sample(files, HEARTBEAT_SAMPLE), 8, (e) => readJson<Heartbeat>(b, t, `${PROGRESS_DIR}/${f.name}/${e.name}`)))
      .filter((h): h is Heartbeat => !!h && typeof h.iteration === 'number');
    heartbeats[f.name] = { items, total: files.length };
  });

  return { job, prefix: prefix ?? null, parentActivities: parent, childActivities, plan: opts.plan, folders, details, heartbeats };
}

export interface CsvTotals extends StatusCount { files: number; truncated: boolean }

/** Counts rows and failed queries (`status` column) from the user CSV files of a level: for runs without summary.json. */
export async function countLevelCsv(b: Backend, t: Target, folder: string, files: PathEntry[], maxFiles = 60): Promise<CsvTotals> {
  const csv = files.filter((f) => !f.isDirectory && /_user_\d+\.csv$/i.test(f.name));
  const part = csv.slice(0, maxFiles);
  const counts = await pool(part, 6, async (f) => countStatus((await b.read(t.ws, t.lh, `${LOGS_DIR}/${folder}/${f.name}`)) ?? ''));
  return {
    rows: counts.reduce((s, c) => s + c.rows, 0), failed: counts.reduce((s, c) => s + c.failed, 0), hasStatus: counts.some((c) => c.hasStatus),
    users: counts.filter((c) => c.rows > 0).length, files: part.length, truncated: csv.length > part.length,
  };
}

// ---------- reports ----------

export interface AnalysisEntry { id: string; modified: string }

export async function listAnalyses(b: Backend, t: Target): Promise<AnalysisEntry[]> {
  return (await b.list(t.ws, t.lh, ANALYSIS_DIR)).filter((e) => e.isDirectory)
    .map((e) => ({ id: e.name, modified: e.lastModified }))
    .sort((a, c) => Date.parse(c.modified || '0') - Date.parse(a.modified || '0') || c.id.localeCompare(a.id));
}

export async function loadManifest(b: Backend, t: Target, id: string): Promise<Manifest> {
  const text = await b.read(t.ws, t.lh, `${ANALYSIS_DIR}/${id}/manifest.json`);
  if (text === null) throw new Error(`The analysis "${id}" has no manifest.json yet (the notebook may still be running or failed).`);
  return parseManifest(text);
}

export async function loadQueryRows(b: Backend, t: Target, id: string, file: string): Promise<Row[]> {
  const text = await b.read(t.ws, t.lh, `${ANALYSIS_DIR}/${id}/${file}`);
  if (text === null) throw new Error(`${file} was not found in the analysis folder.`);
  return parseRows(text);
}

export interface RunFolderInfo { name: string; level: number | null }

/** Run folders under logs/ that belong to a test prefix: <prefix>-<model_key>-c<N>-<timestamp>. */
export async function runFolders(b: Backend, t: Target, prefix: string): Promise<{ name: string; model_key: string; level: number; stamp: string }[]> {
  const out: { name: string; model_key: string; level: number; stamp: string }[] = [];
  for (const e of await b.list(t.ws, t.lh, LOGS_DIR)) {
    if (!e.isDirectory) continue;
    const p = parseRunFolder(e.name, prefix);
    if (p) out.push({ name: e.name, ...p });
  }
  return out.sort((a, c) => a.stamp.localeCompare(c.stamp));
}

export async function startAnalysis(
  b: Backend, ws: string, notebookId: string, form: AnalysisForm, timing: Timing = REAL_TIMING, now = new Date(),
): Promise<{ analysisId: string; candidates: JobInstance[] }> {
  const problems = analysisFormProblems(form);
  if (problems.length) throw new Error(problems.join(' '));
  const analysisId = analysisIdFor(form.prefix.trim(), now);
  const before = new Set((await b.jobs(ws, notebookId)).map((j) => j.id));
  const launchedAt = new Date();
  await b.runNotebook(ws, notebookId, buildNotebookParams(form, analysisId));
  return { analysisId, candidates: await locate(b, ws, notebookId, before, launchedAt, timing) };
}

export { LAKEHOUSE_PREFIX };
