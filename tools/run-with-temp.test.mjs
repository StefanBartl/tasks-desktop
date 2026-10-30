// Tests of tools/run-with-temp.mjs:  node --test "tools/*.test.mjs"
// And of the workflows: every step that runs Node tests or a browser runs through it, so that a leftover fails the job.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(new URL("./run-with-temp.mjs", import.meta.url));
const repo = join(dirname(script), "..");
const LIB_URL = pathToFileURL(join(dirname(script), "run-with-temp-lib.mjs")).href;

// What the command does, by its first argument: say where its temp dir is and what is in it, leave a folder, or fail.
const PROGRAM = `
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [mode, name] = process.argv.slice(2);
if (mode === "print") {
  const same = [process.env.TEMP, process.env.TMP, process.env.TMPDIR].every((v) => v === tmpdir());
  console.log("DIR=" + tmpdir());
  console.log("SAME=" + same);
  console.log("ENTRIES=" + JSON.stringify(readdirSync(tmpdir())));
}
if (mode === "leave") mkdirSync(join(tmpdir(), name));
if (mode === "fail") process.exit(7);
// "wait UP GO": leaves a folder of the tests, says it runs (the file UP), and ends when the file GO exists or after 25 s
if (mode === "wait") {
  const [up, go] = process.argv.slice(3);
  mkdirSync(join(tmpdir(), "tasks-web-run-sig"));
  writeFileSync(up, "x");
  const until = Date.now() + 25000;
  while (!existsSync(go) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}
`;

/** Runs the tool in a base folder of its own (RUNNER_TEMP) with a command made from `mode`; the base is removed after. */
function runTool(flags, ...programArgs) {
  const base = mkdtempSync(join(tmpdir(), "run-with-temp-test-"));
  try {
    const program = join(base, "program.mjs");
    writeFileSync(program, PROGRAM);
    const r = spawnSync(process.execPath, [script, ...flags, "--", process.execPath, program, ...programArgs], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: base },
    });
    // the folder the tool made is gone, the base holds only the program
    const rest = readdirSync(base).filter((n) => n !== "program.mjs");
    return { code: r.status, out: r.stdout, err: r.stderr, rest };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("the command gets a temp dir of its own, empty, in TEMP, TMP and TMPDIR, and it is removed after", () => {
  const r = runTool([], "print");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /SAME=true/);
  assert.match(r.out, /ENTRIES=\[\]/);
  assert.match(r.out, /DIR=.*run-with-temp-/);
  assert.deepEqual(r.rest, [], "the temp dir of the command is removed");
});

test("a leftover of the tests fails the step and is named", () => {
  for (const name of ["tasks-desktop-e2e-x1", "tasks-web-run-x1", "hub-testkit-x1"]) {
    const r = runTool([], "leave", name);
    assert.equal(r.code, 1, `${name}: ${r.err}`);
    assert.match(r.err, new RegExp(name));
    assert.deepEqual(r.rest, []);
  }
});

test("the caches of the tools are not counted by default", () => {
  for (const name of ["chrome_chrome_url_fetcher_1_2", "playwright-transform-cache", "node-compile-cache"]) {
    const r = runTool([], "leave", name);
    assert.equal(r.code, 0, `${name}: ${r.err}`);
  }
});

test("--strict counts them, and --allow lets a name pass", () => {
  const dirty = runTool(["--strict"], "leave", "node-compile-cache");
  assert.equal(dirty.code, 1);
  assert.match(dirty.err, /node-compile-cache/);
  const allowed = runTool(["--strict", "--allow", "node-compile-cache"], "leave", "node-compile-cache");
  assert.equal(allowed.code, 0, allowed.err);
});

test("the exit code of a failed command is the command's, and the check still runs", () => {
  const r = runTool([], "fail");
  assert.equal(r.code, 7);
  assert.deepEqual(r.rest, []);
});

test("no command, or no --, is an error", () => {
  assert.equal(spawnSync(process.execPath, [script, "--"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, "node"], { encoding: "utf8" }).status, 2);
});

test("a command that does not exist fails the step", () => {
  const base = mkdtempSync(join(tmpdir(), "run-with-temp-test-"));
  try {
    const r = spawnSync(process.execPath, [script, "--", "no-such-command-for-the-test"], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: base },
    });
    assert.notEqual(r.status, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// A signal while the command runs. `process.emit` stands for the signal (on Windows a real one cannot be sent to a
// process: it kills it at once), and runs in a process of its own that runs `main`. Without the listeners of `main` the
// emit does nothing, and these cases are red: the command is not ended, or the exit code is not the signal's.
/**
 * `release`: the command ends by itself after the signal (what the terminal's Ctrl-C does to it). Otherwise it runs on
 * until `main` ends it. Returns the exit code of `main`, how long it took, what is left in the base, and the stderr.
 */
function signalRun(signal, { release, graceMs = 10000 }) {
  const base = mkdtempSync(join(tmpdir(), "run-with-temp-test-"));
  try {
    const program = join(base, "program.mjs");
    writeFileSync(program, PROGRAM);
    const up = JSON.stringify(join(base, "up"));
    const go = JSON.stringify(join(base, "go"));
    const code = [
      `import { main } from ${JSON.stringify(LIB_URL)};`,
      `import { existsSync, writeFileSync } from "node:fs";`,
      `const began = Date.now();`,
      `const args = ["--", process.execPath, ${JSON.stringify(program)}, "wait", ${up}, ${go}];`,
      `const done = main(args, { graceMs: ${graceMs} });`,
      `while (!existsSync(${up})) await new Promise((r) => setTimeout(r, 20));`,
      `process.emit(${JSON.stringify(signal)});`,
      release ? `writeFileSync(${go}, "x");` : "",
      `const code = await done;`,
      `console.log("CODE=" + code + " MS=" + (Date.now() - began));`,
    ].join("\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: base },
      timeout: 40000,
    });
    const said = /CODE=(\d+) MS=(\d+)/.exec(r.stdout) ?? [];
    const rest = readdirSync(base).filter((n) => !["program.mjs", "up", "go"].includes(n));
    return { code: Number(said[1] ?? -1), ms: Number(said[2] ?? -1), rest, err: r.stderr, out: r.stdout };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("a SIGINT while the command runs: the command is waited for, the check and the removal run, the code is 130", () => {
  const r = signalRun("SIGINT", { release: true });
  assert.equal(r.code, 130, `${r.out}${r.err}`);
  assert.deepEqual(r.rest, [], "the temp dir of the command is removed");
  assert.match(r.err, /tasks-web-run-sig/, "the check ran after the signal and named the leftover");
});

test("a SIGINT that the command does not follow: it is ended after the grace time", () => {
  const r = signalRun("SIGINT", { release: false, graceMs: 300 });
  assert.equal(r.code, 130, `${r.out}${r.err}`);
  assert.ok(r.ms < 15000, `the command ran on for ${r.ms} ms`);
  assert.deepEqual(r.rest, []);
});

test("a SIGTERM ends the command at once, and the code is 143", () => {
  const r = signalRun("SIGTERM", { release: false });
  assert.equal(r.code, 143, `${r.out}${r.err}`);
  assert.ok(r.ms < 15000, `the command ran on for ${r.ms} ms`);
  assert.deepEqual(r.rest, []);
});

// The tool is only worth anything when the steps run through it. Without these the wrapper could be dropped from a
// step and every job stays green.
const workflow = (name) => readFileSync(join(repo, ".github", "workflows", name), "utf8");
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim().replace(/^- /, ""));

test("the steps with Node tests and browsers run through it", () => {
  const steps = {
    "ci.yml": [
      "node ../tools/run-with-temp.mjs -- pnpm web:test",
      "node ../tools/run-with-temp.mjs -- pnpm web:e2e",
      "node ../tools/run-with-temp.mjs -- pnpm e2e",
      "node ../tools/run-with-temp.mjs -- pnpm test",
      "node tools/run-with-temp.mjs -- pwsh -NoProfile -File scripts/test-install.ps1 target/debug/tasks-hub.exe",
      "node tools/run-with-temp.mjs -- sh scripts/test-install.sh target/debug/tasks-hub.exe",
    ],
    "release.yml": [
      "node tools/run-with-temp.mjs -- pwsh -NoProfile -File scripts/test-install.ps1 target/release/tasks-hub.exe",
      "node tools/run-with-temp.mjs -- sh scripts/test-install.sh target/release/tasks-hub.exe",
    ],
    "web.yml": ["node ../tools/run-with-temp.mjs -- pnpm web:test", "node ../tools/run-with-temp.mjs -- pnpm web:e2e"],
  };
  for (const [file, wanted] of Object.entries(steps)) {
    const have = lines(workflow(file));
    for (const line of wanted) assert.ok(have.some((l) => l === `run: ${line}` || l === line), `${file}: no step runs "${line}"`);
  }
});

// A line that starts Node tests, a browser or the install scripts. Whatever form it takes (`pnpm run e2e`,
// `pnpm exec playwright test`, `npx playwright test`, `pnpm --dir ui test`, `cd ui && pnpm test`), it has to start with
// the wrapper. Each part of a line joined with && || ; | counts for itself. `cargo test` has its own strict step in ci.yml.
const TESTS = [
  /\b(pnpm|npm|npx|yarn)\b.*\b(test|e2e|playwright|vitest)\b/,
  /\bplaywright\s+test\b/,
  /\bnode\b.*\s--test\b/,
  /\bscripts\/test-install\.(ps1|sh)\b/,
];
const WRAPPED = /^(run: )?node (\.\.\/)?tools\/run-with-temp\.mjs\s/;
// the tests of the tools themselves: they make their folders below RUNNER_TEMP or in the temp dir, and remove them
const EXEMPT = new Set(['node --test "tools/*.test.mjs"']);
// fetching the browsers of Playwright starts no test (it writes to the browsers' folder, not the temp dir)
const INSTALL = /\bplaywright\s+install\b/;

function unwrapped(text) {
  const found = [];
  for (const line of lines(text)) {
    if (line.startsWith("#")) continue;
    for (const part of line.split(/&&|\|\||;|\|/).map((p) => p.trim())) {
      if (EXEMPT.has(part.replace(/^run: /, "")) || WRAPPED.test(part) || INSTALL.test(part)) continue;
      if (TESTS.some((re) => re.test(part))) found.push(line);
    }
  }
  return found;
}

test("no step runs those tests without it", () => {
  const dir = join(repo, ".github", "workflows");
  const files = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
  assert.ok(files.includes("ci.yml") && files.includes("release.yml"), "the walk found the workflows");
  for (const file of files) assert.deepEqual(unwrapped(workflow(file)), [], file);
});

test("the lint of the workflows sees the forms that go around the wrapper, and leaves the rest alone", () => {
  for (const bypass of [
    "run: pnpm test",
    "- run: pnpm web:test",
    "pnpm run e2e",
    "pnpm exec playwright test",
    "npx playwright test -c playwright.web.config.ts",
    "pnpm --dir ui test",
    "cd ui && pnpm test",
    "node ../tools/run-with-temp.mjs -- pnpm web:test && pnpm test",
    "echo run-with-temp.mjs; pnpm e2e",
    "node --test web/*.test.mjs",
    "pwsh -NoProfile -File scripts/test-install.ps1 target/debug/tasks-hub.exe",
    "sh scripts/test-install.sh target/debug/tasks-hub.exe",
    "pnpm exec playwright install firefox && pnpm exec playwright test",
  ]) {
    assert.equal(unwrapped(`steps:\n  ${bypass}\n`).length, 1, `not seen: ${bypass}`);
  }
  for (const fine of [
    "run: node ../tools/run-with-temp.mjs -- pnpm web:test",
    "- run: node tools/run-with-temp.mjs --strict -- pwsh -NoProfile -File scripts/test-install.ps1 x",
    'run: node --test "tools/*.test.mjs"',
    "run: pnpm install --frozen-lockfile",
    "run: pnpm build",
    "run: pnpm exec playwright install firefox webkit",
    "# pnpm test is run through the wrapper",
    "name: Browser tests (Playwright, axe, XSS corpus)",
    "path: ui/test-results",
  ]) {
    assert.deepEqual(unwrapped(`steps:\n  ${fine}\n`), [], `seen where nothing runs: ${fine}`);
  }
});

// The install test makes `tasks-desktop-test-install-*` in the temp dir. A removal that fails silently there would leave
// it for good, and nothing would say so.
test("scripts/test-install.ps1 does not swallow a failed removal of its folder", () => {
  const text = readFileSync(join(repo, "scripts", "test-install.ps1"), "utf8");
  assert.match(text, /Remove-Item -LiteralPath \$tmp [^\n]*-ErrorAction Stop/);
  assert.doesNotMatch(text, /Remove-Item[^\n]*\$tmp[^\n]*SilentlyContinue/);
  assert.match(text, /could not remove \$tmp/, "a failed removal is reported as a failed check");
});

test("the tool is where the workflows expect it", () => {
  assert.ok(existsSync(script));
});
