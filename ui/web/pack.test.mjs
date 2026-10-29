// The packer of the single-file page: what the file holds, what it escapes, and what the build refuses. Synthetic
// script, style and parts; no vite run.
//
//   node --experimental-strip-types --test web/pack.test.mjs        (from ui/)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { assemble, CSP, inlineScript, inlineStyle, PART_IDS, verifyShell } from './pack.mjs';

const parts = Object.fromEntries(PART_IDS.map((id) => [id, Buffer.from(`part ${id} ☃`)]));
const page = (over = {}) => assemble({ css: 'body{margin:0}', js: 'console.log(1)', parts, build: 'abc1234', ...over });

test('the file holds the policy, the script and style inline, and the four parts packed', () => {
  const html = page();
  assert.deepEqual(verifyShell(html), []);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`));
  assert.match(html, /<style>body\{margin:0\}<\/style>/);
  assert.match(html, /<script type="module">console\.log\(1\)<\/script>/);
  assert.match(html, /build abc1234/);
  for (const id of PART_IDS) {
    const m = html.match(new RegExp(`<script id="${id}" type="application/octet-stream">([^<]*)</script>`));
    assert.ok(m, id);
    assert.equal(gunzipSync(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')).toString('utf8'), `part ${id} ☃`, id);
  }
});

test('the policy forbids every request and every outside source', () => {
  for (const directive of ["default-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", 'worker-src blob:']) {
    assert.ok(CSP.includes(directive), directive);
  }
  assert.ok(!/https?:|\*/.test(CSP), 'no address and no wildcard in the policy');
  assert.ok(!CSP.includes("'unsafe-eval'"), 'wasm-unsafe-eval only');
});

test('a script cannot end its own element, a style cannot either', () => {
  const html = page({ js: 'const a = "</script><img src=x>"; const b = "<!-- x";' });
  assert.deepEqual(verifyShell(html), [], 'the end tag in the script does not become markup');
  assert.equal(inlineScript('"</SCRIPT>"'), '"<\\/SCRIPT>"');
  assert.equal(inlineScript('"<!--"'), '"<\\!--"');
  assert.throws(() => inlineStyle('a{} </style><script>x</script>'), /<\/style/);
});

test('the build refuses a shell that loads something or lacks something', () => {
  const good = page();
  const bad = (html, pattern, label) => assert.match(verifyShell(html).join('\n'), pattern, label);
  bad(good.replace('<script type="module">', '<script type="module" src="app.js">'), /loads a file \(src=\)/, 'a script with a source');
  bad(good.replace('</head>', '<link rel="stylesheet" href="style.css"></head>'), /loads a file \(href=\)/, 'a linked style');
  bad(good.replace('<div id="app">', '<img src="x.png"><div id="app">'), /src=/, 'an image');
  bad(good.replace('</head>', '<base href="/"></head>'), /href=/, 'a base');
  bad(good.replace('</head>', '<meta http-equiv="refresh" content="0;url=/x"></head>'), /refresh/, 'a refresh');
  bad(good.replace('<div id="app">', '<p>see https://example.com/x</p><div id="app">'), /URL in the page/, 'an address in the shell');
  bad(good.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), /CSP meta/, 'no policy');
  bad(good.replace(/connect-src 'none'/, "connect-src 'self'"), /CSP meta/, 'a policy that lets connections through');
  bad(good.replace('<script id="wasm"', '<script id="other"'), /part "wasm" is missing/, 'a part is missing');
  bad(good.replace('</body>', '<script>alert(1)</script></body>'), /neither a part nor the module/, 'a stray script');
  bad(good.replace('<script type="module">', '<script type="module">1</script><script type="module">'), /one inline module script, found 2/, 'two modules');
});

test('what is inside the script and the style is not the shell: an address in the compiled code does not fail the build', () => {
  // The compiled code holds namespaces and links (`http://www.w3.org/2000/svg`, an issue address). What it does at run
  // time is the browser test's to check, with the requests counted.
  const html = page({ js: 'const ns = "http://www.w3.org/2000/svg"; const t = `<a href="https://github.com/x">`;', css: '@namespace svg url(http://www.w3.org/2000/svg);' });
  assert.deepEqual(verifyShell(html), []);
});

test('parts must be bytes, and all four must be given', () => {
  assert.throws(() => assemble({ css: '', js: '', parts: { worker: Buffer.from('x') }, build: 'b' }), /parts missing: wasm, bundle, shim/);
  assert.throws(() => assemble({ css: '', js: '', parts: { ...parts, wasm: 'text' }, build: 'b' }), /parts missing: wasm/);
});
