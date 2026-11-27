import type { JobInstance } from './fabric';
import { stringifyParams, type Generated, type Params, effectiveSettings } from './generate';
import { redactParams } from './privacy';

export type PipelineVersion = 'verified' | 'unverified' | 'mismatch';

export interface LaunchContext {
  signedIn: boolean;
  workspaceId?: string;
  pipelineId?: string;
  lakehouseId?: string;
  pipelineVersion: PipelineVersion;
  /** The user confirmed that the deployed pipeline is the version with per-model settings (needed when it is not verified). */
  pipelineConfirmed: boolean;
  files: { status: 'unchecked' | 'checking' | 'done' | 'error'; missing: string[]; error?: string };
  datasets: { status: 'unchecked' | 'checking' | 'done' | 'error'; missing: string[]; unverifiable: string[] };
  submitting: boolean;
}

export interface LaunchCheck { blockers: string[]; warnings: string[]; ready: boolean }

/**
 * The "Launch test" button is enabled only when all of this is true: no blocking error, every mandatory field filled, the referenced files
 * exist in the lakehouse, the semantic models exist in their workspace, the pipeline is located (and is the right version, or the user
 * confirmed it) and the user is signed in.
 */
export function launchCheck(gen: Generated, ctx: LaunchContext): LaunchCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (gen.errors.length) blockers.push(`${gen.errors.length} error${gen.errors.length === 1 ? '' : 's'} to fix in the parameters.`);
  if (!ctx.signedIn) blockers.push('Sign in (the session needs permission to run items).');
  if (!ctx.workspaceId) blockers.push('Choose the test workspace on the Environment page.');
  if (!ctx.pipelineId) blockers.push('PL_PerfTest_MultiModel_v3 was not found in the workspace.');
  if (!ctx.lakehouseId) blockers.push('Choose the lakehouse of the test on the Environment page.');
  if (ctx.pipelineVersion === 'mismatch') blockers.push('The pipeline is not the current version: per-model settings would be ignored.');
  else if (ctx.pipelineVersion === 'unverified' && !ctx.pipelineConfirmed) blockers.push('Confirm on the Environment page that the deployed pipeline is the current version (it could not be verified).');

  if (!gen.errors.length) {
    if (ctx.files.status === 'checking' || ctx.files.status === 'unchecked') blockers.push('Checking that the files exist in the lakehouse…');
    else if (ctx.files.status === 'error') blockers.push(`Could not check the files: ${ctx.files.error ?? 'unknown error'}`);
    else if (ctx.files.missing.length) blockers.push(`Files not found in the lakehouse: ${ctx.files.missing.join(', ')}`);
    if (ctx.datasets.status === 'checking' || ctx.datasets.status === 'unchecked') blockers.push('Checking that the semantic models exist…');
    else if (ctx.datasets.missing.length) blockers.push(`Semantic models not found: ${ctx.datasets.missing.join('; ')}`);
    if (ctx.datasets.status === 'error' || ctx.datasets.unverifiable.length) {
      warnings.push(`Could not verify these semantic models (no access to list them): ${ctx.datasets.unverifiable.join(', ') || 'all'}.`);
    }
  }
  if (ctx.pipelineVersion === 'unverified' && ctx.pipelineConfirmed) warnings.push('Pipeline version not verified (confirmed by you).');
  if (ctx.submitting) blockers.push('Launching…');
  return { blockers, warnings, ready: blockers.length === 0 };
}

/** Body of POST …/jobs/instances?jobType=Pipeline. The same text that the preview shows and Copy puts in the clipboard. */
export function launchBody(params: Params): string {
  return `{"executionData":{"parameters":${stringifyParams(params).replace(/\n\s*/g, ' ')}}}`;
}

/**
 * Jobs created by this launch: the Location header is not readable through CORS, so the new job is found by comparing the list of job
 * instances before and after the POST. More than one candidate (someone launched at the same time) asks the user to choose.
 */
export function newJobCandidates(before: Set<string>, jobs: JobInstance[], launchedAt: Date): JobInstance[] {
  const from = launchedAt.getTime() - 120_000;
  return jobs
    .filter((j) => !before.has(j.id))
    .filter((j) => !j.invokeType || /manual/i.test(j.invokeType))
    .filter((j) => !j.startTimeUtc || Date.parse(j.startTimeUtc.endsWith('Z') ? j.startTimeUtc : `${j.startTimeUtc}Z`) >= from)
    .sort((a, b) => (b.startTimeUtc ?? '').localeCompare(a.startTimeUtc ?? ''));
}

// ---------- what to tell the user before launching ----------

export interface Confirmation {
  workspace: string;
  pipeline: string;
  models: number;
  summary: string[];
  levels: { model_key: string; levels: number[] }[];
  peaks: { dataset: string; peak: number; profiles: string[] }[];
}

export function confirmation(gen: Generated, workspace: string, pipeline: string): Confirmation {
  return {
    workspace, pipeline, models: gen.effective.length, summary: gen.summary,
    levels: gen.effective.map((e) => ({ model_key: e.model_key, levels: e.exec.ramp_levels })),
    peaks: gen.peaks.map((p) => ({ dataset: p.dataset, peak: p.peak, profiles: p.profiles })),
  };
}

// ---------- launched runs remembered for the session (UPNs replaced by counts) ----------

export interface LaunchedRun {
  jobId: string;
  launchedAt: string;
  params: Record<string, unknown>;
  plan: { prefix: string; models: { model_key: string; dataset: string; levels: number[] }[] };
}

export const LAUNCHED_KEY = 'loadtest.launched.v1';

export function toLaunched(jobId: string, params: Params, launchedAt: Date): LaunchedRun {
  const eff = effectiveSettings(params);
  const models = (params.models as Record<string, unknown>[]).map((m, i) => ({
    model_key: String(m.model_key), dataset: String(m.dataset), levels: eff[i].ramp_levels as number[],
  }));
  return { jobId, launchedAt: launchedAt.toISOString(), params: redactParams(params), plan: { prefix: String(params.test_name_prefix), models } };
}

export function loadLaunched(storage: Pick<Storage, 'getItem'> = sessionStorage): Record<string, LaunchedRun> {
  try { return JSON.parse(storage.getItem(LAUNCHED_KEY) ?? '{}'); } catch { return {}; }
}

export function saveLaunched(run: LaunchedRun, storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage): void {
  try {
    const all = loadLaunched(storage);
    all[run.jobId] = run;
    storage.setItem(LAUNCHED_KEY, JSON.stringify(all));
  } catch { /* storage not available: the run is still shown from the Jobs API */ }
}
