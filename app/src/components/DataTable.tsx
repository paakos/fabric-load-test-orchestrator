import { useMemo, useState } from 'react';
import { toCsv } from '../lib/csv';
import type { ManifestColumn, Row } from '../lib/reports';
import { Button } from './ui';

const PAGE = 200;

function show(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function cmp(a: unknown, b: unknown): number {
  const x = a === null || a === undefined ? null : a; const y = b === null || b === undefined ? null : b;
  if (x === null) return y === null ? 0 : 1;
  if (y === null) return -1;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y), 'en', { numeric: true });
}

/** Table of one result: sorting (click a header), filter by model and level, CSV download. */
export function DataTable({ id, columns, rows }: { id: string; columns: ManifestColumn[]; rows: Row[] }) {
  const names = columns.length ? columns.map((c) => c.name) : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [model, setModel] = useState('');
  const [level, setLevel] = useState('');
  const [all, setAll] = useState(false);
  const models = useMemo(() => [...new Set(rows.map((r) => show(r.model)).filter(Boolean))].sort(), [rows]);
  const levels = useMemo(() => [...new Set(rows.map((r) => show(r.level)).filter(Boolean))].sort((a, b) => Number(a) - Number(b)), [rows]);
  const filtered = useMemo(() => {
    let r = rows;
    if (model) r = r.filter((x) => show(x.model) === model);
    if (level) r = r.filter((x) => show(x.level) === level);
    if (sort) r = [...r].sort((a, b) => sort.dir * cmp(a[sort.col], b[sort.col]));
    return r;
  }, [rows, model, level, sort]);
  const shown = all ? filtered : filtered.slice(0, PAGE);

  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(names, filtered)], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `${id}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const toggle = (col: string) => setSort((s) => (s?.col === col ? (s.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }));

  return (
    <div className="data-table">
      <div className="table-tools">
        {models.length > 1 && (
          <label>Model <select className="input small" value={model} onChange={(e) => setModel(e.target.value)}><option value="">All</option>{models.map((m) => <option key={m}>{m}</option>)}</select></label>
        )}
        {levels.length > 1 && (
          <label>Level <select className="input small" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">All</option>{levels.map((m) => <option key={m}>{m}</option>)}</select></label>
        )}
        <span className="muted small">{filtered.length} row{filtered.length === 1 ? '' : 's'}</span>
        <Button small onClick={download}>Download CSV</Button>
      </div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={`Table ${id}`}>
        <table className="table small">
          <thead>
            <tr>
              {names.map((n) => (
                <th key={n} aria-sort={sort?.col === n ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="th-btn" onClick={() => toggle(n)}>{n}{sort?.col === n ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{shown.map((r, i) => <tr key={i}>{names.map((n) => <td key={n} className={typeof r[n] === 'number' ? 'num' : ''}>{show(r[n])}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {!all && filtered.length > PAGE && <Button small onClick={() => setAll(true)}>Show all {filtered.length} rows</Button>}
    </div>
  );
}
