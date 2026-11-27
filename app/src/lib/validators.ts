import { maskUpn, parseUpns } from './privacy';

/** Validation of the files the app uploads, with the rules of RunPerfScenario_v3 (navigation JSON) and RunLoadTest_v3 (users file). */

export const MAX_NAV_WARN_BYTES = 20 * 1024 * 1024;

export interface NavInfo {
  ok: boolean;
  errors: string[];
  warnings: string[];
  actions: number;
  queries: number;
  visuals: number;
  /** User Action events with a timestamp: needed to replay the recorded think times. */
  hasTimestamps: boolean;
}

const validTs = (v: unknown): boolean => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * RunPerfScenario_v3.load_queries reads `json["events"]`; every "Visual Container Lifecycle" event must have
 * metrics.visualTitle and metrics.visualId, every "Execute DAX Query" event metrics.QueryText, and at least one query is needed.
 * "User Action" events (with a start timestamp) define the actions and the recorded think times.
 */
export function validateNavigation(text: string): NavInfo {
  const info: NavInfo = { ok: false, errors: [], warnings: [], actions: 0, queries: 0, visuals: 0, hasTimestamps: false };
  let doc: unknown;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { info.errors.push(`Not valid JSON: ${(e as Error).message}`); return info; }
  const events = (doc as { events?: unknown } | null)?.events;
  if (!doc || typeof doc !== 'object' || !Array.isArray(events)) {
    info.errors.push('Not a Performance Analyzer export: the JSON has no "events" array.');
    return info;
  }
  const bad = { lifecycle: [] as number[], dax: [] as number[] };
  const visuals = new Set<string>();
  let visualId = '';
  let queriesWithStart = 0;
  events.forEach((raw, i) => {
    const e = (raw && typeof raw === 'object' ? raw : {}) as { name?: string; start?: string; metrics?: Record<string, unknown> };
    const metrics = e.metrics && typeof e.metrics === 'object' ? e.metrics : undefined;
    if (e.name === 'Visual Container Lifecycle') {
      if (!metrics || metrics.visualTitle === undefined || metrics.visualId === undefined) bad.lifecycle.push(i);
      else visualId = String(metrics.visualId);
    } else if (e.name === 'Execute DAX Query') {
      if (!metrics || typeof metrics.QueryText !== 'string') { bad.dax.push(i); return; }
      info.queries++;
      visuals.add(visualId);
      if (validTs(e.start)) queriesWithStart++;
    } else if (e.name === 'User Action' && validTs(e.start)) info.actions++;
  });
  const where = (xs: number[]) => `event${xs.length > 1 ? 's' : ''} ${xs.slice(0, 5).map((x) => `#${x}`).join(', ')}${xs.length > 5 ? '…' : ''}`;
  if (bad.lifecycle.length) info.errors.push(`"Visual Container Lifecycle" without metrics.visualTitle / metrics.visualId (${where(bad.lifecycle)}): the notebook would fail with KeyError.`);
  if (bad.dax.length) info.errors.push(`"Execute DAX Query" without metrics.QueryText (${where(bad.dax)}): the notebook would fail with KeyError.`);
  if (!info.queries) info.errors.push('The file has no "Execute DAX Query" events: the run fails immediately.');
  info.visuals = visuals.size;
  info.hasTimestamps = info.actions > 0 && queriesWithStart > 0;
  if (info.queries && !info.actions) info.warnings.push('No "User Action" events: think times use fallback_think_time_sec between queries.');
  else if (info.actions && !info.hasTimestamps) info.warnings.push('The queries have no timestamps: the recorded think times cannot be replayed.');
  if (text.length > MAX_NAV_WARN_BYTES) info.warnings.push('The file is larger than 20 MB: every virtual user reads it.');
  info.ok = info.errors.length === 0;
  return info;
}

export interface UsersInfo {
  ok: boolean;
  errors: string[];
  valid: number;
  duplicates: number;
  invalidLines: number[];
  /** At most the first two entries, masked. The full list is never shown. */
  preview: string[];
  upns: string[];
}

export function inspectUsersText(text: string): UsersInfo {
  const p = parseUpns(text);
  const errors: string[] = [];
  if (p.invalidLines.length) errors.push(`Not user@domain on line${p.invalidLines.length > 1 ? 's' : ''} ${p.invalidLines.slice(0, 10).join(', ')}${p.invalidLines.length > 10 ? '…' : ''}.`);
  if (!p.upns.length && !p.invalidLines.length) errors.push('The file contains no users: the run would fail.');
  return { ok: errors.length === 0, errors, valid: p.upns.length, duplicates: p.duplicates, invalidLines: p.invalidLines, preview: p.upns.slice(0, 2).map(maskUpn), upns: p.upns };
}

/** UTF-8 (BOM accepted); anything else is rejected, as the orchestrator reads the file with utf-8-sig. */
export function decodeUtf8(bytes: ArrayBuffer | Uint8Array): { text?: string; error?: string } {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; } catch { return { error: 'The file is not UTF-8 text.' }; }
}

export function inspectUsersBytes(bytes: ArrayBuffer | Uint8Array): UsersInfo {
  const d = decodeUtf8(bytes);
  if (d.error || d.text === undefined) return { ok: false, errors: [d.error ?? 'Unreadable file.'], valid: 0, duplicates: 0, invalidLines: [], preview: [], upns: [] };
  return inspectUsersText(d.text);
}

/** The users file the app creates from a pasted list: one normalised UPN per line. */
export function usersFileFromList(pasted: string): { content: string; info: UsersInfo } {
  const info = inspectUsersText(pasted);
  return { content: info.upns.length ? `${info.upns.join('\n')}\n` : '', info };
}

export function sanitizeFileName(name: string, defaultExt: string): string {
  const base = name.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '').slice(0, 100);
  const stem = base || 'file';
  return /\.[A-Za-z0-9]{1,5}$/.test(stem) ? stem : `${stem}${defaultExt}`;
}

/** name.ext → name_2.ext, name_3.ext… until it is free. */
export function freeFileName(name: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (taken.has(`${stem}_${n}${ext}`.toLowerCase())) n++;
  return `${stem}_${n}${ext}`;
}
