/**
 * Single schema of the 19 parameters of PL_PerfTest_MultiModel_v3 (names, types, defaults, ranges, help and documentation anchors).
 * The form, the validation, the JSON generator and the tests all derive from it; a test compares it with the pipeline JSON.
 */
export type ParamKind = 'models' | 'string' | 'int-array' | 'int' | 'bool' | 'float' | 'enum';

export interface ParamDef {
  name: string;
  kind: ParamKind;
  default: unknown;
  /** Can also be set inside each item of `models`. */
  perModel: boolean;
  label: string;
  /** What it is for. */
  summary: string;
  /** Accepted values. */
  accepted: string;
  example: string;
  /** Section of docs/pipeline-parameters.md. */
  anchor: string;
  min?: number;
  max?: number;
  options?: string[];
}

export const MAX_LEVEL = 300;
export const MAX_PARALLEL_MODELS = 10;
export const DOC_PARAMETERS = 'pipeline-parameters';

export const PARAMETERS: ParamDef[] = [
  {
    name: 'models', kind: 'models', default: [], perModel: false, label: 'Models',
    summary: 'The semantic models to test. Every model runs its own ramp, all models in parallel (at most 10 at a time).',
    accepted: 'At least one model with model_key, dataset, workspace and queryfile.',
    example: '[{"model_key":"SalesA","dataset":"Sales A","workspace":"","queryfile":"/lakehouse/default/Files/PerfScenarios/Queries/nav_a.json"}]',
    anchor: 'models',
  },
  {
    name: 'test_name_prefix', kind: 'string', default: 'ramp-v3', perModel: false, label: 'Test name prefix',
    summary: 'Start of the name of every run folder: <prefix>-<model_key>-c<users>-<timestamp>. Use one prefix per test campaign.',
    accepted: 'Text without spaces. Recommended: letters, digits, . _ -',
    example: 'ramp-v3', anchor: 'test_name_prefix',
  },
  {
    name: 'ramp_levels', kind: 'int-array', default: [1, 5, 10], perModel: true, label: 'Ramp levels (users)',
    summary: 'Concurrent virtual users of each level. The levels run one after another for every model.',
    accepted: `Integers from 1 to ${MAX_LEVEL}.`, example: '[6, 20, 60]', anchor: 'ramp_levels', min: 1, max: MAX_LEVEL,
  },
  {
    name: 'iterations', kind: 'int', default: 1, perModel: true, label: 'Iterations',
    summary: 'Times each virtual user plays the whole recorded scenario during its level.',
    accepted: 'Integer, 1 or more.', example: '3', anchor: 'iterations', min: 1,
  },
  {
    name: 'delay_sec', kind: 'int', default: 4, perModel: true, label: 'Delay (s)',
    summary: 'Wait between iterations. With think times off it is also the wait after every query.',
    accepted: 'Integer, 0 or more.', example: '4', anchor: 'delay_sec', min: 0,
  },
  {
    name: 'enable_think_times', kind: 'bool', default: true, perModel: true, label: 'Think times',
    summary: 'Replay the pauses between user actions that Performance Analyzer recorded. Off = stress style, no pauses between actions.',
    accepted: 'Yes / No.', example: 'true', anchor: 'think-times',
  },
  {
    name: 'think_time_scale', kind: 'float', default: 1.0, perModel: true, label: 'Think time scale',
    summary: 'Multiplier of every recorded pause: 1 = recorded pace, 0.5 = twice as fast, 2 = twice as slow, 0 = no pauses.',
    accepted: 'Number, 0 or more.', example: '0.5', anchor: 'think-times', min: 0,
  },
  {
    name: 'max_think_time_sec', kind: 'float', default: 60.0, perModel: true, label: 'Max think time (s)',
    summary: 'Upper limit of one pause after scaling, so a recorded long break does not stall the test.',
    accepted: 'Number, 0 or more.', example: '60', anchor: 'think-times', min: 0,
  },
  {
    name: 'think_time_jitter_pct', kind: 'float', default: 0.1, perModel: true, label: 'Think time jitter',
    summary: 'Random variation of each pause: 0.1 = between 90 % and 110 %. 0 makes runs repeatable.',
    accepted: 'Number from 0 to 1.', example: '0.1', anchor: 'think-times', min: 0, max: 1,
  },
  {
    name: 'fallback_think_time_sec', kind: 'float', default: 0.0, perModel: true, label: 'Fallback think time (s)',
    summary: 'Pause between queries when the navigation file has no User Action events.',
    accepted: 'Number, 0 or more.', example: '0', anchor: 'think-times', min: 0,
  },
  {
    name: 'ramp_up_sec', kind: 'float', default: 0.0, perModel: true, label: 'Start window (s)',
    summary: 'Window over which the users of one level start: user i of N waits ramp_up_sec × i / N. It is not the ramp of levels.',
    accepted: 'Number, 0 or more. 0 starts everyone at once.', example: '30', anchor: 'ramp_up_sec-and-initial_user_jitter_sec', min: 0,
  },
  {
    name: 'initial_user_jitter_sec', kind: 'float', default: 0.0, perModel: true, label: 'Initial jitter (s)',
    summary: 'Random extra wait (0…N s) before each user\'s first action, so the start is not a perfect grid.',
    accepted: 'Number, 0 or more.', example: '2', anchor: 'ramp_up_sec-and-initial_user_jitter_sec', min: 0,
  },
  {
    name: 'rls_source', kind: 'enum', default: 'list', perModel: false, label: 'RLS source',
    summary: 'Where the impersonated users (EffectiveUserName) come from: a typed list, a file, or no impersonation.',
    accepted: 'list, file or none.', example: 'file', anchor: 'rls-identities', options: ['list', 'file', 'none'],
  },
  {
    name: 'rls_scope', kind: 'enum', default: 'global', perModel: false, label: 'RLS scope',
    summary: 'global: the same users for every model. per_model: each model brings its own users.',
    accepted: 'global or per_model.', example: 'per_model', anchor: 'rls-identities', options: ['global', 'per_model'],
  },
  {
    name: 'rls_users', kind: 'string', default: '', perModel: false, label: 'RLS users (global list)',
    summary: 'Global list of user principal names, spread across the virtual users in turn.',
    accepted: 'UPNs separated by commas or semicolons.', example: 'user1@contoso.com,user2@contoso.com', anchor: 'rls-identities',
  },
  {
    name: 'rls_users_file', kind: 'string', default: '', perModel: false, label: 'RLS users file (global)',
    summary: 'Global text file with one UPN per line, in the default lakehouse.',
    accepted: '/lakehouse/default/... path, no spaces.', example: '/lakehouse/default/Files/PerfScenarios/Users/users.txt', anchor: 'rls-identities',
  },
  {
    name: 'stop_on_query_error', kind: 'bool', default: false, perModel: false, label: 'Stop on query error',
    summary: 'false: a failed query is recorded as an error row and the user carries on. true: the user stops at its first failed query.',
    accepted: 'Yes / No.', example: 'false', anchor: 'results',
  },
  {
    name: 'fail_on_error_rate', kind: 'float', default: 1.0, perModel: false, label: 'Fail above error rate',
    summary: 'The level fails when its error rate (failed queries + lost users) is above this value. 1 = never fail; 0 = fail on any failed query.',
    accepted: 'Number from 0 to 1.', example: '0.05', anchor: 'results', min: 0, max: 1,
  },
  {
    name: 'write_results_to_tables', kind: 'bool', default: false, perModel: false, label: 'Write results to Delta tables',
    summary: 'Also append each run to the Delta tables loadtest_runs and loadtest_queries of the default lakehouse.',
    accepted: 'Yes / No.', example: 'false', anchor: 'results',
  },
];

export const PARAM_BY_NAME: Record<string, ParamDef> = Object.fromEntries(PARAMETERS.map((p) => [p.name, p]));
export const PARAM_NAMES = PARAMETERS.map((p) => p.name);
/** The ten execution settings that a model may override, in the order they are emitted. */
export const EXEC_KEYS = PARAMETERS.filter((p) => p.perModel).map((p) => p.name);
export const FLOAT_KEYS = new Set(PARAMETERS.filter((p) => p.kind === 'float').map((p) => p.name));
export const MODEL_KEYS = ['model_key', 'dataset', 'workspace', 'queryfile', 'users', 'users_file', ...EXEC_KEYS];
/** The settings that only matter while enable_think_times is on (greyed out otherwise). */
export const THINK_KEYS = ['think_time_scale', 'max_think_time_sec', 'think_time_jitter_pct', 'fallback_think_time_sec'];

export const RAMP_PRESETS: { id: string; label: string; levels: number[] }[] = [
  { id: 'first', label: '1 · 5 · 10', levels: [1, 5, 10] },
  { id: 'medium', label: '6 · 20 · 60', levels: [6, 20, 60] },
  { id: 'large', label: '6 · 20 · 60 · 100 · 200 · 300', levels: [6, 20, 60, 100, 200, 300] },
];
export const THINK_SCALE_PRESETS = [0, 0.5, 1, 2];

export const QUERIES_DIR = 'Files/PerfScenarios/Queries';
export const USERS_DIR = 'Files/PerfScenarios/Users';
export const LOGS_DIR = 'Files/PerfScenarios/logs';
export const PROGRESS_DIR = 'Files/PerfScenarios/progress';
export const ANALYSIS_DIR = 'Files/PerfScenarios/analysis';
export const LAKEHOUSE_PREFIX = '/lakehouse/default/';
export const PIPELINE_NAME = 'PL_PerfTest_MultiModel_v3';
export const REPORT_NOTEBOOK_NAME = 'AnalyzeReportPerformance_v3';

export const toLakehousePath = (relative: string) => `${LAKEHOUSE_PREFIX}${relative}`;
export const fromLakehousePath = (p: string) => (p.startsWith(LAKEHOUSE_PREFIX) ? p.slice(LAKEHOUSE_PREFIX.length) : null);
