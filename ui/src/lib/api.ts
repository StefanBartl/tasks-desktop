// The hub's routes, as typed calls. Only the shapes the UI needs.

import type { Areas, Next, Snapshot, TaskDocument } from './contract';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Hello {
  instance: string;
  version: string;
  engine: { ready: boolean; problem: string | null };
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
      engine: { ready: boolean; problem: string | null };
    }>('/api/tasks/hello');
    return { instance: doc.instance, version: doc.version, engine: doc.engine };
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

  /** The tasks whose text holds every word of `query` (the hub searches the text it keeps). */
  search(query: string, signal?: AbortSignal): Promise<SearchResult> {
    const path = `/api/tasks/search?q=${encodeURIComponent(query)}&limit=20`;
    return this.json<SearchResult>(path, signal ? { signal } : undefined);
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
