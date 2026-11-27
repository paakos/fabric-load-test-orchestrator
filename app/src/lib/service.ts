import * as api from './fabric';
import { currentAccount, signIn } from './msal';

export interface Account { name: string }

/**
 * Fabric and OneLake primitives. FabricBackend calls the real APIs; DemoBackend (demo.ts) simulates them in memory,
 * so the demo mode exercises exactly the same logic (ops.ts, progress.ts) as the real one.
 */
export interface Backend {
  readonly demo: boolean;
  account(): Promise<Account | null>;
  signIn(): Promise<Account | null>;
  workspaces(): Promise<api.Workspace[]>;
  items(workspaceId: string, type: string): Promise<api.Item[]>;
  list(workspaceId: string, lakehouseId: string, directory: string): Promise<api.PathEntry[]>;
  read(workspaceId: string, lakehouseId: string, path: string, maxBytes?: number): Promise<string | null>;
  write(workspaceId: string, lakehouseId: string, path: string, data: Blob | string): Promise<void>;
  mkdir(workspaceId: string, lakehouseId: string, path: string): Promise<void>;
  runPipeline(workspaceId: string, pipelineId: string, bodyText: string): Promise<void>;
  runNotebook(workspaceId: string, notebookId: string, parameters: api.NotebookParams): Promise<void>;
  jobs(workspaceId: string, itemId: string): Promise<api.JobInstance[]>;
  job(workspaceId: string, itemId: string, jobId: string): Promise<api.JobInstance>;
  cancel(workspaceId: string, itemId: string, jobId: string): Promise<void>;
  activityRuns(workspaceId: string, runId: string, since: Date): Promise<api.ActivityRun[]>;
}

const toAccount = (a: { name?: string; username: string } | null): Account | null => (a ? { name: a.name || 'Signed-in user' } : null);

export class FabricBackend implements Backend {
  readonly demo = false;
  async account() { return toAccount(await currentAccount()); }
  async signIn() { return toAccount(await signIn()); }
  workspaces() { return api.listWorkspaces(); }
  items(ws: string, type: string) { return api.listItems(ws, type); }
  list(ws: string, lh: string, dir: string) { return api.onelakeList(ws, lh, dir); }
  read(ws: string, lh: string, path: string, maxBytes?: number) { return api.onelakeRead(ws, lh, path, maxBytes); }
  write(ws: string, lh: string, path: string, data: Blob | string) { return api.onelakeWrite(ws, lh, path, data); }
  mkdir(ws: string, lh: string, path: string) { return api.onelakeMkdir(ws, lh, path); }
  runPipeline(ws: string, id: string, body: string) { return api.runPipeline(ws, id, body); }
  runNotebook(ws: string, id: string, p: api.NotebookParams) { return api.runNotebook(ws, id, p); }
  jobs(ws: string, item: string) { return api.listJobs(ws, item); }
  job(ws: string, item: string, id: string) { return api.getJob(ws, item, id); }
  cancel(ws: string, item: string, id: string) { return api.cancelJob(ws, item, id); }
  activityRuns(ws: string, runId: string, since: Date) { return api.queryActivityRuns(ws, runId, since); }
}
