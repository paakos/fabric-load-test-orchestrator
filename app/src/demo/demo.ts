import type { ActivityRun, Item, JobInstance, NotebookParams, PathEntry, Workspace } from '../lib/fabric';
import { effectiveSettings, type Params } from '../lib/generate';
import { ANALYSIS_DIR, LOGS_DIR, PROGRESS_DIR, QUERIES_DIR, USERS_DIR } from '../lib/parameters';
import { PIPELINE_NAME, REPORT_NOTEBOOK_NAME } from '../lib/parameters';
import type { Account, Backend } from '../lib/service';
import { DEMO_ANALYSIS_FILES, DEMO_ANALYSIS_ID } from './analysis';

/**
 * Demo mode: an in-memory Fabric with synthetic data. It simulates workspaces, items, OneLake files and jobs, including a pipeline run that
 * advances (a few minutes of real test compressed into about a minute) and writes the same folders and files the orchestrator writes
 * (CSV per user, error.log, summary.json, progress files). The app logic on top of it is the real one.
 */

const WS = { test: 'demo-ws-test', models: 'demo-ws-models', dev: 'demo-ws-dev' };
const IDS = { workspace: WS.test, lakehouse: 'demo-lh', pipeline: 'demo-pipeline', notebook: 'demo-notebook' };
const LH = IDS.lakehouse;

interface Entry { content: string | null; modified: number }
interface SimJob {
  id: string; kind: 'pipeline' | 'notebook'; start: number; cancelledAt?: number;
  params?: Params; analysisId?: string; written?: boolean; past?: boolean; failedAt?: number;
}

const ISO = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const stampOf = (t: number) => ISO(t).replace(/[-:]/g, '').replace('T', '-').replace('Z', '');

function nav(events: number): string {
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  const ev: unknown[] = [];
  for (let i = 0; i < events; i++) {
    ev.push({ name: 'User Action', start: ISO(t0 + i * 20000), end: ISO(t0 + i * 20000 + 500), metrics: { sourceLabel: 'Click' } });
    ev.push({ name: 'Visual Container Lifecycle', metrics: { visualTitle: `Visual ${i + 1}`, visualId: `v${i + 1}` } });
    ev.push({ name: 'Execute DAX Query', start: ISO(t0 + i * 20000 + 600), end: ISO(t0 + i * 20000 + 1400), metrics: { QueryText: 'EVALUATE ROW("x", 1)' } });
  }
  return JSON.stringify({ events: ev });
}

const CSV_HEAD = 'loadtest_id,model,concurrent_threads,iterations,delay_sec,query_number,visual_name,visual_id,iteration,query,rows,duration,start_time,thread_id,status,error';
const csvOf = (id: string, level: number, thread: number, failed: number) => [CSV_HEAD,
  ...Array.from({ length: 4 }, (_, i) => `${id},Demo,${level},1,4,${i + 1},Visual ${i + 1},v${i + 1},0,"EVALUATE ROW(""x"", 1)",1,${(0.4 + i * 0.1).toFixed(2)},0,${thread},${i < failed ? 'error' : 'ok'},${i < failed ? 'Timeout' : ''}`)].join('\n');

interface Plan { key: string; levels: number[]; iterations: number; failedQueries: number }

const LEVEL_SETUP_S = 3;
const levelSeconds = (level: number) => Math.min(26, 8 + level * 0.35);

export class DemoBackend implements Backend {
  readonly demo = true;
  readonly ids = IDS;
  lastNotebookParams: NotebookParams | null = null;
  private fs = new Map<string, Entry>();
  private sim: SimJob[] = [];
  private signed = true;
  private seq = 0;

  constructor(private clock: () => number = Date.now) {
    this.seed();
  }

  // ---------- seed data ----------
  private put(path: string, content: string | null, modified = this.clock()) { this.fs.set(`${LH}/${path}`, { content, modified }); }

  private seed() {
    const old = Date.parse('2026-11-20T09:00:00Z');
    this.put(`${QUERIES_DIR}/nav_sales.json`, nav(6), old);
    this.put(`${QUERIES_DIR}/nav_inventory.json`, nav(4), old + 60000);
    this.put(`${USERS_DIR}/users_analysts.txt`, '# demo analysts (synthetic)\nanalyst01@example.invalid\nanalyst02@example.invalid\nanalyst03@example.invalid\n', old);
    this.put(PROGRESS_DIR, null, old);
    // a finished run, with its folders
    const start = Date.parse('2026-11-20T09:59:00Z');
    this.sim.push({ id: 'demo-job-previous', kind: 'pipeline', start, past: true, params: { test_name_prefix: 'ramp-v3', models: [
      { model_key: 'SalesModel', dataset: 'Sales A' }, { model_key: 'InventoryModel', dataset: 'Inventory' }], ramp_levels: [1, 5, 20] } });
    this.sim.push({ id: 'demo-job-failed', kind: 'pipeline', start: Date.parse('2026-11-19T15:00:00Z'), past: true, failedAt: Date.parse('2026-11-19T15:01:30Z'),
      params: { test_name_prefix: 'ramp-v3', models: [{ model_key: 'SalesModel' }], ramp_levels: [1] } });
    const runs: [string, number, string, number][] = [['SalesModel', 1, '100000', 0], ['SalesModel', 5, '100500', 0], ['SalesModel', 20, '101500', 0],
      ['InventoryModel', 1, '100020', 0], ['InventoryModel', 5, '100520', 0], ['InventoryModel', 20, '101520', 4]];
    for (const [key, level, hms, failed] of runs) {
      const name = `ramp-v3-${key}-c${level}-20261120-${hms}`;
      const t = Date.parse(`2026-11-20T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4)}Z`);
      this.put(`${LOGS_DIR}/${name}`, null, t);
      for (let u = 0; u < Math.min(level, 3); u++) this.put(`${LOGS_DIR}/${name}/${name}_user_${u}.csv`, csvOf(name, level, u, u === 0 ? failed : 0), t + 60000);
      this.put(`${LOGS_DIR}/${name}/summary.json`, JSON.stringify(this.summary(name, key, level, 1, failed)), t + 90000);
      if (failed) this.put(`${LOGS_DIR}/${name}/error.log`, Array.from({ length: failed }, (_, i) => `user 0 query error: Timeout (${i + 1})\n`).join(''), t + 60000);
    }
    // analyses
    for (const [file, text] of Object.entries(DEMO_ANALYSIS_FILES)) this.put(`${ANALYSIS_DIR}/${DEMO_ANALYSIS_ID}/${file}`, text, Date.parse('2026-11-20T10:30:00Z'));
    this.writeVariant('ramp-v3-20261121-090000', Date.parse('2026-11-21T09:00:00Z'));
  }

  /** A second analysis where some queries have no data or failed, to see how the page copes. */
  private writeVariant(id: string, modified: number) {
    const m = JSON.parse(DEMO_ANALYSIS_FILES['manifest.json']);
    m.analysis_id = id;
    m.generated_utc = ISO(modified);
    m.alerts = [];
    for (const q of m.queries) {
      if (q.id === 'Q14' || q.id === 'Q20') Object.assign(q, { status: 'no_data', message: 'The query returned no rows with the current filters.', file: null, rows: 0, columns: [] });
      if (q.id === 'Q09') Object.assign(q, { status: 'error', message: 'BinderException: Referenced column "cv" not found in FROM clause', file: null, rows: 0, columns: [] });
    }
    this.put(`${ANALYSIS_DIR}/${id}/manifest.json`, JSON.stringify(m), modified);
    for (const q of m.queries) if (q.file) this.put(`${ANALYSIS_DIR}/${id}/${q.file}`, DEMO_ANALYSIS_FILES[q.file], modified);
  }

  private summary(id: string, key: string, level: number, iterations: number, failed: number) {
    const expected = level * 4 * iterations;
    return {
      loadtest_id: id, model: key, concurrent_threads: level, status: failed ? 'completed_with_errors' : 'completed', users_with_results: level,
      missing_users: 0, queries_per_user: 4 * iterations, queries: expected, failed_queries: failed, expected_queries: expected,
      error_rate: Math.round((failed / expected) * 10000) / 10000, p50_s: 0.5, p90_s: 0.9, p95_s: 1.1, qps: 3.2, duration_s: 20, error_log_lines: failed, run_error: null,
    };
  }

  // ---------- simulation ----------
  private plansOf(job: SimJob): Plan[] {
    const p = job.params ?? {};
    const eff = Array.isArray(p.models) && (p.models as Record<string, unknown>[]).every((m) => m.queryfile !== undefined) ? effectiveSettings(p) : null;
    return ((p.models as Record<string, unknown>[]) ?? []).map((m, i) => {
      const levels = (eff?.[i].ramp_levels as number[] | undefined) ?? (p.ramp_levels as number[]) ?? [1];
      return { key: String(m.model_key), levels, iterations: Number(eff?.[i].iterations ?? p.iterations ?? 1), failedQueries: job.past ? 0 : i === 0 ? 3 : 0 };
    });
  }

  /** Seconds from the job start at which each level of each model starts and ends. */
  private timeline(job: SimJob): { plan: Plan; spans: { level: number; from: number; to: number }[]; total: number }[] {
    return this.plansOf(job).map((plan) => {
      let t = 2;
      const spans = plan.levels.map((level) => { const from = t + LEVEL_SETUP_S; const to = from + levelSeconds(level); t = to; return { level, from, to }; });
      return { plan, spans, total: t + 1 };
    });
  }

  private total(job: SimJob): number { return Math.max(0, ...this.timeline(job).map((m) => m.total)); }

  private status(job: SimJob, now: number): string {
    if (job.failedAt) return 'Failed';
    if (job.cancelledAt && now >= job.cancelledAt) return 'Cancelled';
    const el = (now - job.start) / 1000;
    if (job.past) return 'Completed';
    if (job.kind === 'notebook') return el < 1 ? 'NotStarted' : el < 6 ? 'InProgress' : 'Completed';
    return el < 1 ? 'NotStarted' : el < this.total(job) ? 'InProgress' : 'Completed';
  }

  private tick(now: number) {
    for (const job of this.sim) {
      if (job.past) continue;
      const el = (Math.min(now, job.cancelledAt ?? now) - job.start) / 1000;
      if (job.kind === 'notebook') {
        if (el >= 6 && !job.written && !job.cancelledAt) { job.written = true; this.writeNotebookResult(job); }
        continue;
      }
      for (const { plan, spans } of this.timeline(job)) {
        spans.forEach((s, li) => {
          if (el < s.from) return;
          const prefix = String(job.params?.test_name_prefix ?? 'ramp-v3');
          const name = `${prefix}-${plan.key}-c${s.level}-${stampOf(job.start + s.from * 1000)}`;
          const modified = job.start + s.from * 1000;
          if (!this.fs.has(`${LH}/${LOGS_DIR}/${name}`)) this.put(`${LOGS_DIR}/${name}`, null, modified);
          const f = Math.min(1, (el - s.from) / (s.to - s.from));
          const lastLevel = li === plan.levels.length - 1;
          const failedNow = lastLevel ? plan.failedQueries : 0;
          let finishedUsers = 0;
          for (let u = 0; u < s.level; u++) {
            const endFrac = 0.4 + (0.6 * (u + 1)) / s.level;
            const done = f >= endFrac;
            if (done) {
              finishedUsers++;
              const path = `${LOGS_DIR}/${name}/${name}_user_${u}.csv`;
              if (!this.fs.has(`${LH}/${path}`)) this.put(path, csvOf(name, s.level, u, u === 0 ? failedNow : 0), modified + endFrac * 1000);
            }
            if (u < 60) {
              const iterations = plan.iterations;
              const hb = { loadtest_id: name, thread_id: u, status: done ? 'done' : 'running', iteration: done ? iterations : Math.min(iterations - 1, Math.floor((f / endFrac) * iterations)),
                iterations, queries_done: 0, queries_total: 4 * iterations, updated_utc: ISO(now) };
              hb.queries_done = done ? hb.queries_total : hb.iteration * 4;
              this.put(`${PROGRESS_DIR}/${name}/user_${u}.json`, JSON.stringify(hb), now);
            }
          }
          if (failedNow && f > 0.5) this.put(`${LOGS_DIR}/${name}/error.log`, Array.from({ length: failedNow }, (_, i) => `user 0 query error: Timeout (${i + 1})\n`).join(''), now);
          if (f >= 1 && finishedUsers === s.level && !this.fs.has(`${LH}/${LOGS_DIR}/${name}/summary.json`)) {
            this.put(`${LOGS_DIR}/${name}/summary.json`, JSON.stringify(this.summary(name, plan.key, s.level, plan.iterations, failedNow)), modified + (s.to - s.from) * 1000);
          }
        });
      }
    }
  }

  private writeNotebookResult(job: SimJob) {
    const id = job.analysisId as string;
    const m = JSON.parse(DEMO_ANALYSIS_FILES['manifest.json']);
    m.analysis_id = id;
    m.generated_utc = ISO(this.clock());
    const prefix = (this.lastNotebookParams?.RUN_PREFIX?.value as string | undefined) ?? 'ramp-v3';
    m.parameters = { ...m.parameters, RUN_PREFIX: prefix };
    this.put(`${ANALYSIS_DIR}/${id}/manifest.json`, JSON.stringify(m));
    for (const [file, text] of Object.entries(DEMO_ANALYSIS_FILES)) if (file !== 'manifest.json') this.put(`${ANALYSIS_DIR}/${id}/${file}`, text);
  }

  // ---------- Backend ----------
  async account(): Promise<Account | null> { return this.signed ? { name: 'Demo User' } : null; }
  async signIn(): Promise<Account | null> { this.signed = true; return { name: 'Demo User' }; }

  async workspaces(): Promise<Workspace[]> {
    return [{ id: WS.models, displayName: 'Demo Models' }, { id: WS.test, displayName: 'Demo Load Test' }, { id: WS.dev, displayName: 'Demo Scratch' }];
  }

  async items(ws: string, type: string): Promise<Item[]> {
    const all: Item[] = ws === WS.test ? [
      { id: IDS.pipeline, displayName: PIPELINE_NAME, type: 'DataPipeline' },
      { id: 'demo-ramp', displayName: 'PL_PerfTest_Ramp_v3', type: 'DataPipeline' },
      { id: IDS.notebook, displayName: REPORT_NOTEBOOK_NAME, type: 'Notebook' },
      { id: LH, displayName: 'LoadTestLakehouse', type: 'Lakehouse' },
      { id: 'demo-sm1', displayName: 'Sales A', type: 'SemanticModel' }, { id: 'demo-sm2', displayName: 'Sales B', type: 'SemanticModel' },
      { id: 'demo-sm3', displayName: 'Inventory', type: 'SemanticModel' },
    ] : ws === WS.models ? [{ id: 'demo-sm4', displayName: 'Finance', type: 'SemanticModel' }, { id: 'demo-sm5', displayName: 'HR', type: 'SemanticModel' }] : [];
    return all.filter((i) => i.type === type);
  }

  async list(_ws: string, lh: string, dir: string): Promise<PathEntry[]> {
    this.tick(this.clock());
    const base = `${lh}/${dir}/`;
    const out = new Map<string, PathEntry>();
    for (const [key, e] of this.fs) {
      if (!key.startsWith(base)) continue;
      const rest = key.slice(base.length);
      const first = rest.split('/')[0];
      if (!first) continue;
      const deeper = rest.includes('/');
      const isDir = deeper || e.content === null;
      const prev = out.get(first);
      const modified = Math.max(e.modified, prev ? Date.parse(prev.lastModified) : 0);
      out.set(first, { name: first, isDirectory: isDir, contentLength: isDir ? 0 : (e.content ?? '').length, lastModified: new Date(modified).toISOString() });
    }
    return [...out.values()];
  }

  async read(_ws: string, lh: string, path: string, maxBytes?: number): Promise<string | null> {
    this.tick(this.clock());
    const e = this.fs.get(`${lh}/${path}`);
    if (!e || e.content === null) return null;
    return maxBytes ? e.content.slice(0, maxBytes) : e.content;
  }

  async write(_ws: string, lh: string, path: string, data: Blob | string): Promise<void> {
    const content = typeof data === 'string' ? data : await data.text();
    this.fs.set(`${lh}/${path}`, { content, modified: this.clock() });
  }

  async mkdir(_ws: string, lh: string, path: string): Promise<void> {
    this.fs.set(`${lh}/${path}`, { content: null, modified: this.clock() });
  }

  async runPipeline(_ws: string, _pipelineId: string, bodyText: string): Promise<void> {
    const params = JSON.parse(bodyText).executionData.parameters as Params;
    this.sim.push({ id: `demo-job-${++this.seq}`, kind: 'pipeline', start: this.clock() + 1500, params });
  }

  async runNotebook(_ws: string, _id: string, parameters: NotebookParams): Promise<void> {
    this.lastNotebookParams = parameters;
    this.sim.push({ id: `demo-nb-job-${++this.seq}`, kind: 'notebook', start: this.clock() + 1000, analysisId: String(parameters.ANALYSIS_ID?.value ?? '') });
  }

  private instance(job: SimJob, now: number): JobInstance {
    const status = this.status(job, now);
    const final = ['Completed', 'Failed', 'Cancelled'].includes(status);
    const end = job.failedAt ?? (job.past ? job.start + 40 * 60000 : job.cancelledAt ?? (job.kind === 'notebook' ? job.start + 6000 : job.start + this.total(job) * 1000));
    return {
      id: job.id, status, invokeType: 'Manual', jobType: job.kind === 'pipeline' ? 'Pipeline' : 'RunNotebook', startTimeUtc: ISO(job.start),
      endTimeUtc: final ? ISO(end) : undefined, failureReason: status === 'Failed' ? { message: 'Activity Run_Ramp_For_Model failed: RunLoadTest_v3 failed (demo)', errorCode: 'ActivityFailed' } : null,
    };
  }

  async jobs(_ws: string, itemId: string): Promise<JobInstance[]> {
    const now = this.clock();
    return this.sim.filter((j) => (itemId === IDS.pipeline ? j.kind === 'pipeline' : j.kind === 'notebook')).map((j) => this.instance(j, now))
      .sort((a, b) => (b.startTimeUtc ?? '').localeCompare(a.startTimeUtc ?? ''));
  }

  async job(_ws: string, _itemId: string, jobId: string): Promise<JobInstance> {
    this.tick(this.clock());
    const j = this.sim.find((x) => x.id === jobId);
    if (!j) throw new Error(`Job ${jobId} not found (demo)`);
    return this.instance(j, this.clock());
  }

  async cancel(_ws: string, _itemId: string, jobId: string): Promise<void> {
    const j = this.sim.find((x) => x.id === jobId);
    if (j && this.status(j, this.clock()) === 'InProgress') j.cancelledAt = this.clock();
  }

  async activityRuns(_ws: string, runId: string, _since: Date): Promise<ActivityRun[]> {
    const now = this.clock();
    this.tick(now);
    const parentJob = this.sim.find((j) => j.id === runId && j.kind === 'pipeline');
    if (parentJob) {
      const el = (Math.min(now, parentJob.cancelledAt ?? now) - parentJob.start) / 1000;
      const jobStatus = this.status(parentJob, now);
      const timelines = parentJob.past ? [] : this.timeline(parentJob);
      const pastModels = (parentJob.params?.models as { model_key: string }[]) ?? [];
      const rows = parentJob.past ? pastModels.map((m) => ({ key: m.model_key, total: 0, levels: (parentJob.params?.ramp_levels as number[]) ?? [1] })) : timelines.map((t) => ({ key: t.plan.key, total: t.total, levels: t.plan.levels }));
      return rows.map((m, i) => {
        const done = parentJob.past ? !parentJob.failedAt : el >= m.total;
        const status = parentJob.failedAt ? 'Failed' : jobStatus === 'Cancelled' ? 'Cancelled' : done ? 'Succeeded' : 'InProgress';
        return {
          activityName: 'Run_Ramp_For_Model', activityType: 'ExecutePipeline', status, activityRunStart: ISO(parentJob.start + 1000),
          input: { pipeline: { referenceName: 'PL_PerfTest_Ramp_v3' }, parameters: { model_key: m.key, test_name_prefix: parentJob.params?.test_name_prefix ?? 'ramp-v3', ramp_levels: m.levels } },
          output: { pipelineRunId: `child|${parentJob.id}|${i}` },
          error: status === 'Failed' ? { message: 'Execute pipeline failed: RunLoadTest_v3 failed (demo)' } : undefined,
        };
      });
    }
    if (runId.startsWith('child|')) {
      const [, jobId, idx] = runId.split('|');
      const job = this.sim.find((j) => j.id === jobId);
      if (!job) return [];
      const jobStatus = this.status(job, now);
      if (job.past) {
        return ((job.params?.ramp_levels as number[]) ?? []).map((level, i) => this.levelActivity(level, 'Succeeded', job.start + i * 60000, undefined));
      }
      const t = this.timeline(job)[Number(idx)];
      const el = (Math.min(now, job.cancelledAt ?? now) - job.start) / 1000;
      return t.spans.filter((s) => el >= s.from).map((s) => {
        const done = el >= s.to;
        const status = done ? 'Succeeded' : jobStatus === 'Cancelled' ? 'Cancelled' : 'InProgress';
        const name = `${job.params?.test_name_prefix ?? 'ramp-v3'}-${t.plan.key}-c${s.level}-${stampOf(job.start + s.from * 1000)}`;
        const summary = done ? JSON.stringify(this.summary(name, t.plan.key, s.level, t.plan.iterations, s === t.spans[t.spans.length - 1] ? t.plan.failedQueries : 0)) : undefined;
        return this.levelActivity(s.level, status, job.start + s.from * 1000, summary);
      });
    }
    return [];
  }

  private levelActivity(level: number, status: string, start: number, exitValue?: string): ActivityRun {
    return {
      activityName: 'RunLoadTest_v3', activityType: 'TridentNotebook', status, activityRunStart: ISO(start),
      input: { parameters: { concurrent_threads: { value: level, type: 'int' } } },
      output: exitValue ? { result: { exitValue } } : undefined,
    };
  }
}
