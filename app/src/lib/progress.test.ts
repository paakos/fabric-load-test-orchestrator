import { describe, expect, it } from 'vitest';
import type { ActivityRun, PathEntry } from './fabric';
import {
  computeProgress, iterationSentence, levelSentence, parseErrorLog, parseRunFolder,
  type FolderDetails, type Heartbeat, type ProgressInputs, type RunFolder,
} from './progress';

const PREFIX = 'ramp-v3';
const modelActivity = (key: string, status: string, over: Partial<ActivityRun> = {}): ActivityRun => ({
  activityName: 'Run_Ramp_For_Model', activityType: 'ExecutePipeline', status,
  input: { pipeline: { referenceName: 'PL_PerfTest_Ramp_v3' }, parameters: { model_key: key, test_name_prefix: PREFIX, ramp_levels: [2, 4] } },
  output: { pipelineRunId: `child-${key}` }, ...over,
});
const levelActivity = (level: number, status: string, over: Partial<ActivityRun> = {}): ActivityRun => ({
  activityName: 'RunLoadTest_v3', activityType: 'TridentNotebook', status, activityRunStart: `2026-11-20T10:0${level}:00Z`,
  input: { parameters: { concurrent_threads: { value: level, type: 'int' } } }, ...over,
});
const folder = (key: string, level: number, stamp = '20261120-100000'): RunFolder =>
  ({ name: `${PREFIX}-${key}-c${level}-${stamp}`, model_key: key, level, stamp, lastModified: '2026-11-20T10:00:00Z' });
const file = (name: string, size = 10): PathEntry => ({ name, isDirectory: false, contentLength: size, lastModified: '' });
const csvs = (n: number): PathEntry[] => Array.from({ length: n }, (_, i) => file(`x_user_${i}.csv`));
const hb = (thread: number, status: Heartbeat['status'], iteration: number, over: Partial<Heartbeat> = {}): Heartbeat =>
  ({ thread_id: thread, status, iteration, iterations: 3, queries_done: iteration * 6, queries_total: 18, ...over });

function inputs(over: Partial<ProgressInputs> = {}): ProgressInputs {
  return { job: { id: 'j', status: 'InProgress' }, prefix: PREFIX, parentActivities: [], childActivities: {}, folders: [], details: {}, heartbeats: {}, ...over };
}

describe('folder names', () => {
  it('parses <prefix>-<model_key>-c<N>-<timestamp>, also when the key has hyphens', () => {
    expect(parseRunFolder('ramp-v3-Sales-A-c20-20261120-101500', 'ramp-v3')).toEqual({ model_key: 'Sales-A', level: 20, stamp: '20261120-101500' });
    expect(parseRunFolder('other-x-c1-20261120-101500', 'ramp-v3')).toBeNull();
    expect(parseRunFolder('ramp-v3-x-cX-20261120-101500', 'ramp-v3')).toBeNull();
  });
});

describe('progress of a run', () => {
  it('level 2 of 2 running: level, users done, failed users, iteration range from the heartbeat, bar', () => {
    const f1 = folder('SalesA', 2, '20261120-100000');
    const f2 = folder('SalesA', 4, '20261120-100500');
    const p = computeProgress(inputs({
      parentActivities: [modelActivity('SalesA', 'InProgress')],
      childActivities: { 'child-SalesA': [levelActivity(2, 'Succeeded'), levelActivity(4, 'InProgress')] },
      folders: [f1, f2],
      details: {
        [f1.name]: { files: [...csvs(2), file('summary.json')], summary: { status: 'completed', users_with_results: 2, missing_users: 0, failed_queries: 0, error_rate: 0, queries: 24 } },
        [f2.name]: { files: [...csvs(1), file('error.log', 50)], errorLog: parseErrorLog('user 2 query error: Timeout\nuser 3 query error: Timeout\nconn : Boom') },
      },
      heartbeats: { [f2.name]: { total: 4, items: [hb(0, 'done', 3), hb(1, 'running', 1), hb(2, 'running', 2), hb(3, 'running', 0)] } },
    }));
    const m = p.models[0];
    expect(m.levels).toEqual([2, 4]);
    expect(m.levelsKnown).toBe(true);
    expect(m.currentIndex).toBe(1);
    expect(levelSentence(m)).toBe('Level 2 of 2 · 4 users');
    const l = m.levelProgress[1];
    expect(l).toMatchObject({ status: 'running', usersDone: 1, usersTotal: 4, usersFailed: 1, failedQueries: 2, failedQueriesSource: 'error.log' });
    expect(l.iteration).toMatchObject({ min: 1, max: 3, of: 3 });
    expect(iterationSentence(l, true)).toBe('Iteration 1–3 of 3');
    expect(m.levelProgress[0]).toMatchObject({ status: 'done', fraction: 1, failedQueries: 0, errorRate: 0, failedQueriesSource: 'summary' });
    expect(m.fraction).toBeGreaterThan(0.5);
    expect(m.fraction).toBeLessThan(1);
    expect(m.status).toBe('running');
    expect(p.fraction).toBeCloseTo(m.fraction as number);
  });

  it('without the progress folder the iteration is "not available" but level and users are still shown', () => {
    const f = folder('SalesA', 2);
    const p = computeProgress(inputs({
      parentActivities: [modelActivity('SalesA', 'InProgress')], childActivities: { 'child-SalesA': [levelActivity(2, 'InProgress')] },
      folders: [f], details: { [f.name]: { files: csvs(1) } },
    }));
    const l = p.models[0].levelProgress[0];
    expect(l.iteration).toBeNull();
    expect(iterationSentence(l, p.models[0].heartbeatSeen)).toBe('Iteration: not available');
    expect(l.usersDone).toBe(1);
    expect(l.fraction).toBe(0.5);
  });

  it('first heartbeat not written yet is not "not available" once another level had one', () => {
    expect(iterationSentence({ status: 'running', iteration: null } as never, true)).toContain('waiting');
  });

  it('level pending: not started; fraction 0', () => {
    const p = computeProgress(inputs({ parentActivities: [modelActivity('SalesA', 'InProgress')] }));
    expect(p.models[0].levelProgress.map((l) => l.status)).toEqual(['pending', 'pending']);
    expect(iterationSentence(p.models[0].levelProgress[0], false)).toBe('Iteration: not started');
    expect(p.models[0].fraction).toBe(0);
  });

  it('plan from the launched JSON gives the levels before they start; hyphenated heartbeat done reaches the iteration total', () => {
    const f = folder('M-1', 5);
    const p = computeProgress(inputs({
      plan: { models: [{ model_key: 'M-1', dataset: 'D', levels: [5, 10, 20] }] }, folders: [f],
      details: { [f.name]: { files: [] } }, heartbeats: { [f.name]: { total: 5, items: [hb(0, 'running', 1), hb(1, 'running', 1)] } },
    }));
    expect(p.models[0].levels).toEqual([5, 10, 20]);
    expect(levelSentence(p.models[0])).toBe('Level 1 of 3 · 5 users');
    expect(p.models[0].levelProgress[0].iteration).toMatchObject({ min: 2, max: 2, of: 3 });
    expect(p.models[0].dataset).toBe('D');
  });

  it('the heartbeat fraction accounts for users that have not started and for queries done', () => {
    const f = folder('A', 4);
    const p = computeProgress(inputs({
      plan: { models: [{ model_key: 'A', levels: [4] }] }, folders: [f], details: { [f.name]: { files: [] } },
      heartbeats: { [f.name]: { total: 2, items: [hb(0, 'running', 1, { queries_done: 9, queries_total: 18 }), hb(1, 'running', 1, { queries_done: 9, queries_total: 18 })] } },
    }));
    expect(p.models[0].levelProgress[0].fraction).toBeCloseTo(0.25); // half of the users started, each half way
  });

  it('summary.json ends the level: failed queries and error rate come from it; run_error / failed status mark it failed', () => {
    const f = folder('A', 2);
    const ok: FolderDetails = { files: [file('summary.json')], summary: { status: 'completed_with_errors', users_with_results: 2, missing_users: 0, failed_queries: 4, error_rate: 0.0167, queries: 240 } };
    const p1 = computeProgress(inputs({ plan: { models: [{ model_key: 'A', levels: [2] }] }, folders: [f], details: { [f.name]: ok } }));
    expect(p1.models[0].levelProgress[0]).toMatchObject({ status: 'done', failedQueries: 4, errorRate: 0.0167, usersDone: 2 });
    const bad: FolderDetails = { files: [], summary: { status: 'failed', run_error: 'RuntimeError: Load test failed', users_with_results: 0, missing_users: 2 } };
    const p2 = computeProgress(inputs({ plan: { models: [{ model_key: 'A', levels: [2] }] }, folders: [f], details: { [f.name]: bad } }));
    expect(p2.models[0].levelProgress[0].status).toBe('failed');
    expect(p2.models[0].status).toBe('failed');
  });

  it('exit value of the notebook activity is used when there is no summary.json read yet', () => {
    const act = levelActivity(2, 'Succeeded', { output: { result: { exitValue: JSON.stringify({ status: 'completed', users_with_results: 2, failed_queries: 1, error_rate: 0.01 }) } } });
    const p = computeProgress(inputs({ parentActivities: [modelActivity('A', 'InProgress', { input: { parameters: { model_key: 'A', ramp_levels: '[2]' } } })], childActivities: { 'child-A': [act] } }));
    expect(p.models[0].levelProgress[0]).toMatchObject({ status: 'done', failedQueries: 1, errorRate: 0.01 });
  });

  it('a failing level before any folder (validation error) shows the activity error, masked', () => {
    const act = levelActivity(2, 'Failed', { error: { message: 'Not a valid user principal name:\n  users, line 2: bob@contoso.com' } });
    const p = computeProgress(inputs({ parentActivities: [modelActivity('A', 'Failed')], childActivities: { 'child-A': [act] } }));
    expect(p.models[0].status).toBe('failed');
    expect(p.models[0].levelProgress[0].status).toBe('failed');
    expect(p.models[0].message).toContain('Not a valid user principal name');
    expect(p.models[0].message).not.toContain('@');
  });

  it('a finished run: succeeded models are done at 100 %; cancelled job marks running levels as cancelled', () => {
    const done = computeProgress(inputs({ job: { id: 'j', status: 'Completed' }, parentActivities: [modelActivity('A', 'Succeeded')] }));
    expect(done.finished).toBe(true);
    expect(done.models[0]).toMatchObject({ status: 'done', fraction: 1 });
    const f = folder('A', 2);
    const cancelled = computeProgress(inputs({
      job: { id: 'j', status: 'Cancelled' }, plan: { models: [{ model_key: 'A', levels: [2, 4] }] }, folders: [f], details: { [f.name]: { files: [] } },
    }));
    expect(cancelled.models[0].levelProgress[0].status).toBe('cancelled');
    expect(cancelled.models[0].status).toBe('cancelled');
  });

  it('models are discovered from the folders when neither the plan nor the activities are known; the same level twice maps in order', () => {
    const a = folder('A', 2, '20261120-100000');
    const b = folder('A', 2, '20261120-101000');
    const p = computeProgress(inputs({ folders: [b, a], details: { [a.name]: { files: [file('summary.json')], summary: { status: 'completed', users_with_results: 2 } }, [b.name]: { files: [] } } }));
    expect(p.models[0].levels).toEqual([2]);
    expect(p.models[0].levelsKnown).toBe(false);
    expect(p.models[0].fraction).toBeNull();
    expect(levelSentence(p.models[0])).toBe('Level 1 · 2 users');
    const twice = computeProgress(inputs({ plan: { models: [{ model_key: 'A', levels: [2, 2] }] }, folders: [b, a], details: { [a.name]: { files: [file('summary.json')], summary: { status: 'completed', users_with_results: 2 } }, [b.name]: { files: [] } } }));
    expect(twice.models[0].levelProgress.map((l) => l.status)).toEqual(['done', 'running']);
    expect(twice.models[0].levelProgress.map((l) => l.folder)).toEqual([a.name, b.name]);
  });

  it('two models progress independently', () => {
    const p = computeProgress(inputs({
      plan: { models: [{ model_key: 'A', levels: [1] }, { model_key: 'B', levels: [1, 2] }] },
      parentActivities: [modelActivity('A', 'Succeeded'), modelActivity('B', 'InProgress')],
    }));
    expect(p.models.map((m) => [m.model_key, m.status])).toEqual([['A', 'done'], ['B', 'running']]);
    expect(p.fraction).toBeCloseTo(0.5);
  });
});

describe('error.log', () => {
  it('separates failed queries from failed users and masks identities and connection strings', () => {
    const info = parseErrorLog('user 3 query error: Timeout for ana@contoso.com\nData Source=powerbi://x;Initial Catalog=M;EffectiveUserName=bob@contoso.com;  : boom\n');
    expect(info).toMatchObject({ lines: 2, queryErrors: 1, userFailures: 1 });
    expect(info.sample.join('\n')).not.toContain('@');
    expect(info.sample.join('\n')).not.toContain('Data Source');
  });
});
