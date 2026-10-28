// The bundle of the engine's Lua sources: which requires count, what the comments leave, which file a module is.
//
//   node --experimental-strip-types --test web/        (from ui/)

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { lex, luaFiles, requiresOf, stripComments } from './engine-bundle.mjs';

const SOURCE = [
  'local a = "--" .. require("a.b")',
  '-- require("comment.line")',
  '--[[ require("comment.block") ]]',
  '--[==[ ]] require("comment.level") ]==]',
  '--[[ a block comment',
  '   over three lines: require("comment.multi")',
  ']] local after = 1',
  'local s = [[ require("in.long.string") -- ]] local c = require "c"',
  "local ok, f = pcall(require, 'f.optional')",
  'local ok2, g = pcall(require, "g." .. name)',
  "local i = require('i').x",
  'local d = require(name)',
  'local e = "it\'s \\"--\\" " .. require("e")',
].join('\n');

test('requires are read from the code: not from comments or strings, pcall(require, "x") counts', () => {
  const { literal, dynamic } = requiresOf(lex(SOURCE).tokens);
  assert.deepEqual(literal, ['a.b', 'c', 'f.optional', 'i', 'e']);
  assert.deepEqual(dynamic, ['g....', 'name...']);
});

test('comments go, every line stays where it was', () => {
  const { comments } = lex(SOURCE);
  const code = stripComments(SOURCE, comments);
  assert.equal(code.split('\n').length, SOURCE.split('\n').length);
  assert.ok(!code.includes('comment.'), code);
  assert.ok(code.includes('local s = [[ require("in.long.string") -- ]] local c = require "c"'), 'a long string keeps its "--"');
  assert.ok(code.includes('local a = "--" .. require("a.b")'), 'a quoted "--" is no comment');
  assert.equal(code.split('\n').findIndex((l) => l.includes('local after = 1')), 6, 'the code after a block comment keeps its line');
});

test('a module path outside ASCII is found, x.lua wins over x/init.lua', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-web-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  put('lua/plain.lua', 'return "plain"');
  put('lua/plain/init.lua', 'return "init"');
  put('lua/only/init.lua', 'return "only init"');
  put('lua/äöü.lua', 'return "umlaut"');
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.quotepath=true', ...args]);
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  const files = luaFiles(dir, 'HEAD');
  assert.equal(files.get('plain'), 'return "plain"');
  assert.equal(files.get('only'), 'return "only init"');
  assert.equal(files.get('äöü'), 'return "umlaut"');
});
