#!/usr/bin/env node
// Fail when the tests of this repository left folders or files of their own in the temp dir.
//
// Tests that make their own folder in the temp dir and do not remove it (a failed test, a panic, a forgotten
// cleanup) fill it for good: 24918 such folders were counted on one machine. Every test gets its folder from a
// helper that removes it (`Scratch` in crates/hub-testkit, `tmp.mjs` in ui/); this is the check that none escaped.
//
//     node tools/check-temp-leftovers.mjs [--dir DIR] [--prefix PREFIX]... [--strict [--allow NAME]...]
//
// DIR is the temp dir to look in; by default the one of this process (TEMP/TMP on Windows, TMPDIR elsewhere). It must
// exist: a typo in the job that points TEMP at a folder of its own would otherwise read as "nothing left".
//
// Counted are the entries whose name starts with one of the PREFIXes; by default `tasks-desktop-` (Rust tests, e2e),
// `hub-testkit-` (the older name of the Rust helpers) and `tasks-web-` (the tests of the web variant). Naming
// --prefix replaces that list.
//
// On a machine that has run other things the shared temp dir holds old leftovers and other jobs' folders, so CI points
// TEMP, TMP and TMPDIR of the job at a folder of its own, empty at the start, and names it here with --strict: then
// every entry in it counts except the ones named by --allow (a tool that makes its own, such as `nvim`), whatever a
// test called its folder.
//
// Exit 0: nothing left. Exit 1: the names are listed (at most 30, then the number). Exit 2: wrong arguments, or DIR
// could not be read (a missing DIR included).

import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const SHOWN = 30;
const DEFAULT_PREFIXES = ["tasks-desktop-", "hub-testkit-", "tasks-web-"];

/**
 * The entries of `dir` that count, sorted. `dir` must exist. Without `strict` an entry counts when its name starts with
 * one of `prefixes`; with it every entry counts that is not in `allow`.
 */
function leftovers(dir, { prefixes, strict, allow }) {
  const names = readdirSync(dir);
  const found = strict ? names.filter((n) => !allow.includes(n)) : names.filter((n) => prefixes.some((p) => n.startsWith(p)));
  return found.sort();
}

function parse(argv) {
  const out = { dir: tmpdir(), prefixes: [], strict: false, allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = i + 1 < argv.length ? argv[i + 1] : "";
    if (flag === "--strict") {
      out.strict = true;
    } else if ((flag === "--dir" || flag === "--prefix" || flag === "--allow") && value !== "") {
      i++;
      if (flag === "--dir") out.dir = value;
      else if (flag === "--prefix") out.prefixes.push(value);
      else out.allow.push(value);
    } else {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
  }
  if (out.allow.length > 0 && !out.strict) throw new Error("--allow only goes with --strict");
  if (out.strict && out.prefixes.length > 0) throw new Error("--prefix does not go with --strict (it counts every entry)");
  if (out.prefixes.length === 0) out.prefixes = DEFAULT_PREFIXES;
  return out;
}

function main(argv) {
  let args;
  try {
    args = parse(argv);
  } catch (e) {
    console.error(
      `${e.message}\nusage: node tools/check-temp-leftovers.mjs [--dir DIR] [--prefix PREFIX]... [--strict [--allow NAME]...]`,
    );
    return 2;
  }
  let found;
  try {
    found = leftovers(args.dir, args);
  } catch (e) {
    console.error(`cannot read ${args.dir}: ${e.message}`);
    return 2;
  }
  const what = args.strict ? "entries" : args.prefixes.map((p) => `${p}*`).join(", ");
  if (found.length === 0) {
    console.log(`nothing (${what}) left in ${args.dir}`);
    return 0;
  }
  console.error(`${found.length} ${what} left in ${args.dir}:`);
  for (const name of found.slice(0, SHOWN)) console.error(`  ${name}`);
  if (found.length > SHOWN) console.error(`  ... and ${found.length - SHOWN} more`);
  console.error("a test made a folder in the temp dir and did not remove it; get the folder from the test helper");
  return 1;
}

// Always runs, however it was started (a junction or a symlink to this folder included): a check that is skipped
// because of the way it was called passes with no output, which reads as "nothing left".
process.exitCode = main(process.argv.slice(2));
