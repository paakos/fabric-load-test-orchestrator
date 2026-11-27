import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Dialog, Notice, ProgressBar, fmtDuration, fmtTime } from '../components/ui';
import { countLevelCsv, fetchProgressInputs, newProgressCache, type CsvTotals } from '../lib/ops';
import { maskText } from '../lib/privacy';
import {
  computeProgress, isFinal, iterationSentence, levelSentence, type LevelProgress, type ModelProgress, type ProgressInputs, type RunProgress,
} from '../lib/progress';
import { env } from '../lib/env';
import { errorText, useApp } from '../lib/store';

const tone = (s: string): 'ok' | 'warn' | 'bad' | 'info' | 'run' | 'idle' =>
  s === 'Completed' || s === 'done' ? 'ok' : s === 'Failed' || s === 'failed' ? 'bad' : s === 'Cancelled' || s === 'cancelled' ? 'warn' : s === 'InProgress' || s === 'running' ? 'run' : 'idle';

export function RunsView() {
  const app = useApp();
  const id = app.route.id;
  if (id) return <RunDetail jobId={id} />;
  const jobs = [...app.jobs].sort((a, b) => (b.startTimeUtc ?? '').localeCompare(a.startTimeUtc ?? ''));
  return (
    <div>
      <div className="page-head">
        <h1>Runs</h1>
        <Button small onClick={() => void app.refreshJobs()}>Refresh</Button>
      </div>
      {!app.account && <Notice tone="info">Sign in to see the runs of the pipeline.</Notice>}
      {app.account && !app.discovery?.pipeline && <Notice tone="warn">The pipeline <code>PL_PerfTest_MultiModel_v3</code> was not found in the selected workspace. Check the Environment page.</Notice>}
      {app.jobsError && <Notice tone="bad">{maskText(app.jobsError)}</Notice>}
      {jobs.length === 0 && app.discovery?.pipeline && <p className="muted">No runs yet. Launch a test from <a href="#/launch">Parameters &amp; launch</a>.</p>}
      {jobs.length > 0 && (
        <table className="table" aria-label="Runs of the pipeline">
          <thead><tr><th>Run</th><th>State</th><th>Started</th><th>Duration</th><th>Trigger</th><th>Source</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td><a href={`#/runs/${encodeURIComponent(j.id)}`} className="mono">{j.id.slice(0, 8)}…</a></td>
                <td><Badge tone={tone(j.status)}>{j.status}</Badge></td>
                <td>{fmtTime(j.startTimeUtc)}</td>
                <td>{fmtDuration(j.startTimeUtc, j.endTimeUtc)}</td>
                <td>{j.invokeType ?? '–'}</td>
                <td>{app.launched[j.id] ? 'launched from this app' : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function useRunProgress(jobId: string) {
  const app = useApp();
  const { backend, target, discovery } = app;
  const plan = app.launched[jobId]?.plan;
  const cache = useRef(newProgressCache());
  const [state, setState] = useState<{ progress: RunProgress | null; inputs: ProgressInputs | null; error: string | null; updated: number | null }>({ progress: null, inputs: null, error: null, updated: null });
  const pipelineId = discovery?.pipeline?.id;
  const planRef = useRef(plan);
  planRef.current = plan;

  const load = useCallback(async () => {
    if (!target || !pipelineId) return true;
    try {
      const inputs = await fetchProgressInputs(backend, target, pipelineId, jobId, { plan: planRef.current ? { models: planRef.current.models } : undefined, prefix: planRef.current?.prefix, cache: cache.current });
      const progress = computeProgress(inputs);
      setState({ progress, inputs, error: null, updated: Date.now() });
      return progress.finished;
    } catch (e) {
      setState((s) => ({ ...s, error: errorText(e) }));
      return false;
    }
  }, [backend, target, pipelineId, jobId]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const loop = async () => {
      const finished = await load();
      if (alive && !finished) timer = window.setTimeout(() => void loop(), env.demo ? 2000 : 12000);
    };
    void loop();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [load]);
  return { ...state, reload: load };
}

function RunDetail({ jobId }: { jobId: string }) {
  const app = useApp();
  const { progress, inputs, error, updated, reload } = useRunProgress(jobId);
  const launched = app.launched[jobId];
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const job = inputs?.job ?? app.jobs.find((j) => j.id === jobId);
  const status = job?.status ?? '…';
  const final = isFinal(status);
  const prefix = launched?.plan.prefix ?? inputs?.prefix ?? '';

  const cancel = async () => {
    setConfirmCancel(false);
    try { await app.backend.cancel(app.stored.workspaceId, app.discovery?.pipeline?.id ?? '', jobId); setCancelError(''); void reload(); void app.refreshJobs(); } catch (e) { setCancelError(errorText(e)); }
  };

  return (
    <div>
      <p className="crumb"><a href="#/runs">← Runs</a></p>
      <div className="page-head">
        <h1>Run <span className="mono small">{jobId}</span></h1>
        <div className="row">
          <Badge tone={tone(status)}>{status}</Badge>
          {!final && <Button kind="danger" small onClick={() => setConfirmCancel(true)}>Cancel run</Button>}
          {final && progress && prefix && (
            <a className="btn primary small" href={`#/reports?prefix=${encodeURIComponent(prefix)}&runs=${encodeURIComponent(progress.loadtestIds.join(','))}`}>Analyze this run</a>
          )}
        </div>
      </div>
      <p className="muted" aria-live="polite">
        Started {fmtTime(job?.startTimeUtc)} · duration {fmtDuration(job?.startTimeUtc, job?.endTimeUtc)}
        {updated ? ` · updated ${new Date(updated).toLocaleTimeString('en-GB')}` : ''}{!final ? ' · refreshes automatically' : ''}
      </p>
      {error && <Notice tone="bad">{maskText(error)}</Notice>}
      {cancelError && <Notice tone="bad">{maskText(cancelError)}</Notice>}
      {job?.failureReason?.message && <Notice tone="bad">{maskText(job.failureReason.message)}</Notice>}
      {!progress && !error && <p className="muted">Loading the progress…</p>}
      {progress && progress.models.length === 0 && <Notice tone="info">No model activity yet. The pipeline is starting.</Notice>}
      {progress && progress.fraction !== null && progress.models.length > 1 && <ProgressBar value={progress.fraction} label="Overall progress" />}
      {progress?.models.map((m) => <ModelRow key={m.model_key} m={m} inputs={inputs} />)}
      {progress && !launched && <p className="muted small">This run was not launched from this browser session, so the planned levels come from the pipeline activities; levels that have not started are not listed.</p>}
      {launched && (
        <details className="details"><summary>Parameters of this launch (users hidden)</summary><pre className="json">{JSON.stringify(launched.params, null, 2)}</pre></details>
      )}
      {progress && progress.activities.length > 0 && (
        <details className="details"><summary>Pipeline activities ({progress.activities.length})</summary>
          <ul className="small">{progress.activities.map((a, i) => <li key={i}>{a.name} · {a.type} · {a.status}</li>)}</ul>
        </details>
      )}
      {confirmCancel && (
        <Dialog title="Cancel this run?" onClose={() => setConfirmCancel(false)}>
          <p>The levels that are running will end as cancelled. Results written so far stay in the lakehouse.</p>
          <div className="dialog-actions"><Button kind="ghost" onClick={() => setConfirmCancel(false)}>Keep running</Button><Button kind="danger" onClick={() => void cancel()}>Cancel run</Button></div>
        </Dialog>
      )}
    </div>
  );
}

function ModelRow({ m, inputs }: { m: ModelProgress; inputs: ProgressInputs | null }) {
  const current = m.levelProgress[Math.max(0, m.currentIndex)] as LevelProgress | undefined;
  return (
    <section className="model-row" aria-label={`Model ${m.model_key}`}>
      <header>
        <h2>{m.model_key}{m.dataset ? <span className="muted"> · {m.dataset}</span> : null}</h2>
        <Badge tone={tone(m.status)}>{m.status}</Badge>
      </header>
      <ProgressBar value={m.fraction} label={`Progress of ${m.model_key}`} />
      <ol className="chips" aria-label="Ramp levels">
        {m.levelProgress.map((l, i) => (
          <li key={`${l.level}-${i}`} className={`chip ${l.status}${i === m.currentIndex ? ' current' : ''}`} aria-current={i === m.currentIndex ? 'step' : undefined}>
            {l.level}<span className="visually-hidden"> users, {l.status}</span>
          </li>
        ))}
      </ol>
      <dl className="facts-grid">
        <div><dt>Level</dt><dd>{levelSentence(m)}</dd></div>
        <div><dt>Iteration</dt><dd>{iterationSentence(current, m.heartbeatSeen)}{current?.iteration && current.iteration.sampled < current.iteration.users ? ` (sample of ${current.iteration.sampled} of ${current.iteration.users} users)` : ''}</dd></div>
        <div><dt>Users of the level</dt><dd>{current ? `${current.usersDone} of ${current.usersTotal} done${current.usersFailed ? ` · ${current.usersFailed} failed` : ''}` : '–'}</dd></div>
        <div><dt>Failed queries</dt><dd>{current?.failedQueries !== null && current?.failedQueries !== undefined ? `${current.failedQueries}${current.errorRate !== null ? ` · error rate ${(current.errorRate * 100).toFixed(1)} %` : ''}` : '–'}</dd></div>
      </dl>
      {m.message && <Notice tone="bad">{m.message}</Notice>}
      <details className="details"><summary>All levels</summary><LevelTable m={m} inputs={inputs} /></details>
    </section>
  );
}

function LevelTable({ m, inputs }: { m: ModelProgress; inputs: ProgressInputs | null }) {
  const app = useApp();
  const [csv, setCsv] = useState<Record<string, CsvTotals | string>>({});
  const count = async (l: LevelProgress) => {
    if (!l.folder || !app.target) return;
    const files = inputs?.details[l.folder]?.files ?? [];
    setCsv((c) => ({ ...c, [l.folder as string]: 'Counting…' }));
    try { const t = await countLevelCsv(app.backend, app.target as never, l.folder, files); setCsv((c) => ({ ...c, [l.folder as string]: t })); } catch (e) { setCsv((c) => ({ ...c, [l.folder as string]: errorText(e) })); }
  };
  return (
    <table className="table small" aria-label={`Levels of ${m.model_key}`}>
      <thead><tr><th>Users</th><th>State</th><th>Users done</th><th>Failed users</th><th>Failed queries</th><th>Error rate</th><th>Folder</th></tr></thead>
      <tbody>
        {m.levelProgress.map((l, i) => {
          const c = l.folder ? csv[l.folder] : undefined;
          return (
            <tr key={`${l.level}-${i}`}>
              <td>{l.level}</td><td><Badge tone={tone(l.status)}>{l.status}</Badge></td>
              <td>{l.usersDone}/{l.usersTotal}</td><td>{l.usersFailed}</td>
              <td>
                {l.failedQueries ?? '–'}{l.failedQueriesSource === 'error.log' && l.status === 'running' ? ' (so far)' : ''}
                {typeof c === 'object' && c ? <span className="muted"> · CSV: {c.failed} of {c.rows} rows{c.hasStatus ? '' : ' (no status column)'}{c.truncated ? ', first files only' : ''}</span> : typeof c === 'string' ? <span className="muted"> {c}</span> : null}
                {l.folder && l.failedQueriesSource === null && l.status !== 'pending' && !c && <> <button type="button" className="link" onClick={() => void count(l)}>Count from CSV</button></>}
              </td>
              <td>{l.errorRate !== null ? `${(l.errorRate * 100).toFixed(2)} %` : '–'}</td>
              <td className="mono small">{l.folder ?? '–'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
