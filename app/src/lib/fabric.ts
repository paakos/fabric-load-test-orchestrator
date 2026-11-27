import { getToken, type ScopeSet } from './msal';

const FABRIC = 'https://api.fabric.microsoft.com/v1';
const ONELAKE = 'https://onelake.dfs.fabric.microsoft.com';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function friendly(status: number, body: string): string {
  let detail = body.slice(0, 300);
  try {
    const j = JSON.parse(body);
    detail = j.message ?? j.error?.message ?? j.errorCode ?? detail;
  } catch { /* plain text */ }
  if (status === 401) return `Session expired or consent missing (401). ${detail}`;
  if (status === 403) return `Your user does not have permission for this operation (403). ${detail}`;
  if (status === 404) return `Not found (404). ${detail}`;
  if (status === 429) return 'Fabric is throttling the requests (429). Wait a few seconds.';
  return `Error ${status}. ${detail}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait before retry n (0-based) of a throttled request: Retry-After if the server sent it, otherwise exponential. */
export function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  return Math.min(2000 * 2 ** attempt, 30_000);
}

async function call(url: string, scopes: ScopeSet, init: RequestInit = {}, attempt = 0, refreshed = false): Promise<Response> {
  const token = await getToken(scopes);
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401 && !refreshed) {
    await getToken(scopes, { forceRefresh: true });
    return call(url, scopes, init, attempt, true);
  }
  if (res.status === 429 && attempt < 4) {
    await sleep(backoffMs(attempt, res.headers.get('Retry-After')));
    return call(url, scopes, init, attempt + 1, refreshed);
  }
  if (!res.ok) throw new ApiError(res.status, friendly(res.status, await res.text().catch(() => '')));
  return res;
}

async function json<T>(url: string, scopes: ScopeSet, init?: RequestInit): Promise<T> {
  const res = await call(url, scopes, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function paged<T>(url: string, scopes: ScopeSet): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const page: { value?: T[]; continuationUri?: string } = await json(next, scopes);
    out.push(...(page.value ?? []));
    next = page.continuationUri ?? undefined;
  }
  return out;
}

const byName = <T extends { displayName?: string }>(a: T, b: T) => (a.displayName ?? '').localeCompare(b.displayName ?? '', 'en', { sensitivity: 'base' });

// ---------- Discovery ----------
export interface Workspace { id: string; displayName: string; capacityId?: string; type?: string }
export interface Item { id: string; displayName: string; type: string; description?: string }

export async function listWorkspaces(): Promise<Workspace[]> {
  return (await paged<Workspace>(`${FABRIC}/workspaces`, 'fabricRead')).filter((w) => w.type !== 'Personal').sort(byName);
}

export async function listItems(workspaceId: string, type?: string): Promise<Item[]> {
  const q = type ? `?type=${encodeURIComponent(type)}` : '';
  return (await paged<Item>(`${FABRIC}/workspaces/${workspaceId}/items${q}`, 'fabricRead')).sort(byName);
}

// ---------- Jobs ----------
export interface JobInstance {
  id: string;
  status: string;
  invokeType?: string;
  jobType?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  failureReason?: { message?: string; errorCode?: string } | null;
}

export async function runPipeline(workspaceId: string, pipelineId: string, bodyText: string): Promise<void> {
  // bodyText is built by the caller so that the JSON that was shown and copied is exactly the JSON that is sent
  await call(`${FABRIC}/workspaces/${workspaceId}/items/${pipelineId}/jobs/instances?jobType=Pipeline`, 'fabricRun', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyText,
  });
}

export type NotebookParamType = 'string' | 'int' | 'float' | 'bool';
export type NotebookParams = Record<string, { value: string | number | boolean; type: NotebookParamType }>;

export async function runNotebook(workspaceId: string, notebookId: string, parameters: NotebookParams): Promise<void> {
  await call(`${FABRIC}/workspaces/${workspaceId}/items/${notebookId}/jobs/instances?jobType=RunNotebook`, 'fabricRun', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executionData: { parameters } }),
  });
}

export async function listJobs(workspaceId: string, itemId: string): Promise<JobInstance[]> {
  return paged<JobInstance>(`${FABRIC}/workspaces/${workspaceId}/items/${itemId}/jobs/instances`, 'fabricRun');
}

export function getJob(workspaceId: string, itemId: string, jobId: string): Promise<JobInstance> {
  return json(`${FABRIC}/workspaces/${workspaceId}/items/${itemId}/jobs/instances/${jobId}`, 'fabricRun');
}

export async function cancelJob(workspaceId: string, itemId: string, jobId: string): Promise<void> {
  await call(`${FABRIC}/workspaces/${workspaceId}/items/${itemId}/jobs/instances/${jobId}/cancel`, 'fabricRun', { method: 'POST' });
}

export interface ActivityRun {
  activityName: string;
  activityType: string;
  status: string;
  activityRunStart?: string;
  activityRunEnd?: string;
  durationInMs?: number;
  input?: unknown;
  output?: unknown;
  error?: { message?: string; errorCode?: string };
}

export async function queryActivityRuns(workspaceId: string, runId: string, since: Date): Promise<ActivityRun[]> {
  const body = {
    filters: [], orderBy: [{ orderBy: 'ActivityRunStart', order: 'ASC' }],
    lastUpdatedAfter: new Date(since.getTime() - 3600_000).toISOString(),
    lastUpdatedBefore: new Date(Date.now() + 3600_000).toISOString(),
  };
  const r = await json<ActivityRun[] | { value: ActivityRun[] }>(
    `${FABRIC}/workspaces/${workspaceId}/datapipelines/pipelineruns/${runId}/queryactivityruns`, 'fabricRun',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return Array.isArray(r) ? r : r.value ?? [];
}

// ---------- OneLake (DFS) ----------
const dfsHeaders = { 'x-ms-version': '2023-11-03' };
const lakeUrl = (workspaceId: string, lakehouseId: string, path: string) => `${ONELAKE}/${workspaceId}/${lakehouseId}/${path}`;

/** Reads a text file; `maxBytes` limits the read (Range header). null = it does not exist. */
export async function onelakeRead(workspaceId: string, lakehouseId: string, path: string, maxBytes?: number): Promise<string | null> {
  try {
    const headers: Record<string, string> = { ...dfsHeaders };
    if (maxBytes) headers.Range = `bytes=0-${maxBytes - 1}`;
    const res = await call(lakeUrl(workspaceId, lakehouseId, path), 'onelake', { headers });
    return await res.text();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function onelakeWrite(workspaceId: string, lakehouseId: string, path: string, data: Blob | string): Promise<void> {
  const url = lakeUrl(workspaceId, lakehouseId, path);
  const blob = typeof data === 'string' ? new Blob([data]) : data;
  // Explicit empty body: without it the browser sends no Content-Length and OneLake answers 400 MissingRequiredHeader.
  await call(`${url}?resource=file`, 'onelake', { method: 'PUT', headers: dfsHeaders, body: '' });
  if (blob.size) await call(`${url}?action=append&position=0`, 'onelake', { method: 'PATCH', headers: dfsHeaders, body: blob });
  await call(`${url}?action=flush&position=${blob.size}`, 'onelake', { method: 'PATCH', headers: dfsHeaders, body: '' });
}

export async function onelakeMkdir(workspaceId: string, lakehouseId: string, path: string): Promise<void> {
  await call(`${lakeUrl(workspaceId, lakehouseId, path)}?resource=directory`, 'onelake', { method: 'PUT', headers: dfsHeaders, body: '' });
}

export interface PathEntry { name: string; isDirectory: boolean; contentLength: number; lastModified: string }

/** Lists one directory (not recursive). A directory that does not exist gives []. Up to 5000 entries (one DFS page). */
export async function onelakeList(workspaceId: string, lakehouseId: string, directory: string): Promise<PathEntry[]> {
  try {
    const url = `${ONELAKE}/${workspaceId}?resource=filesystem&recursive=false&directory=${encodeURIComponent(`${lakehouseId}/${directory}`)}`;
    const r = await json<{ paths?: { name: string; isDirectory?: string | boolean; contentLength?: string; lastModified?: string }[] }>(
      url, 'onelake', { headers: dfsHeaders });
    return (r.paths ?? []).map((p) => ({
      name: p.name.split('/').pop() ?? p.name,
      isDirectory: p.isDirectory === true || p.isDirectory === 'true',
      contentLength: Number(p.contentLength ?? 0),
      lastModified: p.lastModified ?? '',
    }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}
