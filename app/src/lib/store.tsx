import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DemoBackend } from '../demo/demo';
import { env, missingConfig } from './env';
import type { Item, JobInstance, Workspace } from './fabric';
import { defaultForm, type FormState } from './model';
import { discover, hasPerfScenarios, listFiles, type Discovery, type LakeFile, type Target } from './ops';
import { QUERIES_DIR, USERS_DIR } from './parameters';
import { FabricBackend, type Account, type Backend } from './service';
import { SignInRequiredError } from './msal';
import { isFinal } from './progress';
import type { ImportReport } from './importParams';
import { loadLaunched, saveLaunched, type LaunchedRun } from './launch';

/** Page and help state, kept in the URL hash: #/launch, #/runs/<jobId>, #/reports/<analysisId>/<Q05>, #/environment, #/help/<doc>/<anchor>. */
export type Page = 'launch' | 'runs' | 'reports' | 'environment';
export interface Route { page: Page; id?: string; query?: string; params: URLSearchParams; help: { doc?: string; anchor?: string } | null }

export function parseHash(hash: string, previous: Page = 'launch'): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, search = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(search);
  if (parts[0] === 'help') return { page: previous, params, help: { doc: parts[1], anchor: parts[2] } };
  const page: Page = parts[0] === 'runs' || parts[0] === 'reports' || parts[0] === 'environment' ? parts[0] : 'launch';
  return { page, id: parts[1], query: parts[2], params, help: null };
}

const ENV_KEY = 'loadtest.env.v1';
interface StoredEnv { workspaceId: string; lakehouseId: string; pipelineConfirmed: boolean }

function readEnv(): StoredEnv {
  try {
    const raw = JSON.parse(sessionStorage.getItem(ENV_KEY) ?? 'null') as Partial<StoredEnv> | null;
    if (raw) return { workspaceId: raw.workspaceId ?? '', lakehouseId: raw.lakehouseId ?? '', pipelineConfirmed: !!raw.pipelineConfirmed };
  } catch { /* nothing stored */ }
  return { workspaceId: env.demo ? 'demo-ws-test' : env.defaultWorkspaceId, lakehouseId: env.demo ? 'demo-lh' : '', pipelineConfirmed: false };
}

export interface FileCache { queries: LakeFile[]; users: LakeFile[] }

interface Ctx {
  backend: Backend;
  route: Route;
  go(hash: string): void;
  closeHelp(): void;
  account: Account | null;
  authError: string | null;
  missing: string[];
  signIn(): Promise<void>;
  /** Environment */
  stored: StoredEnv;
  setWorkspace(id: string): void;
  setLakehouse(id: string): void;
  setPipelineConfirmed(v: boolean): void;
  workspaces: Workspace[];
  discovery: Discovery | null;
  discoveryError: string | null;
  refreshDiscovery(): Promise<void>;
  target: Target | null;
  workspaceName: string;
  lakehouseName: string;
  warnedWorkspace: boolean;
  /** Form (memory only: it may hold UPNs) */
  form: FormState;
  setForm(f: FormState | ((prev: FormState) => FormState)): void;
  importReport: ImportReport | null;
  setImportReport(r: ImportReport | null): void;
  files: FileCache;
  refreshFiles(kind: 'queries' | 'users'): Promise<void>;
  /** Jobs of the pipeline */
  jobs: JobInstance[];
  jobsError: string | null;
  refreshJobs(): Promise<void>;
  activeRuns: number;
  launched: Record<string, LaunchedRun>;
  rememberLaunched(run: LaunchedRun): void;
}

const AppCtx = createContext<Ctx | null>(null);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AppProvider({ children }: { children: ReactNode }) {
  const backend = useMemo<Backend>(() => (env.demo ? new DemoBackend() : new FabricBackend()), []);
  const lastPage = useRef<Page>('launch');
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [account, setAccount] = useState<Account | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [stored, setStored] = useState<StoredEnv>(readEnv);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => defaultForm());
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [files, setFiles] = useState<FileCache>({ queries: [], users: [] });
  const [jobs, setJobs] = useState<JobInstance[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<Record<string, LaunchedRun>>(() => loadLaunched());

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash, lastPage.current));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (!route.help) lastPage.current = route.page;

  const go = useCallback((hash: string) => { window.location.hash = hash; }, []);
  const closeHelp = useCallback(() => {
    const p = lastPage.current;
    window.location.hash = p === 'launch' ? '#/launch' : `#/${p}`;
  }, []);

  const handleAuth = useCallback((e: unknown) => {
    if (e instanceof SignInRequiredError) { setAccount(null); return true; }
    return false;
  }, []);

  useEffect(() => {
    let alive = true;
    void backend.account().then((a) => { if (alive) setAccount(a); }).catch(() => undefined);
    return () => { alive = false; };
  }, [backend]);

  useEffect(() => { try { sessionStorage.setItem(ENV_KEY, JSON.stringify(stored)); } catch { /* no storage */ } }, [stored]);

  const signIn = useCallback(async () => {
    setAuthError(null);
    try { setAccount(await backend.signIn()); } catch (e) { setAuthError(errorText(e)); }
  }, [backend]);

  // workspaces, once signed in
  useEffect(() => {
    if (!account) return;
    let alive = true;
    backend.workspaces().then((w) => { if (alive) setWorkspaces(w); }).catch((e) => { if (!handleAuth(e) && alive) setDiscoveryError(errorText(e)); });
    return () => { alive = false; };
  }, [backend, account, handleAuth]);

  const ws = stored.workspaceId;
  const refreshDiscovery = useCallback(async () => {
    if (!account || !ws) { setDiscovery(null); return; }
    try {
      setDiscoveryError(null);
      const d = await discover(backend, ws);
      setDiscovery(d);
      setStored((s) => {
        if (s.lakehouseId && d.lakehouses.some((l) => l.id === s.lakehouseId)) return s;
        return { ...s, lakehouseId: d.lakehouses.length === 1 ? d.lakehouses[0].id : '' };
      });
      if (d.lakehouses.length > 1) {
        const probes = await Promise.all(d.lakehouses.map(async (l) => [l, await hasPerfScenarios(backend, ws, l.id)] as const));
        const hit = probes.filter(([, ok]) => ok).map(([l]) => l);
        setStored((s) => (s.lakehouseId || hit.length !== 1 ? s : { ...s, lakehouseId: hit[0].id }));
      }
    } catch (e) {
      if (!handleAuth(e)) setDiscoveryError(errorText(e));
    }
  }, [backend, account, ws, handleAuth]);
  useEffect(() => { void refreshDiscovery(); }, [refreshDiscovery]);

  const target = useMemo<Target | null>(() => (ws && stored.lakehouseId ? { ws, lh: stored.lakehouseId } : null), [ws, stored.lakehouseId]);

  const refreshFiles = useCallback(async (kind: 'queries' | 'users') => {
    if (!target || !account) return;
    try {
      const list = kind === 'queries'
        ? await listFiles(backend, target, QUERIES_DIR, /\.json$/i)
        : await listFiles(backend, target, USERS_DIR, /\.(txt|csv|list)$/i);
      setFiles((f) => ({ ...f, [kind]: list }));
    } catch (e) { handleAuth(e); }
  }, [backend, target, account, handleAuth]);
  useEffect(() => { void refreshFiles('queries'); void refreshFiles('users'); }, [refreshFiles]);

  const pipelineId = discovery?.pipeline?.id;
  const refreshJobs = useCallback(async () => {
    if (!account || !ws || !pipelineId) { setJobs([]); return; }
    try { setJobs(await backend.jobs(ws, pipelineId)); setJobsError(null); } catch (e) { if (!handleAuth(e)) setJobsError(errorText(e)); }
  }, [backend, account, ws, pipelineId, handleAuth]);
  useEffect(() => {
    void refreshJobs();
    const id = window.setInterval(() => void refreshJobs(), env.demo ? 4000 : 20000);
    return () => window.clearInterval(id);
  }, [refreshJobs]);

  const rememberLaunched = useCallback((run: LaunchedRun) => { saveLaunched(run); setLaunched((l) => ({ ...l, [run.jobId]: run })); }, []);

  const workspaceName = workspaces.find((w) => w.id === ws)?.displayName ?? '';
  const lakehouseName = discovery?.lakehouses.find((l: Item) => l.id === stored.lakehouseId)?.displayName ?? '';
  const value: Ctx = {
    backend, route, go, closeHelp, account, authError, missing: missingConfig(), signIn, stored,
    setWorkspace: (id) => setStored((s) => ({ ...s, workspaceId: id, lakehouseId: '', pipelineConfirmed: false })),
    setLakehouse: (id) => setStored((s) => ({ ...s, lakehouseId: id })),
    setPipelineConfirmed: (v) => setStored((s) => ({ ...s, pipelineConfirmed: v })),
    workspaces, discovery, discoveryError, refreshDiscovery, target, workspaceName, lakehouseName,
    warnedWorkspace: env.warnWorkspaces.includes(workspaceName.toLowerCase()),
    form, setForm, importReport, setImportReport, files, refreshFiles,
    jobs, jobsError, refreshJobs, activeRuns: jobs.filter((j) => !isFinal(j.status)).length, launched, rememberLaunched,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}
