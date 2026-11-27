import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { Marked, type Token, type Tokens } from 'marked';

/**
 * Help documents, generated at build time from the repository (single source of truth):
 * README.md, docs/*.md and the markdown headers of the report notebook, plus the app's own guides in app/help.
 * The build fails on a missing document, a broken internal link or a broken anchor.
 */
export interface HelpSection { id: string; title: string; level: number; text: string }
export interface HelpDoc {
  id: string; title: string; origin: 'repo' | 'app'; file: string; html: string; sha256: string;
  sections: HelpSection[]; anchors: string[];
}
export interface QueryDoc { id: string; title: string; measures: string; computed: string; read: string; skew: string; visual: string }
export interface HelpBundle { docs: HelpDoc[]; queries: Record<string, QueryDoc>; notes: string[] }

export class HelpBuildError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Help build failed:\n - ${problems.join('\n - ')}`);
    this.name = 'HelpBuildError';
  }
}

/** Documents of the app itself, in the order of the help index. Everything under docs/ is added after them. */
const APP_DOCS = ['using-the-app.md', 'run-progress.md', 'reports.md'];
const REPO_DOCS_FIRST = ['docs/pipeline-parameters.md', 'docs/parameters.md', 'docs/analysis.md', 'docs/architecture.md', 'docs/deployment.md'];
const REQUIRED = ['README.md', 'docs/pipeline-parameters.md', 'docs/parameters.md', 'docs/analysis.md'];
/** Aimed at AI agents that deploy the orchestrator, not at the people who run tests with this app. */
const SKIPPED_DOCS = new Set(['docs/agent-deployment.md']);
/** Sections that describe other products of the repository. */
const EXCLUDED_SECTIONS: Record<string, RegExp[]> = { 'README.md': [/^promotion gate/i] };
export const NOTEBOOK = 'notebooks/AnalyzeReportPerformance_v3.ipynb';

/** GitHub's anchor algorithm: lower case, drop punctuation (keeping letters, digits, `_` and `-`), spaces to hyphens. */
export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

export class Slugger {
  private seen = new Map<string, number>();
  slug(text: string): string {
    const base = slugify(text);
    const n = this.seen.get(base);
    if (n === undefined) { this.seen.set(base, 0); return base; }
    let next = n + 1;
    let candidate = `${base}-${next}`;
    while (this.seen.has(candidate)) candidate = `${base}-${++next}`;
    this.seen.set(base, next);
    this.seen.set(candidate, 0);
    return candidate;
  }
}

export function plainText(tokens: Token[] | undefined, raw = ''): string {
  if (!tokens?.length) return raw;
  return tokens.map((t) => {
    const x = t as Tokens.Generic;
    if (x.type === 'codespan' || x.type === 'text' || x.type === 'escape') return x.tokens ? plainText(x.tokens, x.text) : (x.text as string);
    if (x.tokens) return plainText(x.tokens, x.text ?? '');
    if (x.type === 'image') return x.text as string;
    return (x.text as string) ?? '';
  }).join('');
}

const docIdOf = (file: string) => (file === 'README.md' ? 'readme' : posix.basename(file, '.md'));

interface PendingLink { from: string; docId: string; anchor: string; label: string }

interface Source { file: string; origin: 'repo' | 'app'; text: string }

function dropSections(tokens: Token[], patterns: RegExp[]): Token[] {
  const out: Token[] = [];
  let skipDepth = 0;
  for (const t of tokens) {
    if (t.type === 'heading') {
      const h = t as Tokens.Heading;
      if (skipDepth && h.depth <= skipDepth) skipDepth = 0;
      if (!skipDepth && patterns.some((p) => p.test(plainText(h.tokens, h.text)))) { skipDepth = h.depth; continue; }
    }
    if (!skipDepth) out.push(t);
  }
  return out;
}

function renderDoc(src: Source, repoRoot: string, docFiles: Map<string, string>, pending: PendingLink[], problems: string[], notes: string[]): HelpDoc {
  const slugger = new Slugger();
  const anchors: string[] = [];
  const sections: HelpSection[] = [];
  const lexed = new Marked().lexer(src.text);
  const tokens = Object.assign(dropSections(lexed, EXCLUDED_SECTIONS[src.file] ?? []), { links: lexed.links });
  const id = docIdOf(src.file);

  const resolveLink = (href: string, label: string): { kind: 'internal' | 'external' | 'ref'; href: string; title?: string } => {
    if (/^(https?:|mailto:)/i.test(href)) return { kind: 'external', href };
    const [pathPart, rawAnchor = ''] = href.split('#');
    const anchor = decodeURIComponent(rawAnchor);
    if (!pathPart) {
      pending.push({ from: src.file, docId: id, anchor, label });
      return { kind: 'internal', href: `#/help/${id}/${anchor}` };
    }
    const target = posix.normalize(posix.join(posix.dirname(src.file), decodeURIComponent(pathPart))).replace(/\/$/, '');
    if (target.startsWith('..')) {
      notes.push(`${src.file}: "${href}" points outside the repository (a GitHub-relative link); shown as plain text`);
      return { kind: 'ref', href, title: 'Link relative to the GitHub repository' };
    }
    const docFile = docFiles.get(target);
    if (docFile) {
      const targetId = docIdOf(docFile);
      if (anchor) pending.push({ from: src.file, docId: targetId, anchor, label });
      return { kind: 'internal', href: `#/help/${targetId}/${anchor}` };
    }
    if (existsSync(join(repoRoot, ...target.split('/')))) return { kind: 'ref', href, title: `File in the repository: ${target}` };
    problems.push(`${src.file}: broken link "${href}" (${target} does not exist)`);
    return { kind: 'ref', href, title: 'Broken link' };
  };

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline(t: Token[]): string } }, { tokens: t, depth }: Tokens.Heading) {
        const text = plainText(t);
        const anchor = slugger.slug(text);
        anchors.push(anchor);
        return `<h${depth} id="${anchor}">${this.parser.parseInline(t)}<a class="anchor" href="#/help/${id}/${anchor}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      link(this: { parser: { parseInline(t: Token[]): string } }, { href, title, tokens: t }: Tokens.Link) {
        const inner = this.parser.parseInline(t);
        const r = resolveLink(href, plainText(t));
        if (r.kind === 'external') return `<a href="${escapeAttr(r.href)}" target="_blank" rel="noopener noreferrer" class="ext"${title ? ` title="${escapeAttr(title)}"` : ''}>${inner}</a>`;
        if (r.kind === 'internal') return `<a href="${escapeAttr(r.href)}" class="int">${inner}</a>`;
        return `<span class="ref" title="${escapeAttr(r.title ?? '')}">${inner}</span>`;
      },
      image({ text }: Tokens.Image) { return text ? `<em class="img-alt">[${escapeHtml(text)}]</em>` : ''; },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        if (/<\s*(script|iframe|object|embed|style)\b|\son\w+\s*=|javascript:/i.test(text)) problems.push(`${src.file}: unsafe HTML in the document`);
        return text;
      },
    },
  });
  const html = marked.parser(tokens);

  // Sections for the search index: heading text plus the text up to the next heading
  const slugger2 = new Slugger();
  let current: HelpSection | null = null;
  for (const t of tokens) {
    if (t.type === 'heading') {
      const h = t as Tokens.Heading;
      const title = plainText(h.tokens, h.text);
      current = { id: slugger2.slug(title), title, level: h.depth, text: '' };
      sections.push(current);
    } else if (current && t.type !== 'space') {
      current.text += `${plainText((t as Tokens.Generic).tokens, (t as Tokens.Generic).raw ?? '').replace(/[|`*_>#]/g, ' ').replace(/\s+/g, ' ')} `;
    }
  }
  const firstHeading = sections[0]?.title ?? id;
  return {
    id, title: src.file === 'README.md' ? 'Overview (README)' : firstHeading, origin: src.origin, file: src.file, html,
    sha256: createHash('sha256').update(src.text).digest('hex'), sections, anchors,
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

const FIELDS: [keyof Omit<QueryDoc, 'id' | 'title'>, string][] = [
  ['measures', 'What it measures'], ['computed', 'How it is computed'], ['read', 'How to read it'],
  ['skew', 'Skew the test may introduce'], ['visual', 'Visual'],
];

/** "What it measures / How to read it" of every query: the cells of the notebook whose source starts with `## Q`. */
export function extractQueryDocs(notebookJson: string, problems: string[]): Record<string, QueryDoc> {
  const out: Record<string, QueryDoc> = {};
  const inline = new Marked();
  let nb: { cells?: { cell_type: string; source: string[] | string }[] };
  try { nb = JSON.parse(notebookJson); } catch (e) { problems.push(`${NOTEBOOK}: not valid JSON (${(e as Error).message})`); return out; }
  for (const cell of nb.cells ?? []) {
    if (cell.cell_type !== 'markdown') continue;
    const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    const head = /^## (Q\d\d) · (.+)/.exec(source);
    if (!head) continue;
    const doc: QueryDoc = { id: head[1], title: head[2].trim(), measures: '', computed: '', read: '', skew: '', visual: '' };
    for (const [key, label] of FIELDS) {
      const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\s*\\n\\*\\*|$)`).exec(source);
      if (m) doc[key] = (inline.parseInline(m[1].trim()) as string).trim();
      if (/<\s*(script|iframe|object|embed|style)\b|\son\w+\s*=|javascript:/i.test(doc[key])) problems.push(`${NOTEBOOK}: ${doc.id} "${label}" contains unsafe HTML`);
    }
    out[doc.id] = doc;
  }
  for (let n = 1; n <= 20; n++) {
    const id = `Q${String(n).padStart(2, '0')}`;
    if (!out[id]) problems.push(`${NOTEBOOK}: no "## ${id}" markdown header`);
    else if (!out[id].measures || !out[id].read) problems.push(`${NOTEBOOK}: ${id} lacks "What it measures" or "How to read it"`);
  }
  return out;
}

function readText(p: string): string {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export function buildHelpBundle(repoRoot: string, appRoot: string): HelpBundle {
  const problems: string[] = [];
  const notes: string[] = [];
  const files: Source[] = [];
  const appPrefix = relative(repoRoot, appRoot).split(sep).join('/') || 'app';
  const add = (file: string, origin: 'repo' | 'app', required: boolean) => {
    const full = join(repoRoot, ...file.split('/'));
    if (!existsSync(full)) { if (required) problems.push(`missing document: ${file}`); return; }
    files.push({ file, origin, text: readText(full) });
  };

  APP_DOCS.forEach((name) => add(`${appPrefix}/help/${name}`, 'app', true));
  const docsDir = join(repoRoot, 'docs');
  const repoDocs = existsSync(docsDir)
    ? readdirSync(docsDir).filter((n) => n.endsWith('.md')).map((n) => `docs/${n}`).filter((f) => !SKIPPED_DOCS.has(f)) : [];
  const ordered = [...REPO_DOCS_FIRST, ...repoDocs.filter((f) => !REPO_DOCS_FIRST.includes(f)).sort()];
  ordered.forEach((f) => add(f, 'repo', REQUIRED.includes(f)));
  add('README.md', 'repo', true);

  const docFiles = new Map(files.map((f) => [f.file, f.file]));
  const pending: PendingLink[] = [];
  const docs = files.map((f) => renderDoc(f, repoRoot, docFiles, pending, problems, notes));
  const byId = new Map(docs.map((d) => [d.id, d]));
  for (const p of pending) {
    const target = byId.get(p.docId);
    if (!target) problems.push(`${p.from}: link to unknown document "${p.docId}"`);
    else if (p.anchor && !target.anchors.includes(p.anchor)) problems.push(`${p.from}: broken anchor "#${p.anchor}" in ${target.file} (link "${p.label}")`);
  }

  let queries: Record<string, QueryDoc> = {};
  const nbPath = join(repoRoot, ...NOTEBOOK.split('/'));
  if (!existsSync(nbPath)) problems.push(`missing notebook: ${NOTEBOOK}`);
  else queries = extractQueryDocs(readText(nbPath), problems);

  if (problems.length) throw new HelpBuildError(problems);
  return { docs, queries, notes };
}
export function defaultRepoRoot(appRoot: string): string {
  return process.env.LOADTEST_REPO_ROOT ? resolve(process.env.LOADTEST_REPO_ROOT) : resolve(appRoot, '..');
}
