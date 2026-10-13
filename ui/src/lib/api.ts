// The hub's routes, as typed calls. Only the shapes the UI needs.

import type { Areas, DonePreview, Next, Result, Snapshot, TaskDocument } from './contract';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One operation of a write. The engine checks the rules; the form is the page's. */
export type Op =
  | { op: 'set'; id: string; patch: Record<string, unknown>; if_match?: string }
  | { op: 'new'; area: string; title: string; fields?: Record<string, unknown>; body?: string }
  | { op: 'reorder'; id: string; after?: string; before?: string; group?: string; if_match?: string }
  | { op: 'done'; id: string; confirm: string; remind?: string }
  | { op: 'tick_step'; id: string; n: number; done?: boolean; if_match?: string }
  | { op: 'append_note'; id: string; text: string; if_match?: string }
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

export interface Hello {
  instance: string;
  version: string;
  engine: { ready: boolean; problem: string | null; capabilities: string[] | null };
}

/** One area as `GET /api/tasks/areas` tells it, with the class it is shown with. */
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

export type SnapshotResult =
  | { kind: 'fresh'; doc: Snapshot; etag: string | null }
  | { kind: 'not_modified' };

export class Hub {
  private token: string | null = null;
  /** Called when the hub says the session is gone. */
  onUnauthorized: () => void = () => {};

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly base: string = '',
  ) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  /** The session token, for a request the browser makes by itself (the stream). */
  get bearer(): string {
    return this.token ?? '';
  }

  url(path: string): string {
    return this.base + path;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const response = await this.fetchFn(this.url(path), {
      ...init,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (response.status === 401) this.onUnauthorized();
    return response;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  }

  async hello(): Promise<Hello> {
    const doc = await this.json<{
      instance: string;
      version: string;
      engine: { ready: boolean; problem: string | null; capabilities?: string[] };
    }>('/api/tasks/hello');
    return {
      instance: doc.instance,
      version: doc.version,
      engine: { ...doc.engine, capabilities: doc.engine.capabilities ?? null },
    };
  }

  /** Trade a pairing code for a session token. */
  async exchange(code: string): Promise<string> {
    const response = await this.fetchFn(this.url('/auth/exchange'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw await failure(response);
    const doc = (await response.json()) as { token?: string };
    if (typeof doc.token !== 'string') throw new ApiError(502, 'bad_reply', 'no token');
    return doc.token;
  }

  async snapshot(etag: string | null): Promise<SnapshotResult> {
    const headers: Record<string, string> = {};
    if (etag) headers['If-None-Match'] = `"${etag}"`;
    const response = await this.request('/api/tasks/snapshot', { headers });
    if (response.status === 304) return { kind: 'not_modified' };
    if (!response.ok) throw await failure(response);
    const raw = response.headers.get('etag');
    const tag = raw ? raw.replace(/^W\//, '').replace(/^"|"$/g, '') : null;
    return { kind: 'fresh', doc: (await response.json()) as Snapshot, etag: tag };
  }

  /** One task with its body. A `signal` that aborts drops the request: the hub then never starts the read. */
  task(id: string, signal?: AbortSignal): Promise<TaskDocument> {
    const path = `/api/tasks/task?id=${encodeURIComponent(id).replace(/%2F/gi, '/')}`;
    return this.json<TaskDocument>(path, signal ? { signal } : undefined);
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

  private async vaultPost(path: string, body: Record<string, unknown>): Promise<void> {
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
  }

  /** Remember a folder as a vault; the page has asked the person first. */
  addVault(name: string, path: string): Promise<void> {
    return this.vaultPost('/api/vaults/add', { name, path, confirm: true });
  }

  removeVault(name: string): Promise<void> {
    return this.vaultPost('/api/vaults/remove', { name });
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

  /** What finishing a task would do, and the token `done` needs. */
  donePreview(id: string): Promise<DonePreview> {
    const path = `/api/tasks/done_preview?id=${encodeURIComponent(id).replace(/%2F/gi, '/')}`;
    return this.json<DonePreview>(path);
  }

  async rescan(): Promise<void> {
    const response = await this.request('/api/tasks/rescan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) throw await failure(response);
  }
}

async function failure(response: Response): Promise<ApiError> {
  let code = 'http_error';
  let message = `HTTP ${response.status}`;
  try {
    const doc = (await response.json()) as { error?: { code?: string; message?: string } };
    if (doc.error?.code) code = doc.error.code;
    if (doc.error?.message) message = doc.error.message;
  } catch {
    // not JSON: keep the generic words
  }
  return new ApiError(response.status, code, message);
}
