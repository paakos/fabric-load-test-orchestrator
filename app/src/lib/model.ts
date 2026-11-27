import { EXEC_KEYS, PARAM_BY_NAME } from './parameters';

/** Form state of the Parameters & launch page. Numbers are kept as text so that a half-typed value never breaks the form. */
export interface ExecForm {
  ramp_levels: string;
  iterations: string;
  delay_sec: string;
  enable_think_times: boolean;
  think_time_scale: string;
  max_think_time_sec: string;
  think_time_jitter_pct: string;
  fallback_think_time_sec: string;
  ramp_up_sec: string;
  initial_user_jitter_sec: string;
}
export type ExecKey = keyof ExecForm;

export type SettingsMode = 'global' | 'per_model';
export type RlsSource = 'none' | 'list' | 'file';
export type RlsScope = 'global' | 'per_model';
export type NavMode = 'per_model' | 'same';
export type WorkspaceMode = 'same' | 'other';

export interface ModelCard {
  id: string;
  model_key: string;
  dataset: string;
  workspaceMode: WorkspaceMode;
  workspace: string;
  queryfile: string;
  /** UPNs, one per line or separated by commas/semicolons. Memory only: never persisted. */
  users: string;
  users_file: string;
  settings: ExecForm;
  /** The user edited this card's own settings: they are not overwritten when the mode changes. */
  settingsTouched: boolean;
}

export interface FormState {
  settingsMode: SettingsMode;
  rlsSource: RlsSource;
  rlsScope: RlsScope;
  navMode: NavMode;
  test_name_prefix: string;
  global: ExecForm;
  rls_users: string;
  rls_users_file: string;
  /** queryfile used by every model when navMode is 'same'. */
  globalQueryfile: string;
  stop_on_query_error: boolean;
  fail_on_error_rate: string;
  write_results_to_tables: boolean;
  models: ModelCard[];
}

const text = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));

export function execDefaults(): ExecForm {
  const d = (k: string) => text(PARAM_BY_NAME[k].default);
  return {
    ramp_levels: d('ramp_levels'), iterations: d('iterations'), delay_sec: d('delay_sec'),
    enable_think_times: PARAM_BY_NAME.enable_think_times.default as boolean,
    think_time_scale: d('think_time_scale'), max_think_time_sec: d('max_think_time_sec'),
    think_time_jitter_pct: d('think_time_jitter_pct'), fallback_think_time_sec: d('fallback_think_time_sec'),
    ramp_up_sec: d('ramp_up_sec'), initial_user_jitter_sec: d('initial_user_jitter_sec'),
  };
}

export function newCard(id: string, over: Partial<ModelCard> = {}, settings: ExecForm = execDefaults()): ModelCard {
  return {
    id, model_key: '', dataset: '', workspaceMode: 'same', workspace: '', queryfile: '', users: '', users_file: '',
    settings: { ...settings }, settingsTouched: false, ...over,
  };
}

let counter = 0;
export const nextCardId = () => `m${++counter}`;

export function defaultForm(id: () => string = nextCardId): FormState {
  return {
    settingsMode: 'global', rlsSource: PARAM_BY_NAME.rls_source.default as RlsSource,
    rlsScope: PARAM_BY_NAME.rls_scope.default as RlsScope, navMode: 'per_model',
    test_name_prefix: PARAM_BY_NAME.test_name_prefix.default as string, global: execDefaults(),
    rls_users: '', rls_users_file: '', globalQueryfile: '',
    stop_on_query_error: false, fail_on_error_rate: text(PARAM_BY_NAME.fail_on_error_rate.default),
    write_results_to_tables: false, models: [newCard(id())],
  };
}

/** Switching to "per model" preloads the cards that were never edited with the global values. */
export function setSettingsMode(form: FormState, mode: SettingsMode): FormState {
  if (mode === form.settingsMode) return form;
  const models = mode === 'per_model'
    ? form.models.map((m) => (m.settingsTouched ? m : { ...m, settings: { ...form.global } }))
    : form.models;
  return { ...form, settingsMode: mode, models };
}

export function addModel(form: FormState, id: string): FormState {
  const settings = form.settingsMode === 'per_model' ? { ...form.global } : execDefaults();
  return { ...form, models: [...form.models, newCard(id, { queryfile: form.navMode === 'same' ? form.globalQueryfile : '' }, settings)] };
}

/** Same dataset and workspace, suggested key `<model_key>-2`, no users copied (they are personal data). */
export function duplicateModel(form: FormState, cardId: string, id: string): FormState {
  const i = form.models.findIndex((m) => m.id === cardId);
  if (i < 0) return form;
  const src = form.models[i];
  const taken = new Set(form.models.map((m) => m.model_key));
  let n = 2;
  const base = src.model_key.replace(/-\d+$/, '') || 'model';
  while (taken.has(`${base}-${n}`)) n++;
  const copy: ModelCard = { ...src, id, model_key: `${base}-${n}`, users: '', users_file: '', settings: { ...src.settings } };
  const models = [...form.models];
  models.splice(i + 1, 0, copy);
  return { ...form, models };
}

export function removeModel(form: FormState, cardId: string): FormState {
  return { ...form, models: form.models.filter((m) => m.id !== cardId) };
}

export function patchCard(form: FormState, cardId: string, patch: Partial<ModelCard>): FormState {
  return { ...form, models: form.models.map((m) => (m.id === cardId ? { ...m, ...patch } : m)) };
}

export function patchCardSettings(form: FormState, cardId: string, patch: Partial<ExecForm>): FormState {
  return { ...form, models: form.models.map((m) => (m.id === cardId ? { ...m, settings: { ...m.settings, ...patch }, settingsTouched: true } : m)) };
}

export const isExecKey = (k: string): k is ExecKey => EXEC_KEYS.includes(k);
