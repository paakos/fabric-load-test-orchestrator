import { useEffect, useMemo, useRef, useState } from 'react';
import help from 'virtual:help';
import { DOC_PARAMETERS } from '../lib/parameters';
import { useApp } from '../lib/store';

const DEFAULT_DOC = 'using-the-app';

interface Hit { doc: string; docTitle: string; anchor: string; title: string; snippet: string }

function search(q: string): Hit[] {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  for (const d of help.docs) {
    for (const s of d.sections) {
      const hay = `${s.title} ${s.text}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const i = hay.indexOf(terms[0]);
      const from = Math.max(0, i - 40);
      hits.push({ doc: d.id, docTitle: d.title, anchor: s.id, title: s.title, snippet: `${from > 0 ? '…' : ''}${`${s.title} ${s.text}`.slice(from, from + 140).trim()}…` });
    }
  }
  return hits.slice(0, 25);
}

/** Side panel with the embedded documentation: index, search, rules and common errors. Links carry the document and the section in the URL. */
export function HelpPanel() {
  const app = useApp();
  const h = app.route.help;
  const [tab, setTab] = useState<'docs' | 'rules'>('docs');
  const [q, setQ] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const docId = h?.doc && help.docs.some((d) => d.id === h.doc) ? h.doc : DEFAULT_DOC;
  const doc = help.docs.find((d) => d.id === docId) ?? help.docs[0];
  const hits = useMemo(() => search(q), [q]);

  useEffect(() => {
    if (!h) return;
    const el = h.anchor ? [...(body.current?.querySelectorAll<HTMLElement>('[id]') ?? [])].find((x) => x.id === h.anchor) : null;
    if (el) el.scrollIntoView({ block: 'start' }); else body.current?.scrollTo({ top: 0 });
  }, [h, docId, tab]);
  useEffect(() => {
    if (!h) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') app.closeHelp(); };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!h]);
  if (!h) return null;

  return (
    <aside className="help-panel" role="complementary" aria-label="Help" tabIndex={-1} ref={panel}>
      <header className="help-head">
        <h2>Help</h2>
        <button type="button" className="btn ghost small" onClick={app.closeHelp} aria-label="Close help">Close ✕</button>
      </header>
      <div className="help-tools">
        <label className="visually-hidden" htmlFor="help-search">Search the documentation</label>
        <input id="help-search" type="search" className="input" placeholder="Search the documentation" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="tabs small" role="tablist" aria-label="Help sections">
          <button type="button" role="tab" aria-selected={tab === 'docs'} className={`tab${tab === 'docs' ? ' on' : ''}`} onClick={() => setTab('docs')}>Documents</button>
          <button type="button" role="tab" aria-selected={tab === 'rules'} className={`tab${tab === 'rules' ? ' on' : ''}`} onClick={() => setTab('rules')}>Rules &amp; common errors</button>
        </div>
      </div>
      <div className="help-body" ref={body}>
        {q.trim().length > 1 ? (
          <section aria-label="Search results">
            <h3>{hits.length} result{hits.length === 1 ? '' : 's'}</h3>
            <ul className="hits">{hits.map((x) => <li key={`${x.doc}-${x.anchor}`}><a href={`#/help/${x.doc}/${x.anchor}`} onClick={() => setQ('')}><strong>{x.title}</strong><span className="muted small"> · {x.docTitle}</span><br /><span className="small">{x.snippet}</span></a></li>)}</ul>
          </section>
        ) : tab === 'rules' ? <Rules /> : (
          <>
            <nav aria-label="Documents"><ul className="doc-index">
              {help.docs.map((d) => <li key={d.id}><a href={`#/help/${d.id}`} aria-current={d.id === docId ? 'page' : undefined} className={d.id === docId ? 'on' : ''}>{d.title}</a></li>)}
            </ul></nav>
            <article className="doc" dangerouslySetInnerHTML={{ __html: doc.html }} />
          </>
        )}
      </div>
    </aside>
  );
}

function Rules() {
  const l = (a: string, t: string) => <a href={`#/help/${DOC_PARAMETERS}/${a}`}>{t}</a>;
  return (
    <div className="doc">
      <h3>Rules of the form</h3>
      <ul>
        <li><strong>Run settings</strong> <em>Global</em>: the ten settings are written once and the model cards are greyed out. <em>Per model</em>: every model carries its ten settings and the global fields are greyed out. A per-model <code>false</code>, <code>0</code> or <code>0.0</code> is valid. {l('per-model-execution-settings', 'Reference')}</li>
        <li><strong>RLS</strong>: <code>none</code> disables everything RLS. <code>list</code> / <code>file</code> × <code>global</code> / <code>per_model</code> decide which field is active. With <code>per_model</code> every model needs its own users or file. {l('rls-identities', 'Reference')}</li>
        <li><strong>Navigation file</strong>: <em>One file per model</em> or <em>Same file for all</em> (the pipeline always has a <code>queryfile</code> in each model).</li>
        <li><strong><code>workspace</code> of a model</strong>: empty (same workspace) or the display name of the workspace, never a GUID.</li>
        <li><strong>Paths</strong> start with <code>/lakehouse/default/</code>, have no spaces and must exist.</li>
        <li><strong>All 19 parameters</strong> are always sent, so the defaults stored in the pipeline never leak in.</li>
      </ul>
      <h3>Frequent errors</h3>
      <table>
        <thead><tr><th>Symptom</th><th>Cause</th></tr></thead>
        <tbody>
          <tr><td>A setting has no effect</td><td>Misspelled name (Fabric ignores unknown names silently) or a pipeline older than the per-model settings.</td></tr>
          <tr><td><code>Navigation file … not found</code></td><td>Wrong <code>queryfile</code>, spaces in the path, or the file was not uploaded.</td></tr>
          <tr><td>Authentication failed / model not found</td><td><code>dataset</code> or <code>workspace</code> is not the exact display name, or the XMLA read endpoint is disabled on the capacity.</td></tr>
          <tr><td>Queries of one virtual user fail with RLS</td><td>The impersonated user does not exist or has no read and build permission on the model.</td></tr>
          <tr><td>The run is green but has failed queries</td><td>With <code>stop_on_query_error = false</code> the run ends Completed: read the failed queries on the Runs page or set <code>fail_on_error_rate</code>.</td></tr>
          <tr><td>Iteration: not available</td><td>The progress folder does not exist: the notebooks are older than the progress files.</td></tr>
        </tbody>
      </table>
      <p>More in {l('common-mistakes', 'Common mistakes')}.</p>
    </div>
  );
}
