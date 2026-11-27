import {
  EXEC_KEYS, FLOAT_KEYS, LAKEHOUSE_PREFIX, MAX_LEVEL, MAX_PARALLEL_MODELS, PARAMETERS, PARAM_BY_NAME,
} from './parameters';
import type { ExecForm, FormState, ModelCard } from './model';
import { joinUpns, parseUpns, redactParams } from './privacy';

export type Severity = 'error' | 'warning' | 'info';
export interface Issue { severity: Severity; code: string; message: string; field?: string; cardId?: string }

export interface ExecValues {
  ramp_levels: number[]; iterations: number; delay_sec: number; enable_think_times: boolean;
  think_time_scale: number; max_think_time_sec: number; think_time_jitter_pct: number; fallback_think_time_sec: number;
  ramp_up_sec: number; initial_user_jitter_sec: number;
}

export type Params = Record<string, unknown>;

export interface EffectiveModel {
  cardId: string; model_key: string; dataset: string; workspace: string; queryfile: string;
  rls: { kind: 'none' | 'list' | 'file'; count?: number; file?: string };
  exec: ExecValues;
}

export interface PeakInfo { dataset: string; workspace: string; peak: number; profiles: string[] }

export interface Generated {
  params: Params;
  issues: Issue[];
  errors: Issue[];
  warnings: Issue[];
  infos: Issue[];
  effective: EffectiveModel[];
  /** One sentence per aspect of the test, in natural language. */
  summary: string[];
  peaks: PeakInfo[];
  /** Paths of lakehouse files the JSON refers to (navigation, users). */
  files: string[];
  cardLines: Record<string, string>;
}

const GUID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;
export const isGuid = (s: string) => GUID.test(s.trim());

export function parseIntText(t: string): number | null {
  return /^\s*[+-]?\d+\s*$/.test(t) ? Number(t) : null;
}
export function parseNumberText(t: string): number | null {
  const s = t.trim().replace(/^([+-]?\d+),(\d+)$/, '$1.$2');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseLevels(t: string): { levels: number[]; error?: string } {
  const tokens = t.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return { levels: [], error: 'Enter at least one level.' };
  const levels: number[] = [];
  for (const tok of tokens) {
    const n = parseIntText(tok);
    if (n === null) return { levels: [], error: `"${tok}" is not an integer.` };
    if (n < 1 || n > MAX_LEVEL) return { levels: [], error: `${n} is outside 1–${MAX_LEVEL}.` };
    levels.push(n);
  }
  return { levels };
}

const fieldOf = (scope: string, key: string) => (scope ? `${scope}.${key}` : key);

/** Parses and validates the ten execution settings. `raw` keeps the typed text of an invalid value so the preview shows it. */
function parseExec(f: ExecForm, scope: string, cardId: string | undefined, issues: Issue[]): { values: ExecValues; raw: Record<string, unknown> } {
  const raw: Record<string, unknown> = {};
  const values = {} as Record<string, unknown>;
  const fail = (key: string, message: string) => issues.push({ severity: 'error', code: `invalid_${key}`, field: fieldOf(scope, key), cardId, message });
  const label = (key: string) => PARAM_BY_NAME[key].label;
  for (const key of EXEC_KEYS) {
    const def = PARAM_BY_NAME[key];
    const typed = f[key as keyof ExecForm];
    if (key === 'ramp_levels') {
      const r = parseLevels(typed as string);
      if (r.error) { fail(key, `${label(key)}: ${r.error}`); raw[key] = typed; values[key] = def.default; } else { raw[key] = r.levels; values[key] = r.levels; }
    } else if (key === 'enable_think_times') {
      raw[key] = values[key] = typed as boolean;
    } else if (def.kind === 'int') {
      const n = parseIntText(typed as string);
      if (n === null || (def.min !== undefined && n < def.min)) { fail(key, `${label(key)} must be an integer${def.min !== undefined ? ` ≥ ${def.min}` : ''}.`); raw[key] = typed; values[key] = def.default; } else { raw[key] = values[key] = n; }
    } else {
      const n = parseNumberText(typed as string);
      const bad = n === null || (def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max);
      if (bad) {
        fail(key, `${label(key)} must be a number ${def.max !== undefined ? `from ${def.min} to ${def.max}` : `≥ ${def.min}`}.`);
        raw[key] = typed; values[key] = def.default;
      } else { raw[key] = values[key] = n; }
    }
  }
  return { values: values as unknown as ExecValues, raw };
}

const defaultsExec = (): ExecValues => Object.fromEntries(EXEC_KEYS.map((k) => [k, PARAM_BY_NAME[k].default])) as unknown as ExecValues;

export function levelsText(levels: number[]): string {
  if (levels.length === 1) return `a fixed ${levels[0]} user${levels[0] === 1 ? '' : 's'}`;
  return `${levels.slice(0, -1).join(', ')} and ${levels[levels.length - 1]} users`;
}

function thinkText(e: ExecValues): string {
  if (!e.enable_think_times) return `no think times (stress style), ${e.delay_sec} s between iterations`;
  const pace = e.think_time_scale === 1 ? 'recorded pace' : e.think_time_scale === 0 ? 'no pauses' : `pauses ×${e.think_time_scale}`;
  return `${pace}${e.think_time_jitter_pct ? ` (±${Math.round(e.think_time_jitter_pct * 100)} %)` : ''}`;
}

function cardLine(e: EffectiveModel, nav: string): string {
  const x = e.exec;
  const ramp = x.ramp_levels.length === 1 ? `${x.ramp_levels[0]} users` : `ramp ${x.ramp_levels.join(' → ')}`;
  const rls = e.rls.kind === 'none' ? 'no RLS' : e.rls.kind === 'file' ? `users from ${(e.rls.file ?? '').split('/').pop() || 'a file'}` : `${e.rls.count ?? 0} users`;
  return `${ramp} · ${x.iterations} iteration${x.iterations === 1 ? '' : 's'} · ${thinkText(x)} · ${rls}${nav ? ` · ${nav}` : ''}`;
}

const lakehousePathProblem = (p: string): string | null => {
  if (!p.startsWith(LAKEHOUSE_PREFIX)) return `must start with ${LAKEHOUSE_PREFIX}`;
  if (/\s/.test(p)) return 'must not contain spaces';
  return null;
};

/** Builds the pipeline parameters from the form. All 19 parameters are always emitted. */
export function generate(form: FormState): Generated {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string, field?: string, cardId?: string) => issues.push({ severity, code, message, field, cardId });
  const perModelSettings = form.settingsMode === 'per_model';

  // --- global settings: typed values in Global mode, the pipeline defaults (greyed, not used) in Per model mode
  const parsedGlobal = perModelSettings ? null : parseExec(form.global, 'global', undefined, issues);
  const globalValues: ExecValues = parsedGlobal ? parsedGlobal.values : defaultsExec();
  const globalRaw: Record<string, unknown> = parsedGlobal ? parsedGlobal.raw : { ...defaultsExec() };

  // --- test name prefix
  const prefix = form.test_name_prefix.trim();
  if (!prefix) add('error', 'prefix_empty', 'The test name prefix is required.', 'test_name_prefix');
  else if (/\s/.test(prefix)) add('error', 'prefix_spaces', 'The test name prefix must not contain spaces.', 'test_name_prefix');
  else if (!/^[A-Za-z0-9_.-]+$/.test(prefix)) add('warning', 'prefix_chars', 'Recommended characters for the prefix: letters, digits, . _ -', 'test_name_prefix');

  // --- results parameters
  const failRate = parseNumberText(form.fail_on_error_rate);
  if (failRate === null || failRate < 0 || failRate > 1) add('error', 'invalid_fail_on_error_rate', 'Fail above error rate must be a number from 0 to 1.', 'fail_on_error_rate');

  // --- RLS
  const { rlsSource: source, rlsScope: scope } = form;
  const globalListUpns = source === 'list' && scope === 'global' ? parseUpns(form.rls_users) : { upns: [], duplicates: 0, invalidLines: [] };
  if (source === 'list' && scope === 'global') {
    if (globalListUpns.invalidLines.length) add('error', 'rls_users_invalid', `Lines not in user@domain format: ${globalListUpns.invalidLines.join(', ')}.`, 'rls_users');
    if (!globalListUpns.upns.length && !globalListUpns.invalidLines.length) add('warning', 'rls_empty', 'No users: the identity that runs the test is used (no RLS impersonation).', 'rls_users');
  }
  const globalUsersFile = form.rls_users_file.trim();
  if (source === 'file' && scope === 'global') {
    if (!globalUsersFile) add('error', 'rls_file_missing', 'Choose or upload the users file (rls_users_file).', 'rls_users_file');
    else { const p = lakehousePathProblem(globalUsersFile); if (p) add('error', 'rls_file_path', `rls_users_file ${p}.`, 'rls_users_file'); }
  }

  // --- models
  if (!form.models.length) add('error', 'no_models', 'Add at least one model.', 'models');
  if (form.models.length > MAX_PARALLEL_MODELS) add('warning', 'many_models', `More than ${MAX_PARALLEL_MODELS} models: only ${MAX_PARALLEL_MODELS} run at the same time, the rest wait.`, 'models');
  const keyCount = new Map<string, number>();
  const keyLower = new Map<string, number>();
  form.models.forEach((m) => { const k = m.model_key.trim(); keyCount.set(k, (keyCount.get(k) ?? 0) + 1); keyLower.set(k.toLowerCase(), (keyLower.get(k.toLowerCase()) ?? 0) + 1); });

  const effective: EffectiveModel[] = [];
  const files = new Set<string>();
  const models = form.models.map((m: ModelCard, index) => {
    const at = (key: string) => `models.${m.id}.${key}`;
    const name = m.model_key.trim() || `model ${index + 1}`;
    const out: Record<string, unknown> = {};
    const modelKey = m.model_key.trim();
    if (!modelKey) add('error', 'key_empty', `Model ${index + 1}: model_key is required.`, at('model_key'), m.id);
    else if (!/^[A-Za-z0-9_-]+$/.test(modelKey)) add('error', 'key_chars', `${name}: model_key accepts only letters, digits, - and _.`, at('model_key'), m.id);
    else if (/CHANGE_ME/i.test(modelKey)) add('error', 'key_placeholder', `${name}: replace the CHANGE_ME placeholder.`, at('model_key'), m.id);
    else if ((keyCount.get(modelKey) ?? 0) > 1) add('error', 'key_duplicate', `${name}: model_key must be unique.`, at('model_key'), m.id);
    else if ((keyLower.get(modelKey.toLowerCase()) ?? 0) > 1) add('warning', 'key_case', `${name}: another model_key differs only in upper/lower case.`, at('model_key'), m.id);

    const dataset = m.dataset.trim();
    if (!dataset) add('error', 'dataset_empty', `${name}: the semantic model name (dataset) is required.`, at('dataset'), m.id);
    else if (/CHANGE_ME/i.test(dataset)) add('error', 'dataset_placeholder', `${name}: replace the CHANGE_ME placeholder with the exact model name.`, at('dataset'), m.id);

    let workspace = '';
    if (m.workspaceMode === 'other') {
      workspace = m.workspace.trim();
      if (!workspace) add('error', 'workspace_empty', `${name}: choose the workspace of the model or use "Same workspace".`, at('workspace'), m.id);
      else if (isGuid(workspace)) add('error', 'workspace_guid', `${name}: the workspace must be its display name, not a GUID (the XMLA address is built from the name).`, at('workspace'), m.id);
    }

    const queryfile = (form.navMode === 'same' ? form.globalQueryfile : m.queryfile).trim();
    const qField = form.navMode === 'same' ? 'globalQueryfile' : at('queryfile');
    if (!queryfile) add('error', 'queryfile_empty', form.navMode === 'same' ? 'Choose or upload the navigation file shared by all models.' : `${name}: choose or upload the navigation file.`, qField, form.navMode === 'same' ? undefined : m.id);
    else {
      const p = lakehousePathProblem(queryfile);
      if (p) add('error', 'queryfile_path', `${name}: the navigation file ${p}.`, qField, m.id);
      else if (!/\.json$/i.test(queryfile)) add('error', 'queryfile_ext', `${name}: the navigation file must end in .json.`, qField, m.id);
      else files.add(queryfile);
    }

    out.model_key = modelKey; out.dataset = dataset; out.workspace = workspace; out.queryfile = queryfile;

    // RLS inside the model
    let rls: EffectiveModel['rls'] = { kind: 'none' };
    if (source === 'list' && scope === 'per_model') {
      const u = parseUpns(m.users);
      if (u.invalidLines.length) add('error', 'users_invalid', `${name}: lines not in user@domain format: ${u.invalidLines.join(', ')}.`, at('users'), m.id);
      else if (!u.upns.length) add('error', 'users_missing', `${name}: this model would run without impersonation; add users or switch the RLS scope to global.`, at('users'), m.id);
      out.users = u.upns;
      rls = { kind: 'list', count: u.upns.length };
    } else if (source === 'file' && scope === 'per_model') {
      const f = m.users_file.trim();
      if (!f) add('error', 'users_file_missing', `${name}: choose or upload its users file; a model without one would run without impersonation.`, at('users_file'), m.id);
      else { const p = lakehousePathProblem(f); if (p) add('error', 'users_file_path', `${name}: users_file ${p}.`, at('users_file'), m.id); else files.add(f); }
      out.users_file = f;
      rls = { kind: 'file', file: f };
    } else if (source === 'list') rls = { kind: 'list', count: globalListUpns.upns.length || 0 };
    else if (source === 'file') rls = { kind: 'file', file: globalUsersFile };
    if (source === 'list' && scope === 'global' && !globalListUpns.upns.length) rls = { kind: 'none' };

    // execution settings inside the model
    let exec = globalValues;
    if (perModelSettings) {
      const parsed = parseExec(m.settings, `models.${m.id}.settings`, m.id, issues);
      Object.assign(out, parsed.raw);
      exec = parsed.values;
    }
    effective.push({ cardId: m.id, model_key: modelKey, dataset, workspace, queryfile, rls, exec });
    return out;
  });

  if (source === 'file' && scope === 'global' && globalUsersFile && !lakehousePathProblem(globalUsersFile)) files.add(globalUsersFile);

  // --- warnings that need the whole picture
  const peaks = new Map<string, PeakInfo>();
  effective.forEach((e) => {
    const key = `${e.workspace.toLowerCase()}|${e.dataset.toLowerCase()}`;
    const peak = Math.max(0, ...e.exec.ramp_levels);
    const cur = peaks.get(key) ?? { dataset: e.dataset, workspace: e.workspace, peak: 0, profiles: [] };
    cur.peak += peak; cur.profiles.push(e.model_key);
    peaks.set(key, cur);
  });
  for (const p of peaks.values()) {
    if (p.profiles.length > 1 && p.dataset) {
      const names = p.profiles.join(', ');
      add('warning', 'profiles_load', `Profiles on the same semantic model "${p.dataset}" (${names}): the theoretical peak load is the sum of the highest level of each profile, ${p.peak} users.`, 'models');
      add('warning', 'profiles_results', `Profiles on "${p.dataset}": compare them by loadtest_id (it contains the model_key); the "model" column of the results is the same for all.`, 'models');
      add('warning', 'profiles_overlap', `Profiles on "${p.dataset}": each profile starts its own Spark session, so the loads may not overlap exactly.`, 'models');
    }
  }
  const high = effective.filter((e) => e.exec.ramp_levels.some((l) => l >= 100));
  if (high.length) add('warning', 'high_levels', 'Levels of 100 users or more need a bigger Spark session: raise vCores in the %%configure cell of RunLoadTest_v3.', 'ramp_levels');
  if (form.navMode === 'same' && new Set(effective.map((e) => `${e.workspace}|${e.dataset}`)).size > 1) {
    add('warning', 'same_nav_models', 'The same navigation file for different semantic models: the Performance Analyzer export contains queries of one specific model and may fail on another.', 'globalQueryfile');
  }
  if (source !== 'none') {
    add('info', 'rls_permissions', 'Every impersonated user must exist in the tenant and have read and build permission on the model. Do not use workspace admins.', 'rls_source');
    for (const e of effective) {
      if (e.rls.kind === 'list' && e.rls.count && Math.max(...e.exec.ramp_levels) > e.rls.count) {
        add('info', 'rls_reuse', `${e.model_key || 'A model'}: the top level has more virtual users than identities (${e.rls.count}); identities are reused in turn (user[i mod n]).`, 'rls_users', e.cardId);
      }
    }
  }
  // --- params
  const dflt = (k: string) => PARAM_BY_NAME[k].default;
  const emitUsers = source === 'list' && scope === 'global' ? joinUpns(globalListUpns.upns) : '';
  const emitUsersFile = source === 'file' && scope === 'global' ? globalUsersFile : '';
  const params: Params = {};
  for (const def of PARAMETERS) {
    const k = def.name;
    if (k === 'models') params.models = models;
    else if (k === 'test_name_prefix') params[k] = prefix;
    else if (EXEC_KEYS.includes(k)) params[k] = globalRaw[k];
    else if (k === 'rls_source') params[k] = source;
    else if (k === 'rls_scope') params[k] = source === 'none' ? dflt('rls_scope') : scope;
    else if (k === 'rls_users') params[k] = emitUsers;
    else if (k === 'rls_users_file') params[k] = emitUsersFile;
    else if (k === 'stop_on_query_error') params[k] = form.stop_on_query_error;
    else if (k === 'fail_on_error_rate') params[k] = failRate === null ? form.fail_on_error_rate : failRate;
    else if (k === 'write_results_to_tables') params[k] = form.write_results_to_tables;
  }

  // --- summary
  const summary: string[] = [];
  const n = effective.length;
  summary.push(`${n} model${n === 1 ? '' : 's'} ${n === 1 ? 'runs' : 'in parallel'}.`);
  if (perModelSettings) summary.push('Each model has its own ramp, iterations and think times (see each card).');
  else if (effective[0]) {
    const x = globalValues;
    summary.push(`${n === 1 ? 'It' : 'Each one'} walks ${levelsText(x.ramp_levels)}${x.ramp_levels.length > 1 ? ' in sequence' : ''}, ${x.iterations} iteration${x.iterations === 1 ? '' : 's'}.`);
    summary.push(`${thinkText(x).replace(/^./, (c) => c.toUpperCase())}${x.ramp_up_sec ? `; users of a level start within ${x.ramp_up_sec} s` : ''}.`);
  }
  summary.push(
    source === 'none' ? 'No user impersonation (the identity that runs the test is used).'
      : source === 'list' && scope === 'global' ? `Impersonated users from a typed list (${globalListUpns.upns.length}).`
        : source === 'file' && scope === 'global' ? 'Impersonated users from one file shared by all models.'
          : source === 'list' ? 'Impersonated users typed per model.' : 'Impersonated users from one file per model.');
  summary.push(form.navMode === 'same' ? 'The same navigation file for all models.' : `${n === 1 ? 'One navigation file' : 'One navigation file per model'}.`);

  const cardLines: Record<string, string> = {};
  effective.forEach((e) => { cardLines[e.cardId] = cardLine(e, ''); });

  return {
    params, issues,
    errors: issues.filter((i) => i.severity === 'error'), warnings: issues.filter((i) => i.severity === 'warning'),
    infos: issues.filter((i) => i.severity === 'info'),
    effective, summary, peaks: [...peaks.values()], files: [...files], cardLines,
  };
}

// ---------- JSON text ----------

function ser(value: unknown, key: string | null, indent: number): string {
  const pad = '  '.repeat(indent);
  const pad1 = '  '.repeat(indent + 1);
  if (typeof value === 'number') return Number.isInteger(value) && key !== null && FLOAT_KEYS.has(key) ? `${value}.0` : JSON.stringify(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) return `[${value.map((v) => ser(v, null, 0)).join(', ')}]`;
    return `[\n${value.map((v) => pad1 + ser(v, null, indent + 1)).join(',\n')}\n${pad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${pad1}${JSON.stringify(k)}: ${ser(v, k, indent + 1)}`).join(',\n')}\n${pad}}`;
}

/** JSON text of the parameters; decimals of Float parameters keep their ".0" (1.0, 60.0). Equivalent to JSON.stringify. */
export function stringifyParams(params: Params): string {
  return ser(params, null, 0);
}

/** Preview text for the screen: UPNs are replaced by counts. */
export function previewParams(params: Params): string {
  return stringifyParams(redactParams(params));
}

// ---------- effective configuration (what the pipeline expressions compute) ----------

/** The value of every execution setting of every model, as `@coalesce(item()?.x, pipeline().parameters.x)` computes it. */
export function effectiveSettings(params: Params): Record<string, unknown>[] {
  const models = (params.models as Record<string, unknown>[]) ?? [];
  return models.map((m) => {
    const out: Record<string, unknown> = { model_key: m.model_key };
    for (const k of EXEC_KEYS) out[k] = m[k] ?? params[k] ?? PARAM_BY_NAME[k].default;
    return out;
  });
}

export interface ResolvedRls { kind: 'none' | 'list' | 'file'; upns?: string[]; file?: string }

/** Which identities a model uses, following RunLoadTest_v3.resolve_rls_users. */
export function resolveRls(params: Params, model: Record<string, unknown>): ResolvedRls {
  const source = String(params.rls_source ?? 'list').toLowerCase();
  const perModel = String(params.rls_scope ?? 'global').toLowerCase() === 'per_model';
  if (source === 'none') return { kind: 'none' };
  if (source === 'list') {
    const own = perModel ? parseUpns(Array.isArray(model.users) ? (model.users as string[]).join('\n') : String(model.users ?? '')).upns : [];
    if (own.length) return { kind: 'list', upns: own };
    const global = parseUpns(String(params.rls_users ?? '')).upns;
    return global.length ? { kind: 'list', upns: global } : { kind: 'none' };
  }
  const own = perModel ? String(model.users_file ?? '').trim() : '';
  if (own) return { kind: 'file', file: own };
  return { kind: 'file', file: String(params.rls_users_file ?? '').trim() };
}
