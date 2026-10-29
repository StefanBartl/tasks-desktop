// The hub of the web variant: the routes of crates/tasks-hub/src/server/routes.rs, answered in the page by the engine
// in the worker, behind the `fetch` the API client already takes (ui/src/lib/api.ts). The components do not know
// whether a server or this answers.
//
// What the Rust hub checks before it asks the engine is checked here the same way (the query is plain, an id is
// `<area>/<slug>`, an area is a name, a sort is one of five words), and an engine refusal keeps its code and message
// and gets the same HTTP status. Left out on purpose: the session (there is no server and no token), the event stream
// (the page reads again on focus), and everything that writes or opens something on the machine (step 8 and later).

import type { CallResult } from './engine.ts';

export interface HubDeps {
  /** One method of the engine over the vault in the worker, as `engine.call` answers it. */
  call(method: string, request: string | null): Promise<CallResult>;
  /** The version of this build (the page's `package.json`) and its build id, for `about`. */
  version: string;
  build: string | null;
  /** The commits of `engine.lock`, for `about`. */
  pinned: { engine: string | null; lib: string | null };
  /** The class an area is shown with (`areas.json`, fail-closed); an area the file does not name is unclassified. */
  classes?: (area: string) => DataClass;
  /** Called by `POST rescan`: the page asks to read the folder again. */
  rescan?: () => Promise<void>;
}

export type DataClass = 'public' | 'internal' | 'private' | 'unclassified';

const NS = '/api/tasks/';
/** The one session of a page in the web variant: a word, not a secret. */
export const SESSION = 'web-session';
const SORTS = ['default', 'prio-effort', 'severity', 'frecency', 'roi'];
const MAX_AREA_NAME = 128;
const ESTIMATE_MAX = 1000;
const JSON_TYPE = { 'Content-Type': 'application/json' };

function respond(status: number, body: string, etag?: string | null): Response {
  const headers: Record<string, string> = { ...JSON_TYPE };
  if (etag) headers['ETag'] = `"${etag}"`;
  return new Response(body, { status, headers });
}

function errorBody(status: number, code: string, message: string): Response {
  return respond(status, JSON.stringify({ error: { code, message } }));
}

/** The folder name rule of `config::valid_area_name`. */
export function validAreaName(name: string): boolean {
  if (name === '' || [...name].length > MAX_AREA_NAME) return false;
  if (name.startsWith('.') || name.endsWith(' ') || name.endsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f/\\,:*?"<>|]/.test(name);
}

/** `<area>/<slug>`: two plain names. The engine says whether the task is there. */
export function validTaskId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const cut = id.indexOf('/');
  if (cut < 0) return false;
  const area = id.slice(0, cut);
  const slug = id.slice(cut + 1);
  const plain = /^[A-Za-z0-9._-]*$/;
  return validAreaName(area) && plain.test(area) && slug !== '' && slug.length <= 128 && !slug.startsWith('.') && plain.test(slug);
}

/** A query of plain pairs, or the reason it is not (`parse_query` of appkit-hub). */
export function parseQuery(query: string, allowed: readonly string[]): Map<string, string> | string {
  const out = new Map<string, string>();
  if (query === '') return out;
  for (const pair of query.split('&')) {
    const cut = pair.indexOf('=');
    if (cut < 0) return 'a query part has no value';
    const key = pair.slice(0, cut);
    const value = pair.slice(cut + 1);
    if (!allowed.includes(key)) return 'unknown query parameter';
    if (!/^[A-Za-z0-9._/-]{1,128}$/.test(value)) return 'a query value is not plain text';
    if (out.has(key)) return 'a query parameter is given twice';
    out.set(key, value);
  }
  return out;
}

const STATUS_OF_CODE: Record<string, number> = {
  invalid_argument: 400,
  unsupported_schema: 400,
  not_found: 404,
  conflict: 409,
  exists: 409,
  forbidden: 403,
  locked: 503,
};

/** An engine refusal, as `engine_failure` of the Rust hub tells it: the code and a short plain message. */
export function failureResponse(result: CallResult): Response {
  let doc: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(result.text);
    if (typeof parsed === 'object' && parsed !== null) doc = parsed as Record<string, unknown>;
  } catch {
    // an answer that is not JSON is told as a failed engine below
  }
  const raw = typeof doc['code'] === 'string' ? doc['code'] : result.code ?? '';
  const status = STATUS_OF_CODE[raw] ?? 502;
  const codeOk = /^[a-z_]{1,48}$/.test(raw);
  // eslint-disable-next-line no-control-regex
  const message = (typeof doc['message'] === 'string' ? doc['message'] : '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 512);
  const retryable = doc['retryable'] === true;
  return respond(status, JSON.stringify({ error: { code: codeOk ? raw : 'engine_failed', message, retryable } }));
}

/** The tag of a snapshot: its digest, when that is plain (`plain_digest` of the store). */
function etagOf(text: string): string | null {
  try {
    const digest = (JSON.parse(text) as { digest?: unknown }).digest;
    return typeof digest === 'string' && /^[A-Za-z0-9:]{1,128}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

function etagMatches(header: string, etag: string): boolean {
  const quoted = `"${etag}"`;
  return header.split(',').some((c) => {
    const t = c.trim();
    return t === '*' || (t.startsWith('W/') ? t.slice(2) : t) === quoted;
  });
}

type CheckState =
  | { state: 'idle' }
  | { state: 'done'; id: number; result: unknown }
  | { state: 'failed'; id: number; error: { code: string; message: string } };

export interface WebHub {
  fetch: typeof fetch;
  /** Tell every open event stream that the vault may have changed: the page reads again (a `resync` event). */
  notify(): void;
  /** End every open event stream. */
  close(): void;
}

export function createWebHub(deps: HubDeps): WebHub {
  const classes = deps.classes ?? (() => 'unclassified' as const);
  let check: CheckState = { state: 'idle' };
  let checkId = 0;
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const text = new TextEncoder();

  /** `GET events`: what the Rust hub sends over SSE, without a server. `hello` first, then `resync` on `notify`. */
  function events(signal?: AbortSignal | null): Response {
    let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        mine = controller;
        streams.add(controller);
        controller.enqueue(text.encode('event: hello\ndata: {}\n\n'));
        // A request that is aborted ends its stream, as a real connection does: the reader sees an AbortError.
        signal?.addEventListener(
          'abort',
          () => {
            streams.delete(controller);
            try {
              controller.error(new DOMException('The request was aborted', 'AbortError'));
            } catch {
              // already closed
            }
          },
          { once: true },
        );
      },
      cancel() {
        if (mine) streams.delete(mine);
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  }

  async function engine(method: string, params?: Record<string, unknown>): Promise<CallResult | Response> {
    let result: CallResult;
    try {
      result = await deps.call(method, params ? JSON.stringify({ params }) : null);
    } catch {
      return errorBody(502, 'engine_failed', 'the engine could not answer');
    }
    return result.code !== null ? failureResponse(result) : result;
  }

  /** Ask the engine and pass its document on unchanged. */
  async function passOn(method: string, params?: Record<string, unknown>): Promise<Response> {
    const r = await engine(method, params);
    return r instanceof Response ? r : respond(200, r.text);
  }

  const noQuery = (query: string): Response | null =>
    query === '' ? null : errorBody(400, 'bad_query', 'this route takes no query');

  const idRequired = (q: Map<string, string>): string | Response => {
    const id = q.get('id');
    return validTaskId(id) ? id : errorBody(400, 'bad_id', 'id must be <area>/<slug>');
  };

  async function get(name: string, query: string, headers: Headers, signal?: AbortSignal | null): Promise<Response> {
    switch (name) {
      case 'hello': {
        const r = await engine('hello');
        const caps = r instanceof Response ? null : (JSON.parse(r.text) as { capabilities?: string[] }).capabilities ?? null;
        return respond(
          200,
          JSON.stringify({
            instance: 'web',
            version: deps.version,
            engine: { ready: !(r instanceof Response), problem: r instanceof Response ? 'engine_failed' : null, capabilities: caps },
          }),
        );
      }
      case 'snapshot': {
        const refused = noQuery(query);
        if (refused) return refused;
        const r = await engine('snapshot');
        if (r instanceof Response) return r;
        const etag = etagOf(r.text);
        const seen = headers.get('if-none-match');
        if (etag && seen && etagMatches(seen, etag)) return new Response(null, { status: 304, headers: { ETag: `"${etag}"` } });
        return respond(200, r.text, etag);
      }
      case 'task': {
        const q = parseQuery(query, ['id']);
        if (typeof q === 'string') return errorBody(400, 'bad_query', q);
        const id = idRequired(q);
        return typeof id === 'string' ? passOn('task', { id }) : id;
      }
      case 'next': {
        const q = parseQuery(query, ['n', 'actor', 'area']);
        if (typeof q === 'string') return errorBody(400, 'bad_query', q);
        const params: Record<string, unknown> = {};
        const n = q.get('n');
        if (n !== undefined) {
          if (!/^[0-9]+$/.test(n) || Number(n) > 10) return errorBody(400, 'bad_query', 'n is 0 to 10');
          params['n'] = Number(n);
        }
        const actor = q.get('actor');
        if (actor !== undefined) params['actor'] = actor;
        const area = q.get('area');
        if (area !== undefined) {
          if (!validAreaName(area)) return errorBody(400, 'bad_query', 'area is not a name');
          params['area'] = area;
        }
        return passOn('next', params);
      }
      case 'about': {
        const refused = noQuery(query);
        if (refused) return refused;
        const r = await engine('hello');
        const engineDoc = r instanceof Response ? null : (JSON.parse(r.text) as { engine?: unknown }).engine ?? null;
        return respond(
          200,
          JSON.stringify({
            app: 'tasks-desktop',
            version: deps.version,
            build: deps.build,
            os: 'web',
            arch: 'wasm',
            mode: 'web',
            engine: engineDoc,
            engine_problem: r instanceof Response ? 'engine_failed' : null,
            pinned: deps.pinned,
          }),
        );
      }
      case 'areas': {
        const refused = noQuery(query);
        if (refused) return refused;
        const r = await engine('areas');
        if (r instanceof Response) return r;
        let doc: { areas?: Array<Record<string, unknown>> };
        try {
          doc = JSON.parse(r.text);
        } catch {
          return errorBody(502, 'engine_failed', 'the engine could not answer');
        }
        const out: Array<Record<string, unknown>> = [];
        const unclassified: string[] = [];
        const priv: string[] = [];
        for (const area of doc.areas ?? []) {
          const name = area['name'];
          if (typeof name !== 'string') continue;
          const shown = classes(name);
          if (shown === 'unclassified') unclassified.push(name);
          else if (shown === 'private') priv.push(name);
          out.push({ ...area, data_class: shown });
        }
        return respond(200, JSON.stringify({ schema: 1, kind: 'hub.areas', areas: out, unclassified, private: priv }));
      }
      case 'done_preview': {
        const q = parseQuery(query, ['id']);
        if (typeof q === 'string') return errorBody(400, 'bad_query', q);
        const id = idRequired(q);
        return typeof id === 'string' ? passOn('done_preview', { id }) : id;
      }
      case 'finished': {
        const q = parseQuery(query, ['area', 'plan', 'since', 'until', 'limit', 'offset']);
        if (typeof q === 'string') return errorBody(400, 'bad_query', q);
        const params: Record<string, unknown> = {};
        for (const key of ['area', 'plan', 'since', 'until']) {
          const v = q.get(key);
          if (v !== undefined) params[key] = v;
        }
        for (const key of ['limit', 'offset']) {
          const v = q.get(key);
          if (v === undefined) continue;
          if (!/^[0-9]+$/.test(v) || Number(v) > 0xffffffff) {
            return errorBody(400, 'bad_query', 'limit and offset are whole numbers');
          }
          params[key] = Number(v);
        }
        return passOn('finished', params);
      }
      case 'links':
      case 'groupings':
      case 'views':
      case 'lists': {
        const refused = noQuery(query);
        return refused ?? passOn(name);
      }
      case 'enums': {
        const refused = noQuery(query);
        if (refused) return refused;
        const r = await engine('hello');
        if (r instanceof Response) return r;
        const enums = (JSON.parse(r.text) as { enums?: unknown }).enums;
        if (typeof enums !== 'object' || enums === null || Array.isArray(enums)) {
          return errorBody(502, 'engine_failed', 'the engine named no ranges of fields');
        }
        return respond(200, JSON.stringify({ kind: 'hub.enums', enums }));
      }
      case 'order': {
        const q = parseQuery(query, ['sort', 'area']);
        if (typeof q === 'string') return errorBody(400, 'bad_query', q);
        const params: Record<string, unknown> = {};
        const sort = q.get('sort');
        if (sort !== undefined) {
          if (!SORTS.includes(sort)) {
            return errorBody(400, 'bad_sort', 'sort must be default, prio-effort, severity, frecency or roi');
          }
          params['sort'] = sort;
        }
        const area = q.get('area');
        if (area !== undefined) {
          if (!validAreaName(area)) return errorBody(400, 'bad_query', 'area is not a name');
          params['area'] = area;
        }
        return passOn('order', params);
      }
      case 'plan_for': {
        const q = parseQuery(query, ['id', 'direction']);
        if (typeof q === 'string') return errorBody(400, 'bad_query', q);
        const id = idRequired(q);
        if (typeof id !== 'string') return id;
        const direction = q.get('direction') ?? 'needs';
        if (direction !== 'needs' && direction !== 'unlocks') {
          return errorBody(400, 'bad_direction', 'direction must be needs or unlocks');
        }
        return passOn('plan_for', { id, direction });
      }
      case 'check': {
        const refused = noQuery(query);
        return refused ?? respond(200, JSON.stringify(check));
      }
      case 'search': {
        return search(query);
      }
      case 'events': {
        const refused = noQuery(query);
        return refused ?? events(signal);
      }
      default:
        return errorBody(404, 'not_found', 'no such route');
    }
  }

  /**
   * The words of the query must all be in the id or the title of a task (case-insensitive). The texts of the tasks
   * are not read, so the answer says `partial`: a task whose words are only in its text is not found.
   */
  async function search(query: string): Promise<Response> {
    const q = parseSearch(query);
    if (typeof q === 'string') return errorBody(400, 'bad_query', q);
    const r = await engine('snapshot');
    if (r instanceof Response) return r;
    const tasks = (JSON.parse(r.text) as { tasks?: Array<{ id?: unknown; title?: unknown }> }).tasks ?? [];
    const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: Array<{ id: string; score: number; snippet: unknown }> = [];
    for (const t of tasks) {
      if (typeof t.id !== 'string' || typeof t.title !== 'string') continue;
      const hay = t.title.toLowerCase();
      const hayId = t.id.toLowerCase();
      if (!words.every((w) => hay.includes(w) || hayId.includes(w))) continue;
      const marks: Array<[number, number]> = [];
      for (const w of words) {
        const at = hay.indexOf(w);
        if (at >= 0) marks.push([at, at + w.length]);
      }
      hits.push({
        id: t.id,
        score: words.length,
        snippet: { text: t.title, marks, more_before: false, more_after: false },
      });
    }
    return respond(
      200,
      JSON.stringify({
        schema: 1,
        kind: 'hub.search',
        status: 'ready',
        indexed: tasks.length,
        partial: true,
        total: hits.length,
        hits: hits.slice(0, q.limit),
      }),
    );
  }

  async function post(name: string, body: string): Promise<Response> {
    switch (name) {
      case 'estimate': {
        const request = checkEstimateRequest(body);
        if (typeof request === 'string') return errorBody(400, 'bad_request', request);
        return passOn('estimate', request);
      }
      case 'check': {
        let map: Record<string, unknown>;
        try {
          const parsed: unknown = body === '' ? {} : JSON.parse(body);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
          map = parsed as Record<string, unknown>;
        } catch {
          return errorBody(400, 'bad_request', 'the body is not a JSON object');
        }
        const unknown = Object.keys(map).find((k) => k !== 'stale' && k !== 'area');
        if (unknown !== undefined) return errorBody(400, 'bad_request', `unknown field ${unknown.slice(0, 40)} in the request`);
        const params: Record<string, unknown> = {};
        if ('stale' in map) {
          if (map['stale'] !== 'refs') return errorBody(400, 'bad_request', 'stale must be refs');
          params['stale'] = 'refs';
        }
        if ('area' in map) {
          if (typeof map['area'] !== 'string' || !validAreaName(map['area'])) {
            return errorBody(400, 'bad_request', 'area must be the name of an area');
          }
          params['area'] = map['area'];
        }
        const id = ++checkId;
        const r = await engine('check', Object.keys(params).length ? params : undefined);
        if (r instanceof Response) {
          const doc = (await r.json()) as { error: { code: string; message: string } };
          check = { state: 'failed', id, error: { code: doc.error.code, message: doc.error.message } };
        } else {
          check = { state: 'done', id, result: JSON.parse(r.text) };
        }
        return respond(200, JSON.stringify(check));
      }
      case 'rescan': {
        await deps.rescan?.();
        return respond(200, '{}');
      }
      case 'ops':
        return errorBody(405, 'read_only', 'the web variant reads only for now: change tasks in Neovim or the app');
      default:
        return errorBody(404, 'not_available', 'this route does not exist in the web variant');
    }
  }

  const web: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(href, 'http://web.invalid');
    // The page trades a pairing code for a session before it asks for anything. There is no server to pair with and
    // nothing to protect from another page here, so any code is traded for the one session of this page.
    if (url.pathname === '/auth/exchange') {
      return method === 'POST' ? respond(200, JSON.stringify({ token: SESSION })) : errorBody(405, 'method_not_allowed', 'POST');
    }
    if (!url.pathname.startsWith(NS)) return errorBody(404, 'not_found', 'no such route');
    const name = url.pathname.slice(NS.length);
    const query = url.search.startsWith('?') ? url.search.slice(1) : '';
    const headers = new Headers(init?.headers);
    if (method === 'GET') return get(name, query, headers, init?.signal);
    if (method === 'POST') {
      const body = typeof init?.body === 'string' ? init.body : '';
      return post(name, body);
    }
    return errorBody(405, 'method_not_allowed', 'GET or POST');
  };
  const tell = (message: string): void => {
    for (const controller of [...streams]) {
      try {
        controller.enqueue(text.encode(message));
      } catch {
        streams.delete(controller);
      }
    }
  };
  return {
    fetch: web,
    notify: () => tell('event: resync\ndata: {}\n\n'),
    close: () => {
      for (const controller of [...streams]) {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      streams.clear();
    },
  };
}

function parseSearch(query: string): { text: string; limit: number } | string {
  let text: string | null = null;
  let limit = 20;
  if (query !== '') {
    for (const pair of query.split('&')) {
      const cut = pair.indexOf('=');
      if (cut < 0) return 'a query part has no value';
      const key = pair.slice(0, cut);
      let value: string;
      try {
        value = decodeURIComponent(pair.slice(cut + 1).replace(/\+/g, ' '));
      } catch {
        return 'the query is not valid text';
      }
      if (key === 'q') text = value;
      else if (key === 'limit') {
        if (!/^[0-9]{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 50) return 'limit is 1 to 50';
        limit = Number(value);
      } else return 'unknown query parameter';
    }
  }
  if (text === null || text.trim() === '' || text.length > 200) return 'q is the text to find (1 to 200 characters)';
  return { text, limit };
}

/** The form and size of a question of `estimate`, before the engine is asked (`check_estimate_request`). */
export function checkEstimateRequest(body: string): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return 'the body is not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'the request must be a JSON object';
  const map = value as Record<string, unknown>;
  const bad = Object.keys(map).find((k) => k !== 'ids' && k !== 'assume');
  if (bad !== undefined) return `unknown field ${bad.slice(0, 40)} in the request`;
  if ('ids' in map) {
    const ids = map['ids'];
    if (!Array.isArray(ids)) return 'ids must be a list';
    if (ids.length > ESTIMATE_MAX) return `ids holds at most ${ESTIMATE_MAX} ids`;
    if (!ids.every((id) => validTaskId(id))) return 'every id must be <area>/<slug>';
  }
  if ('assume' in map) {
    const list = map['assume'];
    if (!Array.isArray(list)) return 'assume must be a list';
    if (list.length > ESTIMATE_MAX) return `assume holds at most ${ESTIMATE_MAX} entries`;
    for (let i = 0; i < list.length; i++) {
      const at = i + 1;
      const entry: unknown = list[i];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return `assume[${at}] must be an object`;
      const e = entry as Record<string, unknown>;
      const key = Object.keys(e).find((k) => k !== 'id' && k !== 'effort' && k !== 'value');
      if (key !== undefined) return `assume[${at}]: unknown field ${key.slice(0, 40)}`;
      if (!validTaskId(e['id'])) return `assume[${at}].id must be <area>/<slug>`;
      if ('effort' in e) {
        const eff = e['effort'];
        if (typeof eff !== 'string' || eff === '' || eff.length > 12 || !/^[\x00-\x7f]*$/.test(eff)) {
          return `assume[${at}].effort must be a short word`;
        }
      }
      if ('value' in e && !Number.isSafeInteger(e['value'])) return `assume[${at}].value must be a whole number`;
    }
  }
  return map;
}
