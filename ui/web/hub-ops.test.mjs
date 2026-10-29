// The write route of the browser hub (POST ops) over a stand-in for the write path: what is judged before anything is
// asked, how each way a write can end is told, and who hears of a change.
//
//   node --experimental-strip-types --test web/hub-ops.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test as base } from 'node:test';
import { checkOpsRequest, createWebHub } from '../src/web/hub.ts';

// An event that never comes must fail the test, not hang the run.
const test = (name, fn) => base(name, { timeout: 20_000 }, fn);

const RESULT = (changed = ['lib.nvim/alpha']) =>
  JSON.stringify({ kind: 'tasks.result', ok: true, dry_run: false, results: [{ n: 1, op: 'set', ok: true, changed_ids: changed }] });

const SET = { op: 'set', id: 'lib.nvim/alpha', patch: { prio: 2 } };

/**
 * A hub whose write path answers `outcome` (or a function of the request). Every request to the write path and every
 * call of the engine is kept.
 */
function writer(outcome, docs = {}) {
  const seen = [];
  const calls = [];
  const api = createWebHub({
    version: '9.9.9',
    build: 'abc',
    pinned: { engine: 'e1', lib: 'l1' },
    async call(method, request) {
      calls.push(method);
      const doc = docs[method];
      return { text: typeof doc === 'function' ? doc() : doc ?? '{}', code: null };
    },
    async ops(request) {
      seen.push(JSON.parse(request));
      return typeof outcome === 'function' ? outcome(request) : outcome;
    },
  });
  const post = (body) => api.fetch('/api/tasks/ops', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { api, seen, calls, post, get: (path) => api.fetch(`/api/tasks/${path}`) };
}

const error = async (response) => (await response.json()).error;

test('a request of ops is judged as the Rust hub judges it, before the engine or the folder is asked', async () => {
  const w = writer({ kind: 'done', text: RESULT() });
  const many = Array.from({ length: 101 }, () => SET);
  const cases = [
    ['nope', 'the body is not JSON'],
    ['[]', 'the request must be a JSON object'],
    ['3', 'the request must be a JSON object'],
    ['{"ops":[{"op":"set"}],"zeta":1,"alpha":2}', 'unknown field alpha in the request'],
    ['{"ops":[{"op":"set"}],"' + 'x'.repeat(60) + '":1}', 'unknown field ' + 'x'.repeat(40) + ' in the request'],
    ['{}', 'ops must be a list'],
    ['{"ops":"set"}', 'ops must be a list'],
    ['{"ops":[]}', 'ops holds 1 to 100 operations'],
    [JSON.stringify({ ops: many }), 'ops holds 1 to 100 operations'],
    ['{"ops":[{"id":"x/y"}]}', 'ops[1] has no op'],
    ['{"ops":[3]}', 'ops[1] has no op'],
    ['{"ops":[{"op":7}]}', 'ops[1] has no op'],
    ['{"ops":[{"op":"set","id":"a/b"},{"op":"explode"}]}', 'ops[2]: unknown operation'],
    ['{"ops":[{"op":"attach"},{"op":"attach"}]}', 'at most one attach in a request'],
    ['{"ops":[{"op":"set"}],"client_op_id":""}', 'client_op_id is 1 to 64 letters, digits and . _ : -'],
    ['{"ops":[{"op":"set"}],"client_op_id":"has space"}', 'client_op_id is 1 to 64 letters, digits and . _ : -'],
    ['{"ops":[{"op":"set"}],"client_op_id":"' + 'a'.repeat(65) + '"}', 'client_op_id is 1 to 64 letters, digits and . _ : -'],
    ['{"ops":[{"op":"set"}],"client_op_id":5}', 'client_op_id is 1 to 64 letters, digits and . _ : -'],
    ['{"ops":[{"op":"set"}],"dry_run":"yes"}', 'dry_run must be true or false'],
  ];
  for (const [body, why] of cases) {
    const r = await w.post(body);
    assert.equal(r.status, 400, body.slice(0, 80));
    const e = await error(r);
    assert.equal(e.code, 'bad_request');
    assert.equal(e.message, why, body.slice(0, 80));
  }
  assert.deepEqual(w.seen, [], 'nothing reached the write path');
  assert.deepEqual(w.calls, [], 'and the engine was not asked');
  assert.equal(typeof checkOpsRequest('{"ops":[{"op":"set"}]}'), 'object');
});

test('a plain request of ops goes to the write path as it is, and its answer is passed on unchanged', async () => {
  const text = RESULT();
  const w = writer({ kind: 'done', text });
  const request = { schema: 1, client_op_id: 'a.b_c:d-1', dry_run: false, ops: [SET, { op: 'new', area: 'lib.nvim', title: 'T' }] };
  const r = await w.post(request);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), text);
  assert.deepEqual(w.seen, [request]);
  const names = ['set', 'new', 'reorder', 'done', 'move_area', 'plan_new', 'tick_step', 'answer', 'append_note', 'reopen', 'set_body', 'view_save', 'view_delete'];
  for (const name of names) assert.equal((await w.post({ ops: [{ op: name }] })).status, 200, name);
});

test('the clipboard of the machine is out of reach: an attach is refused, not tried', async () => {
  const w = writer({ kind: 'done', text: RESULT() });
  const r = await w.post({ ops: [SET, { op: 'attach', id: 'a/b', from: 'clipboard' }] });
  assert.equal(r.status, 400);
  assert.equal((await error(r)).code, 'not_available');
  assert.deepEqual(w.seen, []);
});

test('how a write ended is told as the Rust hub tells it: refusals with their status, a conflict as 409, a failure as 5xx or 403', async () => {
  const refuse = (code, message) => ({ kind: 'refused', result: { code, text: JSON.stringify({ kind: 'tasks.error', code, message, retryable: false }) } });
  const cases = [
    [refuse('invalid_argument', 'bad field'), 400, 'invalid_argument'],
    [refuse('unsupported_schema', 'old'), 400, 'unsupported_schema'],
    [refuse('not_found', 'none'), 404, 'not_found'],
    [refuse('conflict', 'moved on'), 409, 'conflict'],
    [refuse('locked', 'busy'), 503, 'locked'],
    [refuse('payload_too_large', 'big'), 502, 'payload_too_large'],
    [{ kind: 'conflict', message: 'the folder changed since it was read, nothing was written: a.md (changed)' }, 409, 'conflict'],
    [{ kind: 'failed', code: 'io', message: 'writing a.md failed' }, 502, 'io'],
    [{ kind: 'failed', code: 'rollback_incomplete', message: 'not taken back: a.md' }, 502, 'rollback_incomplete'],
    [{ kind: 'failed', code: 'forbidden', message: 'lies in a folder' }, 403, 'forbidden'],
    [{ kind: 'failed', code: 'Not A Code!', message: 'odd' }, 502, 'engine_failed'],
  ];
  for (const [outcome, status, code] of cases) {
    const r = await writer(outcome).post({ ops: [SET] });
    assert.equal(r.status, status, JSON.stringify(outcome).slice(0, 80));
    const e = await error(r);
    assert.equal(e.code, code);
    assert.ok(e.message.length > 0);
  }
  const long = await writer({ kind: 'conflict', message: 'a\u0000b\n' + 'x'.repeat(2000) }).post({ ops: [SET] });
  const message = (await error(long)).message;
  assert.equal(message.length, 512);
  assert.ok(!/[\u0000-\u001f]/.test(message), 'no control characters in a message');
});

test('a write path that throws is a failure the page can read, and the page is told to read again', async () => {
  const w = writer(() => {
    throw new Error('worker gone');
  });
  const stream = await w.get('events');
  const reader = stream.body.getReader();
  await reader.read();
  const r = await w.post({ ops: [SET] });
  assert.equal(r.status, 502);
  assert.equal((await error(r)).code, 'engine_failed');
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: resync/);
  await reader.cancel();
});


test('a write that changed the vault tells the open streams and drops the texts of the search; a dry run and a no-op do not', async () => {
  let rev = 'one';
  let answer = RESULT();
  const bodies = () => JSON.stringify({ schema: 1, kind: 'tasks.bodies', rev, items: [{ id: 'a/b', body: 'zebra ' + rev }], total: 1 });
  const w = writer(() => ({ kind: 'done', text: answer }), { bodies });
  const stream = await w.get('events');
  const reader = stream.body.getReader();
  await reader.read(); // hello
  const events = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        events.push(new TextDecoder().decode(value));
      }
    } catch {
      // the stream was ended by close()
    }
  })();
  const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
  const hits = async () => JSON.stringify((await (await w.get('search?q=zebra')).json()).hits);

  assert.match(await hits(), /one/);
  rev = 'two';
  assert.match(await hits(), /one/, 'the texts are kept while nothing changed');

  assert.equal((await w.post({ dry_run: true, ops: [SET] })).status, 200);
  answer = RESULT([]);
  assert.equal((await w.post({ ops: [SET] })).status, 200);
  await wait();
  assert.deepEqual(events, [], 'a dry run and a write that changed no file tell nobody');
  assert.match(await hits(), /one/);

  answer = RESULT();
  assert.equal((await w.post({ ops: [SET] })).status, 200);
  await wait();
  assert.equal(events.length, 1);
  assert.match(events[0], /event: resync/);
  assert.match(await hits(), /two/, 'the texts were read again');
  w.api.close();
  await pump;
});

test('a read waits for a write that is under way (idle), a write does not wait for itself', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const order = [];
  const api = createWebHub({
    version: '1',
    build: null,
    pinned: { engine: null, lib: null },
    idle: async () => {
      order.push('idle asked');
      await gate;
    },
    async call(method) {
      order.push(`engine ${method}`);
      return { text: JSON.stringify({ capabilities: [], engine: {}, enums: {} }), code: null };
    },
    async ops() {
      order.push('write');
      return { kind: 'done', text: RESULT([]) };
    },
  });
  const read = api.fetch('/api/tasks/hello');
  const write = await api.fetch('/api/tasks/ops', { method: 'POST', body: JSON.stringify({ ops: [SET] }) });
  assert.equal(write.status, 200, 'the write path does not go through idle');
  assert.deepEqual(order, ['idle asked', 'write'], 'the read has not reached the engine');
  release();
  assert.equal((await read).status, 200);
  assert.deepEqual(order, ['idle asked', 'write', 'engine hello']);
});
