import { useEffect, useState } from 'react';
import help from 'virtual:help';
import pkg from '../../package.json';
import { Badge, Button, Dialog, Notice } from '../components/ui';
import { checkFolders, createFolders, type FolderStatus } from '../lib/ops';
import { PIPELINE_NAME, REPORT_NOTEBOOK_NAME } from '../lib/parameters';
import { maskText } from '../lib/privacy';
import { errorText, useApp } from '../lib/store';

export function EnvironmentView() {
  const app = useApp();
  const [folders, setFolders] = useState<FolderStatus[] | null>(null);
  const [folderError, setFolderError] = useState('');
  const [creating, setCreating] = useState(false);
  const d = app.discovery;

  const load = async () => {
    if (!app.target || !app.account) { setFolders(null); return; }
    try { setFolders(await checkFolders(app.backend, app.target)); setFolderError(''); } catch (e) { setFolderError(errorText(e)); }
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.target, app.account]);

  const missing = folders?.filter((f) => !f.exists) ?? [];
  const create = async () => {
    setCreating(false);
    if (!app.target) return;
    try { await createFolders(app.backend, app.target, missing.map((f) => f.path)); await load(); void app.refreshFiles('queries'); void app.refreshFiles('users'); } catch (e) { setFolderError(errorText(e)); }
  };

  return (
    <div className="env-page">
      <h1>Environment</h1>
      <p className="muted">What the app connects to. The choice is remembered for this browser session only (it holds no user names).</p>
      {app.missing.length > 0 && <Notice tone="bad">Missing configuration: <code>{app.missing.join(', ')}</code>. See the README (environment variables).</Notice>}
      {!app.account && (
        <Notice tone="info"><strong>Sign in</strong> to list your workspaces. One consent screen asks for Fabric (read, run) and OneLake permissions on your behalf.
          <div><Button kind="primary" small onClick={() => void app.signIn()}>Sign in</Button> {app.authError && <span className="err-text">{app.authError}</span>}</div>
          <p className="small muted">Inside the Fabric portal the first click may open the hosting sign-in; if so, click Sign in again. The VS Code embedded browser blocks popups: use a normal browser.</p>
        </Notice>
      )}
      {app.discoveryError && <Notice tone="bad">{maskText(app.discoveryError)}</Notice>}
      {app.warnedWorkspace && <Notice tone="warn"><strong>This workspace is flagged as not for tests</strong> (VITE_WARN_WORKSPACES). Choose another one.</Notice>}

      <table className="table env-table" aria-label="Environment checks">
        <tbody>
          <tr>
            <th scope="row"><label htmlFor="env-ws">Test workspace</label></th>
            <td>
              <select id="env-ws" className="input" value={app.stored.workspaceId} disabled={!app.account} onChange={(e) => app.setWorkspace(e.target.value)}>
                <option value="">Choose a workspace…</option>
                {app.workspaces.map((w) => <option key={w.id} value={w.id}>{w.displayName}</option>)}
              </select>
            </td>
            <td>{app.stored.workspaceId ? <Badge tone="ok">selected</Badge> : <Badge tone="idle">required</Badge>}</td>
          </tr>
          <tr>
            <th scope="row">Pipeline <code>{PIPELINE_NAME}</code></th>
            <td>{d?.pipeline ? <span>Found</span> : <span>{d ? 'Not found in this workspace. Deploy the orchestrator with the installer notebook.' : '–'}</span>}</td>
            <td>{d ? (d.pipeline ? <Badge tone="ok">found</Badge> : <Badge tone="bad">missing</Badge>) : null}</td>
          </tr>
          <tr>
            <th scope="row">Pipeline version</th>
            <td>
              <Badge tone={app.stored.pipelineConfirmed ? 'warn' : 'idle'}>{app.stored.pipelineConfirmed ? 'not verified · confirmed by you' : 'not verified'}</Badge>
              <p className="small muted">Reading the definition of a pipeline needs a write permission (<code>Item.ReadWrite.All</code>), which this app does not ask for. If the deployed pipeline is older, the per-model settings are
                ignored without a warning.</p>
              <label className="check"><input type="checkbox" checked={app.stored.pipelineConfirmed} disabled={!d?.pipeline} onChange={(e) => app.setPipelineConfirmed(e.target.checked)} />
                I confirm that the deployed pipeline is the current version (its <code>ForEach</code> uses <code>@coalesce(item()?.x, pipeline().parameters.x)</code> and it has the 19 parameters).</label>
            </td>
            <td />
          </tr>
          <tr>
            <th scope="row"><label htmlFor="env-lh">Lakehouse of the test</label></th>
            <td>
              <select id="env-lh" className="input" value={app.stored.lakehouseId} disabled={!d} onChange={(e) => app.setLakehouse(e.target.value)}>
                <option value="">Choose a lakehouse…</option>
                {d?.lakehouses.map((l) => <option key={l.id} value={l.id}>{l.displayName}</option>)}
              </select>
              <p className="small muted">The one that holds <code>Files/PerfScenarios</code>: the default lakehouse of the notebooks. <code>/lakehouse/default/Files/…</code> in the pipeline is <code>{'{workspace}/{lakehouse}/Files/…'}</code> in OneLake.</p>
            </td>
            <td>{app.stored.lakehouseId ? <Badge tone="ok">selected</Badge> : <Badge tone="idle">required</Badge>}</td>
          </tr>
          <tr>
            <th scope="row">Notebook <code>{REPORT_NOTEBOOK_NAME}</code></th>
            <td>{d?.notebook ? 'Found' : d ? <>Not found. Import <code>notebooks/AnalyzeReportPerformance_v3.ipynb</code> and attach the lakehouse of the logs as its default lakehouse. The Reports page can still open analyses that already exist.</> : '–'}</td>
            <td>{d ? (d.notebook ? <Badge tone="ok">found</Badge> : <Badge tone="warn">missing</Badge>) : null}</td>
          </tr>
        </tbody>
      </table>

      <h2>Folders in the lakehouse</h2>
      {folderError && <Notice tone="bad">{maskText(folderError)}</Notice>}
      {!folders && <p className="muted">Choose the workspace and the lakehouse to check the folders.</p>}
      {folders && (
        <>
          <table className="table small" aria-label="Folders">
            <thead><tr><th>Folder</th><th>State</th><th>Note</th></tr></thead>
            <tbody>
              {folders.map((f) => (
                <tr key={f.path}><td className="mono">{f.path}</td><td><Badge tone={f.exists ? 'ok' : f.optional ? 'idle' : 'bad'}>{f.exists ? 'exists' : 'missing'}</Badge></td>
                  <td className="muted">{f.path.endsWith('Queries') ? 'Navigation JSON (Performance Analyzer)' : f.path.endsWith('Users') ? 'Users files for RLS' : f.path.endsWith('logs') ? 'Written by the test' : f.path.endsWith('progress') ? 'Progress files (iteration); written by the test' : 'Written by the report notebook'}</td></tr>
              ))}
            </tbody>
          </table>
          {missing.length > 0 && <Button onClick={() => setCreating(true)}>Create the missing folders…</Button>}
        </>
      )}

      <h2>About</h2>
      <p className="small">App <strong>{pkg.name}</strong> {pkg.version}{app.backend.demo ? ' · demo mode (synthetic data)' : ''}. Help documents generated at build time from the repository:</p>
      <table className="table small" aria-label="Embedded documents">
        <thead><tr><th>Document</th><th>Source</th><th>SHA-256 (first 12)</th></tr></thead>
        <tbody>{help.docs.map((x) => <tr key={x.id}><td>{x.title}</td><td className="mono">{x.file}</td><td className="mono">{x.sha256.slice(0, 12)}</td></tr>)}</tbody>
      </table>
      {help.notes.length > 0 && <details className="details"><summary>Notes of the help build ({help.notes.length})</summary><ul className="small">{help.notes.map((n) => <li key={n}>{n}</li>)}</ul></details>}

      {creating && (
        <Dialog title="Create the missing folders?" onClose={() => setCreating(false)}>
          <ul className="mono small">{missing.map((f) => <li key={f.path}>{f.path}</li>)}</ul>
          <div className="dialog-actions"><Button kind="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button kind="primary" onClick={() => void create()}>Create</Button></div>
        </Dialog>
      )}
    </div>
  );
}
