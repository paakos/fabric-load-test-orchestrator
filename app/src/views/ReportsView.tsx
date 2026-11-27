import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import help from 'virtual:help';
import { ChartView } from '../components/Chart';
import { DataTable } from '../components/DataTable';
import { Badge, Button, Label, Notice, fmtTime } from '../components/ui';
import { buildChartModel } from '../lib/charts/model';
import { parseLevels } from '../lib/generate';
import { listAnalyses, loadManifest, loadQueryRows, runFolders, startAnalysis, type AnalysisEntry } from '../lib/ops';
import { maskText } from '../lib/privacy';
import { alertSeverityRank, BLOCKS, queryFileProblem, type AnalysisForm, type Manifest, type ManifestQuery, type Row } from '../lib/reports';
import { isFinal } from '../lib/progress';
import { env } from '../lib/env';
import { errorText, useApp } from '../lib/store';
import type { JobInstance } from '../lib/fabric';

export function ReportsView() {
  const app = useApp();
  const analysisId = app.route.id && app.route.id !== 'new' ? app.route.id : undefined;
  const [list, setList] = useState<AnalysisEntry[]>([]);
  const [listError, setListError] = useState('');
  const refresh = useCallback(async () => {
    if (!app.target || !app.account) return;
    try { setList(await listAnalyses(app.backend, app.target)); setListError(''); } catch (e) { setListError(errorText(e)); }
  }, [app.backend, app.target, app.account]);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="reports">
      <aside className="reports-side" aria-label="Analyses">
        <div className="page-head"><h2>Analyses</h2><Button small onClick={() => void refresh()}>Refresh</Button></div>
        <a className={`btn ${analysisId ? 'secondary' : 'primary'} small`} href="#/reports">New analysis</a>
        {listError && <Notice tone="bad">{maskText(listError)}</Notice>}
        {list.length === 0 && !listError && <p className="muted small">No analyses yet in <code>Files/PerfScenarios/analysis</code>.</p>}
        <ul className="analysis-list">
          {list.map((a) => (
            <li key={a.id}><a href={`#/reports/${encodeURIComponent(a.id)}`} aria-current={a.id === analysisId ? 'page' : undefined} className={a.id === analysisId ? 'on' : ''}>
              <span className="mono">{a.id}</span><span className="muted small">{fmtTime(a.modified)}</span></a></li>
          ))}
        </ul>
      </aside>
      <div className="reports-main">
        {analysisId ? <Viewer id={analysisId} query={app.route.query} /> : <NewAnalysis onDone={refresh} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- run the notebook

function NewAnalysis({ onDone }: { onDone(): Promise<void> }) {
  const app = useApp();
  const last = Object.values(app.launched).sort((a, b) => b.launchedAt.localeCompare(a.launchedAt))[0];
  const [prefix, setPrefix] = useState(app.route.params.get('prefix') ?? last?.plan.prefix ?? 'ramp-v3');
  const preselected = useMemo(() => new Set((app.route.params.get('runs') ?? '').split(',').filter(Boolean)), [app.route.params]);
  const [folders, setFolders] = useState<{ name: string; model_key: string; level: number }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(preselected);
  const [models, setModels] = useState('');
  const [levels, setLevels] = useState('');
  const [since, setSince] = useState('');
  const [focus, setFocus] = useState('');
  const [sla, setSla] = useState('3');
  const [apdex, setApdex] = useState('1');
  const [error, setError] = useState('');
  const [job, setJob] = useState<{ analysisId: string; jobId?: string; status: string; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const notebook = app.discovery?.notebook;

  const find = useCallback(async () => {
    if (!app.target) return;
    try { setFolders(await runFolders(app.backend, app.target, prefix.trim())); } catch (e) { setError(errorText(e)); }
  }, [app.backend, app.target, prefix]);
  useEffect(() => { if (preselected.size) void find(); /* once, for the link from a run */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.target]);

  const form = (): AnalysisForm | string => {
    const lv = levels.trim() ? parseLevels(levels) : { levels: [] as number[] };
    if ('error' in lv && lv.error) return `Levels: ${lv.error}`;
    const sl = Number(sla); const ap = Number(apdex);
    const fo = focus.trim() ? Number(focus) : null;
    if (fo !== null && (!Number.isInteger(fo) || fo < 1)) return 'Focus level must be a whole number.';
    return {
      prefix, runIds: [...selected], models: models.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), levels: lv.levels,
      sinceUtc: since, focusLevel: fo, slaSec: sl, apdexT: ap,
    };
  };

  const analyze = async () => {
    setError('');
    const f = form();
    if (typeof f === 'string') { setError(f); return; }
    if (!app.target || !notebook) return;
    setBusy(true);
    try {
      const r = await startAnalysis(app.backend, app.target.ws, notebook.id, f, env.demo ? { sleep: (ms) => new Promise((x) => setTimeout(x, ms)), pollMs: 500, attempts: 10 } : undefined);
      if (!r.candidates.length) { setJob({ analysisId: r.analysisId, status: 'Unknown', reason: 'The notebook was started but its job did not show up yet. Open the notebook in Fabric to follow it; the analysis will appear in the list when it ends.' }); return; }
      void trackJob(r.analysisId, r.candidates);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const trackJob = async (analysisId: string, candidates: JobInstance[]) => {
    const jobId = candidates[0].id;
    setJob({ analysisId, jobId, status: candidates[0].status });
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, env.demo ? 1000 : 5000));
      try {
        const j = await app.backend.job(app.stored.workspaceId, notebook!.id, jobId);
        setJob({ analysisId, jobId, status: j.status, reason: j.failureReason?.message ? maskText(j.failureReason.message) : undefined });
        if (isFinal(j.status)) {
          await onDone();
          if (j.status === 'Completed') app.go(`#/reports/${encodeURIComponent(analysisId)}`);
          return;
        }
      } catch (e) { setJob({ analysisId, jobId, status: 'Unknown', reason: errorText(e) }); return; }
    }
  };

  const problemsNotebook = app.account && app.discovery && !notebook;
  return (
    <div>
      <h1>Reports</h1>
      <p className="muted">Runs <code>AnalyzeReportPerformance_v3</code> over the logs of a test and shows its 20 analyses. The page never runs SQL: it draws what the notebook calculated.</p>
      {!app.account && <Notice tone="info">Sign in to run an analysis or open one.</Notice>}
      {problemsNotebook && (
        <Notice tone="warn">The notebook <code>AnalyzeReportPerformance_v3</code> was not found in the workspace. Import <code>notebooks/AnalyzeReportPerformance_v3.ipynb</code> (or redeploy with the installer) and attach, as its default lakehouse,
          the lakehouse that holds <code>Files/PerfScenarios/logs</code>. Analyses already in the lakehouse can still be opened from the list.</Notice>
      )}
      <fieldset className="subsection">
        <legend>What to analyze</legend>
        <div className="grid2">
          <div className="field">
            <Label htmlFor="an-prefix">Test name prefix (RUN_PREFIX)</Label>
            <div className="row"><input id="an-prefix" className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value)} /><Button small onClick={() => void find()} disabled={!app.target}>Find runs</Button></div>
          </div>
          <div className="field">
            <Label htmlFor="an-since">Only runs since (SINCE_UTC, optional)</Label>
            <input id="an-since" type="datetime-local" className="input" value={since} onChange={(e) => setSince(e.target.value)} />
          </div>
        </div>
        {folders.length > 0 && (
          <div className="field">
            <Label>Runs of this prefix ({selected.size ? `${selected.size} selected` : 'none selected = all'})</Label>
            <div className="row"><Button small onClick={() => setSelected(new Set(folders.map((f) => f.name)))}>Select all</Button><Button small onClick={() => setSelected(new Set())}>Clear</Button></div>
            <ul className="run-pick" aria-label="Runs">
              {folders.map((f) => (
                <li key={f.name}><label><input type="checkbox" checked={selected.has(f.name)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(f.name); else n.delete(f.name); return n; })} />
                  <span className="mono small">{f.name}</span></label></li>
              ))}
            </ul>
          </div>
        )}
        <div className="grid3">
          <div className="field"><Label htmlFor="an-models">Semantic model names (MODELS, one per line, optional)</Label><textarea id="an-models" className="input" rows={2} value={models} onChange={(e) => setModels(e.target.value)} /></div>
          <div className="field"><Label htmlFor="an-levels">Levels (LEVELS, optional)</Label><input id="an-levels" className="input mono" placeholder="6, 20, 60" value={levels} onChange={(e) => setLevels(e.target.value)} /></div>
          <div className="field"><Label htmlFor="an-focus">Focus level (FOCUS_LEVEL, optional)</Label><input id="an-focus" className="input" inputMode="numeric" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="highest of each model" /></div>
          <div className="field"><Label htmlFor="an-sla">SLA per action, s (SLA_SEC)</Label><input id="an-sla" className="input" inputMode="decimal" value={sla} onChange={(e) => setSla(e.target.value)} /></div>
          <div className="field"><Label htmlFor="an-apdex">Apdex T, s (APDEX_T)</Label><input id="an-apdex" className="input" inputMode="decimal" value={apdex} onChange={(e) => setApdex(e.target.value)} /></div>
        </div>
        <p className="muted small">The app always sends <code>MASK_UPN = true</code>, <code>EXPORT_JSON = true</code> and its own <code>ANALYSIS_ID</code>. Lists are sent as text: run ids and model names as a JSON list, levels as <code>6,20,60</code>.</p>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button kind="primary" disabled={!notebook || !app.account || busy || (!!job && !isFinal(job.status) && job.status !== 'Unknown')} reason={!notebook ? 'Notebook not found' : 'Sign in first'} onClick={() => void analyze()}>{busy ? 'Starting…' : 'Analyze'}</Button>
      </fieldset>
      {job && (
        <Notice tone={job.status === 'Failed' ? 'bad' : job.status === 'Completed' ? 'ok' : 'info'} role="status">
          <strong>{job.analysisId}</strong> · notebook job: <Badge tone={job.status === 'Completed' ? 'ok' : job.status === 'Failed' ? 'bad' : 'run'}>{job.status}</Badge>
          {job.reason && <p>{job.reason}</p>}
          {job.status === 'Failed' && <p className="small">Check that the default lakehouse of the notebook is the one with the logs, and that the prefix and filters match some runs.</p>}
        </Notice>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- view one analysis

function Viewer({ id, query }: { id: string; query?: string }) {
  const app = useApp();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState('');
  const [block, setBlock] = useState<string>('A');

  useEffect(() => {
    let alive = true;
    setManifest(null); setError('');
    if (!app.target) return undefined;
    loadManifest(app.backend, app.target, id).then((m) => {
      if (!alive) return;
      setManifest(m);
      const q = m.queries.find((x) => x.id === query);
      if (q) setBlock(q.block);
    }).catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [app.backend, app.target, id, query]);

  if (error) return <div><h1>{id}</h1><Notice tone="bad">{maskText(error)}</Notice></div>;
  if (!manifest) return <p className="muted">Loading the analysis…</p>;

  const queries = manifest.queries.filter((q) => q.block === block);
  const alerts = [...manifest.alerts].sort((a, b) => alertSeverityRank(a.severity) - alertSeverityRank(b.severity));
  const p = manifest.parameters;
  const masked = p.MASK_UPN === false;
  return (
    <div>
      <h1>Analysis <span className="mono">{manifest.analysis_id || id}</span></h1>
      <dl className="facts-grid" aria-label="Analysis header">
        <div><dt>Generated</dt><dd>{fmtTime(manifest.generated_utc)}</dd></div>
        <div><dt>Notebook</dt><dd>{manifest.notebook} {manifest.notebook_version}</dd></div>
        <div><dt>Prefix</dt><dd className="mono">{String(p.RUN_PREFIX ?? '')}</dd></div>
        <div><dt>Runs analysed</dt><dd>{manifest.runs.length}</dd></div>
        <div><dt>SLA / Apdex T</dt><dd>{String(p.SLA_SEC ?? '–')} s / {String(p.APDEX_T ?? '–')} s</dd></div>
        <div><dt>Focus level</dt><dd>{Object.keys(manifest.focus).length ? Object.entries(manifest.focus).map(([m, l]) => `${m}: ${l}`).join(' · ') : '–'}</dd></div>
      </dl>
      {masked && <Notice tone="warn">This analysis was generated with MASK_UPN = false. User names are masked again here, but they are in the files of the lakehouse.</Notice>}
      <details className="details"><summary>Runs analysed</summary><ul className="mono small">{manifest.runs.map((r) => <li key={r}>{r}</li>)}</ul></details>

      <AlertsPanel id={id} alerts={alerts} />

      <nav className="tabs" aria-label="Blocks of analyses">
        {Object.entries(BLOCKS).map(([k, b]) => (
          <button key={k} type="button" className={`tab${block === k ? ' on' : ''}`} aria-pressed={block === k} onClick={() => setBlock(k)}>{k} · {b.short}</button>
        ))}
      </nav>
      <h2>{BLOCKS[block]?.title ?? `Block ${block}`}</h2>
      {queries.length === 0 && <p className="muted">This analysis has no queries in this block.</p>}
      {queries.map((q) => <QueryCard key={q.id} analysisId={id} q={q} manifest={manifest} open={q.id === query} />)}
    </div>
  );
}

function AlertsPanel({ id, alerts }: { id: string; alerts: Manifest['alerts'] }) {
  const [all, setAll] = useState(false);
  const shown = all ? alerts : alerts.slice(0, 8);
  return (
    <section aria-labelledby="h-alerts" className="alerts">
      <h2 id="h-alerts">Alerts ({alerts.length})</h2>
      {alerts.length === 0 ? <p className="muted">No alerts with the current thresholds.</p> : (
        <ul>
          {shown.map((a, i) => (
            <li key={i}><Badge tone={a.severity === 'high' ? 'bad' : 'warn'}>{a.severity}</Badge>{' '}
              {a.query ? <a href={`#/reports/${encodeURIComponent(id)}/${a.query}`}>{a.query}</a> : null} {maskText(a.text)}</li>
          ))}
        </ul>
      )}
      {alerts.length > 8 && <Button small onClick={() => setAll(!all)}>{all ? 'Show fewer alerts' : `Show all ${alerts.length} alerts`}</Button>}
    </section>
  );
}

function QueryCard({ analysisId, q, manifest, open }: { analysisId: string; q: ManifestQuery; manifest: Manifest; open: boolean }) {
  const app = useApp();
  const doc = help.queries[q.id];
  const ref = useRef<HTMLElement>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (q.status !== 'ok' || !q.file || !app.target) return undefined;
    const problem = queryFileProblem(q);
    if (problem) { setError(problem); return undefined; }
    let alive = true;
    loadQueryRows(app.backend, app.target, analysisId, q.file).then((r) => { if (alive) setRows(r); }).catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [app.backend, app.target, analysisId, q]);
  useEffect(() => { if (open) ref.current?.scrollIntoView({ block: 'start' }); }, [open, rows]);

  const model = useMemo(() => (rows && q.chart ? buildChartModel(q.chart, rows, { parameters: manifest.parameters, focus: manifest.focus }) : null), [rows, q.chart, manifest]);
  return (
    <article className="query" id={`q-${q.id}`} ref={ref} aria-labelledby={`t-${q.id}`}>
      <header><h3 id={`t-${q.id}`}>{q.id} · {q.title}</h3>{q.status !== 'ok' && <Badge tone={q.status === 'error' ? 'bad' : 'idle'}>{q.status === 'error' ? 'error' : 'no data'}</Badge>}</header>
      {doc && (
        <div className="qdoc">
          <p><strong>What it measures.</strong> <span dangerouslySetInnerHTML={{ __html: doc.measures }} /></p>
          <p><strong>How to read it.</strong> <span dangerouslySetInnerHTML={{ __html: doc.read }} /></p>
          {(doc.computed || doc.skew) && (
            <details><summary>How it is computed and the skew the test may introduce</summary>
              {doc.computed && <p><strong>How it is computed.</strong> <span dangerouslySetInnerHTML={{ __html: doc.computed }} /></p>}
              {doc.skew && <p><strong>Skew the test may introduce.</strong> <span dangerouslySetInnerHTML={{ __html: doc.skew }} /></p>}
            </details>
          )}
        </div>
      )}
      {q.status === 'no_data' && <Notice tone="info">No data: {maskText(q.message || 'the query returned no rows with the current filters.')}</Notice>}
      {q.status === 'error' && <Notice tone="bad">The analysis could not be completed: {maskText(q.message)}</Notice>}
      {error && <Notice tone="bad">{maskText(error)}</Notice>}
      {q.status === 'ok' && !rows && !error && <p className="muted small">Loading…</p>}
      {model && <ChartView model={model} />}
      {rows && <DataTable id={`${analysisId}-${q.id}`} columns={q.columns} rows={rows} />}
    </article>
  );
}
