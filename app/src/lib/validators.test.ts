import { describe, expect, it } from 'vitest';
import { countStatus, parseCsv, toCsv } from './csv';
import { countLabel, maskText, maskUpn, maskValue, parseUpns, redactParams } from './privacy';
import {
  decodeUtf8, freeFileName, inspectUsersBytes, inspectUsersText, sanitizeFileName, usersFileFromList, validateNavigation,
} from './validators';

const lifecycle = (title = 'Sales', id = 'v1') => ({ name: 'Visual Container Lifecycle', metrics: { visualTitle: title, visualId: id } });
const dax = (start?: string) => ({ name: 'Execute DAX Query', start, end: start, metrics: { QueryText: 'EVALUATE ROW("a",1)' } });
const action = (start?: string) => ({ name: 'User Action', start, end: start, metrics: { sourceLabel: 'Click' } });
const nav = (events: unknown[]) => JSON.stringify({ events });

describe('navigation JSON (as RunPerfScenario_v3 reads it)', () => {
  it('accepts a Performance Analyzer export and reports actions, queries, visuals and timestamps', () => {
    const t = '2026-11-12T10:00:00.000Z';
    const info = validateNavigation(nav([action(t), lifecycle('A', 'a'), dax(t), lifecycle('B', 'b'), dax(t), dax(t), action('2026-11-12T10:00:30Z')]));
    expect(info).toMatchObject({ ok: true, actions: 2, queries: 3, visuals: 2, hasTimestamps: true, errors: [], warnings: [] });
  });

  it('accepts a BOM and warns when there are no user actions', () => {
    const info = validateNavigation(`\uFEFF${nav([lifecycle(), dax()])}`);
    expect(info.ok).toBe(true);
    expect(info.warnings.join(' ')).toContain('fallback_think_time_sec');
  });

  it('rejects what the notebook would reject', () => {
    expect(validateNavigation('{').errors[0]).toContain('Not valid JSON');
    expect(validateNavigation('[]').errors[0]).toContain('events');
    expect(validateNavigation('{"events": {}}').ok).toBe(false);
    expect(validateNavigation(nav([lifecycle()])).errors.join(' ')).toContain('no "Execute DAX Query"');
    expect(validateNavigation(nav([{ name: 'Visual Container Lifecycle', metrics: { visualTitle: 'x' } }, dax()])).errors.join(' ')).toContain('visualId');
    expect(validateNavigation(nav([lifecycle(), { name: 'Execute DAX Query', metrics: {} }])).errors.join(' ')).toContain('QueryText');
    expect(validateNavigation(nav([lifecycle(), { name: 'Execute DAX Query' }])).ok).toBe(false);
  });

  it('warns when actions exist but the queries have no timestamps', () => {
    const info = validateNavigation(nav([action('2026-11-12T10:00:00Z'), lifecycle(), dax()]));
    expect(info.ok).toBe(true);
    expect(info.hasTimestamps).toBe(false);
    expect(info.warnings.join(' ')).toContain('timestamps');
  });
});

describe('users file (RunLoadTest_v3 rules)', () => {
  it('counts valid users and duplicates, ignores comments and blank lines, accepts , and ;', () => {
    const info = inspectUsersText('# header\nana@contoso.com\n\nBob@contoso.com; carol@contoso.com  # trailing\nANA@contoso.com\n');
    expect(info).toMatchObject({ ok: true, valid: 3, duplicates: 1, invalidLines: [] });
    expect(info.upns).toEqual(['ana@contoso.com', 'Bob@contoso.com', 'carol@contoso.com']);
  });

  it('reports invalid lines by number and never keeps their content', () => {
    const info = inspectUsersText('ana@contoso.com\nnot-a-upn\nx@y.com, bad, z@w.com\n');
    expect(info.ok).toBe(false);
    expect(info.invalidLines).toEqual([2, 3]);
    expect(JSON.stringify(info)).not.toContain('not-a-upn');
    expect(info.errors[0]).toContain('2, 3');
  });

  it('a file with only comments contains no users', () => {
    const info = inspectUsersText('# nothing\n\n');
    expect(info.ok).toBe(false);
    expect(info.errors[0]).toContain('no users');
  });

  it('shows at most two masked entries', () => {
    const info = inspectUsersText('a@x.com\nb@x.com\nc@x.com');
    expect(info.preview).toHaveLength(2);
    expect(info.preview.every((p) => /^user_[0-9a-f]{6}$/.test(p))).toBe(true);
  });

  it('decodes UTF-8 with BOM and rejects other encodings', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a@x.com\n')]);
    expect(inspectUsersBytes(bom)).toMatchObject({ ok: true, valid: 1 });
    expect(decodeUtf8(new Uint8Array([0xff, 0xfe, 0x61, 0x00])).error).toContain('UTF-8');
    expect(inspectUsersBytes(new Uint8Array([0xff, 0xfe, 0x61, 0x00])).ok).toBe(false);
  });

  it('creates the file from a pasted list, normalised one per line', () => {
    const r = usersFileFromList('a@x.com, B@x.com; a@X.com');
    expect(r.content).toBe('a@x.com\nB@x.com\n');
    expect(usersFileFromList('bad').content).toBe('');
  });
});

describe('file names', () => {
  it('sanitises to [A-Za-z0-9._-] and adds the extension', () => {
    expect(sanitizeFileName('My nav (final).json', '.json')).toBe('My_nav_final_.json');
    expect(sanitizeFileName('users list', '.txt')).toBe('users_list.txt');
    expect(sanitizeFileName('   ', '.txt')).toBe('file.txt');
    expect(sanitizeFileName('../../x.json', '.json')).toBe('x.json');
  });
  it('finds a free name', () => {
    expect(freeFileName('a.json', ['b.json'])).toBe('a.json');
    expect(freeFileName('a.json', ['A.json', 'a_2.json'])).toBe('a_3.json');
  });
});

describe('privacy', () => {
  it('masks UPNs in text and values, consistently', () => {
    expect(maskUpn('Ana@Contoso.com')).toBe(maskUpn('ana@contoso.com'));
    const t = maskText('EffectiveUserName=ana@contoso.com; failed for bob@contoso.com.');
    expect(t).not.toContain('@');
    expect(maskValue({ a: ['x@y.com'], b: { c: 'z@w.org' }, n: 3 })).toEqual({ a: [maskUpn('x@y.com')], b: { c: maskUpn('z@w.org') }, n: 3 });
  });

  it('redacts the parameters kept for the session: UPNs become counts', () => {
    const r = redactParams({ rls_users: 'a@x.com,b@x.com', models: [{ model_key: 'A', users: ['a@x.com', 'b@x.com', 'c@x.com'] }, { model_key: 'B', users: 'a@x.com' }] });
    expect(JSON.stringify(r)).not.toContain('@');
    expect(r.rls_users).toBe(countLabel(2));
    expect((r.models as { users: string }[])[0].users).toBe('«3 users»');
    expect((r.models as { users: string }[])[1].users).toBe('«1 user»');
  });

  it('parseUpns follows the notebook (comment only after start or whitespace)', () => {
    expect(parseUpns('a#b@x.com').upns).toEqual(['a#b@x.com']);
    expect(parseUpns('a@x.com #c').upns).toEqual(['a@x.com']);
  });
});

describe('CSV', () => {
  const csv = 'loadtest_id,query,rows,status,error\r\nr1,"EVALUATE\nROW(""a"",1)",1,ok,\r\nr1,"EVALUATE X",0,error,"Timeout, retry"\r\n';
  it('parses quoted multi-line fields and counts failed queries from the status column', () => {
    expect(parseCsv(csv)).toHaveLength(3);
    expect(countStatus(csv)).toEqual({ rows: 2, failed: 1, hasStatus: true, users: 1 });
    expect(countStatus('a,b\n1,2\n')).toMatchObject({ rows: 1, failed: 0, hasStatus: false });
  });
  it('escapes and neutralises formulas on export', () => {
    const out = toCsv(['a', 'b'], [{ a: '=1+1', b: 'x,"y"' }, { a: 3, b: null }]);
    expect(out).toBe('a,b\r\n\'=1+1,"x,""y"""\r\n3,');
  });
});
