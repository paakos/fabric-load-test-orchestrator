import type { ReactNode } from 'react';
import type { ChartModel, Panel, PointSeries, Series } from '../lib/charts/model';
import { panelHasData } from '../lib/charts/model';
import { AXIS, GREEN, GRID, PALETTE, RED, fmt, heatColor, heatText, linear, logScale, short } from '../lib/charts/scale';

/** Generic SVG renderer of the chart specifications written by the report notebook. No dependency, no external resource. */

const W = 560;
const H = 310;
const M = { l: 52, r: 34, t: 14, b: 62 };

function Legend({ names, colors = PALETTE }: { names: string[]; colors?: string[] }) {
  if (names.length < 2) return null;
  return (
    <ul className="chart-legend" aria-hidden="true">
      {names.map((n, i) => <li key={n}><span className="swatch" style={{ background: colors[i % colors.length] }} />{n}</li>)}
    </ul>
  );
}

function YAxis({ scale, left = true, label }: { scale: ReturnType<typeof linear>; left?: boolean; label?: string }) {
  const x = left ? M.l : W - M.r;
  return (
    <g className="axis">
      {scale.ticks.map((t) => (
        <g key={t}>
          {left && <line x1={M.l} x2={W - M.r} y1={scale(t)} y2={scale(t)} stroke={GRID} />}
          <text x={left ? x - 6 : x + 6} y={scale(t)} dy="0.32em" textAnchor={left ? 'end' : 'start'} fill={AXIS} fontSize="10">{fmt(t)}</text>
        </g>
      ))}
      {label && left && <text transform={`translate(12 ${(M.t + H - M.b) / 2}) rotate(-90)`} textAnchor="middle" fill={AXIS} fontSize="10">{label}</text>}
    </g>
  );
}

function RefLines({ lines, scale }: { lines: { value: number; label: string }[]; scale: ReturnType<typeof linear> }) {
  return (
    <>
      {lines.map((l) => (
        <g key={l.label}>
          <line x1={M.l} x2={W - M.r} y1={scale(l.value)} y2={scale(l.value)} stroke={RED} strokeDasharray="5 4" />
          <text x={W - M.r - 4} y={scale(l.value) - 4} textAnchor="end" fill={RED} fontSize="10">{l.label}</text>
        </g>
      ))}
    </>
  );
}

function XLabels({ cats, x }: { cats: string[]; x: (i: number) => number }) {
  const rotate = cats.length > 7 || cats.some((c) => c.length > 9);
  return (
    <g className="axis">
      {cats.map((c, i) => (
        <text key={`${c}-${i}`} x={x(i)} y={H - M.b + 14} fill={AXIS} fontSize="10" textAnchor={rotate ? 'end' : 'middle'}
          transform={rotate ? `rotate(-35 ${x(i)} ${H - M.b + 14})` : undefined}>{short(c, 20)}</text>
      ))}
    </g>
  );
}

function maxOf(series: Series[], min0 = 0): number {
  const vals = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  return Math.max(min0, ...vals, 0);
}

function Bars({ p }: { p: Extract<Panel, { kind: 'bars' }> }) {
  const top = Math.max(maxOf(p.series), ...p.refLines.map((r) => r.value)) * 1.08 || 1;
  const y = linear(0, top, H - M.b, M.t);
  const n = p.categories.length;
  const band = (W - M.l - M.r) / Math.max(1, n);
  const w = (band * 0.8) / Math.max(1, p.series.length);
  const cx = (i: number) => M.l + band * (i + 0.5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Grouped bars ${p.title}: ${p.series.map((s) => s.name).join(', ')}`}>
      <YAxis scale={y} />
      {p.series.map((s, si) => s.values.map((v, i) => v === null ? null : (
        <rect key={`${si}-${i}`} x={cx(i) - (band * 0.8) / 2 + si * w} y={y(Math.max(v, 0))} width={Math.max(1, w - 1)} height={Math.max(0, y(0) - y(Math.max(v, 0)))} fill={PALETTE[si % PALETTE.length]}>
          <title>{`${p.categories[i]} · ${s.name}: ${fmt(v)}`}</title>
        </rect>
      )))}
      <XLabels cats={p.categories} x={cx} />
      <RefLines lines={p.refLines} scale={y} />
    </svg>
  );
}

function pointsRange(series: PointSeries[]) {
  const pts = series.flatMap((s) => s.points);
  return { x0: Math.min(...pts.map((q) => q.x)), x1: Math.max(...pts.map((q) => q.x)), y0: Math.min(0, ...pts.map((q) => q.y)), y1: Math.max(...pts.map((q) => q.y)) };
}

function Lines({ p }: { p: Extract<Panel, { kind: 'lines' }> }) {
  const r = pointsRange(p.series);
  const x = p.logx ? logScale(r.x0, r.x1, M.l + 8, W - M.r - 8) : linear(r.x0, r.x1, M.l + 8, W - M.r - 8);
  const y1 = Math.max(r.y1, ...p.refLines.map((l) => l.value)) * 1.08 || 1;
  const y = linear(Math.min(0, r.y0), y1, H - M.b, M.t);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Lines ${p.title}: ${p.series.map((s) => s.name).join(', ')}`}>
      <YAxis scale={y} />
      <g className="axis">
        {x.ticks.map((t) => <text key={t} x={x(t)} y={H - M.b + 14} textAnchor="middle" fill={AXIS} fontSize="10">{fmt(t)}</text>)}
        <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" fill={AXIS} fontSize="10">{p.logx ? 'level (log scale)' : 'level'}</text>
      </g>
      {p.series.map((s, i) => (
        <g key={s.name} stroke={PALETTE[i % PALETTE.length]} fill={PALETTE[i % PALETTE.length]}>
          <polyline fill="none" strokeWidth="2" points={s.points.map((q) => `${x(q.x)},${y(q.y)}`).join(' ')} />
          {s.points.map((q) => <circle key={q.x} cx={x(q.x)} cy={y(q.y)} r="3"><title>{`${s.name} · ${fmt(q.x)}: ${fmt(q.y)}`}</title></circle>)}
        </g>
      ))}
      <RefLines lines={p.refLines} scale={y} />
    </svg>
  );
}

function Combo({ p }: { p: Extract<Panel, { kind: 'combo' }> }) {
  const y = linear(0, maxOf(p.bars) * 1.1 || 1, H - M.b, M.t);
  const y2 = linear(0, maxOf(p.lines) * 1.15 || 1, H - M.b, M.t);
  const n = p.categories.length;
  const band = (W - M.l - M.r) / Math.max(1, n);
  const w = (band * 0.8) / Math.max(1, p.bars.length);
  const cx = (i: number) => M.l + band * (i + 0.5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bars and lines ${p.title}: ${[...p.bars, ...p.lines].map((s) => s.name).join(', ')}`}>
      <YAxis scale={y} />
      <YAxis scale={y2} left={false} />
      {p.bars.map((s, si) => s.values.map((v, i) => v === null ? null : (
        <rect key={`${si}-${i}`} x={cx(i) - (band * 0.8) / 2 + si * w} y={y(Math.max(v, 0))} width={Math.max(1, w - 1)} height={Math.max(0, y(0) - y(Math.max(v, 0)))} fill={PALETTE[si % PALETTE.length]} opacity="0.85">
          <title>{`${p.categories[i]} · ${s.name}: ${fmt(v)}`}</title>
        </rect>
      )))}
      {p.lines.map((s, li) => {
        const color = PALETTE[(p.bars.length + li) % PALETTE.length];
        const pts = s.values.map((v, i) => (v === null ? null : [cx(i), y2(v)] as const)).filter((q): q is readonly [number, number] => q !== null);
        return (
          <g key={s.name} stroke={color} fill={color}>
            <polyline fill="none" strokeWidth="2.2" points={pts.map((q) => q.join(',')).join(' ')} />
            {pts.map((q, i) => <circle key={i} cx={q[0]} cy={q[1]} r="3.4" />)}
          </g>
        );
      })}
      <XLabels cats={p.categories} x={cx} />
    </svg>
  );
}

function MiniPlot({ label, series, scatter }: { label: string; series: PointSeries[]; scatter: boolean }) {
  const w = 260; const h = 130; const m = { l: 40, r: 8, t: 10, b: 22 };
  const r = pointsRange(series);
  const x = linear(r.x0, r.x1, m.l, w - m.r, 4);
  const y = linear(Math.min(0, r.y0), r.y1 * 1.05 || 1, h - m.b, m.t, 3);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      {y.ticks.map((t) => (
        <g key={t}><line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke={GRID} /><text x={m.l - 4} y={y(t)} dy="0.32em" textAnchor="end" fill={AXIS} fontSize="9">{fmt(t)}</text></g>
      ))}
      {x.ticks.map((t) => <text key={t} x={x(t)} y={h - 8} textAnchor="middle" fill={AXIS} fontSize="9">{fmt(t)}</text>)}
      {series.map((s, i) => {
        const c = PALETTE[i % PALETTE.length];
        return scatter
          ? <g key={s.name} fill={c} opacity="0.8">{s.points.map((q, k) => <circle key={k} cx={x(q.x)} cy={y(q.y)} r="2.6" />)}</g>
          : <polyline key={s.name} fill="none" stroke={c} strokeWidth="1.8" points={s.points.map((q) => `${x(q.x)},${y(q.y)}`).join(' ')} />;
      })}
    </svg>
  );
}

function Multi({ p }: { p: Extract<Panel, { kind: 'multi' }> }) {
  return (
    <div className="mini-stack">
      {p.plots.map((pl) => (
        <div key={pl.label} className="mini">
          <div className="mini-label">{pl.label}</div>
          <MiniPlot label={`${p.title} ${pl.label}`} series={pl.series} scatter={p.scatter} />
          {p.scatter && <Legend names={pl.series.map((s) => s.name)} />}
        </div>
      ))}
    </div>
  );
}

function Hbar({ p }: { p: Extract<Panel, { kind: 'hbar' }> }) {
  const rowH = 24;
  const left = 190;
  const h = M.t + p.items.length * rowH + 34;
  const maxV = Math.max(...p.items.map((i) => i.value), ...p.items.map((i) => i.marker ?? 0), p.refLine?.value ?? 0, 0) * 1.1 || 1;
  const x = linear(0, maxV, left, W - 24);
  const colors = p.items.map((i) => i.color).filter((c): c is number => c !== null);
  const c0 = Math.min(...colors); const c1 = Math.max(...colors);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`Horizontal bars ${p.title}`}>
      {x.ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={M.t} y2={h - 30} stroke={GRID} /><text x={x(t)} y={h - 16} textAnchor="middle" fill={AXIS} fontSize="10">{fmt(t)}</text></g>)}
      {p.items.map((it, i) => {
        const yy = M.t + i * rowH;
        const fill = it.flagged ? RED : it.color !== null && c1 > c0 ? heatColor((it.color - c0) / (c1 - c0)) : PALETTE[0];
        return (
          <g key={`${it.label}-${i}`}>
            <text x={left - 8} y={yy + rowH / 2} dy="0.32em" textAnchor="end" fill="#1b2330" fontSize="10.5">{short(it.label, 30)}</text>
            <rect x={left} y={yy + 3} width={Math.max(1, x(it.value) - left)} height={rowH - 7} fill={fill} stroke={it.flagged ? '#7a1d12' : 'none'}>
              <title>{`${it.label}: ${fmt(it.value)}${it.marker !== null ? ` (${p.markerLabel}: ${fmt(it.marker)})` : ''}`}</title>
            </rect>
            <text x={x(it.value) + 4} y={yy + rowH / 2} dy="0.32em" fill={AXIS} fontSize="9.5">{fmt(it.value)}</text>
            {it.marker !== null && <rect x={x(it.marker) - 4} y={yy + rowH / 2 - 4} width="8" height="8" transform={`rotate(45 ${x(it.marker)} ${yy + rowH / 2})`} fill="#111" />}
          </g>
        );
      })}
      {p.refLine && (
        <g><line x1={x(p.refLine.value)} x2={x(p.refLine.value)} y1={M.t} y2={h - 30} stroke={RED} strokeDasharray="5 4" />
          <text x={x(p.refLine.value) + 3} y={M.t + 9} fill={RED} fontSize="10">{p.refLine.label}</text></g>
      )}
    </svg>
  );
}

function Heat({ p }: { p: Extract<Panel, { kind: 'heat' }> }) {
  const left = 190; const cellH = 24;
  const cellW = Math.max(36, Math.min(80, (W - left - 16) / Math.max(1, p.cols.length)));
  const w = left + cellW * p.cols.length + 16;
  const h = 26 + p.rows.length * cellH + 8;
  const vals = p.values.flat().filter((v): v is number => v !== null);
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  return (
    <svg viewBox={`0 0 ${Math.max(W, w)} ${h}`} role="img" aria-label={`Heat map ${p.title}: ${p.valueLabel}`}>
      {p.cols.map((c, j) => <text key={c} x={left + cellW * (j + 0.5)} y={16} textAnchor="middle" fill={AXIS} fontSize="10">{c}</text>)}
      {p.rows.map((r, i) => (
        <g key={`${r}-${i}`}>
          <text x={left - 8} y={26 + i * cellH + cellH / 2} dy="0.32em" textAnchor="end" fontSize="10.5" fill="#1b2330">{short(r, 30)}</text>
          {p.cols.map((c, j) => {
            const v = p.values[i][j];
            const t = v === null || hi === lo ? 0 : (v - lo) / (hi - lo);
            return (
              <g key={c}>
                <rect x={left + cellW * j} y={26 + i * cellH} width={cellW - 1} height={cellH - 1} fill={v === null ? '#f0f2f5' : heatColor(t)}><title>{`${r} · ${c}: ${v === null ? 'no data' : fmt(v)}`}</title></rect>
                {v !== null && <text x={left + cellW * (j + 0.5)} y={26 + i * cellH + cellH / 2} dy="0.32em" textAnchor="middle" fontSize="9.5" fill={heatText(t)}>{fmt(v)}</text>}
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

function Scatter({ p }: { p: Extract<Panel, { kind: 'scatter' }> }) {
  const xs = p.points.map((q) => q.x); const ys = p.points.map((q) => q.y);
  const x = p.logx ? logScale(Math.min(...xs), Math.max(...xs) * 1.0001 || 1, M.l + 8, W - M.r - 8) : linear(Math.min(0, ...xs), Math.max(...xs) * 1.05 || 1, M.l + 8, W - M.r - 8);
  const y = p.logy ? logScale(Math.min(...ys), Math.max(...ys) * 1.0001 || 1, H - M.b, M.t) : linear(Math.min(0, ...ys), Math.max(...ys) * 1.05 || 1, H - M.b, M.t);
  const maxSize = Math.max(...p.points.map((q) => q.size), 1);
  const labelled = [...p.points].sort((a, b) => b.y - a.y).slice(0, 6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Scatter ${p.title}: ${p.yLabel} against ${p.xLabel}`}>
      {y.ticks.map((t) => <g key={t}><line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke={GRID} /><text x={M.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fill={AXIS} fontSize="10">{fmt(t)}</text></g>)}
      {x.ticks.map((t) => <text key={t} x={x(t)} y={H - M.b + 14} textAnchor="middle" fill={AXIS} fontSize="10">{fmt(t)}</text>)}
      <text x={(M.l + W - M.r) / 2} y={H - 6} textAnchor="middle" fill={AXIS} fontSize="10">{p.xLabel}{p.logx ? ' (log)' : ''}</text>
      <text transform={`translate(12 ${(M.t + H - M.b) / 2}) rotate(-90)`} textAnchor="middle" fill={AXIS} fontSize="10">{p.yLabel}{p.logy ? ' (log)' : ''}</text>
      {p.points.map((q, i) => (
        <circle key={i} cx={x(q.x)} cy={y(q.y)} r={4 + 8 * (q.size / maxSize)} fill={PALETTE[0]} fillOpacity="0.6" stroke="#fff"><title>{`${q.label}: ${fmt(q.x)}, ${fmt(q.y)}`}</title></circle>
      ))}
      {labelled.map((q, i) => <text key={`l${i}`} x={x(q.x) + 6} y={y(q.y) - 6} fontSize="9" fill="#1b2330">{short(q.label, 22)}</text>)}
    </svg>
  );
}

function Stack({ p }: { p: Extract<Panel, { kind: 'stack' }> }) {
  const n = p.categories.length;
  const y = linear(0, 100, H - M.b, M.t);
  const band = (W - M.l - M.r) / Math.max(1, n);
  const cx = (i: number) => M.l + band * (i + 0.5);
  const lineMax = Math.max(...p.lines.flatMap((s) => s.values).filter((v): v is number => v !== null), 1);
  const y2 = linear(0, lineMax * 1.05, H - M.b, M.t);
  const stackColors = p.parts.length === 3 ? STACK3 : STACK5;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`100 % stacked bars ${p.title}: ${p.parts.map((s) => s.name).join(', ')}`}>
      <YAxis scale={y} />
      {p.lines.length > 0 && <YAxis scale={y2} left={false} />}
      {Array.from({ length: n }, (_, i) => {
        const total = p.parts.reduce((s, part) => s + Math.max(0, part.values[i] ?? 0), 0) || 1;
        let acc = 0;
        return (
          <g key={i}>
            {p.parts.map((part, pi) => {
              const v = Math.max(0, part.values[i] ?? 0) / total * 100;
              const rect = (
                <g key={part.name}>
                  <rect x={cx(i) - band * 0.35} width={band * 0.7} y={y(acc + v)} height={Math.max(0, y(acc) - y(acc + v))} fill={stackColors[pi % stackColors.length]}>
                    <title>{`${p.categories[i]} · ${part.name}: ${fmt(v)} %`}</title>
                  </rect>
                  {v >= 7 && <text x={cx(i)} y={y(acc + v / 2)} dy="0.32em" textAnchor="middle" fontSize="9" fill="#fff">{Math.round(v)}%</text>}
                </g>
              );
              acc += v;
              return rect;
            })}
          </g>
        );
      })}
      {p.lines.map((s, li) => {
        const color = LINE_COLORS[li % 2];
        const pts = s.values.map((v, i) => (v === null ? null : [cx(i), y2(v)] as const)).filter((q): q is readonly [number, number] => q !== null);
        return <g key={s.name} stroke={color} fill={color}><polyline fill="none" strokeWidth="2" strokeDasharray={li ? '4 3' : undefined} points={pts.map((q) => q.join(',')).join(' ')} />{pts.map((q, i) => <circle key={i} cx={q[0]} cy={q[1]} r="3" />)}</g>;
      })}
      <XLabels cats={p.categories} x={cx} />
    </svg>
  );
}

function Diverging({ p }: { p: Extract<Panel, { kind: 'diverging' }> }) {
  const rowH = 24; const left = 190;
  const h = M.t + p.items.length * rowH + 30;
  const ext = Math.max(...p.items.map((i) => Math.abs(i.value)), 1) * 1.15;
  const x = linear(-ext, ext, left, W - 28);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`Diverging bars ${p.title}: ${p.valueLabel}`}>
      {x.ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={M.t} y2={h - 26} stroke={GRID} /><text x={x(t)} y={h - 12} textAnchor="middle" fill={AXIS} fontSize="10">{fmt(t)}</text></g>)}
      <line x1={x(0)} x2={x(0)} y1={M.t} y2={h - 26} stroke="#111" />
      {p.items.map((it, i) => {
        const yy = M.t + i * rowH;
        const x0 = x(0); const x1 = x(it.value);
        return (
          <g key={`${it.label}-${i}`}>
            <text x={left - 8} y={yy + rowH / 2} dy="0.32em" textAnchor="end" fontSize="10.5" fill="#1b2330">{short(it.label, 30)}</text>
            <rect x={Math.min(x0, x1)} y={yy + 3} width={Math.max(1, Math.abs(x1 - x0))} height={rowH - 7} fill={it.value <= 0 ? GREEN : RED}><title>{`${it.label}: ${it.value > 0 ? '+' : ''}${fmt(it.value)}`}</title></rect>
            <text x={it.value >= 0 ? x1 + 4 : x1 - 4} y={yy + rowH / 2} dy="0.32em" textAnchor={it.value >= 0 ? 'start' : 'end'} fontSize="9.5" fill={AXIS}>{`${it.value > 0 ? '+' : ''}${fmt(it.value)}`}</text>
          </g>
        );
      })}
    </svg>
  );
}

const STACK3 = [GREEN, '#e6a23c', RED];
const STACK5 = ['#4c78a8', '#f58518', '#54a24b', '#b279a2', '#e45756'];
const LINE_COLORS = ['#111', '#7c3aed'];

function legendColors(p: Panel): string[] | undefined {
  if (p.kind !== 'stack') return undefined;
  return [...(p.parts.length === 3 ? STACK3 : STACK5).slice(0, p.parts.length), ...p.lines.map((_, i) => LINE_COLORS[i % 2])];
}

function legendOf(p: Panel): string[] {
  switch (p.kind) {
    case 'bars': return p.series.map((s) => s.name);
    case 'lines': return p.series.map((s) => s.name);
    case 'combo': return [...p.bars, ...p.lines].map((s) => s.name);
    case 'stack': return [...p.parts, ...p.lines].map((s) => s.name);
    default: return [];
  }
}

function PanelView({ p }: { p: Panel }): ReactNode {
  switch (p.kind) {
    case 'bars': return <Bars p={p} />;
    case 'lines': return <Lines p={p} />;
    case 'combo': return <Combo p={p} />;
    case 'multi': return <Multi p={p} />;
    case 'hbar': return <Hbar p={p} />;
    case 'heat': return <Heat p={p} />;
    case 'scatter': return <Scatter p={p} />;
    case 'stack': return <Stack p={p} />;
    case 'diverging': return <Diverging p={p} />;
  }
}

export function ChartView({ model }: { model: ChartModel }) {
  const panels = model.panels.filter(panelHasData);
  if (!panels.length) return <p className="muted">There is nothing to draw with these rows; the table below has them.</p>;
  return (
    <div className="chart-grid" data-chart={model.type}>
      {panels.map((p, i) => (
        <figure key={`${p.title}-${i}`} className="chart-panel">
          {p.title && <figcaption>{p.title}</figcaption>}
          <PanelView p={p} />
          <Legend names={legendOf(p)} colors={legendColors(p)} />
        </figure>
      ))}
      {model.notes.map((n) => <p key={n} className="muted small">{n}</p>)}
    </div>
  );
}
