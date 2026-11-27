import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExecSettings, fieldId } from '../components/ExecSettings';
import { FilePicker } from '../components/FilePicker';
import { JsonPanel } from '../components/JsonPanel';
import { ModelCardView } from '../components/ModelCardView';
import { Button, Dialog, Label, Notice, RadioGroup, TextInput } from '../components/ui';
import { generate, stringifyParams, type Issue } from '../lib/generate';
import { importParams } from '../lib/importParams';
import { confirmation, launchCheck, toLaunched, type LaunchContext } from '../lib/launch';
import { modeState } from '../lib/modes';
import {
  addModel, defaultForm, duplicateModel, nextCardId, patchCard, patchCardSettings, removeModel, setSettingsMode, execDefaults,
} from '../lib/model';
import { checkDatasets, launchPipeline, missingFiles, type DatasetCheck } from '../lib/ops';
import { PIPELINE_NAME } from '../lib/parameters';
import { errorText, useApp } from '../lib/store';
import type { JobInstance } from '../lib/fabric';
import { ParamHelp as ParamHelpInline, fmtTime } from '../components/ui';

function errorMap(issues: Issue[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const i of issues) if (i.field && !m[i.field]) m[i.field] = i.message;
  return m;
}

export function LaunchView() {
  const app = useApp();
  const { form, setForm, backend, target, account } = app;
  const gen = useMemo(() => generate(form), [form]);
  const errors = useMemo(() => errorMap(gen.errors), [gen.errors]);
  const m = modeState(form);
  const [files, setFiles] = useState<LaunchContext['files']>({ status: 'unchecked', missing: [] });
  const [datasets, setDatasets] = useState<LaunchContext['datasets']>({ status: 'unchecked', missing: [], unverifiable: [] });
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [choose, setChoose] = useState<JobInstance[] | null>(null);
  const [notice, setNotice] = useState<{ tone: 'bad' | 'warn' | 'ok'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const seq = useRef(0);

  const pipeline = app.discovery?.pipeline;
  const ctx: LaunchContext = {
    signedIn: !!account, workspaceId: app.stored.workspaceId || undefined, pipelineId: pipeline?.id, lakehouseId: app.stored.lakehouseId || undefined,
    pipelineVersion: 'unverified', pipelineConfirmed: app.stored.pipelineConfirmed, files, datasets, submitting,
  };
  const check = launchCheck(gen, ctx);

  // Do the referenced files and the semantic models exist? (debounced; checked again right before launching)
  const filesKey = gen.files.join('|');
  const datasetsKey = JSON.stringify(gen.effective.map((e) => [e.workspace, e.dataset]));
  const runChecks = useCallback(async (): Promise<{ missing: string[]; ds: DatasetCheck } | null> => {
    if (!target || !account) return null;
    const missing = gen.files.length ? await missingFiles(backend, target, gen.files) : [];
    const ds = await checkDatasets(backend, target.ws, gen.effective);
    return { missing, ds };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, target, account, filesKey, datasetsKey]);

  useEffect(() => {
    if (!target || !account) { setFiles({ status: 'unchecked', missing: [] }); setDatasets({ status: 'unchecked', missing: [], unverifiable: [] }); return undefined; }
    const mine = ++seq.current;
    setFiles((f) => ({ ...f, status: 'checking' })); setDatasets((d) => ({ ...d, status: 'checking' }));
    const timer = window.setTimeout(() => {
      void runChecks().then((r) => {
        if (mine !== seq.current || !r) return;
        setFiles({ status: 'done', missing: r.missing });
        setDatasets({ status: 'done', missing: r.ds.missing, unverifiable: r.ds.unverifiable });
      }).catch((e) => {
        if (mine !== seq.current) return;
        setFiles({ status: 'error', missing: [], error: errorText(e) }); setDatasets({ status: 'error', missing: [], unverifiable: [] });
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [runChecks, target, account]);

  const onLaunchClick = async () => {
    setNotice(null);
    setSubmitting(true);
    try {
      const r = await runChecks();
      if (r) { setFiles({ status: 'done', missing: r.missing }); setDatasets({ status: 'done', missing: r.ds.missing, unverifiable: r.ds.unverifiable }); }
      if (r && (r.missing.length || r.ds.missing.length)) { setNotice({ tone: 'bad', text: 'Something referenced by the parameters does not exist (see the reasons next to the button). Nothing was launched.' }); return; }
      setConfirm(true);
    } catch (e) { setNotice({ tone: 'bad', text: errorText(e) }); } finally { setSubmitting(false); }
  };

  const doLaunch = async () => {
    if (submitting || !target || !pipeline) return;
    setConfirm(false);
    setSubmitting(true);
    try {
      const located = await launchPipeline(backend, target.ws, pipeline.id, gen.params, app.backend.demo ? { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), pollMs: 600, attempts: 10 } : undefined);
      if (located.candidates.length === 1) {
        const id = located.candidates[0].id;
        app.rememberLaunched(toLaunched(id, gen.params, located.launchedAt));
        void app.refreshJobs();
        app.go(`#/runs/${encodeURIComponent(id)}`);
      } else if (located.candidates.length > 1) setChoose(located.candidates);
      else setNotice({ tone: 'warn', text: 'The pipeline was started, but the new run did not show up yet. Open Runs in a moment to find it.' });
    } catch (e) { setNotice({ tone: 'bad', text: errorText(e) }); } finally { setSubmitting(false); }
  };

  const pickJob = (job: JobInstance) => {
    app.rememberLaunched(toLaunched(job.id, gen.params, new Date(Date.parse(job.startTimeUtc ?? '') || Date.now())));
    setChoose(null);
    app.go(`#/runs/${encodeURIComponent(job.id)}`);
  };

  const copy = async () => {
    const text = stringifyParams(gen.params);
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setCopied(true); window.setTimeout(() => setCopied(false), 1800);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([stringifyParams(gen.params)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${form.test_name_prefix || 'loadtest'}-parameters.json`; a.click(); URL.revokeObjectURL(url);
  };

  const globalShown = m.globalExecOff ? execDefaults() : form.global;
  const conf = confirmation(gen, app.workspaceName || app.stored.workspaceId, pipeline?.displayName ?? PIPELINE_NAME);

  return (
    <div className="launch">
      <div className="launch-main">
        <h1>Parameters &amp; launch</h1>
        <EnvBar />
        {notice && <Notice tone={notice.tone} role="alert">{notice.text}</Notice>}
        {app.importReport && <ImportReportView onClose={() => app.setImportReport(null)} />}

        <section id="sec-models" aria-labelledby="h-models">
          <div className="sec-head"><h2 id="h-models">Models <ParamHelpInline name="models" /></h2></div>
          <p className="muted">One card per semantic model; all models run in parallel (at most 10 at a time). The same model can appear several times, each with its own <code>model_key</code>, to simulate different user profiles.</p>
          <div className="mode-row">
            <RadioGroup label="Run settings" value={form.settingsMode} onChange={(v) => setForm((f) => setSettingsMode(f, v))}
              options={[{ value: 'global', label: 'Global', hint: 'Ten settings written once' }, { value: 'per_model', label: 'Per model', hint: 'Every model carries its ten settings' }]} />
            <RadioGroup label="Navigation JSON" value={form.navMode} onChange={(v) => setForm((f) => ({ ...f, navMode: v }))}
              options={[{ value: 'per_model', label: 'One file per model' }, { value: 'same', label: 'Same file for all' }]} />
          </div>
          {form.navMode === 'same' && (
            <div className="field">
              <Label htmlFor={fieldId('globalQueryfile')}>Navigation JSON shared by all models</Label>
              <FilePicker kind="queries" id={fieldId('globalQueryfile')} label="Navigation file for all models" value={form.globalQueryfile}
                onChange={(p) => setForm((f) => ({ ...f, globalQueryfile: p }))} off={m.globalNavOff} why={m.globalNavWhy} error={errors.globalQueryfile} />
            </div>
          )}
          {form.navMode === 'per_model' && <p className="muted small">The selector for one file shared by all models is greyed out: {m.globalNavWhy.replace('Disabled: ', '')}</p>}
          {errors.models && <p className="err-text" role="alert">{errors.models}</p>}
          <div className="cards">
            {form.models.map((c, i) => (
              <ModelCardView key={c.id} card={c} index={i} form={form} gen={gen} errors={errors} canRemove={form.models.length > 1}
                patch={(p) => setForm((f) => patchCard(f, c.id, p))} patchSettings={(p) => setForm((f) => patchCardSettings(f, c.id, p))}
                onDuplicate={() => setForm((f) => duplicateModel(f, c.id, nextCardId()))} onRemove={() => setForm((f) => removeModel(f, c.id))} />
            ))}
          </div>
          <Button onClick={() => setForm((f) => addModel(f, nextCardId()))}>Add model</Button>
        </section>

        <section id="sec-run" aria-labelledby="h-run">
          <div className="sec-head"><h2 id="h-run">Ramp and run settings</h2></div>
          <div className="grid2">
            <div className="field">
              <Label htmlFor={fieldId('test_name_prefix')} param="test_name_prefix">Test name prefix</Label>
              <TextInput id={fieldId('test_name_prefix')} value={form.test_name_prefix} onChange={(v) => setForm((f) => ({ ...f, test_name_prefix: v }))} error={errors.test_name_prefix} mono />
              <p className="muted small">Run folders: <code>{(form.test_name_prefix || 'prefix')}-&lt;model_key&gt;-c&lt;users&gt;-&lt;date&gt;</code></p>
            </div>
          </div>
          <h3 className="sub">Global values {m.globalExecOff && <span className="muted small">(not used in Per model mode)</span>}</h3>
          <ExecSettings value={globalShown} onChange={(p) => setForm((f) => ({ ...f, global: { ...f.global, ...p } }))} scope="global" off={m.globalExecOff} why={m.globalExecWhy} errors={errors} />
          <h3 className="sub">Results</h3>
          <div className="grid3">
            <div className="field">
              <Label param="stop_on_query_error">Stop on query error</Label>
              <RadioGroup label="A failed query stops its user" value={form.stop_on_query_error} onChange={(v) => setForm((f) => ({ ...f, stop_on_query_error: v }))} options={[{ value: false, label: 'No' }, { value: true, label: 'Yes' }]} />
            </div>
            <div className="field">
              <Label htmlFor={fieldId('fail_on_error_rate')} param="fail_on_error_rate">Fail above error rate (0–1)</Label>
              <TextInput id={fieldId('fail_on_error_rate')} value={form.fail_on_error_rate} onChange={(v) => setForm((f) => ({ ...f, fail_on_error_rate: v }))} error={errors.fail_on_error_rate} inputMode="decimal" />
            </div>
            <div className="field">
              <Label param="write_results_to_tables">Write results to Delta tables</Label>
              <RadioGroup label="Also append each run to loadtest_runs and loadtest_queries" value={form.write_results_to_tables} onChange={(v) => setForm((f) => ({ ...f, write_results_to_tables: v }))} options={[{ value: false, label: 'No' }, { value: true, label: 'Yes' }]} />
            </div>
          </div>
          <p className="muted small">A run with failed queries still ends <em>Completed</em> unless you set a threshold in “Fail above error rate”.</p>
        </section>

        <section id="sec-rls" aria-labelledby="h-rls">
          <div className="sec-head"><h2 id="h-rls">RLS users</h2></div>
          <div className="mode-row">
            <RadioGroup label="Source (rls_source)" value={form.rlsSource} onChange={(v) => setForm((f) => ({ ...f, rlsSource: v }))}
              options={[{ value: 'none', label: 'none' }, { value: 'list', label: 'list' }, { value: 'file', label: 'file' }]} />
            <RadioGroup label="Scope (rls_scope)" value={form.rlsScope} onChange={(v) => setForm((f) => ({ ...f, rlsScope: v }))} disabled={m.rlsScopeOff} reason={m.rlsScopeOff ? m.rlsScopeWhy : undefined}
              options={[{ value: 'global', label: 'global' }, { value: 'per_model', label: 'per_model' }]} />
          </div>
          <div className="grid2">
            <div className="field">
              <Label htmlFor={fieldId('rls_users')} param="rls_users">Users (global list)</Label>
              <TextInput id={fieldId('rls_users')} textarea rows={4} mono value={form.rls_users} onChange={(v) => setForm((f) => ({ ...f, rls_users: v }))} off={m.globalUsersOff} why={m.globalUsersWhy} error={errors.rls_users} placeholder="one per line, or separated by commas or semicolons" />
            </div>
            <div className="field">
              <Label htmlFor={fieldId('rls_users_file')} param="rls_users_file">Users file (global)</Label>
              <FilePicker kind="users" id={fieldId('rls_users_file')} label="Global users file" value={form.rls_users_file} onChange={(p) => setForm((f) => ({ ...f, rls_users_file: p }))} off={m.globalFileOff} why={m.globalFileWhy} error={errors.rls_users_file} />
            </div>
          </div>
          <p className="muted small">With <em>per_model</em>, every model needs its own users (the global fallback is not offered). Users are never stored in the browser and are masked everywhere except in the fields where you type them.</p>
        </section>
      </div>

      <JsonPanel gen={gen} check={check} onLaunch={() => void onLaunchClick()} onLoad={() => setLoadOpen(true)} onReset={() => setResetOpen(true)} copied={copied} onCopy={() => void copy()} onDownload={download} />

      {confirm && (
        <Dialog title="Launch this test?" onClose={() => setConfirm(false)} wide>
          <dl className="kv">
            <dt>Workspace</dt><dd>{conf.workspace}</dd>
            <dt>Pipeline</dt><dd><code>{conf.pipeline}</code></dd>
            <dt>Models</dt><dd>{conf.models}</dd>
            {conf.levels.map((l) => <div key={l.model_key} className="kvrow"><dt>{l.model_key}</dt><dd>levels {l.levels.join(' → ')}</dd></div>)}
          </dl>
          <ul className="summary">{conf.summary.map((s) => <li key={s}>{s}</li>)}</ul>
          {conf.peaks.length > 0 && (
            <Notice tone="info">Theoretical peak of users per semantic model (highest level of each profile, summed): {conf.peaks.map((p) => `${p.dataset}: ${p.peak}${p.profiles.length > 1 ? ` (${p.profiles.length} profiles)` : ''}`).join(' · ')}</Notice>
          )}
          <div className="dialog-actions">
            <Button kind="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button kind="primary" disabled={submitting} onClick={() => void doLaunch()}>Launch</Button>
          </div>
        </Dialog>
      )}
      {choose && (
        <Dialog title="Which run is yours?" onClose={() => setChoose(null)}>
          <p>More than one new run appeared at the same time. Choose the one you launched.</p>
          <ul className="choose">{choose.map((j) => <li key={j.id}><Button onClick={() => pickJob(j)}>{fmtTime(j.startTimeUtc)} · {j.status}</Button></li>)}</ul>
        </Dialog>
      )}
      {loadOpen && <LoadDialog onClose={() => setLoadOpen(false)} />}
      {resetOpen && (
        <Dialog title="Reset to the default values?" onClose={() => setResetOpen(false)}>
          <p>Everything you typed in the form is cleared (the uploaded files are not touched).</p>
          <div className="dialog-actions">
            <Button kind="ghost" onClick={() => setResetOpen(false)}>Cancel</Button>
            <Button kind="danger" onClick={() => { setForm(defaultForm()); app.setImportReport(null); setResetOpen(false); }}>Reset</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}


function EnvBar() {
  const app = useApp();
  const pipeline = app.discovery?.pipeline;
  return (
    <div className="envbar" aria-label="Test environment">
      <span><strong>Workspace:</strong> {app.workspaceName || '—'}</span>
      <span><strong>Lakehouse:</strong> {app.lakehouseName || '—'}</span>
      <span><strong>Pipeline:</strong> {pipeline ? 'found' : 'not found'} · version {app.stored.pipelineConfirmed ? 'confirmed by you' : 'not verified'}</span>
      <a href="#/environment">Change</a>
      {!app.account && <Button small kind="primary" onClick={() => void app.signIn()}>Sign in</Button>}
      {app.authError && <span className="err-text">{app.authError}</span>}
    </div>
  );
}

function ImportReportView({ onClose }: { onClose(): void }) {
  const { importReport: r } = useApp();
  if (!r) return null;
  const any = r.unknown.length || r.warnings.length || r.notes.length;
  return (
    <section className="import-report" aria-label="Result of loading the JSON">
      <h3>JSON loaded</h3>
      {r.unknown.length > 0 && (
        <Notice tone="warn">Not parameters of the pipeline (Fabric would ignore them silently), so they were not imported: {r.unknown.map((u) => `${u.where}.${u.name}`).join(', ')}.</Notice>
      )}
      {r.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
      {r.notes.length > 0 && <ul className="muted small">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {!any && <p className="muted">Loaded without changes.</p>}
      <Button small kind="ghost" onClick={onClose}>Dismiss</Button>
    </section>
  );
}

function LoadDialog({ onClose }: { onClose(): void }) {
  const app = useApp();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const apply = () => {
    const r = importParams(text);
    if (r.error || !r.form) { setError(r.error ?? 'Could not read the JSON.'); return; }
    app.setForm(r.form);
    app.setImportReport(r.report);
    onClose();
  };
  const onFile = async (f: File | undefined) => { if (f) setText(await f.text()); };
  return (
    <Dialog title="Load an existing JSON" onClose={onClose} wide>
      <p className="muted small">Paste the parameters of the pipeline, or choose a .json file. The modes (per model, same file) are deduced; names that are not parameters are flagged and not imported.</p>
      <label className="lbl" htmlFor="load-json">JSON</label>
      <textarea id="load-json" className="input mono" rows={12} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
      <input type="file" accept=".json,application/json" aria-label="Choose a JSON file" onChange={(e) => void onFile(e.target.files?.[0])} />
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="dialog-actions">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={!text.trim()} onClick={apply}>Load</Button>
      </div>
    </Dialog>
  );
}
