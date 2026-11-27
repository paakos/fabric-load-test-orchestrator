import { describe, expect, it } from 'vitest';
import { DemoBackend } from '../demo/demo';
import { DEMO_ANALYSIS_ID } from '../demo/analysis';
import { generate } from './generate';
import { defaultForm, newCard, setSettingsMode } from './model';
import {
  checkDatasets, checkFolders, countLevelCsv, fetchProgressInputs, launchPipeline, listAnalyses, listFiles, loadManifest, missingFiles,
  newProgressCache, type Timing,
} from './ops';
import { computeProgress } from './progress';
import { toLaunched } from './launch';

const QF = '/lakehouse/default/Files/PerfScenarios/Queries/nav_sales.json';
const noWait: Timing = { sleep: async () => undefined, pollMs: 0, attempts: 3 };

function setup() {
  let now = Date.now();
  const b = new DemoBackend(() => now);
  const t = { ws: b.ids.workspace, lh: b.ids.lakehouse };
  let f = { ...defaultForm(() => 'x'), test_name_prefix: 'demo-run' };
  f = setSettingsMode({ ...f, models: [
    newCard('a', { model_key: 'SalesA', dataset: 'Sales A', queryfile: QF }),
    newCard('b', { model_key: 'Inv', dataset: 'Inventory', queryfile: QF })] }, 'per_model');
  f.models[0].settings = { ...f.models[0].settings, ramp_levels: '2, 4', iterations: '3', enable_think_times: false };
  f.models[1].settings = { ...f.models[1].settings, ramp_levels: '3', iterations: '1' };
  const gen = generate(f);
  return { b, t, gen, advance: (s: number) => { now += s * 1000; }, now: () => now };
}

describe('demo backend: the same logic as Fabric over an in-memory lakehouse', () => {
  it('lists seeded files and folders, uploads and detects missing files', async () => {
    const { b, t } = setup();
    expect((await listFiles(b, t, 'Files/PerfScenarios/Queries', /\.json$/i)).map((f) => f.name).sort()).toEqual(['nav_inventory.json', 'nav_sales.json']);
    expect(await missingFiles(b, t, [QF, '/lakehouse/default/Files/PerfScenarios/Queries/nope.json', '/lakehouse/default/Users/x.txt'])).toEqual([
      '/lakehouse/default/Files/PerfScenarios/Queries/nope.json', '/lakehouse/default/Users/x.txt']);
    await b.write(t.ws, t.lh, 'Files/PerfScenarios/Users/new.txt', 'a@x.com\n');
    expect((await b.list(t.ws, t.lh, 'Files/PerfScenarios/Users')).map((e) => e.name)).toContain('new.txt');
    expect((await checkFolders(b, t)).every((f) => f.exists)).toBe(true);
  });

  it('checks semantic models in the test workspace and in another one by name', async () => {
    const { b, t, gen } = setup();
    expect(await checkDatasets(b, t.ws, gen.effective)).toEqual({ missing: [], unverifiable: [] });
    const bad = [{ ...gen.effective[0], dataset: 'sales a', workspace: 'Demo Models' }, { ...gen.effective[1], workspace: 'Nowhere' }];
    const r = await checkDatasets(b, t.ws, bad);
    expect(r.missing).toHaveLength(2);
    expect(r.missing[1]).toContain('Nowhere');
  });

  it('a launched run advances level by level to completion, with iteration, users and failed queries', async () => {
    const { b, t, gen, advance, now } = setup();
    const located = await launchPipeline(b, t.ws, b.ids.pipeline, gen.params, noWait);
    expect(located.candidates).toHaveLength(1);
    const jobId = located.candidates[0].id;
    const plan = toLaunched(jobId, gen.params, located.launchedAt).plan;
    const cache = newProgressCache();
    const poll = async () => computeProgress(await fetchProgressInputs(b, t, b.ids.pipeline, jobId, { plan: { models: plan.models }, prefix: plan.prefix, cache, now: now() }));

    advance(0);
    let p = await poll();
    expect(p.jobStatus).toBe('NotStarted');
    advance(9);
    p = await poll();
    const a = p.models[0];
    expect(a.status).toBe('running');
    expect(a.levelProgress[0].status).toBe('running');
    expect(a.levelProgress[0].iteration?.of).toBe(3);
    expect(a.heartbeatSeen).toBe(true);

    let last = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 40 && !p.finished; i++) {
      advance(4);
      p = await poll();
      expect(p.fraction ?? 0).toBeGreaterThanOrEqual(last - 1e-9);
      last = p.fraction ?? last;
      p.models[0].levelProgress.forEach((l, k) => seen.add(`${k}:${l.status}`));
    }
    expect(p.jobStatus).toBe('Completed');
    expect(p.fraction).toBe(1);
    expect([...seen]).toEqual(expect.arrayContaining(['0:running', '0:done', '1:running', '1:done']));
    const lastLevel = p.models[0].levelProgress[1];
    expect(lastLevel).toMatchObject({ status: 'done', usersDone: 4, failedQueries: 3, failedQueriesSource: 'summary' });
    expect(lastLevel.errorRate).toBeGreaterThan(0);
    expect(p.models[1].levelProgress[0]).toMatchObject({ status: 'done', failedQueries: 0 });
    expect(p.loadtestIds).toHaveLength(3);
  });

  it('cancelling stops the run: running levels end as cancelled', async () => {
    const { b, t, gen, advance, now } = setup();
    const { candidates } = await launchPipeline(b, t.ws, b.ids.pipeline, gen.params, noWait);
    const jobId = candidates[0].id;
    advance(9);
    await b.cancel(t.ws, b.ids.pipeline, jobId);
    advance(20);
    const p = computeProgress(await fetchProgressInputs(b, t, b.ids.pipeline, jobId, { prefix: 'demo-run', cache: newProgressCache(), now: now() }));
    expect(p.jobStatus).toBe('Cancelled');
    expect(p.models[0].status).toBe('cancelled');
  });

  it('the previous run of the seed is read without a plan (levels from the pipeline activity) and counts failed queries from the CSV', async () => {
    const { b, t, now } = setup();
    const inputs = await fetchProgressInputs(b, t, b.ids.pipeline, 'demo-job-previous', { cache: newProgressCache(), now: now() });
    const p = computeProgress(inputs);
    expect(p.models.map((m) => m.model_key)).toEqual(['SalesModel', 'InventoryModel']);
    expect(p.models[1].levels).toEqual([1, 5, 20]);
    const inv = p.models[1].levelProgress[2];
    expect(inv).toMatchObject({ status: 'done', failedQueries: 4 });
    const csv = await countLevelCsv(b, t, inv.folder as string, inputs.details[inv.folder as string].files);
    expect(csv).toMatchObject({ hasStatus: true, failed: 4 });
  });

  it('reads the analyses of the lakehouse, including one with no_data and error queries', async () => {
    const { b, t } = setup();
    const list = await listAnalyses(b, t);
    expect(list.map((a) => a.id)).toEqual(['ramp-v3-20261121-090000', DEMO_ANALYSIS_ID]);
    const m = await loadManifest(b, t, 'ramp-v3-20261121-090000');
    expect(m.queries.filter((q) => q.status === 'no_data')).toHaveLength(2);
    expect(m.queries.filter((q) => q.status === 'error')).toHaveLength(1);
    await expect(loadManifest(b, t, 'missing')).rejects.toThrow('no manifest.json');
  });
});
