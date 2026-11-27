import { useMemo, useState } from 'react';
import { stringifyParams, previewParams, type Generated, type Issue } from '../lib/generate';
import type { LaunchCheck } from '../lib/launch';
import { fieldId } from './ExecSettings';
import { Button, Notice } from './ui';

function IssueList({ title, issues, tone }: { title: string; issues: Issue[]; tone: 'bad' | 'warn' | 'info' }) {
  if (!issues.length) return null;
  const focus = (i: Issue) => {
    const target = i.field ? document.getElementById(fieldId(i.field)) : null;
    if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); (target as HTMLElement).focus({ preventScroll: true }); }
  };
  return (
    <section className={`issues ${tone}`} aria-label={title}>
      <h3>{title} ({issues.length})</h3>
      <ul>
        {issues.map((i, k) => (
          <li key={`${i.code}-${k}`}>{i.field ? <button type="button" className="link" onClick={() => focus(i)}>{i.message}</button> : i.message}</li>
        ))}
      </ul>
    </section>
  );
}

/** Fixed panel: live JSON (UPNs hidden), errors, warnings, summary in plain words and the action buttons. */
export function JsonPanel({ gen, check, onLaunch, onLoad, onReset, copied, onCopy, onDownload }: {
  gen: Generated; check: LaunchCheck; onLaunch(): void; onLoad(): void; onReset(): void; copied: boolean; onCopy(): void; onDownload(): void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const preview = useMemo(() => previewParams(gen.params), [gen.params]);
  const hasUsers = useMemo(() => stringifyParams(gen.params) !== preview, [gen.params, preview]);
  return (
    <aside className="panel" aria-label="Result: JSON, errors, summary and actions">
      <div className="panel-actions">
        <Button kind="primary" disabled={!check.ready} reason={check.blockers[0]} onClick={onLaunch}>Launch test</Button>
        {!check.ready && (
          <ul className="why-list" aria-label="Why the test cannot be launched yet">
            {check.blockers.slice(0, 4).map((b) => <li key={b}>{b}</li>)}
            {check.blockers.length > 4 && <li>…and {check.blockers.length - 4} more</li>}
          </ul>
        )}
        {check.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
      </div>
      <section aria-label="Summary">
        <h3>Summary</h3>
        <ul className="summary">{gen.summary.map((s) => <li key={s}>{s}</li>)}</ul>
      </section>
      <IssueList title="Errors" issues={gen.errors} tone="bad" />
      <IssueList title="Warnings" issues={gen.warnings} tone="warn" />
      {gen.infos.length > 0 && (
        <p><button type="button" className="link" aria-expanded={showInfo} onClick={() => setShowInfo(!showInfo)}>{showInfo ? 'Hide' : 'Show'} {gen.infos.length} reminder{gen.infos.length === 1 ? '' : 's'}</button></p>
      )}
      {showInfo && <IssueList title="Reminders" issues={gen.infos} tone="info" />}
      <section aria-label="JSON of the pipeline parameters">
        <h3>JSON <span className="muted small">(read only, 19 parameters)</span></h3>
        <pre className="json" tabIndex={0} aria-label="Pipeline parameters as JSON">{preview}</pre>
        {hasUsers && <p className="muted small">User names are hidden in this preview. Copy and Download include them.</p>}
        <div className="row">
          <Button small onClick={onCopy}>{copied ? 'Copied' : 'Copy JSON'}</Button>
          <Button small onClick={onDownload}>Download .json</Button>
          <Button small onClick={onLoad}>Load JSON…</Button>
          <Button small kind="ghost" onClick={onReset}>Reset</Button>
        </div>
      </section>
    </aside>
  );
}
