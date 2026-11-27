import { EXEC_KEYS, MODEL_KEYS, PARAMETERS, PARAM_BY_NAME, PARAM_NAMES } from './parameters';
import { execDefaults, nextCardId, type ExecForm, type FormState, type ModelCard, type NavMode, type RlsScope, type RlsSource } from './model';
import { parseUpns } from './privacy';

export interface ImportReport {
  /** Names that are not parameters of the pipeline: Fabric would ignore them silently, so they are not imported. */
  unknown: { where: string; name: string }[];
  warnings: string[];
  notes: string[];
}

export interface ImportResult { form?: FormState; report: ImportReport; error?: string }

const asText = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v));
const asBool = (v: unknown, fallback: boolean): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', '1', 'yes'].includes(v.trim().toLowerCase());
  return fallback;
};

function execFrom(source: Record<string, unknown>, base: ExecForm): ExecForm {
  const out = { ...base } as Record<string, string | boolean>;
  for (const k of EXEC_KEYS) {
    const v = source[k];
    if (v === undefined || v === null) continue;
    out[k] = k === 'enable_think_times' ? asBool(v, base.enable_think_times) : asText(v);
  }
  return out as unknown as ExecForm;
}

/** Loads a pipeline-parameters JSON into the form, deducing the three modes (see section 8.1 of the functional spec). */
export function importParams(text: string, id: () => string = nextCardId): ImportResult {
  const report: ImportReport = { unknown: [], warnings: [], notes: [] };
  let doc: unknown;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { return { report, error: `Not valid JSON: ${(e as Error).message}` }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { report, error: 'The JSON must be an object with the pipeline parameters.' };
  let params = doc as Record<string, unknown>;
  const wrapped = (params.executionData as { parameters?: unknown } | undefined)?.parameters;
  if (wrapped && typeof wrapped === 'object') { params = wrapped as Record<string, unknown>; report.notes.push('Read the parameters inside "executionData".'); }
  if (!Array.isArray(params.models) || !params.models.length) return { report, error: 'The JSON has no "models" array.' };

  for (const name of Object.keys(params)) {
    if (!PARAM_NAMES.includes(name)) report.unknown.push({ where: 'parameters', name });
  }

  const g = (k: string) => params[k];
  const global = execFrom(params, execDefaults());
  const source = (['none', 'list', 'file'].includes(String(g('rls_source'))) ? g('rls_source') : PARAM_BY_NAME.rls_source.default) as RlsSource;
  const scope = (['global', 'per_model'].includes(String(g('rls_scope'))) ? g('rls_scope') : PARAM_BY_NAME.rls_scope.default) as RlsScope;

  const rawModels = params.models as Record<string, unknown>[];
  const anyOwn = rawModels.some((m) => EXEC_KEYS.some((k) => m && m[k] !== undefined && m[k] !== null));
  const incomplete: string[] = [];
  const cards: ModelCard[] = rawModels.map((m, i) => {
    const model = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    for (const name of Object.keys(model)) if (!MODEL_KEYS.includes(name)) report.unknown.push({ where: `models[${i}]`, name });
    const ws = typeof model.workspace === 'string' ? model.workspace : '';
    const usersRaw = model.users;
    const users = Array.isArray(usersRaw) ? usersRaw.map(String).join('\n') : typeof usersRaw === 'string' ? usersRaw.split(/[,;]/).map((s) => s.trim()).filter(Boolean).join('\n') : '';
    let settings = global;
    if (anyOwn) {
      const missing = EXEC_KEYS.filter((k) => model[k] === undefined || model[k] === null);
      if (missing.length) incomplete.push(String(model.model_key ?? `#${i + 1}`));
      settings = execFrom(model, global);
    }
    return {
      id: id(), model_key: String(model.model_key ?? ''), dataset: String(model.dataset ?? ''),
      workspaceMode: ws ? 'other' : 'same', workspace: ws, queryfile: String(model.queryfile ?? ''),
      users, users_file: String(model.users_file ?? ''), settings: { ...settings }, settingsTouched: anyOwn,
    };
  });
  if (anyOwn && incomplete.length) {
    report.warnings.push(`Models without their own value for some settings were completed with the global value: ${incomplete.join(', ')}.`);
  }

  let rlsUsers = typeof g('rls_users') === 'string' ? (g('rls_users') as string) : '';
  let rlsUsersFile = typeof g('rls_users_file') === 'string' ? (g('rls_users_file') as string) : '';

  // Per-model scope: the global fallback is not offered any more; it is copied to the models that lack their own value.
  if (scope === 'per_model' && source === 'list' && rlsUsers.trim()) {
    const lacking = cards.filter((c) => !parseUpns(c.users).upns.length);
    const names = lacking.map((c) => c.model_key || '(no key)').join(', ');
    report.warnings.push(`The global fallback of rls_users is discarded${lacking.length ? `; its users were assigned to the models without their own: ${names}` : ''}.`);
    const fallback = parseUpns(rlsUsers).upns.join('\n');
    lacking.forEach((c) => { c.users = fallback; });
    rlsUsers = '';
  }
  if (scope === 'per_model' && source === 'file' && rlsUsersFile.trim()) {
    const lacking = cards.filter((c) => !c.users_file.trim());
    const names = lacking.map((c) => c.model_key || '(no key)').join(', ');
    report.warnings.push(`The global fallback of rls_users_file is discarded${lacking.length ? `; its file was assigned to the models without their own: ${names}` : ''}.`);
    lacking.forEach((c) => { c.users_file = rlsUsersFile; });
    rlsUsersFile = '';
  }

  const sameFile = cards.length > 1 && cards.every((c) => c.queryfile.trim() && c.queryfile === cards[0].queryfile);
  const navMode: NavMode = sameFile ? 'same' : 'per_model';
  if (sameFile) report.notes.push('Every model uses the same navigation file: "Same file for all models" was selected.');
  if (anyOwn) report.notes.push('Some models carry their own settings: "Per model" mode was selected.');

  const fail = g('fail_on_error_rate');
  const form: FormState = {
    settingsMode: anyOwn ? 'per_model' : 'global', rlsSource: source, rlsScope: scope, navMode,
    test_name_prefix: typeof g('test_name_prefix') === 'string' ? (g('test_name_prefix') as string) : String(PARAM_BY_NAME.test_name_prefix.default),
    global, rls_users: rlsUsers, rls_users_file: rlsUsersFile, globalQueryfile: sameFile ? cards[0].queryfile : '',
    stop_on_query_error: asBool(g('stop_on_query_error'), false),
    fail_on_error_rate: fail === undefined || fail === null ? String(PARAM_BY_NAME.fail_on_error_rate.default) : asText(fail),
    write_results_to_tables: asBool(g('write_results_to_tables'), false),
    models: cards,
  };
  // Parameters of the pipeline that were not in the JSON take their default; say so for the ones that matter
  const missing = PARAMETERS.filter((p) => p.name !== 'models' && params[p.name] === undefined).map((p) => p.name);
  if (missing.length) report.notes.push(`Not in the JSON, so the pipeline default is used: ${missing.join(', ')}.`);
  return { form, report };
}
