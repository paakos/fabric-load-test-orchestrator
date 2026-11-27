import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChartView } from '../components/Chart';
import { DEMO_ANALYSIS_FILES } from '../demo/analysis';
import { buildChartModel, panelHasData } from './charts/model';
import { CHART_TYPES, chartColumns, chartParameters } from './charts/spec';
import { generate } from './generate';
import { defaultForm, newCard } from './model';
import { launchBody, launchCheck, loadLaunched, newJobCandidates, saveLaunched, toLaunched, type LaunchContext } from './launch';
import {
  analysisFormProblems, analysisIdFor, buildNotebookParams, parseManifest, parseRows, ManifestError, queryFileProblem,
  type AnalysisForm,
} from './reports';
import { startAnalysis, type Timing } from './ops';
import { DemoBackend } from '../demo/demo';

const manifest = parseManifest(DEMO_ANALYSIS_FILES['manifest.json']);
const rowsOf = (file: string) => parseRows(DEMO_ANALYSIS_FILES[file]);

describe('manifest and queries of the report notebook', () => {
  it('reads the demo manifest: 20 queries in blocks A–F, alerts, runs, focus, parameters', () => {
    expect(manifest.notebook).toBe('AnalyzeReportPerformance_v3');
    expect(manifest.queries.map((q) => q.id)).toEqual(Array.from({ length: 20 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`));
    expect(new Set(manifest.queries.map((q) => q.block))).toEqual(new Set(['A', 'B', 'C', 'D', 'E', 'F']));
    expect(manifest.alerts.length).toBeGreaterThan(5);
    expect(manifest.alerts[0]).toMatchObject({ query: 'Q01', severity: 'high' });
    expect(manifest.runs.length).toBe(7);
    expect(manifest.focus).toMatchObject({ SalesModel: 20 });
    expect(manifest.parameters.SLA_SEC).toBe(3);
    for (const q of manifest.queries) expect(queryFileProblem(q)).toBeNull();
  });

  it('every file of the manifest exists and has the announced rows and columns', () => {
    for (const q of manifest.queries.filter((x) => x.status === 'ok')) {
      const rows = rowsOf(q.file as string);
      expect(rows.length, q.id).toBe(q.rows);
      expect(Object.keys(rows[0]).sort(), q.id).toEqual(q.columns.map((c) => c.name).sort());
    }
  });

  it('handles no_data and error statuses without a file', () => {
    const m = parseManifest(JSON.stringify({ ...JSON.parse(DEMO_ANALYSIS_FILES['manifest.json']), queries: [
      { id: 'Q14', block: 'E', title: 'T', chart: null, file: null, rows: 0, columns: [], status: 'no_data', message: 'The query returned no rows' },
      { id: 'Q09', block: 'C', title: 'T', chart: { type: 'scatter' }, file: null, rows: 0, columns: [], status: 'error', message: 'BinderException: x' },
      { id: 'Q99', status: 'weird' }] }));
    expect(m.queries.map((q) => q.status)).toEqual(['no_data', 'error', 'error']);
    expect(m.queries[0].message).toContain('no rows');
    expect(queryFileProblem({ ...m.queries[0], status: 'ok' })).toContain('no file');
  });

  it('rejects broken manifests and rows', () => {
    expect(() => parseManifest('{')).toThrow(ManifestError);
    expect(() => parseManifest('{"queries": 3}')).toThrow('queries');
    expect(() => parseRows('{}')).toThrow('array');
  });

  it('masks any UPN that reaches the rows', () => {
    const rows = parseRows('[{"user_key":"ana@contoso.com","p90_s":1.2}]');
    expect(JSON.stringify(rows)).not.toContain('@');
  });
});

describe('chart specification → renderer contract', () => {
  const okQueries = manifest.queries.filter((q) => q.status === 'ok' && q.chart);

  it('covers the nine chart types of the notebook', () => {
    expect(new Set(okQueries.map((q) => q.chart!.type))).toEqual(new Set(CHART_TYPES));
  });

  it('every column named by a spec exists in the columns of its query, and hline/vline name a manifest parameter', () => {
    for (const q of okQueries) {
      const cols = new Set(q.columns.map((c) => c.name));
      for (const c of chartColumns(q.chart!)) expect(cols.has(c), `${q.id}: ${c}`).toBe(true);
      for (const p of chartParameters(q.chart!)) expect(p in manifest.parameters, `${q.id}: ${p}`).toBe(true);
    }
  });

  it('every query renders from the demo analysis without error and draws something', () => {
    for (const q of okQueries) {
      const model = buildChartModel(q.chart!, rowsOf(q.file as string), { parameters: manifest.parameters, focus: manifest.focus });
      expect(model.panels.length, q.id).toBeGreaterThan(0);
      expect(model.panels.some(panelHasData), q.id).toBe(true);
      const html = renderToStaticMarkup(createElement(ChartView, { model }));
      expect(html, q.id).toContain('<svg');
      expect(html, q.id).not.toContain('NaN');
      expect(html, q.id).not.toContain('undefined');
    }
  });

  it('reference lines take their value from the manifest parameters', () => {
    const q02 = manifest.queries.find((q) => q.id === 'Q02')!;
    const m = buildChartModel(q02.chart!, rowsOf(q02.file as string), { parameters: manifest.parameters, focus: manifest.focus });
    expect(m.panels[0]).toMatchObject({ kind: 'lines', refLines: [{ value: 3, label: 'SLA_SEC = 3' }] });
    const q01 = manifest.queries.find((q) => q.id === 'Q01')!;
    const m1 = buildChartModel(q01.chart!, rowsOf(q01.file as string), { parameters: manifest.parameters, focus: manifest.focus });
    expect(m1.panels.length).toBe(2); // one chart per model
    expect(m1.panels[0]).toMatchObject({ kind: 'bars', refLines: [{ label: 'APDEX_T = 1' }] });
  });

  it('hbar with focus keeps only the focus level of each model; flag marks atypical users', () => {
    const q05 = manifest.queries.find((q) => q.id === 'Q05')!;
    const rows = rowsOf(q05.file as string);
    const m = buildChartModel(q05.chart!, rows, { parameters: manifest.parameters, focus: manifest.focus });
    const expected = rows.filter((r) => manifest.focus[String(r.model)] === r.level).length;
    expect(m.panels.reduce((s, p) => s + (p.kind === 'hbar' ? p.items.length : 0), 0)).toBe(Math.min(expected, 50));
    const q11 = manifest.queries.find((q) => q.id === 'Q11')!;
    const m11 = buildChartModel(q11.chart!, rowsOf(q11.file as string), { parameters: manifest.parameters, focus: manifest.focus });
    expect(m11.panels.some((p) => p.kind === 'hbar' && p.items.some((i) => i.flagged))).toBe(true);
  });

  it('tolerates empty rows and missing columns without throwing', () => {
    for (const q of okQueries) {
      const m = buildChartModel(q.chart!, [], { parameters: {}, focus: {} });
      renderToStaticMarkup(createElement(ChartView, { model: m }));
      const sparse = buildChartModel(q.chart!, [{}, { model: 'x' }], { parameters: {}, focus: {} });
      renderToStaticMarkup(createElement(ChartView, { model: sparse }));
    }
  });
});

describe('running the notebook', () => {
  const form: AnalysisForm = { prefix: 'ramp-v3', runIds: ['ramp-v3-A-c5-20261120-100000'], models: ['Sales, Inc'], levels: [6, 20, 60], sinceUtc: '', focusLevel: null, slaSec: 3, apdexT: 1 };

  it('builds typed parameters: lists as STRING (JSON for ids and names, comma text for levels), only what is set', () => {
    const p = buildNotebookParams(form, 'ramp-v3-20261120-101500');
    expect(p).toEqual({
      RUN_PREFIX: { value: 'ramp-v3', type: 'string' },
      RUN_IDS: { value: '["ramp-v3-A-c5-20261120-100000"]', type: 'string' },
      MODELS: { value: '["Sales, Inc"]', type: 'string' },
      LEVELS: { value: '6,20,60', type: 'string' },
      SLA_SEC: { value: 3, type: 'float' }, APDEX_T: { value: 1, type: 'float' },
      MASK_UPN: { value: true, type: 'bool' }, EXPORT_JSON: { value: true, type: 'bool' },
      ANALYSIS_ID: { value: 'ramp-v3-20261120-101500', type: 'string' },
    });
    const minimal = buildNotebookParams({ ...form, runIds: [], models: [], levels: [], sinceUtc: '2026-11-20T00:00', focusLevel: 20 }, 'x');
    expect(Object.keys(minimal)).toEqual(['RUN_PREFIX', 'SINCE_UTC', 'FOCUS_LEVEL', 'SLA_SEC', 'APDEX_T', 'MASK_UPN', 'EXPORT_JSON', 'ANALYSIS_ID']);
    expect(minimal.FOCUS_LEVEL).toEqual({ value: 20, type: 'int' });
  });

  it('analysis id follows the notebook default pattern and the form is validated', () => {
    expect(analysisIdFor('ramp-v3', new Date('2026-11-20T10:15:00Z'))).toBe('ramp-v3-20261120-101500');
    expect(analysisFormProblems({ ...form, prefix: 'a*b' })[0]).toContain('RUN_PREFIX');
    for (const bad of ["x'||1||'", 'a;b', 'a(b)', 'a b', '../x']) expect(analysisFormProblems({ ...form, prefix: bad })[0], bad).toContain('RUN_PREFIX');
    expect(analysisFormProblems({ ...form, prefix: '' })).toHaveLength(1);
    expect(analysisFormProblems({ ...form, slaSec: 0 })[0]).toContain('SLA_SEC');
    expect(analysisFormProblems(form)).toEqual([]);
  });

  it('starts the job once and locates it by comparing before and after', async () => {
    const b = new DemoBackend();
    const timing: Timing = { sleep: async () => undefined, pollMs: 0, attempts: 3 };
    const r = await startAnalysis(b, b.ids.workspace, b.ids.notebook, form, timing, new Date('2026-11-20T10:15:00Z'));
    expect(r.analysisId).toBe('ramp-v3-20261120-101500');
    expect(r.candidates).toHaveLength(1);
    expect(b.lastNotebookParams?.RUN_IDS.type).toBe('string');
    await expect(startAnalysis(b, b.ids.workspace, b.ids.notebook, { ...form, prefix: '' }, timing)).rejects.toThrow('RUN_PREFIX');
  });
});

describe('launch gating', () => {
  const card = newCard('c1', { model_key: 'A', dataset: 'Sales', queryfile: '/lakehouse/default/Files/PerfScenarios/Queries/a.json' });
  const form = { ...defaultForm(() => 'x'), models: [card] };
  const gen = generate(form);
  const ready: LaunchContext = {
    signedIn: true, workspaceId: 'w', pipelineId: 'p', lakehouseId: 'l', pipelineVersion: 'verified', pipelineConfirmed: false,
    files: { status: 'done', missing: [] }, datasets: { status: 'done', missing: [], unverifiable: [] }, submitting: false,
  };

  it('is ready only when everything holds', () => {
    expect(launchCheck(gen, ready)).toMatchObject({ ready: true, blockers: [] });
  });

  it('each condition blocks', () => {
    const blockers = (patch: Partial<LaunchContext>, g = gen) => launchCheck(g, { ...ready, ...patch }).blockers.join(' | ');
    expect(blockers({ signedIn: false })).toContain('Sign in');
    expect(blockers({ pipelineId: undefined })).toContain('PL_PerfTest_MultiModel_v3 was not found');
    expect(blockers({ workspaceId: undefined })).toContain('workspace');
    expect(blockers({ lakehouseId: undefined })).toContain('lakehouse');
    expect(blockers({ pipelineVersion: 'mismatch' })).toContain('per-model settings would be ignored');
    expect(blockers({ pipelineVersion: 'unverified' })).toContain('Confirm');
    expect(launchCheck(gen, { ...ready, pipelineVersion: 'unverified', pipelineConfirmed: true })).toMatchObject({ ready: true });
    expect(launchCheck(gen, { ...ready, pipelineVersion: 'unverified', pipelineConfirmed: true }).warnings.join()).toContain('not verified');
    expect(blockers({ files: { status: 'done', missing: ['/lakehouse/default/Files/x.json'] } })).toContain('Files not found');
    expect(blockers({ files: { status: 'checking', missing: [] } })).toContain('Checking');
    expect(blockers({ datasets: { status: 'done', missing: ['"Sales" in the test workspace'], unverifiable: [] } })).toContain('Semantic models not found');
    expect(blockers({ submitting: true })).toContain('Launching');
    const bad = generate({ ...form, models: [{ ...card, dataset: '' }] });
    expect(blockers({}, bad)).toContain('error');
  });

  it('an unverifiable dataset only warns', () => {
    const c = launchCheck(gen, { ...ready, datasets: { status: 'done', missing: [], unverifiable: ['Sales (workspace "X")'] } });
    expect(c.ready).toBe(true);
    expect(c.warnings.join()).toContain('Could not verify');
  });

  it('the body is the JSON that is shown, on one line', () => {
    const body = launchBody(gen.params);
    expect(JSON.parse(body)).toEqual({ executionData: { parameters: gen.params } });
    expect(body).not.toContain('\n');
    expect(body).toContain('"think_time_scale": 1.0');
  });

  it('locates the new job: not in the list before, manual, recent; several candidates are all returned', () => {
    const at = new Date('2026-11-20T10:00:00Z');
    const jobs = [
      { id: 'old', status: 'Completed', invokeType: 'Manual', startTimeUtc: '2026-11-20T09:00:00Z' },
      { id: 'sched', status: 'InProgress', invokeType: 'Scheduled', startTimeUtc: '2026-11-20T10:00:01Z' },
      { id: 'n2', status: 'NotStarted', invokeType: 'Manual', startTimeUtc: '2026-11-20T10:00:05Z' },
      { id: 'n1', status: 'InProgress', invokeType: 'Manual', startTimeUtc: '2026-11-20T10:00:02' },
    ];
    expect(newJobCandidates(new Set(['old']), jobs, at).map((j) => j.id)).toEqual(['n2', 'n1']);
    expect(newJobCandidates(new Set(['old', 'n1', 'n2', 'sched']), jobs, at)).toEqual([]);
  });

  it('the run kept for the session has no UPN and carries the plan', () => {
    let f = { ...defaultForm(() => 'x'), rlsSource: 'list' as const, rlsScope: 'per_model' as const };
    f = { ...f, models: [{ ...card, users: 'a@x.com, b@x.com' }] };
    const g = generate(f);
    const run = toLaunched('job-1', g.params, new Date('2026-11-20T10:00:00Z'));
    expect(JSON.stringify(run)).not.toContain('@');
    expect(run.plan).toEqual({ prefix: 'ramp-v3', models: [{ model_key: 'A', dataset: 'Sales', levels: [1, 5, 10] }] });
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveLaunched(run, storage);
    expect(loadLaunched(storage)['job-1'].plan.prefix).toBe('ramp-v3');
    expect([...store.values()].join('')).not.toContain('@');
  });
});
