#!/usr/bin/env node
// Run a command with a temp dir of its own, empty at the start, and fail when it left something of ours in it.
//
//     node tools/run-with-temp.mjs [--strict [--allow NAME]...] [--prefix PREFIX]... -- COMMAND [ARGS...]
//
// TEMP, TMP and TMPDIR of the command point at a new folder below RUNNER_TEMP (the temp dir of the process when that is
// not set), so os.tmpdir() of Node and the temp dir of Chrome, Playwright and the Rust tests are all inside it. When the
// command is over, tools/check-temp-leftovers.mjs looks into the folder (its flags are the ones given here), and the
// folder is removed (a file that is busy for a moment is tried again, see ui/web/tmp.mjs).
//
// Why one folder per command and not one for a whole job: the shared temp dir of a machine holds the leftovers of every
// earlier run (24918 folders at the last count), so a count in it is never zero. And Chrome, Playwright and Node keep
// caches of their own in the temp dir (chrome_chrome_url_fetcher_*, playwright-transform-cache, node-compile-cache):
// those belong to the tools, not to the tests. So the browser and Node steps use the default of the check, which counts
// the names the tests use (`tasks-desktop-*`, `tasks-web-*`, `hub-testkit-*`; web/tmp.mjs gives every folder such a name,
// and web/tmp.test.mjs holds the sources to that). `--strict` counts every entry and is for steps that run no tool with
// a cache of its own (cargo test, see ci.yml).
//
// Ctrl-C (SIGINT) and SIGTERM do not end this process before the cleanup: the command is waited for, then the check and
// the removal run, and the exit code is 130 or 143. (Without that a Ctrl-C left `run-with-temp-XXXX` behind.)
//
// The exit code is the one of the command when it failed, else the one of the check (1: something was left; 2: wrong
// arguments or the folder could not be read). On Windows the command runs in a shell (pnpm is a .cmd file there), and the
// arguments are joined with spaces: one with a space in it is quoted here, one with a double quote or a % is refused.

import { main } from "./run-with-temp-lib.mjs";

process.exitCode = await main(process.argv.slice(2));
