/** Minimal RFC 4180 CSV helpers: the DAX text of a result row is quoted and multi-line. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export interface StatusCount { rows: number; failed: number; hasStatus: boolean; users: number }

/** Rows and failed queries of one user CSV: `status = error` marks a failed query (3.4 and later; older files have no column). */
export function countStatus(csv: string): StatusCount {
  const rows = parseCsv(csv);
  if (!rows.length) return { rows: 0, failed: 0, hasStatus: false, users: 0 };
  const header = rows[0];
  const iStatus = header.indexOf('status');
  const body = rows.slice(1);
  const failed = iStatus < 0 ? 0 : body.filter((r) => (r[iStatus] || 'ok') !== 'ok').length;
  return { rows: body.length, failed, hasStatus: iStatus >= 0, users: body.length ? 1 : 0 };
}

const DANGEROUS = /^[=+\-@\t\r]/;

/** CSV text for download. Text that a spreadsheet would run as a formula is prefixed with a quote. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let t = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (typeof v === 'string' && DANGEROUS.test(t)) t = `'${t}`;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n');
}
