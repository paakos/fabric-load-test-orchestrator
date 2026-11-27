import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RadioGroup, TextInput } from './components/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('accessible primitives', () => {
  it('an exclusive option is a radiogroup of radio buttons with aria-checked', () => {
    const html = renderToStaticMarkup(createElement(RadioGroup<string>, { label: 'Scope', value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], onChange: () => undefined }));
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
  });

  it('a greyed-out radio group and field use aria-disabled and explain why', () => {
    const g = renderToStaticMarkup(createElement(RadioGroup<string>, { label: 'Scope', value: 'a', disabled: true, reason: 'Disabled: source is none', options: [{ value: 'a', label: 'A' }], onChange: () => undefined }));
    expect(g).toContain('aria-disabled="true"');
    expect(g).toContain('Disabled: source is none');
    const t = renderToStaticMarkup(createElement(TextInput, { id: 'x', value: 'keep me', onChange: () => undefined, off: true, why: 'Disabled: global mode' }));
    expect(t).toContain('aria-disabled="true"');
    expect(t).toContain('readOnly');
    expect(t).toContain('value="keep me"');
    expect(t).toContain('Disabled: global mode');
    expect(t).toContain('aria-describedby');
  });
});

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const tick = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

/** Node 26 ships its own (disabled) localStorage that hides the one of jsdom: an in-memory one that the test can inspect. */
const local = (() => {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), getItem: (k: string) => m.get(k) ?? null, key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k), setItem: (k: string, v: string) => void m.set(k, String(v)), dump: () => JSON.stringify([...m.entries()]),
  };
})();

describe('the whole app in demo mode', () => {
  let root: Root;
  let host: HTMLDivElement;
  const logs: string[] = [];

  beforeEach(async () => {
    vi.stubEnv('VITE_DEMO_MODE', 'true');
    vi.resetModules();
    sessionStorage.clear(); logs.length = 0;
    local.clear();
    vi.stubGlobal('localStorage', local);
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    window.location.hash = '#/launch';
    const { App } = await import('./App');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(createElement(App)); });
    await tick(120);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  });

  const radio = (name: string, nth = 0) => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((b) => b.textContent === name)[nth];
  const click = async (el: Element | undefined) => { expect(el).toBeDefined(); await act(async () => { (el as HTMLElement).click(); }); await tick(); };

  it('shows the Parameters page with radiogroups, greyed fields with a reason, and the launch button blocked with reasons', () => {
    expect(host.querySelector('h1')?.textContent).toContain('Parameters');
    expect(host.querySelectorAll('[role="radiogroup"]').length).toBeGreaterThan(6);
    const off = host.querySelectorAll('[aria-disabled="true"]');
    expect(off.length).toBeGreaterThan(10);
    expect(host.textContent).toContain('Disabled: the run settings are global');
    const launch = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Launch test') as HTMLButtonElement;
    expect(launch.getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('.why-list')?.textContent).toBeTruthy();
    expect(host.querySelector('pre.json')?.textContent).toContain('"write_results_to_tables": false');
  });

  it('switching to Per model greys the global settings and enables the card ones', async () => {
    const card = () => host.querySelector<HTMLInputElement>('input[id^="f-models-"][id$="-settings-iterations"]');
    expect(card()).toBeNull();
    const globalIter = () => host.querySelector<HTMLInputElement>('#f-global-iterations')!;
    expect(globalIter().getAttribute('aria-disabled')).toBeNull();
    await click(radio('Per model'));
    expect(globalIter().getAttribute('aria-disabled')).toBe('true');
    expect(card()?.getAttribute('aria-disabled')).toBeNull();
    expect(host.querySelector('pre.json')?.textContent).toContain('"ramp_levels": [1, 5, 10]');
  });

  it('privacy: a typed UPN is never stored, logged, shown in the preview or in the page text', async () => {
    await click(radio('list'));
    const area = host.querySelector<HTMLTextAreaElement>('#f-rls_users')!;
    expect(area.getAttribute('aria-disabled')).toBeNull();
    await act(async () => { setValue(area, 'maria.lopez@contoso.com, pedro@contoso.com'); });
    await tick(600);
    expect(area.value).toContain('maria.lopez@contoso.com');
    expect(host.querySelector('pre.json')?.textContent).toContain('«2 users»');
    const copy = host.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('textarea, input').forEach((e) => e.remove()); // the only place where UPNs may show: the field where they are typed
    const visible = copy.textContent ?? '';
    expect(visible).not.toContain('maria.lopez');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('@');
    expect(local.dump()).not.toContain('@');
    expect(logs.join('\n')).not.toContain('@');
    expect(logs.join('\n')).not.toContain('maria');
    expect(JSON.stringify({ ...sessionStorage })).toContain('loadtest.env.v1');
  });
});
