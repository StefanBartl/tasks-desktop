// The browser hub: the routes of the Rust hub answered over a stand-in for the engine. What the routes check before
// they ask, how a refusal of the engine is told, the tag of a snapshot, and the envelopes the hub adds itself.
//
//   node --experimental-strip-types --test web/hub.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEstimateRequest, createWebHub, parseQuery, validAreaName, validTaskId } from '../src/web/hub.ts';

/** A hub over a fake engine: `docs[method]` is the text it answers, `fail[method]` a refusal; every call is kept. */
function hub(docs = {}, fail = {}, extra = {}) {
  const calls = [];
  const api = createWebHub({
    version: '9.9.9',
    build: 'abc',
    pinned: { engine: 'e1', lib: 'l1' },
    ...extra,
    async call(method, request) {
      calls.push([method, request === null ? null : JSON.parse(request)]);
      if (fail[method]) return { text: JSON.stringify(fail[method]), code: fail[method].code };
      return { text: docs[method] ?? '{}', code: null };
    },
  });
  const get = (path, headers) => api.fetch(`/api/tasks/${path}`, { headers });
  const post = (path, body) => api.fetch(`/api/tasks/${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { api, calls, get, post };
}

const error = async (response) => (await response.json()).error;

test('what an id, an area and a query may be', () => {
  for (const ok of ['lib.nvim/alpha', 'a/b-c_d.e']) assert.equal(validTaskId(ok), true, ok);
  for (const bad of ['alpha', 'a/', '/b', 'a/.b', 'a/b/c', 'a/b c', 'a b/c', `a/${'x'.repeat(129)}`, 3, null, 'a//b']) {
    assert.equal(validTaskId(bad), false, String(bad));
  }
  for (const bad of ['', '.x', 'x.', 'x ', 'a/b', 'a,b', 'a:b', 'a\u0001', 'x'.repeat(129)]) assert.equal(validAreaName(bad), false, JSON.stringify(bad));
  assert.equal(validAreaName('lib.nvim'), true);

  assert.deepEqual([...parseQuery('', ['id'])], []);
  assert.deepEqual([...parseQuery('id=a/b&n=3', ['id', 'n'])], [['id', 'a/b'], ['n', '3']]);
  assert.equal(parseQuery('x=1', ['id']), 'unknown query parameter');
  assert.equal(parseQuery('id', ['id']), 'a query part has no value');
  assert.equal(parseQuery('id=a%2Fb', ['id']), 'a query value is not plain text');
  assert.equal(parseQuery('id=', ['id']), 'a query value is not plain text');
  assert.equal(parseQuery('id=a&id=b', ['id']), 'a query parameter is given twice');
});

test('a request the Rust hub refuses never reaches the engine', async () => {
  const h = hub();
  const cases = [
    ['task', 400, 'bad_id'],
    ['task?id=nope', 400, 'bad_id'],
    ['task?x=1', 400, 'bad_query'],
    ['task?id=a/b&id=a/c', 400, 'bad_query'],
    ['next?n=11', 400, 'bad_query'],
    ['next?n=x', 400, 'bad_query'],
    ['next?area=.hidden', 400, 'bad_query'],
    ['order?sort=random', 400, 'bad_sort'],
    ['plan_for?id=a/b&direction=sideways', 400, 'bad_direction'],
    ['done_preview', 400, 'bad_id'],
    ['finished?limit=-1', 400, 'bad_query'],
    ['finished?offset=x', 400, 'bad_query'],
    ['links?x=1', 400, 'bad_query'],
    ['areas?x=1', 400, 'bad_query'],
    ['snapshot?x=1', 400, 'bad_query'],
    ['nothing', 404, 'not_found'],
  ];
  for (const [path, status, code] of cases) {
    const r = await h.get(path);
    assert.equal(r.status, status, path);
    assert.equal((await error(r)).code, code, path);
  }
  assert.deepEqual(h.calls, [], 'no question reached the engine');
});

test('a valid read passes its parameters to the engine and the document back unchanged', async () => {
  const doc = '{"kind":"tasks.task","x":1}';
  const h = hub({ task: doc, next: '{"n":1}', order: '{"o":1}', plan_for: '{"p":1}', finished: '{"f":1}', done_preview: '{"d":1}' });
  const r = await h.get('task?id=lib.nvim/alpha');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(await r.text(), doc, 'the bytes of the engine, not a re-encoding');
  await h.get('next?n=3&actor=cdx&area=lib.nvim');
  await h.get('order?sort=roi&area=lib.nvim');
  await h.get('plan_for?id=a/b');
  await h.get('finished?area=a&plan=a/p&since=2026-01-01&until=2026-02-01&limit=5&offset=10');
  await h.get('done_preview?id=a/b');
  assert.deepEqual(h.calls, [
    ['task', { params: { id: 'lib.nvim/alpha' } }],
    ['next', { params: { n: 3, actor: 'cdx', area: 'lib.nvim' } }],
    ['order', { params: { sort: 'roi', area: 'lib.nvim' } }],
    ['plan_for', { params: { id: 'a/b', direction: 'needs' } }],
    ['finished', { params: { area: 'a', plan: 'a/p', since: '2026-01-01', until: '2026-02-01', limit: 5, offset: 10 } }],
    ['done_preview', { params: { id: 'a/b' } }],
  ]);
});

test('the reads without parameters ask the engine for the method of their name', async () => {
  const h = hub({ links: '{"l":1}', groupings: '{"g":1}', views: '{"v":1}', lists: '{"s":1}' });
  for (const name of ['links', 'groupings', 'views', 'lists']) {
    const r = await h.get(name);
    assert.equal(r.status, 200, name);
  }
  assert.deepEqual(h.calls.map((c) => c[0]), ['links', 'groupings', 'views', 'lists']);
});

test('a refusal of the engine keeps its code and gets the status the Rust hub gives it', async () => {
  for (const [code, status] of [['invalid_argument', 400], ['unsupported_schema', 400], ['not_found', 404], ['conflict', 409], ['exists', 409], ['forbidden', 403], ['locked', 503], ['internal', 502]]) {
    const h = hub({}, { task: { kind: 'tasks.error', code, message: 'no\u0001 way', retryable: true } });
    const r = await h.get('task?id=a/b');
    assert.equal(r.status, status, code);
    assert.deepEqual(await error(r), { code, message: 'no way', retryable: true }, code);
  }
  const odd = hub({}, { task: { code: 'Not A Code', message: 'x'.repeat(600) } });
  const e = await error(await odd.get('task?id=a/b'));
  assert.equal(e.code, 'engine_failed', 'a code that is not a lowercase word is not passed on');
  assert.equal(e.message.length, 512, 'a message is one short line');
});

test('an engine that throws is a failed engine, not an exception of the page', async () => {
  const api = createWebHub({ version: '1', build: null, pinned: { engine: null, lib: null }, call: async () => { throw new Error('boom'); } });
  const r = await api.fetch('/api/tasks/links');
  assert.equal(r.status, 502);
  assert.deepEqual(await error(r), { code: 'engine_failed', message: 'the engine could not answer' });
});

test('the snapshot carries its digest as the tag, and a held one answers 304', async () => {
  const h = hub({ snapshot: '{"digest":"sha256:abc123","tasks":[]}' });
  const first = await h.get('snapshot');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('etag'), '"sha256:abc123"');
  for (const seen of ['"sha256:abc123"', 'W/"sha256:abc123"', '"other", "sha256:abc123"', '*']) {
    const again = await h.get('snapshot', { 'If-None-Match': seen });
    assert.equal(again.status, 304, seen);
  }
  assert.equal((await h.get('snapshot', { 'If-None-Match': '"stale"' })).status, 200);
  const odd = hub({ snapshot: '{"digest":"has spaces!"}' });
  assert.equal((await odd.get('snapshot')).headers.get('etag'), null, 'a digest that is not plain is no tag');
});

test('hello needs no session and says whether the engine answers', async () => {
  const ok = hub({ hello: '{"capabilities":["list"],"enums":{}}' });
  const doc = await (await ok.get('hello')).json();
  assert.deepEqual(doc, { instance: 'web', version: '9.9.9', engine: { ready: true, problem: null, capabilities: ['list'] } });
  const down = hub({}, { hello: { code: 'internal', message: 'x' } });
  assert.deepEqual((await (await down.get('hello')).json()).engine, { ready: false, problem: 'engine_failed', capabilities: null });
});

test('about names the web mode and the pins, and nothing of the machine', async () => {
  const h = hub({ hello: '{"engine":{"version":"0.1.0-dev","git":"abc","nvim":"web+Lua5.4"}}' });
  const doc = await (await h.get('about')).json();
  assert.deepEqual(doc, {
    app: 'tasks-desktop',
    version: '9.9.9',
    build: 'abc',
    os: 'web',
    arch: 'wasm',
    mode: 'web',
    engine: { version: '0.1.0-dev', git: 'abc', nvim: 'web+Lua5.4' },
    engine_problem: null,
    pinned: { engine: 'e1', lib: 'l1' },
  });
});

test('enums are the ranges of the engine hello, or a failure when it names none', async () => {
  const h = hub({ hello: '{"enums":{"status":["open","done"]}}' });
  assert.deepEqual(await (await h.get('enums')).json(), { kind: 'hub.enums', enums: { status: ['open', 'done'] } });
  const none = hub({ hello: '{}' });
  const r = await none.get('enums');
  assert.equal(r.status, 502);
  assert.equal((await error(r)).code, 'engine_failed');
});

test('areas get the class they are shown with, and an area nobody classified is listed as such', async () => {
  const docs = { areas: '{"areas":[{"name":"pub","open":1},{"name":"sec","open":2},{"name":"new"},{"x":1}]}' };
  const h = hub(docs, {}, { classes: (a) => ({ pub: 'public', sec: 'private' })[a] ?? 'unclassified' });
  const doc = await (await h.get('areas')).json();
  assert.deepEqual(doc, {
    schema: 1,
    kind: 'hub.areas',
    areas: [
      { name: 'pub', open: 1, data_class: 'public' },
      { name: 'sec', open: 2, data_class: 'private' },
      { name: 'new', data_class: 'unclassified' },
    ],
    unclassified: ['new'],
    private: ['sec'],
  });
  const closed = hub(docs);
  assert.deepEqual((await (await closed.get('areas')).json()).unclassified, ['pub', 'sec', 'new'], 'without a class file nothing is open');
});

test('estimate: the form is checked like the Rust hub does, the values are the engine\'s', async () => {
  assert.equal(checkEstimateRequest('nope'), 'the body is not JSON');
  assert.equal(checkEstimateRequest('[]'), 'the request must be a JSON object');
  assert.match(checkEstimateRequest('{"x":1}'), /unknown field x/);
  assert.equal(checkEstimateRequest('{"ids":"a/b"}'), 'ids must be a list');
  assert.equal(checkEstimateRequest('{"ids":["a/b","nope"]}'), 'every id must be <area>/<slug>');
  assert.equal(checkEstimateRequest(JSON.stringify({ ids: Array(1001).fill('a/b') })), 'ids holds at most 1000 ids');
  assert.equal(checkEstimateRequest('{"assume":[3]}'), 'assume[1] must be an object');
  assert.match(checkEstimateRequest('{"assume":[{"id":"a/b","q":1}]}'), /unknown field q/);
  assert.equal(checkEstimateRequest('{"assume":[{"id":"x"}]}'), 'assume[1].id must be <area>/<slug>');
  assert.equal(checkEstimateRequest('{"assume":[{"id":"a/b","effort":""}]}'), 'assume[1].effort must be a short word');
  assert.equal(checkEstimateRequest('{"assume":[{"id":"a/b","effort":"ä"}]}'), 'assume[1].effort must be a short word');
  assert.equal(checkEstimateRequest('{"assume":[{"id":"a/b","value":1.5}]}'), 'assume[1].value must be a whole number');
  assert.deepEqual(checkEstimateRequest('{"ids":["a/b"],"assume":[{"id":"a/b","effort":"M","value":3}]}'), {
    ids: ['a/b'],
    assume: [{ id: 'a/b', effort: 'M', value: 3 }],
  });

  const h = hub({ estimate: '{"e":1}' });
  assert.equal((await h.post('estimate', '{"ids":["a/b"]}')).status, 200);
  assert.deepEqual(h.calls, [['estimate', { params: { ids: ['a/b'] } }]]);
  assert.equal((await h.post('estimate', '{"ids":["x"]}')).status, 400);
  assert.equal(h.calls.length, 1, 'the refused one was not asked');
});

test('the check job: idle, then done with the engine document, or failed in words', async () => {
  const h = hub({ check: '{"kind":"tasks.check","findings":[]}' });
  assert.deepEqual(await (await h.get('check')).json(), { state: 'idle' });
  const started = await (await h.post('check', '{"stale":"refs","area":"lib.nvim"}')).json();
  assert.deepEqual(started, { state: 'done', id: 1, result: { kind: 'tasks.check', findings: [] } });
  assert.deepEqual(await (await h.get('check')).json(), started, 'the state is kept');
  assert.deepEqual(h.calls, [['check', { params: { stale: 'refs', area: 'lib.nvim' } }]]);
  for (const bad of ['{"stale":"all"}', '{"area":".x"}', '{"other":1}', '[]', 'nope']) {
    assert.equal((await h.post('check', bad)).status, 400, bad);
  }
  const broken = hub({}, { check: { code: 'internal', message: 'it broke' } });
  const failed = await (await broken.post('check', '')).json();
  assert.deepEqual(failed, { state: 'failed', id: 1, error: { code: 'internal', message: 'it broke' } });
});

test('what writes or opens something is not answered: a clear refusal, never a silent success', async () => {
  const h = hub();
  const ops = await h.post('ops', { ops: [] });
  assert.equal(ops.status, 405);
  assert.equal((await error(ops)).code, 'read_only');
  for (const name of ['open', 'vault_reveal', 'vault_pick', 'vault_create']) {
    const r = await h.post(name, {});
    assert.equal(r.status, 404, name);
    assert.equal((await error(r)).code, 'not_available', name);
  }
  assert.equal((await h.api.fetch('/api/tasks/snapshot', { method: 'DELETE' })).status, 405);
  assert.deepEqual(h.calls, []);
});

test('rescan asks the page to read the folder again', async () => {
  let n = 0;
  const h = hub({}, {}, { rescan: async () => void n++ });
  assert.equal((await h.post('rescan', '{}')).status, 200);
  assert.equal(n, 1);
});

test('search finds the words in id or title, says it is partial, and checks its query', async () => {
  const snapshot = JSON.stringify({ tasks: [{ id: 'a/alpha', title: 'Fix the Parser' }, { id: 'a/beta', title: 'Docs' }, { id: 'b/gamma', title: 'parser docs' }] });
  const h = hub({ snapshot });
  const doc = await (await h.get('search?q=parser')).json();
  assert.equal(doc.kind, 'hub.search');
  assert.equal(doc.partial, true, 'the texts are not searched');
  assert.deepEqual(doc.hits.map((x) => x.id), ['a/alpha', 'b/gamma']);
  assert.deepEqual(doc.hits[0].snippet.marks, [[8, 14]]);
  assert.equal((await (await h.get('search?q=parser+docs')).json()).total, 1);
  assert.equal((await h.get('search')).status, 400);
  assert.equal((await h.get('search?q=x&limit=99')).status, 400);
  assert.equal((await h.get('search?q=x&z=1')).status, 400);
});

/** Read what a stream has now, up to `n` messages (a stream that has nothing more would wait). */
async function readMessages(reader, n) {
  const decoder = new TextDecoder();
  let buffer = '';
  const out = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
      out.push(buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
    }
  }
  return out;
}

test('the event stream says hello, then tells every page that it should read again', async () => {
  const h = hub();
  const first = await h.get('events');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'text/event-stream');
  const second = await h.get('events');
  const a = first.body.getReader();
  const b = second.body.getReader();
  assert.deepEqual(await readMessages(a, 1), ['event: hello\ndata: {}']);
  assert.deepEqual(await readMessages(b, 1), ['event: hello\ndata: {}']);
  h.api.notify();
  assert.deepEqual(await readMessages(a, 1), ['event: resync\ndata: {}']);
  assert.deepEqual(await readMessages(b, 1), ['event: resync\ndata: {}']);
  assert.equal((await h.get('events?x=1')).status, 400, 'the route takes no query');
});

test('a stream that was cancelled or aborted hears nothing more, and close ends the rest', async () => {
  const h = hub();
  const cancelled = (await h.get('events')).body.getReader();
  await readMessages(cancelled, 1);
  await cancelled.cancel();

  const controller = new AbortController();
  const aborted = (await h.api.fetch('/api/tasks/events', { signal: controller.signal })).body.getReader();
  await readMessages(aborted, 1);
  controller.abort();
  await assert.rejects(aborted.read(), (e) => e.name === 'AbortError');

  const open = (await h.get('events')).body.getReader();
  await readMessages(open, 1);
  h.api.notify();
  h.api.close();
  assert.deepEqual(await readMessages(open, 2), ['event: resync\ndata: {}'], 'the message before the end still arrives');
  assert.equal((await open.read()).done, true);
  h.api.notify(); // nothing is listening: no error
});

test('the page trades any code for its one session, so the app starts without a server to pair with', async () => {
  const h = hub();
  const r = await h.api.fetch('/auth/exchange', { method: 'POST', body: '{"code":"web"}' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { token: 'web-session' });
  assert.equal((await h.api.fetch('/auth/exchange')).status, 405);
  assert.equal((await h.api.fetch('/auth/other', { method: 'POST' })).status, 404);
  assert.deepEqual(h.calls, []);
});
