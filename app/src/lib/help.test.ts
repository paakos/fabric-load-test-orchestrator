import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import help from 'virtual:help';
import { buildHelpBundle, defaultRepoRoot, HelpBuildError, Slugger, slugify } from '../../tools/helpbuild';
import { PARAMETERS, DOC_PARAMETERS } from './parameters';

const REPO = defaultRepoRoot(process.cwd());
const APP = join(REPO, 'app');
const scratch: string[] = [];

/** A copy of the documents in a scratch folder, so that a test can break one of them. */
function sandbox(): string {
  const root = mkdtempSync(join(process.cwd(), '.tmp-help-'));
  scratch.push(root);
  const skip = new Set(['app', 'promotion-gate', '.git', '.github', 'node_modules', 'dist', 'tests', 'tools', 'installer']);
  for (const name of readdirSync(REPO)) {
    if (skip.has(name) || name.endsWith('.zip')) continue;
    cpSync(join(REPO, name), join(root, name), { recursive: true, filter: (s) => !/docs[\\/]es/.test(s) });
  }
  cpSync(join(APP, 'help'), join(root, 'app', 'help'), { recursive: true });
  cpSync(join(APP, 'README.md'), join(root, 'app', 'README.md'));
  return root;
}
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('GitHub anchors', () => {
  it('slugifies like GitHub', () => {
    expect(slugify('`ramp_up_sec` and `initial_user_jitter_sec`')).toBe('ramp_up_sec-and-initial_user_jitter_sec');
    expect(slugify('Report performance analysis (`AnalyzeReportPerformance_v3`)')).toBe('report-performance-analysis-analyzereportperformance_v3');
    expect(slugify('RLS identities')).toBe('rls-identities');
    const s = new Slugger();
    expect([s.slug('Notes'), s.slug('Notes'), s.slug('Notes')]).toEqual(['notes', 'notes-1', 'notes-2']);
  });
});

describe('help generated from the repository', () => {
  it('embeds the documents, the README and the app guides, with a hash each', () => {
    const ids = help.docs.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['using-the-app', 'run-progress', 'reports', 'pipeline-parameters', 'parameters', 'analysis', 'readme']));
    expect(ids).not.toContain('agent-deployment');
    for (const d of help.docs) { expect(d.sha256).toMatch(/^[0-9a-f]{64}$/); expect(d.html.length).toBeGreaterThan(100); }
  });

  it('does not embed the promotion gate section of the README', () => {
    const readme = help.docs.find((d) => d.id === 'readme')!;
    expect(readme.anchors.some((a) => a.startsWith('promotion-gate'))).toBe(false);
    expect(readme.html).not.toContain('promotion-gate/README.md');
  });

  it('every parameter links to an existing section of the parameter reference', () => {
    const doc = help.docs.find((d) => d.id === DOC_PARAMETERS)!;
    for (const p of PARAMETERS) expect(doc.anchors, p.name).toContain(p.anchor);
  });

  it('has "what it measures / how to read it" for the 20 queries', () => {
    expect(Object.keys(help.queries)).toHaveLength(20);
    for (const q of Object.values(help.queries)) { expect(q.measures, q.id).not.toBe(''); expect(q.read, q.id).not.toBe(''); expect(q.title, q.id).not.toBe(''); }
    expect(help.queries.Q01.title).toContain('Executive summary');
  });

  it('internal links point to #/help/<doc>/<anchor>; external ones open safely; no scripts', () => {
    const all = help.docs.map((d) => d.html).join('\n');
    expect(all).toMatch(/href="#\/help\/pipeline-parameters\/[a-z0-9_-]+"/);
    expect(all).toMatch(/target="_blank" rel="noopener noreferrer"/);
    expect(all).not.toMatch(/<script|javascript:/i);
  });

  it('the build output is deterministic', () => {
    expect(JSON.stringify(buildHelpBundle(REPO, APP))).toBe(JSON.stringify(buildHelpBundle(REPO, APP)));
  });
});

describe('help build checks (a problem fails the build)', () => {
  it('passes on an untouched copy', () => { expect(() => buildHelpBuild(sandbox())).not.toThrow(); });

  it('fails on a broken internal link', () => {
    const root = sandbox();
    const f = join(root, 'docs', 'architecture.md');
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n\nSee [nothing](no-such-doc.md).\n`);
    expect(() => buildHelpBuild(root)).toThrow(HelpBuildError);
    expect(() => buildHelpBuild(root)).toThrow(/no-such-doc\.md/);
  });

  it('fails on a broken anchor', () => {
    const root = sandbox();
    const f = join(root, 'docs', 'architecture.md');
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n\nSee [x](parameters.md#no-such-section).\n`);
    expect(() => buildHelpBuild(root)).toThrow(/no-such-section/);
  });

  it('fails on a missing document, a missing notebook and a notebook without a query header', () => {
    let root = sandbox();
    rmSync(join(root, 'docs', 'pipeline-parameters.md'));
    expect(() => buildHelpBuild(root)).toThrow(/missing document: docs\/pipeline-parameters\.md/);
    root = sandbox();
    rmSync(join(root, 'notebooks', 'AnalyzeReportPerformance_v3.ipynb'));
    expect(() => buildHelpBuild(root)).toThrow(/missing notebook/);
    root = sandbox();
    const nb = join(root, 'notebooks', 'AnalyzeReportPerformance_v3.ipynb');
    writeFileSync(nb, readFileSync(nb, 'utf8').replace('## Q07 ·', '## Seven ·'));
    expect(() => buildHelpBuild(root)).toThrow(/no "## Q07" markdown header/);
  });

  it('fails on unsafe HTML', () => {
    const root = sandbox();
    const f = join(root, 'docs', 'architecture.md');
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n\n<script>alert(1)</script>\n`);
    expect(() => buildHelpBuild(root)).toThrow(/unsafe HTML/);
  });
});

function buildHelpBuild(root: string) { return buildHelpBundle(root, join(root, 'app')); }
