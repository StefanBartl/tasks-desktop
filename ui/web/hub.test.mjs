// The browser hub: the routes of the Rust hub answered over a stand-in for the engine. What the routes check before
// they ask, how a refusal of the engine is told, the tag of a snapshot, and the envelopes the hub adds itself.
//
//   node --experimental-strip-types --test web/hub.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEstimateRequest, createWebHub, parseQuery, validAreaName, validTaskId } from '../src/web/hub.ts';
import { readCorpus } from '../src/web/search.ts';

/**
 * A hub over a fake engine: `docs[method]` is the text it answers (or a function that gives it, at once or later),
 * `fail[method]` a refusal; every call is kept.
 */
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
      const doc = docs[method];
      return { text: typeof doc === 'function' ? await doc(request === null ? null : JSON.parse(request)) : doc ?? '{}', code: null };
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

/**
 * The engine's `bodies` over `texts()` (id -> body): `size` tasks a page, each page of the state `rev(n)` (n counts
 * the pages asked for). `asked` keeps the offsets.
 */
function bodies(texts, { size = 1000, rev = () => 'r1' } = {}) {
  const asked = [];
  const answer = (request) => {
    const offset = request?.params?.offset ?? 0;
    asked.push(offset);
    const items = Object.entries(texts()).map(([id, body]) => ({ id, etag: 'e', body, body_truncated: false }));
    const doc = { kind: 'tasks.bodies', rev: rev(asked.length), items: items.slice(offset, offset + size) };
    if (offset + size < items.length) doc.next_offset = offset + size;
    return JSON.stringify(doc);
  };
  answer.asked = asked;
  return answer;
}

/** The pieces of a snippet's text its marks point at (a script indexes by UTF-16 units, as `slice` does). */
const marked = (hit) => hit.snippet.marks.map(([a, b]) => hit.snippet.text.slice(a, b));
const find = async (h, q, rest = '') => (await h.get(`search?q=${encodeURIComponent(q)}${rest}`)).json();

test('search finds a word that is only in the text of a task, and marks it in its piece of the text', async () => {
  const h = hub({ bodies: bodies(() => ({ 'a/alpha': 'The parser keeps a cache of tokens.', 'a/beta': 'Nothing here.' })) });
  const doc = await find(h, 'cache');
  assert.equal(doc.kind, 'hub.search');
  assert.equal(doc.status, 'ready');
  assert.equal(doc.partial, false, 'every text was searched');
  assert.equal(doc.indexed, 2);
  assert.equal(doc.total, 1);
  assert.deepEqual(doc.hits, [
    {
      id: 'a/alpha',
      score: 1,
      snippet: { text: 'The parser keeps a cache of tokens.', marks: [[19, 24]], more_before: false, more_after: false },
    },
  ]);
  assert.deepEqual(h.calls.map((c) => c[0]), ['bodies'], 'the texts come from the engine, not from the titles');
  assert.equal((await find(h, 'missing')).total, 0);
});

test('case is no difference, one character folds to one, and the marks count in UTF-16 units', async () => {
  const h = hub({
    bodies: bodies(() => ({ 'a/x': 'Ärger mit ÖL und STRASSE', 'a/y': '😀😀 Needle here', 'a/z': 'İstanbul and İzmir' })),
  });
  assert.deepEqual(marked((await find(h, 'öl strasse')).hits[0]), ['ÖL', 'STRASSE']);
  const needle = (await find(h, 'NEEDLE')).hits[0];
  assert.deepEqual(needle.snippet.marks, [[5, 11]], 'each emoji is two units');
  // `İ` lowercases to two characters; folded one for one, the positions after it are still the text's.
  assert.deepEqual(marked((await find(h, 'izmir')).hits[0]), ['İzmir']);
  assert.deepEqual(marked((await find(h, 'ISTANBUL')).hits[0]), ['İstanbul']);
});

test('every word must be there, the words together rank first, and limit cuts the hits but not the total', async () => {
  const h = hub({
    bodies: bodies(() => ({ 'a/one': 'the quick brown fox', 'a/two': 'brown dogs, quick cats', 'a/three': 'only quick' })),
  });
  const both = await find(h, 'quick brown');
  assert.equal(both.total, 2);
  assert.deepEqual(both.hits.map((x) => [x.id, x.score]), [['a/one', 12], ['a/two', 2]]);
  assert.deepEqual(marked(both.hits[0]), ['quick', 'brown'], 'each word is marked, not the space between');
  const cut = await find(h, 'quick', '&limit=2');
  assert.equal(cut.total, 3);
  assert.deepEqual(cut.hits.map((x) => x.id), ['a/one', 'a/two'], 'among equals the order of the engine');
});

test('a piece of a long text is a window around the first match, says there is more, and shows no control character', async () => {
  const long = `${'a'.repeat(300)} NEEDLE ${'b'.repeat(300)}`;
  const h = hub({ bodies: bodies(() => ({ 'a/long': long, 'a/ctl': 'line one\nneedle\u001b[31m two\r\n' })) });
  const doc = await find(h, 'needle');
  const [far, ctl] = doc.hits.sort((x, y) => x.id.localeCompare(y.id)).reverse();
  assert.equal(far.id, 'a/long');
  assert.equal(far.snippet.more_before, true);
  assert.equal(far.snippet.more_after, true);
  assert.equal(far.snippet.text, `${'a'.repeat(59)} NEEDLE ${'b'.repeat(99)}`);
  assert.deepEqual(marked(far), ['NEEDLE']);
  assert.doesNotMatch(ctl.snippet.text, /\p{Cc}/u);
  assert.deepEqual(marked(ctl), ['needle']);
});

test('the query of a search is checked as the Rust hub checks it, before any text is read', async () => {
  const h = hub({ bodies: bodies(() => ({ 'a/x': 'größe task' })) });
  const bad = [
    'search',
    'search?q',
    'search?limit=5',
    'search?q=ab&q=cd',
    'search?q=%ZZ',
    'search?q=%E4',
    'search?q=a+b',
    'search?q=a;b',
    'search?q=ab&x=1',
    'search?q=ab&limit=0',
    'search?q=ab&limit=51',
    'search?q=a',
    'search?q=ab%0Acd',
    `search?q=${Array.from({ length: 9 }, (_, i) => `w${i}`).join('%20')}`,
    `search?q=${'x'.repeat(201)}`,
  ];
  for (const path of bad) {
    const r = await h.get(path);
    assert.equal(r.status, 400, path);
    assert.equal((await error(r)).code, 'bad_query', path);
  }
  assert.deepEqual(h.calls, [], 'no text was read for a query that is none');
  const ok = await (await h.get('search?q=gr%C3%B6%C3%9Fe%20task&limit=50')).json();
  assert.deepEqual(ok.hits.map((x) => x.id), ['a/x']);
});

test('the texts are read page by page once, and read again after the vault was read again', async () => {
  let texts = { 'a/one': 'first text', 'a/two': 'second text', 'a/three': 'third text' };
  const pages = bodies(() => texts, { size: 2 });
  const h = hub({ bodies: pages });
  assert.equal((await find(h, 'text')).total, 3);
  assert.deepEqual(pages.asked, [0, 2], 'two pages of two');
  assert.equal((await find(h, 'third')).total, 1);
  assert.deepEqual(pages.asked, [0, 2], 'the texts are kept between searches');
  texts = { ...texts, 'a/two': 'a changed body' };
  h.api.notify();
  const changed = await find(h, 'changed');
  assert.deepEqual(changed.hits.map((x) => x.id), ['a/two'], 'the new text is searched');
  assert.equal((await find(h, 'second')).total, 0, 'the old text is gone');
  assert.deepEqual(pages.asked, [0, 2, 0, 2]);
});

test('a vault that changes while its pages are read is read again from the start', async () => {
  const pages = bodies(() => ({ 'a/one': 'alpha', 'a/two': 'alpha', 'a/three': 'alpha' }), {
    size: 2,
    rev: (n) => (n === 1 ? 'r1' : 'r2'),
  });
  const h = hub({ bodies: pages });
  const doc = await find(h, 'alpha');
  assert.equal(doc.total, 3);
  assert.deepEqual(pages.asked, [0, 2, 0, 2], 'the second page was of another state: the reading started again');
});

test('texts the engine does not hand over are a failed search, and the next search asks again', async () => {
  let fails = 1;
  const good = bodies(() => ({ 'a/one': 'alpha' }));
  const h = hub({
    bodies: (request) => {
      if (fails-- > 0) throw new Error('the worker is gone');
      return good(request);
    },
  });
  const failed = await h.get('search?q=alpha');
  assert.equal(failed.status, 200);
  assert.deepEqual(await failed.json(), { schema: 1, kind: 'hub.search', status: 'failed', indexed: 0, partial: false, total: 0, hits: [] });
  assert.equal((await find(h, 'alpha')).total, 1);
});

test('texts beyond the limit are not searched, and only then the answer says partial', async () => {
  const page = async () => JSON.stringify({ rev: 'r', items: [{ id: 'a/one', body: 'ööö' }, { id: 'a/two', body: 'more' }] });
  // Bytes are counted as Rust counts them, in UTF-8: `ööö` is six.
  assert.deepEqual(
    (await readCorpus(page, 6)).entries.map((e) => e.id),
    ['a/one'],
  );
  assert.equal((await readCorpus(page, 6)).partial, true);
  assert.equal((await readCorpus(page, 5)).entries.length, 0);
  assert.equal((await readCorpus(page, 10)).partial, false);
});

test('the hub says partial when the texts were beyond its limit, and searches only those it read', async () => {
  const texts = () => ({ 'a/one': 'needle ööö', 'a/two': 'needle more' });
  // 'needle ööö' is 13 bytes in UTF-8: the first text fits, the second is beyond the limit.
  const cut = hub({ bodies: bodies(texts) }, {}, { maxIndexBytes: 13 });
  const doc = await find(cut, 'needle');
  assert.equal(doc.status, 'ready');
  assert.equal(doc.partial, true, 'the page tells that some texts were left out');
  assert.equal(doc.indexed, 1);
  assert.deepEqual(doc.hits.map((x) => x.id), ['a/one']);
  const whole = await find(hub({ bodies: bodies(texts) }, {}, { maxIndexBytes: 1000 }), 'needle');
  assert.equal(whole.partial, false);
  assert.equal(whole.total, 2);
});

/** Wait until `ready()` is true, a turn of the event loop at a time. */
async function until(ready) {
  for (let n = 0; !ready(); n++) {
    if (n > 1000) throw new Error('it never came');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('a reading that fails after the vault was read again leaves the newer texts kept', async () => {
  let releaseOld = null;
  let first = true;
  const fresh = bodies(() => ({ 'a/one': 'newer text' }));
  const h = hub({
    bodies: async (request) => {
      if (first) {
        first = false;
        await new Promise((resolve) => (releaseOld = resolve));
        throw new Error('the old reading failed');
      }
      return fresh(request);
    },
  });
  const old = h.get('search?q=text');
  await until(() => releaseOld !== null);
  h.api.notify();
  assert.equal((await find(h, 'newer')).total, 1);
  assert.deepEqual(fresh.asked, [0]);
  releaseOld();
  assert.equal((await (await old).json()).status, 'failed', 'the search that asked the old reading hears that it failed');
  assert.equal((await find(h, 'newer')).total, 1);
  assert.deepEqual(fresh.asked, [0], 'the newer texts are still kept: they are not read again');
});

test('a reading that started before the vault was read again serves the searches of before, and is not kept after', async () => {
  let texts = { 'a/one': 'old words' };
  const pages = bodies(() => texts);
  let hold = true;
  let release = null;
  const h = hub({
    bodies: async (request) => {
      const answer = pages(request);
      if (hold) {
        hold = false;
        await new Promise((resolve) => (release = resolve));
      }
      return answer;
    },
  });
  const before = find(h, 'words');
  await until(() => release !== null);
  texts = { 'a/one': 'new words' };
  h.api.notify();
  release();
  assert.deepEqual((await before).hits.map((x) => x.snippet.text), ['old words']);
  assert.equal((await find(h, 'new')).total, 1, 'the texts are read again, not taken from the reading of before');
  assert.equal((await find(h, 'old')).total, 0);
  assert.deepEqual(pages.asked, [0, 0]);
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
