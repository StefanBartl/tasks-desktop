// The hub's routes, as typed calls. Only the shapes the UI needs.

import type {
  Areas,
  Check,
  DonePreview,
  Estimate,
  Finished,
  Groupings,
  Links,
  NamedLists,
  Next,
  Order,
  PlanFor,
  Result,
  Snapshot,
  TaskDocument,
  Views,
} from './contract';
import type { ViewForm } from './views';
import type { About } from './about';
import { ApiError, failure, HubClient, textOf, type Hello, type SnapshotResult as KitSnapshotResult } from 'appkit-ui/client';

// The transport (the bearer token, the refusal, the pairing code, hello, the snapshot with its tag, rescan) is the
// kit's; this file is the routes of the tasks.
export { ApiError, type Hello };

/** One operation of a write. The engine checks the rules; the form is the page's. */
export type Op =
  | { op: 'set'; id: string; patch: Record<string, unknown>; if_match?: string }
  | { op: 'new'; area: string; title: string; fields?: Record<string, unknown>; body?: string }
  | { op: 'reorder'; id: string; after?: string; before?: string; group?: string; if_match?: string }
  | { op: 'done'; id: string; confirm: string; remind?: string }
  | { op: 'reopen'; id: string; status?: string; if_match?: string }
  | { op: 'tick_step'; id: string; n: number; done?: boolean; if_match?: string }
  /** Tick option `option` of a question (by its key), or take the answer back with `clear`. */
  | { op: 'answer'; id: string; question: string; option?: number; clear?: boolean; if_match?: string }
  | { op: 'append_note'; id: string; text: string; if_match?: string }
  | { op: 'set_body'; id: string; body: string; if_match?: string }
  | { op: 'move_area'; id: string; to_area: string; if_match?: string }
  /** A saved view: `area` alone makes a new one, `id` replaces that one (on the version read). */
  | { op: 'view_save'; id?: string; area?: string; view: ViewForm; if_match?: string }
  /** Only on the version read: the engine refuses a delete without it. */
  | { op: 'view_delete'; id: string; if_match: string }
  /** The image on the clipboard of the hub's machine, or its newest screenshot, becomes an asset of the task. */
  | { op: 'attach'; id: string; from: 'clipboard' | 'latest'; name?: string }
  | {
      op: 'plan_new';
      area: string;
      title: string;
      areas?: string[];
      target?: string;
      phases?: string[];
      gate?: string;
      status?: string;
      summary?: string;
      slug?: string;
    };

/** The vaults the hub can read, and the one it reads. A folder is shown by its last part only. */
export interface VaultList {
  active: string;
  vaults: { name: string; label: string; main: boolean }[];
}

export interface OpsRequest {
  client_op_id: string;
  dry_run?: boolean;
  ops: Op[];
}

/** One area as `GET /api/tasks/areas` tells it, with the class it is shown with. */
/** The check job of the hub: nothing yet, running, done with the engine's document, or failed in words. */
export type CheckJobState =
  | { state: 'idle' }
  | { state: 'running'; id: number }
  | { state: 'done'; id: number; result: Check }
  | { state: 'failed'; id: number; error: { code: string; message: string } };

export interface HubArea {
  name: string;
  data_class: 'public' | 'internal' | 'private' | 'unclassified';
  open?: number;
}

export interface HubAreas {
  areas: HubArea[];
  unclassified: string[];
  private: string[];
}

/** A piece of a task's text around a match; `marks` are `[start, end)` in UTF-16 units of `text`. */
export interface SearchSnippet {
  text: string;
  marks: [number, number][];
  more_before: boolean;
  more_after: boolean;
}

export interface SearchHit {
  id: string;
  score: number;
  snippet: SearchSnippet;
}

export interface SearchResult {
  /** `building`: the hub has not read the texts yet; `failed`: it could not. */
  status: 'ready' | 'building' | 'failed';
  indexed: number;
  /** The texts did not all fit: some tasks are not searched. */
  partial?: boolean;
  total: number;
  hits: SearchHit[];
}

export type SnapshotResult = KitSnapshotResult<Snapshot>;

export class Hub extends HubClient<Snapshot> {
  constructor(fetchFn: typeof fetch, base: string = '') {
    super(fetchFn, '/api/tasks', base);
  }

  /** What this build is and which engine answers (APP-09): only the words the page shows are taken from the hub. */
  async about(): Promise<About> {
    const doc = await this.json<Record<string, unknown>>('/api/tasks/about');
    const text = textOf;
    const engine = doc['engine'];
    const pinned = doc['pinned'];
    const part = (v: unknown, key: string): string | null =>
      typeof v === 'object' && v !== null ? text((v as Record<string, unknown>)[key]) : null;
    return {
      app: text(doc['app']) ?? 'tasks-desktop',
      version: text(doc['version']) ?? '',
      build: text(doc['build']),
      os: text(doc['os']) ?? '',
      arch: text(doc['arch']) ?? '',
      mode: text(doc['mode']),
      engine:
        typeof engine === 'object' && engine !== null
          ? { version: part(engine, 'version'), git: part(engine, 'git'), nvim: part(engine, 'nvim') }
          : null,
      engineProblem: text(doc['engine_problem']),
      pinned: { engine: part(pinned, 'engine'), lib: part(pinned, 'lib') },
    };
  }

  /** One task with its body. A `signal` that aborts drops the request: the hub then never starts the read. */
  task(id: string, signal?: AbortSignal): Promise<TaskDocument> {
    const path = `/api/tasks/task?id=${encodeURIComponent(id).replace(/%2F/gi, '/')}`;
    return this.json<TaskDocument>(path, signal ? { signal } : undefined);
  }

  /** The ids of the open tasks in the order of `sort` (the engine's), in one answer. */
  async order(sort: string, signal?: AbortSignal): Promise<{ ids: string[] }> {
    const doc = await this.json<Order>(`/api/tasks/order?sort=${encodeURIComponent(sort)}`, signal ? { signal } : undefined);
    return { ids: doc.ids };
  }

  /** The named lists of the engine (read only). */
  lists(): Promise<NamedLists> {
    return this.json<NamedLists>('/api/tasks/lists');
  }

  next(): Promise<Next> {
    return this.json<Next>('/api/tasks/next?n=5');
  }

  areas(): Promise<HubAreas & Areas> {
    return this.json<HubAreas & Areas>('/api/tasks/areas');
  }

  /** The vaults the hub can read; the hub answers 404 when it has no list. */
  vaults(): Promise<VaultList> {
    return this.json<VaultList>('/api/vaults');
  }

  private vaultPost(path: string, body: Record<string, unknown>): Promise<void> {
    return this.post(path, body);
  }

  /** The ranges of the fields as the engine names them (its `hello.enums`, passed on by the hub). */
  enums(): Promise<{ enums: unknown }> {
    return this.json<{ enums: unknown }>('/api/tasks/enums');
  }

  /** The fields the open tasks can be grouped by, with their values and how each is written (the engine's). */
  groupings(): Promise<Groupings> {
    return this.json<Groupings>('/api/tasks/groupings');
  }

  /** The saved views of the vault, each with the version of its file. */
  views(): Promise<Views> {
    return this.json<Views>('/api/tasks/views');
  }

  /** Remember a folder as a vault; the page has asked the person first. */
  addVault(name: string, path: string): Promise<void> {
    return this.vaultPost('/api/vaults/add', { name, path, confirm: true });
  }

  /** Make a folder that is new (or empty) a vault with one area; the page has asked the person first. It does not register it. */
  createVault(path: string, area: string): Promise<void> {
    return this.vaultPost('/api/tasks/vault_create', { path, area, confirm: true });
  }

  /** Show the folder of the vault the hub reads in the file manager (the page names no folder). */
  revealVault(): Promise<void> {
    return this.vaultPost('/api/tasks/vault_reveal', {});
  }

  /**
   * Ask the person for a folder with the dialog of the system on the machine of the hub (a page cannot show one with a
   * path). The folder they chose, or `null` when the dialog was closed; the page names nothing.
   */
  async pickVaultFolder(): Promise<string | null> {
    const doc = await this.postJson<{ path: string | null }>('/api/tasks/vault_pick', {});
    return typeof doc.path === 'string' && doc.path !== '' ? doc.path : null;
  }

  removeVault(name: string): Promise<void> {
    return this.vaultPost('/api/vaults/remove', { name });
  }

  /** Show the file of a task in Neovim, in a window of its own (the hub starts it; the page names only the task). */
  openInEditor(id: string): Promise<void> {
    return this.vaultPost('/api/tasks/open', { id });
  }

  /** Read another vault; the hub swaps what it holds and the page reads everything again. */
  selectVault(name: string): Promise<void> {
    return this.vaultPost('/api/vaults/select', { name });
  }

  /** The tasks whose text holds every word of `query` (the hub searches the text it keeps). */
  search(query: string, signal?: AbortSignal): Promise<SearchResult> {
    const path = `/api/tasks/search?q=${encodeURIComponent(query)}&limit=20`;
    return this.json<SearchResult>(path, signal ? { signal } : undefined);
  }

  /** Changes, through the one door of the engine. The answer says per operation what happened. */
  async ops(request: OpsRequest, signal?: AbortSignal): Promise<Result> {
    const response = await this.request('/api/tasks/ops', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as Result;
  }

  /**
   * The figures of an estimate for some tasks, also as they would be with other efforts and values (`assume`): a
   * question, nothing is written. The engine reckons; the page shows.
   */
  async estimate(
    request: { ids?: string[]; assume?: { id: string; effort?: string; value?: number }[] },
    signal?: AbortSignal,
  ): Promise<Estimate> {
    const response = await this.request('/api/tasks/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as Estimate;
  }

  /** The state of the check job (the check of the vault runs in the hub, not in the page). */
  async checkState(): Promise<CheckJobState> {
    return (await this.json<{ job: CheckJobState }>('/api/tasks/check')).job;
  }

  /** Start the check as a job; a job that runs already is answered instead of a second one. */
  async checkStart(request: { stale?: 'refs'; area?: string } = {}): Promise<CheckJobState> {
    const response = await this.request('/api/tasks/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw await failure(response);
    return ((await response.json()) as { job: CheckJobState }).job;
  }

  /** The tasks a task needs before it can start, or that wait for it (the engine walks the graph). */
  planFor(id: string, direction: 'needs' | 'unlocks', signal?: AbortSignal): Promise<PlanFor> {
    const path = `/api/tasks/plan_for?id=${encodeURIComponent(id).replace(/%2F/gi, '/')}&direction=${direction}`;
    return this.json<PlanFor>(path, signal ? { signal } : undefined);
  }

  /** The finished tasks of the Backlogs and what they add up to (the engine counts; `since` and `until` are days). */
  finished(
    query: { area?: string; plan?: string; since?: string; until?: string; limit?: number; offset?: number },
    signal?: AbortSignal,
  ): Promise<Finished> {
    const parts = Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value)).replace(/%2F/gi, '/')}`);
    const path = `/api/tasks/finished${parts.length > 0 ? `?${parts.join('&')}` : ''}`;
    return this.json<Finished>(path, signal ? { signal } : undefined);
  }

  /** Where the areas hang together: the links between the open tasks of different areas. */
  links(): Promise<Links> {
    return this.json<Links>('/api/tasks/links');
  }

  /** The text of a snapshot a test-sheet block names (`<repo>/TESTS/__snapshots__/<path>.snap`); the hub reads it. */
  async sheetSnapshot(name: string, signal?: AbortSignal): Promise<string> {
    const doc = await this.json<{ text: string }>(`/api/tasks/sheet_snap?name=${encodeURIComponent(name).replace(/%2F/gi, '/')}`, signal ? { signal } : undefined);
    return doc.text;
  }

  /** What finishing a task would do, and the token `done` needs. */
  donePreview(id: string): Promise<DonePreview> {
    const path = `/api/tasks/done_preview?id=${encodeURIComponent(id).replace(/%2F/gi, '/')}`;
    return this.json<DonePreview>(path);
  }
}
