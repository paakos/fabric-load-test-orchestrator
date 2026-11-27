import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { QUERIES_DIR, USERS_DIR } from '../lib/parameters';
import { uploadFile } from '../lib/ops';
import { errorText, useApp } from '../lib/store';
import {
  decodeUtf8, freeFileName, inspectUsersText, sanitizeFileName, usersFileFromList, validateNavigation, type NavInfo, type UsersInfo,
} from '../lib/validators';
import { Button, Dialog, Notice, RadioGroup, TextInput } from './ui';

export type FileKind = 'queries' | 'users';
const MAX_BYTES = 50 * 1024 * 1024;

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

/** Selector of the files already in the lakehouse + Upload (and, for users, "create from a list"). Greyed out like the field it belongs to. */
export function FilePicker({ kind, id, value, onChange, off, why, error, label }: {
  kind: FileKind; id: string; value: string; onChange(path: string): void; off?: boolean; why?: string; error?: string; label: string;
}) {
  const app = useApp();
  const list = app.files[kind];
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file?: File; paste?: boolean } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const hintId = useId();
  const options = useMemo(() => (value && !list.some((f) => f.path === value) ? [{ path: value, name: `${value.split('/').pop()} (not in the list)`, size: 0, modified: '' }, ...list] : list), [list, value]);
  const disabledUpload = off || !app.target || !app.account;
  const uploadReason = off ? why : !app.account ? 'Sign in first' : !app.target ? 'Choose the lakehouse on the Environment page' : undefined;

  const onPick = (f: File | undefined) => { if (f) setPending({ file: f }); if (inputRef.current) inputRef.current.value = ''; };

  return (
    <div className={`picker${off ? ' is-off' : ''}`}>
      <div className="picker-row">
        <select id={id} className={`input${off ? ' is-off' : ''}${error ? ' bad' : ''}`} aria-label={label} value={value} aria-disabled={off || undefined}
          aria-invalid={error ? true : undefined} aria-describedby={error || (off && why) ? hintId : undefined}
          onChange={(e) => { if (!off) onChange(e.target.value); }}>
          <option value="">{list.length || value ? 'Choose a file…' : 'No files yet: upload one'}</option>
          {options.map((f) => <option key={f.path} value={f.path}>{f.name}{f.size ? ` · ${kb(f.size)}` : ''}{f.modified ? ` · ${when(f.modified)}` : ''}</option>)}
        </select>
        <input ref={inputRef} type="file" className="visually-hidden" tabIndex={-1} aria-hidden="true" accept={kind === 'queries' ? '.json,application/json' : '.txt,.csv,text/plain'}
          onChange={(e) => onPick(e.target.files?.[0])} />
        <Button small disabled={disabledUpload} reason={uploadReason} onClick={() => inputRef.current?.click()}>Upload</Button>
        {kind === 'users' && <Button small disabled={disabledUpload} reason={uploadReason} onClick={() => setPending({ paste: true })}>Create from a list</Button>}
        <Button small kind="ghost" disabled={off || !app.target} reason={uploadReason} title="Refresh the list" onClick={() => void app.refreshFiles(kind)}>↻</Button>
      </div>
      {value && <p className="mono small path" title={value}>{value}</p>}
      {error && <p id={hintId} className="err-text" role="alert">{error}</p>}
      {!error && off && why && <p id={hintId} className="why">{why}</p>}
      {done && <p className="ok-text small" role="status">{done}</p>}
      {pending && (
        <UploadDialog kind={kind} source={pending} existing={list.map((f) => f.name)} onClose={() => setPending(null)}
          onUploaded={(path, summary) => { setPending(null); setDone(summary); onChange(path); void app.refreshFiles(kind); }} />
      )}
    </div>
  );
}

type Inspected = { nav?: NavInfo; users?: UsersInfo; fatal?: string; text?: string };

function UploadDialog({ kind, source, existing, onClose, onUploaded }: {
  kind: FileKind; source: { file?: File; paste?: boolean }; existing: string[]; onClose(): void; onUploaded(path: string, summary: string): void;
}) {
  const app = useApp();
  const ext = kind === 'queries' ? '.json' : '.txt';
  const [name, setName] = useState(() => sanitizeFileName(source.file?.name ?? (kind === 'users' ? 'users_list' : 'navigation'), ext));
  const [pasted, setPasted] = useState('');
  const [inspected, setInspected] = useState<Inspected | null>(source.paste ? { users: undefined } : null);
  const [choice, setChoice] = useState<'replace' | 'new'>('new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!source.file) return;
    let alive = true;
    void (async () => {
      const f = source.file as File;
      if (f.size > MAX_BYTES) { setInspected({ fatal: 'The file is larger than 50 MB.' }); return; }
      const bytes = await f.arrayBuffer();
      const d = decodeUtf8(bytes);
      if (d.error || d.text === undefined) { if (alive) setInspected({ fatal: d.error ?? 'Unreadable file.' }); return; }
      if (alive) setInspected(kind === 'queries' ? { nav: validateNavigation(d.text), text: d.text } : { users: inspectUsersText(d.text), text: d.text });
    })().catch((e) => { if (alive) setInspected({ fatal: errorText(e) }); });
    return () => { alive = false; };
  }, [source.file, kind]);

  const pastedInfo = useMemo(() => (source.paste ? usersFileFromList(pasted) : null), [source.paste, pasted]);
  const clash = existing.some((n) => n.toLowerCase() === name.toLowerCase());
  const finalName = clash && choice === 'new' ? freeFileName(name, existing) : name;
  const info = pastedInfo?.info ?? inspected?.users;
  const nav = inspected?.nav;
  const errors = inspected?.fatal ? [inspected.fatal] : nav?.errors ?? info?.errors ?? [];
  const ready = source.paste ? !!pastedInfo?.info.ok : !!inspected && !inspected.fatal && errors.length === 0 && (nav ? nav.ok : !!info?.ok);
  const content = source.paste ? pastedInfo?.content ?? '' : inspected?.text ?? '';

  const doUpload = async () => {
    if (!app.target) return;
    setBusy(true); setError('');
    try {
      const path = await uploadFile(app.backend, app.target, kind === 'queries' ? QUERIES_DIR : USERS_DIR, finalName, content);
      const summary = nav ? `Uploaded ${finalName}: ${nav.queries} queries, ${nav.actions} user actions, ${nav.visuals} visuals.`
        : `Uploaded ${finalName}: ${info?.valid ?? 0} users.`;
      onUploaded(path, summary);
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };

  return (
    <Dialog title={source.paste ? 'Create the users file from a list' : `Upload ${kind === 'queries' ? 'a navigation JSON' : 'a users file'}`} onClose={onClose} wide>
      <p className="muted small">Destination: <code>{kind === 'queries' ? QUERIES_DIR : USERS_DIR}/</code>. The file is checked before it is uploaded.</p>
      {source.paste && (
        <>
          <label className="lbl" htmlFor="paste-users">Users (one per line, or separated by commas or semicolons; # starts a comment)</label>
          <TextInput id="paste-users" textarea rows={6} value={pasted} onChange={setPasted} mono />
        </>
      )}
      {!inspected && !source.paste && <p className="muted" role="status">Checking the file…</p>}
      {errors.map((e) => <Notice key={e} tone="bad">{e}</Notice>)}
      {nav && nav.ok && (
        <ul className="facts" aria-label="File summary">
          <li><strong>{nav.actions}</strong> user actions</li><li><strong>{nav.queries}</strong> queries</li><li><strong>{nav.visuals}</strong> distinct visuals</li>
          <li>Think-time timestamps: <strong>{nav.hasTimestamps ? 'yes' : 'no'}</strong></li>
        </ul>
      )}
      {nav?.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
      {info && (
        <ul className="facts" aria-label="File summary">
          <li><strong>{info.valid}</strong> valid users</li><li><strong>{info.duplicates}</strong> duplicates removed</li>
          <li><strong>{info.invalidLines.length}</strong> invalid lines{info.invalidLines.length ? ` (${info.invalidLines.slice(0, 8).join(', ')}${info.invalidLines.length > 8 ? '…' : ''})` : ''}</li>
          {info.preview.length > 0 && <li>First entries (masked): {info.preview.join(', ')}</li>}
        </ul>
      )}
      <label className="lbl" htmlFor="up-name">File name (letters, digits, . _ -)</label>
      <input id="up-name" className="input mono" value={name} onChange={(e) => setName(sanitizeFileName(e.target.value, ext))} />
      {clash && (
        <RadioGroup<'replace' | 'new'> label="A file with this name already exists" value={choice} onChange={setChoice}
          options={[{ value: 'new', label: `Save as ${freeFileName(name, existing)}` }, { value: 'replace', label: 'Replace the existing file' }]} />
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="dialog-actions">
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={!ready || busy} reason={!ready ? 'Fix the problems above first' : undefined} onClick={() => void doUpload()}>{busy ? 'Uploading…' : 'Upload'}</Button>
      </div>
    </Dialog>
  );
}
