// Tests of tools/check-temp-leftovers.mjs:  node --test "tools/*.test.mjs"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-temp-leftovers.mjs", import.meta.url));

/** Makes a temp dir of its own (named so that the check does not count it itself), fills it and runs `run` on it. */
function withRoot(fill, run) {
  const root = mkdtempSync(join(tmpdir(), "leftover-check-test-"));
  try {
    fill(root);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function check(args, env) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Runs the check on a temp dir of its own, filled by `fill`. */
function withDir(fill, args = []) {
  return withRoot(fill, (root) => check(["--dir", root, ...args]));
}

test("an empty temp dir is clean", () => {
  const r = withDir(() => {});
  assert.equal(r.code, 0, r.err);
});

test("other names are not counted", () => {
  const r = withDir((root) => {
    mkdirSync(join(root, "rustc1234"));
    mkdirSync(join(root, "nvim"));
    writeFileSync(join(root, "my-tasks-desktop-note.txt"), "x");
  });
  assert.equal(r.code, 0, r.err);
});

test("a leftover folder is found", () => {
  const r = withDir((root) => mkdirSync(join(root, "tasks-desktop-cli-pair-1234")));
  assert.equal(r.code, 1);
  assert.match(r.err, /1 tasks-desktop-\*.* left/);
  assert.match(r.err, /tasks-desktop-cli-pair-1234/);
});

test("a leftover file is found too", () => {
  const r = withDir((root) => writeFileSync(join(root, "tasks-desktop-marker-x"), ""));
  assert.equal(r.code, 1);
});

test("the older and the web names are counted by default", () => {
  for (const name of ["hub-testkit-second-1", "tasks-web-engine-x1"]) {
    const r = withDir((root) => mkdirSync(join(root, name)));
    assert.equal(r.code, 1, name);
    assert.match(r.err, new RegExp(name));
  }
});

test("the list is cut after thirty names but the number is whole", () => {
  const r = withDir((root) => {
    for (let i = 0; i < 40; i++) mkdirSync(join(root, `tasks-desktop-many-${String(i).padStart(2, "0")}`));
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /40 tasks-desktop-\*.* left/);
  assert.match(r.err, /and 10 more/);
});

test("a folder that does not exist is an error, not a clean temp dir", () => {
  const r = check(["--dir", join(tmpdir(), "leftover-check-test-absent-folder")]);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /cannot read/);
});

test("the prefix can be named, and then replaces the default list", () => {
  const r = withDir((root) => mkdirSync(join(root, "mine-old-1")), ["--prefix", "mine-"]);
  assert.equal(r.code, 1);
  const other = withDir((root) => mkdirSync(join(root, "tasks-desktop-old-1")), ["--prefix", "mine-"]);
  assert.equal(other.code, 0, other.err);
});

test("strict counts every entry, whatever the name", () => {
  const r = withDir((root) => mkdirSync(join(root, "some-name-no-prefix-covers")), ["--strict"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /1 entries left/);
  assert.match(r.err, /some-name-no-prefix-covers/);
});

test("strict lets the allowed names pass and nothing else", () => {
  const args = ["--strict", "--allow", "nvim"];
  const clean = withDir((root) => mkdirSync(join(root, "nvim")), args);
  assert.equal(clean.code, 0, clean.err);
  const dirty = withDir((root) => {
    mkdirSync(join(root, "nvim"));
    mkdirSync(join(root, "stray"));
  }, args);
  assert.equal(dirty.code, 1);
  assert.match(dirty.err, /stray/);
  assert.doesNotMatch(dirty.err, /  nvim/);
});

test("--allow without --strict, and --prefix with it, are refused", () => {
  assert.equal(withDir(() => {}, ["--allow", "nvim"]).code, 2);
  assert.equal(withDir(() => {}, ["--strict", "--prefix", "x-"]).code, 2);
});

test("a bad argument is refused with 2", () => {
  assert.equal(check(["--dir"]).code, 2);
  assert.equal(check(["--nope"]).code, 2);
});

test("without --dir it looks in the temp dir of the process", () => {
  withRoot(
    (root) => mkdirSync(join(root, "tasks-desktop-env-1")),
    (root) => {
      const r = check([], { ...process.env, TEMP: root, TMP: root, TMPDIR: root });
      assert.equal(r.code, 1, r.err);
      assert.match(r.err, /tasks-desktop-env-1/);
    },
  );
});

// A runner whose workspace is behind a junction or a symlink starts the script through it. A check that compared the
// path it was started with to the real one would do nothing then and exit 0: green with no look at the folder.
test("started through a junction or a symlink it still checks", () => {
  withRoot(
    (root) => mkdirSync(join(root, "tasks-desktop-leftover-1")),
    (root) => {
      const link = join(tmpdir(), `leftover-check-test-link-${process.pid}`);
      symlinkSync(dirname(script), link, "junction");
      try {
        const r = spawnSync(process.execPath, [join(link, "check-temp-leftovers.mjs"), "--dir", root], { encoding: "utf8" });
        assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /tasks-desktop-leftover-1/);
      } finally {
        unlinkSync(link);
      }
    },
  );
});

// The check is only worth anything when CI runs it, on a temp dir of the job's own. These hold the workflow to that;
// without them the step could be dropped and every job stays green.
const ci = readFileSync(join(dirname(script), "..", ".github", "workflows", "ci.yml"), "utf8");

test("ci.yml gives the rust job a temp dir of its own and runs the check on it after the tests", () => {
  const setup = ci.indexOf("GITHUB_ENV");
  const tests = ci.indexOf("cargo test --workspace");
  const run = ci.search(/node tools\/check-temp-leftovers\.mjs --dir "\$JOB_TEMP" --strict/);
  assert.ok(setup >= 0, "no step puts TEMP into GITHUB_ENV");
  for (const name of ["TEMP", "TMP", "TMPDIR", "JOB_TEMP"]) assert.match(ci, new RegExp(`"${name}=\\$dir"`), name);
  assert.ok(run >= 0, "the check is not run on $JOB_TEMP");
  assert.ok(setup < tests && tests < run, "the order must be: temp dir, tests, check");
});

test("ci.yml runs the tests of the tools", () => {
  assert.match(ci, /node --test "tools\/\*\.test\.mjs"/);
});
