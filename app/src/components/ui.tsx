import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { PARAM_BY_NAME, DOC_PARAMETERS } from '../lib/parameters';
import { parseUtc } from '../lib/time';

/** Exclusive option: a group of buttons (role=radiogroup). Arrow keys move the choice, Tab leaves the group. */
export function RadioGroup<T extends string | boolean>({ label, value, options, onChange, disabled, reason, describedBy, className }: {
  label: string; value: T; options: { value: T; label: string; hint?: string }[]; onChange(v: T): void;
  disabled?: boolean; reason?: string; describedBy?: string; className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const reasonId = useId();
  const labelId = useId();
  const current = options.findIndex((o) => o.value === value);
  const move = (e: KeyboardEvent, i: number) => {
    if (disabled) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + options.length) % options.length;
    if (next >= 0) { e.preventDefault(); onChange(options[next].value); refs.current[next]?.focus(); }
  };
  return (
    <div className={`radio-wrap ${className ?? ''}`}>
      <div role="radiogroup" aria-labelledby={labelId} aria-disabled={disabled || undefined}
        aria-describedby={[reason ? reasonId : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined} className={`radio-group${disabled ? ' is-off' : ''}`}>
        <span id={labelId} className="radio-label">{label}</span>
        <div className="radio-buttons">
          {options.map((o, i) => (
            <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} title={o.hint}
              tabIndex={current === i || (current < 0 && i === 0) ? 0 : -1} ref={(el) => { refs.current[i] = el; }}
              className={`radio${o.value === value ? ' on' : ''}`} aria-disabled={disabled || undefined}
              onClick={() => { if (!disabled) onChange(o.value); }} onKeyDown={(e) => move(e, i)}>{o.label}</button>
          ))}
        </div>
      </div>
      {reason && <p id={reasonId} className="why">{reason}</p>}
    </div>
  );
}

/** "?" next to a parameter: what it is for, accepted values, default, example, and the exact section of the documentation. */
export function ParamHelp({ name }: { name: string }) {
  const def = PARAM_BY_NAME[name];
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, [open]);
  if (!def) return null;
  const dflt = def.name === 'models' ? 'a CHANGE_ME placeholder' : JSON.stringify(def.default);
  return (
    <span className="help-wrap" ref={ref}>
      <button type="button" className="help-btn" aria-expanded={open} aria-controls={id} aria-label={`Help: ${def.label}`} onClick={() => setOpen(!open)}>?</button>
      {open && (
        <div className="popover" id={id} role="dialog" aria-label={`Help: ${def.label}`}>
          <strong><code>{def.name}</code></strong>
          <p>{def.summary}</p>
          <dl>
            <dt>Accepted</dt><dd>{def.accepted}</dd>
            <dt>Default</dt><dd><code>{dflt}</code></dd>
            <dt>Example</dt><dd><code>{def.example}</code></dd>
          </dl>
          <a href={`#/help/${DOC_PARAMETERS}/${def.anchor}`}>Read the documentation section</a>
        </div>
      )}
    </span>
  );
}

export function Label({ htmlFor, param, children }: { htmlFor?: string; param?: string; children: ReactNode }) {
  return <label className="lbl" htmlFor={htmlFor}>{children}{param && <ParamHelp name={param} />}</label>;
}

/** A field that does not apply: greyed out (not hidden), keeps its content and says why. */
export function TextInput({ id, value, onChange, off, why, error, placeholder, mono, inputMode, textarea, rows, ariaLabel, onBlur, describedBy }: {
  id: string; value: string; onChange(v: string): void; off?: boolean; why?: string; error?: string; placeholder?: string; mono?: boolean;
  inputMode?: 'numeric' | 'decimal' | 'text'; textarea?: boolean; rows?: number; ariaLabel?: string; onBlur?(): void; describedBy?: string;
}) {
  const hintId = `${id}-hint`;
  const common = {
    id, value, placeholder, 'aria-label': ariaLabel, 'aria-invalid': error ? true : undefined,
    'aria-disabled': off || undefined, readOnly: off, 'aria-describedby': error || (off && why) ? hintId : off ? describedBy : undefined,
    className: `input${off ? ' is-off' : ''}${mono ? ' mono' : ''}${error ? ' bad' : ''}`, onBlur,
    onChange: (e: { target: { value: string } }) => { if (!off) onChange(e.target.value); },
  };
  return (
    <>
      {textarea ? <textarea {...common} rows={rows ?? 3} spellCheck={false} /> : <input {...common} type="text" inputMode={inputMode} spellCheck={false} />}
      {error && <p id={hintId} className="err-text" role="alert">{error}</p>}
      {!error && off && why && <p id={hintId} className="why">{why}</p>}
    </>
  );
}

export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose(): void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('aria-disabled'));
        if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Button({ children, onClick, kind = 'secondary', disabled, reason, type = 'button', small, title }: {
  children: ReactNode; onClick?(): void; kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; reason?: string; type?: 'button' | 'submit'; small?: boolean; title?: string;
}) {
  return (
    <button type={type} className={`btn ${kind}${small ? ' small' : ''}${disabled ? ' is-off' : ''}`} aria-disabled={disabled || undefined}
      title={disabled && reason ? reason : title} onClick={() => { if (!disabled) onClick?.(); }}>{children}</button>
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'info' | 'run' | 'idle'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function ProgressBar({ value, label, indeterminate }: { value: number | null; label: string; indeterminate?: boolean }) {
  const pct = value === null ? 0 : Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate || value === null ? undefined : pct}>
      <div className={`bar-fill${indeterminate || value === null ? ' indet' : ''}`} style={{ width: indeterminate || value === null ? '40%' : `${pct}%` }} />
      <span className="bar-text">{value === null ? '…' : `${pct} %`}</span>
    </div>
  );
}

export function Notice({ tone, children, role }: { tone: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode; role?: 'alert' | 'status' }) {
  return <div className={`notice ${tone}`} role={role ?? (tone === 'bad' ? 'alert' : undefined)}>{children}</div>;
}

export const fmtTime = (iso?: string) => {
  if (!iso) return '–';
  const t = parseUtc(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
};

export function fmtDuration(startIso?: string, endIso?: string, now = Date.now()): string {
  if (!startIso) return '–';
  const s = parseUtc(startIso);
  const e = endIso ? parseUtc(endIso) : now;
  if (Number.isNaN(s) || Number.isNaN(e)) return '–';
  const sec = Math.max(0, Math.round((e - s) / 1000));
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const r = sec % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${r} s` : `${r} s`;
}
