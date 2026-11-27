/**
 * User principal names (UPNs) are personal data: they are parsed with the same rules as the orchestrator (RunLoadTest_v3),
 * never written to storage or the console, and masked in every view except the field where they are typed.
 */
export interface UpnParse {
  upns: string[];
  /** Duplicates removed, ignoring case (the first spelling is kept). */
  duplicates: number;
  /** 1-based line numbers of the entries that are not user@domain. The content is never kept. */
  invalidLines: number[];
}

// RunLoadTest_v3._parse_upns: '#' starts a comment (at the start of a line or after a space), entries are separated by , or ;
const COMMENT = /(^|\s)#.*$/;
const VALID = /^[^@\s,;]+@[^@\s,;]+$/;

export function parseUpns(text: string): UpnParse {
  const found = new Map<string, string>();
  const invalidLines: number[] = [];
  let duplicates = 0;
  text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(COMMENT, '');
    for (const part of line.split(/[,;]/)) {
      const token = part.trim();
      if (!token) continue;
      if (VALID.test(token)) {
        const key = token.toLowerCase();
        if (found.has(key)) duplicates++;
        else found.set(key, token);
      } else if (!invalidLines.includes(index + 1)) invalidLines.push(index + 1);
    }
  });
  return { upns: [...found.values()], duplicates, invalidLines };
}

/** Comma-separated, as the pipeline expects in `rls_users`. */
export const joinUpns = (upns: string[]) => upns.join(',');

// FNV-1a: a short, stable, non-reversible label (not a security hash: it only keeps the masked names distinguishable)
function hash6(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

export const maskUpn = (upn: string) => `user_${hash6(upn.toLowerCase())}`;

const EMAIL_IN_TEXT = /[^\s@,;'"<>()[\]{}|\\/=]+@[^\s@,;'"<>()[\]{}|\\/=]+/g;

/** Replaces every e-mail-like text (UPN) of a string by a stable masked label. */
export function maskText(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (m) => maskUpn(m));
}

export function maskValue<T>(value: T): T {
  if (typeof value === 'string') return maskText(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskValue(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskValue(v)])) as T;
  }
  return value;
}

export const countLabel = (n: number) => `«${n} user${n === 1 ? '' : 's'}»`;

/** A copy of the launch parameters that is safe to keep (screen, sessionStorage): the UPNs become counts. */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  if (typeof out.rls_users === 'string' && out.rls_users) out.rls_users = countLabel(parseUpns(out.rls_users).upns.length);
  if (Array.isArray(out.models)) {
    out.models = out.models.map((m) => {
      const model = { ...(m as Record<string, unknown>) };
      if (Array.isArray(model.users)) model.users = countLabel(model.users.length);
      else if (typeof model.users === 'string' && model.users) model.users = countLabel(parseUpns(model.users).upns.length);
      return model;
    });
  }
  return out;
}
