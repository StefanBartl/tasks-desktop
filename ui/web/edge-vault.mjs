// A vault of edge cases for the comparison of the web engine with nvim (engine.test.mjs, TASKS_WEB_COMPARE=1). The
// synthetic vault of the browser tests (e2e/fixture/vault) is tidy: it has no CRLF, no byte order mark, no file that
// is not a task, no text outside ASCII beyond a few words. These are the files a real vault grows over the years, and
// the places where a Lua shim in WebAssembly and Neovim could differ: the reading of bytes, the case of letters, the
// order of names, numbers and dates, the escapes of JSON.
//
// The files are made here, not checked in: git would turn a CRLF into LF (and the test would no longer test it), and
// a byte order mark or an invalid byte does not survive an editor. The test does not say what nvim answers (nvim is
// the measure): it asks both and compares the documents.

const enc = new TextEncoder();
/** @param {string} s */
const utf8 = (s) => enc.encode(s);

const head = (lines) => ['---', ...lines, '---', ''].join('\n');
const day = ['created: 2026-01-01', 'updated: 2026-01-01'];

/** @returns {Record<string, Uint8Array>} path (below the vault) -> bytes */
export function edgeFiles() {
  /** @type {Record<string, Uint8Array>} */
  const f = {};
  const task = (area, slug, text) => (f[`${area}/ROADMAP/tasks/${slug}.md`] = typeof text === 'string' ? utf8(text) : text);
  const done = (area, name, text) => (f[`${area}/Backlog/TASKS/${name}.md`] = utf8(text));

  for (const area of ['edge.nvim', 'unicode-ä.nvim']) {
    f[`${area}/Backlog/README.md`] = utf8(`# ${area} — Backlog\n\n## FEATURES (0)\n\n_noch leer_\n\n## TASKS (0)\n`);
  }

  // line endings, byte order mark, files that are not (whole) tasks
  task('edge.nvim', 'crlf', head(['title: Windows line endings', 'status: open', 'prio: 2', 'tags: [win, crlf]', ...day]).replaceAll('\n', '\r\n') + 'The body.\r\n\r\n## Plan\r\n\r\n- [x] 1. one\r\n- [ ] 2. two\r\n');
  task('edge.nvim', 'bom', '\ufeff' + head(['title: Byte order mark', 'status: open', ...day]) + 'After the mark.\n');
  task('edge.nvim', 'no-frontmatter', '# Just markdown\n\nNo head at all.\n');
  task('edge.nvim', 'unclosed', '---\ntitle: Never closed\nstatus: open\n\nBody that is a head.\n');
  task('edge.nvim', 'empty', '');
  task('edge.nvim', 'only-dashes', '---\n---\n');
  task('edge.nvim', 'invalid-utf8', Uint8Array.from([...utf8(head(['title: Bytes', 'status: open', ...day])), 0xff, 0xfe, 0x20, 0xc3, 0x28, 0x0a]));
  task('edge.nvim', 'nul-in-body', Uint8Array.from([...utf8(head(['title: A nul byte', 'status: open', ...day])), 0x61, 0x00, 0x62, 0x0a]));
  task('edge.nvim', 'no-final-newline', head(['title: No newline at the end', 'status: open', ...day]).slice(0, -1) + '\n' + 'last line');

  // how the head is written
  task('edge.nvim', 'quoted', head(['title: "Quoted: with a colon # and a hash"', "status: 'open'", 'kind: task', 'tags:', '  - block', '  - "list: item"', 'refs: ["a b", c]', ...day]) + 'Body.\n');
  task('edge.nvim', 'dup-keys', head(['title: First title', 'status: open', 'title: Second title', 'status: doing', ...day]) + 'Body.\n');
  task('edge.nvim', 'tabs-spaces', head(['title:\tTab after the colon  ', 'status:    open   ', 'prio:', 'effort:   ', 'tags: [  a ,b,  , c ]', ...day]) + 'Body.\n');
  task('edge.nvim', 'unknown-keys', head(['title: Keys nobody knows', 'status: open', 'zzz: 1', 'Mixed-Case: yes', 'nested: {a: 1}', ...day]) + 'Body.\n');
  task('edge.nvim', 'colon-in-key-value', head(['title: a: b: c', 'status: open', 'summary: first: second', ...day]) + 'Body.\n');
  task('edge.nvim', 'summary-forms', head(['title: Summary in the head', 'status: open', 'summary: One line in the head', ...day]) + '\nA first paragraph\nthat goes on.\n\nSecond paragraph.\n');

  // the body
  task('edge.nvim', 'fences', head(['title: Fences and rules', 'status: open', ...day]) + 'Text.\n\n```md\n## Akzeptanz\n- [ ] not a real one\n---\n```\n\n## Akzeptanz\n\n- [X] upper x\n- [x] lower x\n- [ ] open\n-[ ] no space\n* [ ] star\n\n---\n\n## Notizen\n\nText after a rule.\n');
  task('edge.nvim', 'steps', head(['title: Steps of a plan', 'status: doing', ...day]) + 'x\n\n## Plan\n\n- [ ] 1. first -- Acceptance 2\n- [x] 2. second\n- [ ] 10. tenth\n- [ ] 3. out of order\n- [ ] 3. twice\n');
  task('edge.nvim', 'questions', head(['title: Questions in the text', 'status: decision', 'actor: me', ...day]) + 'Ask.\n\n## Fragen\n\n### Which one?\n\n- [ ] A\n- [x] B\n- [ ] C\n');

  // text outside ASCII, long and odd titles, characters JSON must escape
  task('edge.nvim', 'unicode-title', head(['title: Übergrößen — Ünïcödé 日本語 🎉 ǅ İ ß ΑΣ', 'status: open', 'tags: [Ä, ä, ß, İ, ı, 日本]', ...day]) + 'Ünïcödé body 🎉\n');
  task('edge.nvim', 'combining', head(['title: Cafe\u0301 vs Café, Å vs Å', 'status: open', ...day]) + 'x\n');
  task('edge.nvim', 'json-escapes', head(['title: "<b>&amp; \\ \\\\ / \u2028 \u2029 \u007f \u0001 tab\there"', 'status: open', ...day]) + 'x\n');
  task('edge.nvim', 'long-title', head([`title: ${'Long '.repeat(1000)}end`, 'status: open', ...day]) + 'x\n');
  task('edge.nvim', 'long-line-body', head(['title: One very long line', 'status: open', ...day]) + 'w'.repeat(200000) + '\n');
  task('edge.nvim', 'Größe Datei', head(['title: A name with a space and an umlaut', 'status: open', ...day]) + 'x\n');
  task('edge.nvim', 'UPPER', head(['title: Upper case name', 'status: open', ...day]) + 'x\n');
  task('edge.nvim', 'with.dots.in.name', head(['title: Dots in the name', 'status: open', ...day]) + 'x\n');
  task('edge.nvim', '2026-01-05_dated-prefix', head(['title: A date in the name of an open task', 'status: open', ...day]) + 'x\n');
  f['edge.nvim/ROADMAP/tasks/notes.txt'] = utf8('not a task\n');
  f['edge.nvim/ROADMAP/tasks/.hidden.md'] = utf8(head(['title: Hidden', 'status: open', ...day]) + 'x\n');
  f['edge.nvim/ROADMAP/tasks/folder-task/folder-task.md'] = utf8(head(['title: A task in a folder', 'status: open', ...day]) + 'x [attachment](shot.png)\n');
  f['edge.nvim/ROADMAP/tasks/folder-task/shot.png'] = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  f['edge.nvim/ROADMAP/tasks/folder-without-md/readme.txt'] = utf8('no task in here\n');

  // numbers and dates
  task('edge.nvim', 'prio-zero', head(['title: Priority zero', 'status: open', 'prio: 0', ...day]) + 'x\n');
  task('edge.nvim', 'prio-negative', head(['title: Priority below zero', 'status: open', 'prio: -1', ...day]) + 'x\n');
  task('edge.nvim', 'prio-float', head(['title: Priority with a fraction', 'status: open', 'prio: 1.5', 'value: 5.0', ...day]) + 'x\n');
  task('edge.nvim', 'prio-text', head(['title: Priority as a word', 'status: open', 'prio: high', 'value: lots', ...day]) + 'x\n');
  task('edge.nvim', 'efforts', head(['title: Efforts of many shapes', 'status: open', 'effort: 0.5d', ...day]) + 'x\n');
  task('edge.nvim', 'effort-week', head(['title: A week of effort', 'status: open', 'effort: 1w', ...day]) + 'x\n');
  task('edge.nvim', 'effort-lower', head(['title: Effort in lower case', 'status: open', 'effort: xl', ...day]) + 'x\n');
  task('edge.nvim', 'dates', head(['title: Dates', 'status: open', 'remind: 2028-02-29', 'created: 2026-02-30', 'updated: 2026-13-45']) + 'x\n');
  task('edge.nvim', 'remind-relative', head(['title: A relative reminder', 'status: open', 'remind: +7d', ...day]) + 'x\n');
  task('edge.nvim', 'remind-bad', head(['title: A reminder that is no date', 'status: open', 'remind: someday', ...day]) + 'x\n');
  task('edge.nvim', 'remind-1999', head(['title: A reminder long past', 'status: open', 'remind: 1999-12-31', ...day]) + 'x\n');

  // order and links
  task('edge.nvim', 'self-block', head(['title: Blocks itself', 'status: blocked', 'blocked_by: [edge.nvim/self-block, edge.nvim/does-not-exist, unicode-ä.nvim/ä-task]', ...day]) + 'x\n');
  task('edge.nvim', 'after-a', head(['title: After B', 'status: open', 'after: [edge.nvim/after-b]', ...day]) + 'x\n');
  task('edge.nvim', 'after-b', head(['title: After C', 'status: open', 'after: [edge.nvim/after-c]', ...day]) + 'x\n');
  task('edge.nvim', 'after-c', head(['title: After A', 'status: open', 'after: [edge.nvim/after-a]', ...day]) + 'x\n');
  task('edge.nvim', 'blocked-by-done', head(['title: Blocked by a finished task', 'status: blocked', 'blocked_by: [edge.nvim/shipped]', ...day]) + 'x\n');
  task('edge.nvim', 'links', head(['title: Links of every kind', 'status: open', 'links: [https://example.invalid/a?b=c&d=e#f, http://x, ftp://nope, javascript:alert(1)]', 'refs: [docs/a.md, ../up.md, C:/abs.md, repo@0123abc, repo@zzz, lib.nvim:anchor]', ...day]) + 'x\n');
  task('edge.nvim', 'plan-unknown-phase', head(['title: A phase the plan does not have', 'status: open', 'plan: edge.nvim/the-plan', 'phase: nonsense', ...day]) + 'x\n');
  task('edge.nvim', 'plan-in-plan', head(['title: In the plan', 'status: open', 'plan: edge.nvim/the-plan', 'phase: second', 'effort: S', ...day]) + 'x\n');
  task('edge.nvim', 'plan-missing', head(['title: A plan that is not there', 'status: open', 'plan: edge.nvim/no-such-plan', 'phase: first', ...day]) + 'x\n');
  f['edge.nvim/ROADMAP/plans/the-plan.md'] = utf8(head(['title: The plan of edges', 'status: doing', 'areas: [edge.nvim, unicode-ä.nvim]', 'phase_order: [first, second, first]', ...day]) + 'A plan.\n');
  f['edge.nvim/ROADMAP/plans/no-head.md'] = utf8('No head here.\n');

  // ties in the order: the same prio and effort, titles that differ by case, accent and number
  for (const [slug, title] of [
    ['tie-a', 'abc'], ['tie-b', 'ABC'], ['tie-c', 'Äbc'], ['tie-d', 'zbc'], ['tie-e', 'Task 10'], ['tie-f', 'Task 9'],
    ['tie-g', 'task 2'], ['tie-h', 'Ωmega'], ['tie-i', 'omega'], ['tie-j', 'İstanbul'],
  ]) {
    task('edge.nvim', slug, head([`title: ${title}`, 'status: open', 'prio: 2', 'effort: M', 'value: 3', ...day]) + 'x\n');
  }

  // the other area, with a name outside ASCII
  task('unicode-ä.nvim', 'ä-task', head(['title: Ein Task in einem Bereich mit Umlaut', 'status: open', 'prio: 1', 'tags: [ä]', 'blocked_by: [edge.nvim/self-block]', ...day]) + 'x\n');
  task('unicode-ä.nvim', 'ß-task', head(['title: ẞ vs ß', 'status: parked', ...day]) + 'x\n');
  task('unicode-ä.nvim', '日本語', head(['title: 日本語のタスク', 'status: open', 'actor: cdx', ...day]) + 'x\n');
  task('unicode-ä.nvim', 'emoji-🎉', head(['title: A party', 'status: open', ...day]) + 'x\n');

  // finished tasks: dated, undated, a date that does not exist, with and without the fields of done
  done('edge.nvim', '2026-02-30_impossible-day', head(['title: A day that does not exist', 'status: done', ...day]) + 'x\n');
  done('edge.nvim', 'undated', head(['title: No date in the name', 'status: done', 'kind: bug', ...day]) + 'x\n');
  done('edge.nvim', '2024-02-29_leap-day', head(['title: A leap day', 'status: done', 'effort: 3d', 'commits: [lib.nvim@0123abc, lib.nvim@zz]', 'done_in: see notes', ...day]) + 'x\n');
  done('edge.nvim', '2026-01-03_shipped', head(['title: Shipped', 'status: done', 'kind: feature', 'prio: 1', 'effort: 0.5d', 'remind: +3d', ...day]) + 'x\n');
  done('edge.nvim', '2026-01-03_crlf-done', (head(['title: Done with CRLF', 'status: done', ...day]) + 'x\n').replaceAll('\n', '\r\n'));
  done('edge.nvim', '2026-01-04_ünï', head(['title: Done with an umlaut', 'status: done', 'tags: [ü]', ...day]) + 'x\n');

  // many tasks: the paging, the limits and the order of a long list
  for (let i = 0; i < 120; i++) {
    const n = String(i).padStart(3, '0');
    task('edge.nvim', `gen-${n}`, head([`title: Generated ${n}`, `status: ${['open', 'doing', 'blocked', 'parked'][i % 4]}`, `prio: ${(i % 3) + 1}`, `effort: ${['XS', 'S', 'M', 'L'][i % 4]}`, `tags: [gen, t${i % 7}]`, ...day]) + `Body ${n}\n`);
  }
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(3, '0');
    done('edge.nvim', `2026-01-${String((i % 28) + 1).padStart(2, '0')}_gen-done-${n}`, head([`title: Generated done ${n}`, 'status: done', `kind: ${['bug', 'feature', 'task'][i % 3]}`, `effort: ${['XS', 'S', 'M'][i % 3]}`, ...day]) + 'x\n');
  }
  return f;
}
