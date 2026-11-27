import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRepoRoot } from '../../tools/helpbuild';
import { effectiveSettings, generate, resolveRls, stringifyParams, previewParams, type Params } from './generate';
import { importParams } from './importParams';
import {
  addModel, defaultForm, duplicateModel, patchCard, patchCardSettings, setSettingsMode, newCard, type FormState,
} from './model';
import { EXEC_KEYS, FLOAT_KEYS, PARAMETERS, PARAM_NAMES } from './parameters';

const REPO = defaultRepoRoot(process.cwd());
const pipeline = JSON.parse(readFileSync(join(REPO, 'pipelines', 'PL_PerfTest_MultiModel_v3.json'), 'utf8')).properties.parameters as Record<string, { type: string; defaultValue: unknown }>;
const doc = readFileSync(join(REPO, 'docs', 'pipeline-parameters.md'), 'utf8');

let n = 0;
const id = () => `t${++n}`;
const QF = '/lakehouse/default/Files/PerfScenarios/Queries/nav.json';
const UF = '/lakehouse/default/Files/PerfScenarios/Users/users.txt';

function base(over: Partial<FormState> = {}, models = 2): FormState {
  const f = defaultForm(id);
  f.models = Array.from({ length: models }, (_, i) => newCard(id(), { model_key: `M${i + 1}`, dataset: `Model ${i + 1}`, queryfile: QF }));
  return { ...f, ...over };
}
const models = (p: Params) => p.models as Record<string, unknown>[];

describe('schema against the pipeline JSON', () => {
  it('has the 19 parameters of the pipeline with its types and defaults', () => {
    expect(PARAM_NAMES).toHaveLength(19);
    expect([...PARAM_NAMES].sort()).toEqual(Object.keys(pipeline).sort());
    const kind: Record<string, string> = { models: 'Array', 'int-array': 'Array', string: 'String', enum: 'String', int: 'Int', bool: 'Bool', float: 'Float' };
    for (const p of PARAMETERS) {
      expect(kind[p.kind], p.name).toBe(pipeline[p.name].type);
      if (p.name !== 'models') expect(p.default, p.name).toEqual(pipeline[p.name].defaultValue);
    }
  });

  it('knows the ten per-model keys from the coalesce expressions of the pipeline', () => {
    const text = readFileSync(join(REPO, 'pipelines', 'PL_PerfTest_MultiModel_v3.json'), 'utf8');
    const coalesced = [...text.matchAll(/coalesce\(item\(\)\?\.(\w+), pipeline\(\)\.parameters\.\1\)/g)].map((m) => m[1]);
    expect(coalesced.sort()).toEqual([...EXEC_KEYS].sort());
  });
});

describe('generator: always 19 parameters', () => {
  it('emits all of them, in order, with defaults, and floats keep ".0"', () => {
    const g = generate(base());
    expect(g.errors).toEqual([]);
    expect(Object.keys(g.params)).toEqual(PARAM_NAMES);
    const text = stringifyParams(g.params);
    expect(JSON.parse(text)).toEqual(g.params);
    for (const k of FLOAT_KEYS) expect(text).toMatch(new RegExp(`"${k}": \\d+\\.\\d+`));
    expect(g.params.rls_source).toBe('list');
    expect(g.params.rls_users).toBe('');
  });
});

describe('mode A: run settings', () => {
  it('Global: ten globals emitted, no settings keys inside the models', () => {
    let f = base();
    f = { ...f, global: { ...f.global, iterations: '3', ramp_levels: '6, 20, 60', enable_think_times: false } };
    const g = generate(f);
    expect(g.params.iterations).toBe(3);
    expect(g.params.ramp_levels).toEqual([6, 20, 60]);
    expect(g.params.enable_think_times).toBe(false);
    for (const m of models(g.params)) expect(Object.keys(m)).toEqual(['model_key', 'dataset', 'workspace', 'queryfile']);
  });

  it('Per model: the cards are preloaded with the global values, globals go back to the pipeline defaults, every model has the ten keys', () => {
    let f = base();
    f = { ...f, global: { ...f.global, iterations: '3', delay_sec: '9' } };
    f = setSettingsMode(f, 'per_model');
    expect(f.models[0].settings.iterations).toBe('3');
    const g = generate(f);
    expect(g.errors).toEqual([]);
    expect(g.params.iterations).toBe(1); // greyed global: the pipeline default, not what was typed
    expect(g.params.delay_sec).toBe(4);
    for (const m of models(g.params)) {
      expect(Object.keys(m)).toEqual(['model_key', 'dataset', 'workspace', 'queryfile', ...EXEC_KEYS]);
      expect(m.iterations).toBe(3);
    }
  });

  it('emits per-model false, 0 and 0.0 (valid values, not "missing")', () => {
    let f = setSettingsMode(base(), 'per_model');
    f = patchCardSettings(f, f.models[0].id, { enable_think_times: false, think_time_scale: '0', think_time_jitter_pct: '0.0', delay_sec: '0', ramp_up_sec: '0.0' });
    const m0 = models(generate(f).params)[0];
    expect(m0.enable_think_times).toBe(false);
    expect(m0.think_time_scale).toBe(0);
    expect(m0.think_time_jitter_pct).toBe(0);
    expect(m0.delay_sec).toBe(0);
    expect(stringifyParams(generate(f).params)).toMatch(/"think_time_scale": 0\.0/);
  });

  it('cards that were edited keep their own values when switching modes; Global drops the keys again', () => {
    let f = setSettingsMode(base(), 'per_model');
    f = patchCardSettings(f, f.models[1].id, { iterations: '7' });
    f = setSettingsMode(setSettingsMode(f, 'global'), 'per_model');
    expect(f.models[1].settings.iterations).toBe('7');
    for (const m of models(generate(setSettingsMode(f, 'global')).params)) expect(m.iterations).toBeUndefined();
  });

  it('validates ranges (levels 1–300, jitter 0–1, negative values)', () => {
    const bad = (patch: Partial<FormState['global']>) => generate({ ...base(), global: { ...base().global, ...patch } }).errors.map((e) => e.code);
    expect(bad({ ramp_levels: '0' })).toContain('invalid_ramp_levels');
    expect(bad({ ramp_levels: '301' })).toContain('invalid_ramp_levels');
    expect(bad({ ramp_levels: '5, x' })).toContain('invalid_ramp_levels');
    expect(bad({ think_time_jitter_pct: '1.5' })).toContain('invalid_think_time_jitter_pct');
    expect(bad({ iterations: '0' })).toContain('invalid_iterations');
    expect(bad({ delay_sec: '-1' })).toContain('invalid_delay_sec');
    expect(bad({ ramp_up_sec: '-2' })).toContain('invalid_ramp_up_sec');
    expect(bad({ iterations: '1.5' })).toContain('invalid_iterations');
    expect(bad({ ramp_levels: '1, 300' })).toEqual([]);
  });

  it('per-model validation points at the card', () => {
    let f = setSettingsMode(base(), 'per_model');
    f = patchCardSettings(f, f.models[1].id, { ramp_levels: '500' });
    const e = generate(f).errors[0];
    expect(e.cardId).toBe(f.models[1].id);
    expect(e.field).toBe(`models.${f.models[1].id}.settings.ramp_levels`);
  });
});

describe('mode B: RLS (table 6.3 B)', () => {
  const USERS = 'ana@contoso.com; Bob@contoso.com, ana@CONTOSO.com\n# comment\ncarol@contoso.com';

  it('none: nothing of RLS is emitted whatever is typed in the greyed fields', () => {
    let f = base({ rlsSource: 'none', rls_users: USERS, rls_users_file: UF });
    f = patchCard(f, f.models[0].id, { users: USERS, users_file: UF });
    const g = generate(f);
    expect(g.errors).toEqual([]);
    expect(g.params).toMatchObject({ rls_source: 'none', rls_scope: 'global', rls_users: '', rls_users_file: '' });
    for (const m of models(g.params)) { expect(m.users).toBeUndefined(); expect(m.users_file).toBeUndefined(); }
  });

  it('list + global: normalised rls_users (case-insensitive de-duplication, first spelling kept)', () => {
    const g = generate(base({ rlsSource: 'list', rlsScope: 'global', rls_users: USERS, rls_users_file: UF }));
    expect(g.params.rls_users).toBe('ana@contoso.com,Bob@contoso.com,carol@contoso.com');
    expect(g.params.rls_users_file).toBe('');
    for (const m of models(g.params)) expect(m.users).toBeUndefined();
  });

  it('file + global: rls_users_file only', () => {
    const g = generate(base({ rlsSource: 'file', rlsScope: 'global', rls_users: USERS, rls_users_file: UF }));
    expect(g.errors).toEqual([]);
    expect(g.params.rls_users).toBe('');
    expect(g.params.rls_users_file).toBe(UF);
    expect(g.files).toContain(UF);
  });

  it('file + global without a file is an error', () => {
    expect(generate(base({ rlsSource: 'file', rlsScope: 'global' })).errors.map((e) => e.code)).toContain('rls_file_missing');
  });

  it('list + per_model: users in every model, global fields emitted empty; a model without users blocks', () => {
    let f = base({ rlsSource: 'list', rlsScope: 'per_model', rls_users: USERS, rls_users_file: UF });
    f = patchCard(f, f.models[0].id, { users: 'a@x.com, b@x.com', users_file: UF });
    let g = generate(f);
    expect(g.errors.map((e) => e.code)).toEqual(['users_missing']);
    expect(g.errors[0].message).toContain('without impersonation');
    f = patchCard(f, f.models[1].id, { users: 'c@x.com' });
    g = generate(f);
    expect(g.errors).toEqual([]);
    expect(g.params).toMatchObject({ rls_users: '', rls_users_file: '' });
    expect(models(g.params).map((m) => m.users)).toEqual([['a@x.com', 'b@x.com'], ['c@x.com']]);
    for (const m of models(g.params)) expect(m.users_file).toBeUndefined();
  });

  it('file + per_model: users_file in every model; a model without a file blocks', () => {
    let f = base({ rlsSource: 'file', rlsScope: 'per_model', rls_users: USERS, rls_users_file: UF });
    f = patchCard(f, f.models[0].id, { users_file: UF, users: USERS });
    expect(generate(f).errors.map((e) => e.code)).toEqual(['users_file_missing']);
    f = patchCard(f, f.models[1].id, { users_file: '/lakehouse/default/Files/PerfScenarios/Users/b.txt' });
    const g = generate(f);
    expect(g.errors).toEqual([]);
    expect(g.params).toMatchObject({ rls_users: '', rls_users_file: '' });
    expect(models(g.params).map((m) => m.users_file)).toEqual([UF, '/lakehouse/default/Files/PerfScenarios/Users/b.txt']);
    for (const m of models(g.params)) expect(m.users).toBeUndefined();
  });

  it('rejects invalid UPN lines', () => {
    expect(generate(base({ rlsSource: 'list', rls_users: 'ok@x.com\nnot-a-upn' })).errors.map((e) => e.code)).toContain('rls_users_invalid');
  });
});

describe('mode C: navigation file', () => {
  it('one file per model: each queryfile is emitted', () => {
    let f = base();
    f = patchCard(f, f.models[0].id, { queryfile: '/lakehouse/default/Files/PerfScenarios/Queries/a.json' });
    f = patchCard(f, f.models[1].id, { queryfile: '/lakehouse/default/Files/PerfScenarios/Queries/b.json' });
    f = { ...f, globalQueryfile: '/lakehouse/default/Files/PerfScenarios/Queries/ignored.json' };
    expect(models(generate(f).params).map((m) => m.queryfile)).toEqual([
      '/lakehouse/default/Files/PerfScenarios/Queries/a.json', '/lakehouse/default/Files/PerfScenarios/Queries/b.json']);
  });

  it('same file for all: the global path goes to every model and the cards are ignored', () => {
    let f = base({ navMode: 'same', globalQueryfile: '/lakehouse/default/Files/PerfScenarios/Queries/shared.json' });
    f = patchCard(f, f.models[0].id, { queryfile: '/lakehouse/default/Files/PerfScenarios/Queries/own.json' });
    const g = generate(f);
    expect(models(g.params).map((m) => m.queryfile)).toEqual(Array(2).fill('/lakehouse/default/Files/PerfScenarios/Queries/shared.json'));
    expect(g.warnings.map((w) => w.code)).toContain('same_nav_models');
    expect(generate({ ...f, globalQueryfile: '' }).errors.map((e) => e.field)).toContain('globalQueryfile');
  });

  it('validates the path: prefix, spaces, .json', () => {
    const code = (p: string) => generate(patchCard(base({}, 1), base({}, 1).models[0].id, { queryfile: p })).errors.map((e) => e.code);
    const f1 = base({}, 1);
    const run = (p: string) => generate(patchCard(f1, f1.models[0].id, { queryfile: p })).errors.map((e) => e.code);
    expect(run('Files/x.json')).toContain('queryfile_path');
    expect(run('/lakehouse/default/Files/a b.json')).toContain('queryfile_path');
    expect(run('/lakehouse/default/Files/a.txt')).toContain('queryfile_ext');
    expect(run('')).toContain('queryfile_empty');
    expect(code(QF)).toEqual([]);
  });
});

describe('models', () => {
  it('blocks a GUID in workspace and accepts a name', () => {
    const f = base({}, 1);
    const set = (w: string) => generate(patchCard(f, f.models[0].id, { workspaceMode: 'other', workspace: w }));
    expect(set('3fa85f64-5717-4562-b3fc-2c963f66afa6').errors.map((e) => e.code)).toContain('workspace_guid');
    expect(set('{3FA85F64-5717-4562-B3FC-2C963F66AFA6}').errors.map((e) => e.code)).toContain('workspace_guid');
    expect(set('Finance').errors).toEqual([]);
    expect(models(set('Finance').params)[0].workspace).toBe('Finance');
    expect(models(generate(patchCard(f, f.models[0].id, { workspaceMode: 'same', workspace: 'ignored' })).params)[0].workspace).toBe('');
  });

  it('requires unique valid model_key and rejects CHANGE_ME', () => {
    const f = base();
    expect(generate(patchCard(f, f.models[1].id, { model_key: 'M1' })).errors.map((e) => e.code)).toContain('key_duplicate');
    expect(generate(patchCard(f, f.models[1].id, { model_key: 'a b' })).errors.map((e) => e.code)).toContain('key_chars');
    expect(generate(patchCard(f, f.models[1].id, { dataset: 'CHANGE_ME_SEMANTIC_MODEL_NAME' })).errors.map((e) => e.code)).toContain('dataset_placeholder');
    expect(generate({ ...f, models: [] }).errors.map((e) => e.code)).toContain('no_models');
  });

  it('prefix rules and result parameters', () => {
    expect(generate(base({ test_name_prefix: '' })).errors.map((e) => e.code)).toContain('prefix_empty');
    expect(generate(base({ test_name_prefix: 'a b' })).errors.map((e) => e.code)).toContain('prefix_spaces');
    expect(generate(base({ test_name_prefix: 'a/b' })).warnings.map((e) => e.code)).toContain('prefix_chars');
    expect(generate(base({ fail_on_error_rate: '2' })).errors.map((e) => e.code)).toContain('invalid_fail_on_error_rate');
    const g = generate(base({ stop_on_query_error: true, fail_on_error_rate: '0.05', write_results_to_tables: true }));
    expect(g.params).toMatchObject({ stop_on_query_error: true, fail_on_error_rate: 0.05, write_results_to_tables: true });
  });

  it('duplicate keeps dataset/workspace, suggests <key>-2 and does not copy users', () => {
    let f = base({}, 1);
    f = patchCard(f, f.models[0].id, { users: 'a@x.com', users_file: UF, workspaceMode: 'other', workspace: 'Finance' });
    f = duplicateModel(f, f.models[0].id, id());
    expect(f.models[1]).toMatchObject({ model_key: 'M1-2', dataset: 'Model 1', workspace: 'Finance', users: '', users_file: '' });
    f = duplicateModel(f, f.models[0].id, id());
    expect(f.models.map((m) => m.model_key)).toEqual(['M1', 'M1-3', 'M1-2']);
    expect(addModel(f, id()).models).toHaveLength(4);
  });

  it('profiles on the same semantic model warn (load, results, overlap); more than 10 models warn; levels ≥ 100 warn', () => {
    let f = base({}, 1);
    f = duplicateModel(f, f.models[0].id, id());
    f = { ...f, global: { ...f.global, ramp_levels: '10, 100' } };
    const g = generate(f);
    expect(g.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['profiles_load', 'profiles_results', 'profiles_overlap', 'high_levels']));
    expect(g.peaks[0].peak).toBe(200);
    const many = base({}, 11);
    many.models.forEach((m, i) => { m.model_key = `K${i}`; });
    expect(generate(many).warnings.map((w) => w.code)).toContain('many_models');
  });
});

describe('effective configuration of the validated Fabric test (ProfA / ProfB / ProfC)', () => {
  const input = {
    models: [
      { model_key: 'ProfA', dataset: 'ModelA', workspace: '', queryfile: QF, ramp_levels: [1, 2], iterations: 1, delay_sec: 0, enable_think_times: false },
      { model_key: 'ProfB', dataset: 'ModelA', workspace: '', queryfile: QF, ramp_levels: [3], iterations: 2, think_time_scale: 0.0 },
      { model_key: 'ProfC', dataset: 'ModelB', workspace: '', queryfile: QF },
    ],
    test_name_prefix: 'v331', ramp_levels: [1, 5, 10], iterations: 1, delay_sec: 4, enable_think_times: true, think_time_scale: 1.0,
    max_think_time_sec: 60.0, think_time_jitter_pct: 0.1, fallback_think_time_sec: 0.0, ramp_up_sec: 0.0, initial_user_jitter_sec: 0.0,
    rls_source: 'none', rls_scope: 'global', rls_users: '', rls_users_file: '',
  };

  it('is identical to what the pipeline computes from the original JSON, and ProfC carries the ten keys with the global values', () => {
    const r = importParams(JSON.stringify(input), id);
    expect(r.error).toBeUndefined();
    expect(r.form!.settingsMode).toBe('per_model');
    const g = generate(r.form!);
    expect(g.errors).toEqual([]);
    const original = effectiveSettings({ ...input } as Params);
    const emitted = effectiveSettings(g.params);
    expect(emitted).toEqual(original);
    expect(emitted[0]).toMatchObject({ ramp_levels: [1, 2], iterations: 1, delay_sec: 0, enable_think_times: false });
    expect(emitted[1]).toMatchObject({ ramp_levels: [3], iterations: 2, think_time_scale: 0 });
    const profC = models(g.params)[2];
    for (const k of EXEC_KEYS) expect(profC[k], k).toEqual((input as Record<string, unknown>)[k]);
    expect(r.report.warnings.join(' ')).toContain('ProfC');
  });

  it('a JSON without own settings loads in Global mode', () => {
    const r = importParams(JSON.stringify({ ...input, models: input.models.map((m) => ({ model_key: m.model_key, dataset: m.dataset, workspace: '', queryfile: QF })) }), id);
    expect(r.form!.settingsMode).toBe('global');
    expect(r.form!.navMode).toBe('same');
    expect(generate(r.form!).params.ramp_levels).toEqual([1, 5, 10]);
  });
});

describe('documentation examples and RLS recipes round trip', () => {
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]) as Record<string, unknown>);
  const find = (pred: (b: Record<string, unknown>) => boolean) => blocks.find(pred)!;
  const roundTrip = (input: Record<string, unknown>) => {
    const r = importParams(JSON.stringify(input), id);
    expect(r.error).toBeUndefined();
    const g = generate(r.form!);
    expect(g.errors, JSON.stringify(g.errors)).toEqual([]);
    return { r, g };
  };
  const subset = (emitted: Params, input: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(input)) {
      if (k === 'models') {
        (v as Record<string, unknown>[]).forEach((m, i) => { for (const [mk, mv] of Object.entries(m)) expect(models(emitted)[i][mk], `${k}[${i}].${mk}`).toEqual(mv); });
      } else expect(emitted[k], k).toEqual(v);
    }
  };

  it('found the examples', () => { expect(blocks.length).toBeGreaterThanOrEqual(9); });

  it('recipe 1: no impersonation', () => {
    const i = { ...find((b) => Object.keys(b).length === 1 && b.rls_source === 'none'), models: [{ model_key: 'A', dataset: 'A', workspace: '', queryfile: QF }] };
    subset(roundTrip(i).g.params, i);
  });

  it('recipe 2: global typed users', () => {
    const i = { ...find((b) => b.rls_source === 'list' && b.rls_scope === 'global' && !b.models), models: [{ model_key: 'A', dataset: 'A', workspace: '', queryfile: QF }] };
    subset(roundTrip(i).g.params, i);
  });

  it('recipe 3: global file', () => {
    const i = { ...find((b) => b.rls_source === 'file' && b.rls_scope === 'global' && !b.models), models: [{ model_key: 'A', dataset: 'A', workspace: '', queryfile: QF }] };
    subset(roundTrip(i).g.params, i);
  });

  it('recipe 4: per model, typed users', () => { const i = find((b) => b.rls_source === 'list' && b.rls_scope === 'per_model' && !!b.models); subset(roundTrip(i).g.params, i); });

  it('recipe 5: one users file per model', () => { const i = find((b) => b.rls_source === 'file' && b.rls_scope === 'per_model' && !!b.models); subset(roundTrip(i).g.params, i); });

  it('recipe 6: the global fallback is discarded and copied to the models that lack their own (with a warning)', () => {
    const i = find((b) => b.rls_source === 'file' && b.rls_scope === 'per_model' && !b.models);
    const withModels = { ...i, models: [
      { model_key: 'A', dataset: 'A', workspace: '', queryfile: QF, users_file: '/lakehouse/default/Files/PerfScenarios/Users/own.txt' },
      { model_key: 'B', dataset: 'B', workspace: '', queryfile: QF }] };
    const { r, g } = roundTrip(withModels);
    expect(r.report.warnings.join(' ')).toContain('global fallback');
    expect(g.params.rls_users_file).toBe('');
    expect(models(g.params).map((m) => m.users_file)).toEqual(['/lakehouse/default/Files/PerfScenarios/Users/own.txt', i.rls_users_file]);
    // the identities of every model are unchanged
    const before = withModels.models.map((m) => resolveRls(withModels as unknown as Params, m));
    const after = models(g.params).map((m) => resolveRls(g.params, m));
    expect(after).toEqual(before);
  });

  it('per-model example: the effective settings of every model do not change', () => {
    const i = find((b) => Array.isArray(b.models) && (b.models as { ramp_levels?: unknown }[]).some((m) => m.ramp_levels) && b.rls_scope === 'per_model');
    const { g } = roundTrip(i);
    expect(effectiveSettings(g.params)).toEqual(effectiveSettings(i as Params));
  });

  it('complete example: the documented values are reproduced', () => {
    const i = find((b) => b.ramp_up_sec === 30);
    const { g } = roundTrip(i);
    subset(g.params, i);
  });

  it('flags names that are not parameters and does not import them', () => {
    const r = importParams(JSON.stringify({ models: [{ model_key: 'A', dataset: 'A', workspace: '', queryfile: QF, colour: 1 }], ramp_level: [1], stop_on_query_error: true }), id);
    expect(r.report.unknown).toEqual(expect.arrayContaining([{ where: 'parameters', name: 'ramp_level' }, { where: 'models[0]', name: 'colour' }]));
    expect(generate(r.form!).params.stop_on_query_error).toBe(true);
    expect(importParams('{}', id).error).toBeDefined();
    expect(importParams('nope', id).error).toContain('JSON');
  });
});

describe('preview privacy', () => {
  it('hides the UPNs in the preview but not in the real JSON', () => {
    let f = base({ rlsSource: 'list', rlsScope: 'per_model' });
    f = patchCard(f, f.models[0].id, { users: 'a@x.com, b@x.com' });
    f = patchCard(f, f.models[1].id, { users: 'c@x.com' });
    const g = generate(f);
    expect(stringifyParams(g.params)).toContain('a@x.com');
    expect(previewParams(g.params)).not.toContain('@');
    expect(previewParams(g.params)).toContain('«2 users»');
  });
});
