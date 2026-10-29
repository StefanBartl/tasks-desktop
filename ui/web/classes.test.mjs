// The data classes of the web variant: `areas.json` read the way the Rust hub reads it (crates/tasks-hub/src/classes.rs),
// fail closed. The cases are in classes-cases.mjs; each is an answer `Classes::load` gives.
//
//   node --experimental-strip-types --test web/classes.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classesOfVault, MAX_FILE_BYTES, NO_CLASSES, readClasses } from '../src/web/classes.ts';
import { CASES } from './classes-cases.mjs';

const enc = (s) => new TextEncoder().encode(s);
const bytesOf = (c) => c.bytes ?? enc(c.text);

// Areas that some case decides. A refused file must show none of them as anything but unclassified.
const NAMED = ['a', 'b', 'c', 'x', 'p', 'alpha.nvim', 'pub-area', 'secret-area', 'shared.nvim', 'a0', 'a999', 'lib.nvim', 'anything', 'other'];

test('there is a case for every refusal and every reading the Rust tests have', () => {
  assert.ok(CASES.length >= 150, String(CASES.length));
  assert.ok(CASES.filter((c) => c.refused).length >= 100);
  assert.ok(CASES.filter((c) => c.shows).length >= 30);
  assert.equal(new Set(CASES.map((c) => c.name)).size, CASES.length, 'a name twice');
  for (const c of CASES) assert.ok((c.refused === true) !== (c.shows !== undefined), `${c.name}: refused or shows`);
});

test('a case that is about an escape has the backslash in its file', () => {
  const about = CASES.filter((c) => /escape|surrogate/.test(c.name));
  assert.ok(about.length >= 25, String(about.length));
  for (const c of about) {
    assert.ok(c.text !== undefined && c.text.includes(String.fromCharCode(92)), `${c.name}: no backslash, the escape was turned into a letter`);
  }
});

for (const c of CASES) {
  test(c.name, () => {
    const got = readClasses(bytesOf(c));
    if (c.refused) {
      // Fail closed: a file that cannot be used releases nothing, and says why.
      assert.equal(typeof got.problem, 'string', 'a problem is named');
      assert.ok(got.problem.length > 0);
      for (const area of NAMED) assert.equal(got.shown(area), 'unclassified', area);
      assert.equal(got.size, 0);
      return;
    }
    assert.equal(got.problem, null);
    for (const [area, cls] of Object.entries(c.shows)) assert.equal(got.shown(area), cls, area);
  });
}

test('no file classifies nothing, and says no problem', () => {
  assert.equal(NO_CLASSES.problem, null);
  assert.equal(NO_CLASSES.shown('anything'), 'unclassified');
  assert.equal(NO_CLASSES.size, 0);
  const got = classesOfVault(new Map([['A/ROADMAP/tasks/a.md', enc('x')]]), []);
  assert.equal(got.problem, null);
  assert.equal(got.shown('A'), 'unclassified');
  assert.equal(got.signature, NO_CLASSES.signature);
});

test('the classes of a vault are those of the areas.json at its root', () => {
  const files = new Map([
    ['areas.json', enc('{"schema":1,"areas":{"A":{"class":"internal"},"B":{"class":"private"}}}')],
    ['A/areas.json', enc('{"schema":1,"default":"public","areas":{}}')],
  ]);
  const got = classesOfVault(files, []);
  assert.equal(got.shown('A'), 'internal');
  assert.equal(got.shown('B'), 'private');
  assert.equal(got.shown('C'), 'unclassified', 'a file deeper down decides nothing');
  assert.equal(got.size, 2);
});

test('a file the reader left out is a problem, not "no file"', () => {
  for (const reason of ['too-large', 'unreadable']) {
    const got = classesOfVault(new Map(), [{ path: 'areas.json', reason }]);
    assert.match(got.problem, new RegExp(reason));
    assert.equal(got.shown('A'), 'unclassified');
  }
  // Another file that was left out says nothing about the classes.
  assert.equal(classesOfVault(new Map(), [{ path: 'A/big.md', reason: 'too-large' }]).problem, null);
  // And a file that is there but was also reported (it cannot be, but if it were) is not trusted.
  const both = classesOfVault(new Map([['areas.json', enc('{"schema":1,"default":"public","areas":{}}')]]), [{ path: 'areas.json', reason: 'unreadable' }]);
  assert.equal(both.shown('A'), 'unclassified');
});

test('the signature tells whether the decisions changed, not how the file is written', () => {
  const a = readClasses(enc('{"schema":1,"areas":{"A":{"class":"public"},"B":{"class":"private"}}}'));
  const reordered = readClasses(enc('{ "areas": { "B": {"class":"private","repo":"b"}, "A": {"class":"public"} }, "schema": 1 }'));
  assert.equal(a.signature, reordered.signature);
  // Schema 2 with the same decisions for main.
  const two = readClasses(enc('{"schema":2,"areas":{"main:A":{"class":"public"},"main:B":{"class":"private"},"work:A":{"class":"private"}}}'));
  assert.equal(a.signature, two.signature);
  const changed = readClasses(enc('{"schema":1,"areas":{"A":{"class":"public"},"B":{"class":"internal"}}}'));
  assert.notEqual(a.signature, changed.signature);
  const withDefault = readClasses(enc('{"schema":1,"default":"private","areas":{"A":{"class":"public"},"B":{"class":"private"}}}'));
  assert.notEqual(a.signature, withDefault.signature);
  assert.notEqual(NO_CLASSES.signature, readClasses(enc('{')).signature, 'a file that is broken is not "no file"');
  assert.notEqual(readClasses(enc('{')).signature, readClasses(enc('{"schema":3}')).signature, 'two problems are not one');
  assert.equal(a.shown('A'), 'public');
});

test('the limits are those of classes.rs', () => {
  assert.equal(MAX_FILE_BYTES, 256 * 1024);
});

test('an area the engine names after the file was read is unclassified, whatever its name', () => {
  const got = readClasses(enc('{"schema":1,"areas":{"A":{"class":"public"}}}'));
  // Names that could be mistaken for an entry: the prototype's own, an empty one, one with a path.
  for (const area of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'A/', 'a', 'A ']) {
    assert.equal(got.shown(area), 'unclassified', JSON.stringify(area));
  }
});
