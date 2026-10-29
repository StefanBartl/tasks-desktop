// The work of tools/run-with-temp.mjs (see there for what it does and how it is called). In a file of its own so that the
// tests can run `main` in a process and send it the signals a terminal would.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTree } from "../ui/web/tmp.mjs";

const check = join(dirname(fileURLToPath(import.meta.url)), "check-temp-leftovers.mjs");
const USAGE = "usage: node tools/run-with-temp.mjs [--strict [--allow NAME]...] [--prefix PREFIX]... -- COMMAND [ARGS...]";
const SIGNALS = { SIGINT: 130, SIGTERM: 143 };

/** The flags before `--` (they go to the check) and the command after it. */
function parse(argv) {
  const split = argv.indexOf("--");
  if (split < 0) throw new Error("no `--` before the command");
  const flags = argv.slice(0, split);
  const command = argv.slice(split + 1);
  if (command.length === 0) throw new Error("no command after `--`");
  return { flags, command };
}

function quote(arg) {
  if (/^[\w@+=:,./\\-]+$/.test(arg)) return arg;
  if (/["%]/.test(arg)) throw new Error(`cannot pass this argument through the Windows shell: ${arg}`);
  return `"${arg}"`;
}

/** End the command and what it started. On Windows the shell is the child and the program is below it: the tree goes. */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

/** Runs the command; resolves with `{ status, signal, error }` when it is over. */
function runCommand(command, env, onStart) {
  return new Promise((done) => {
    let child;
    try {
      child =
        process.platform === "win32"
          ? spawn(command.map(quote).join(" "), { stdio: "inherit", env, shell: true })
          : spawn(command[0], command.slice(1), { stdio: "inherit", env });
    } catch (e) {
      console.error(e.message);
      done({ status: 2 });
      return;
    }
    onStart(child);
    child.once("error", (error) => done({ status: null, error }));
    child.once("close", (status, signal) => done({ status, signal }));
  });
}

/**
 * Runs the command, checks the temp dir, removes it. Returns the exit code. A SIGINT or SIGTERM to this process does not
 * end it before the cleanup (that left `run-with-temp-XXXX` in the temp dir after a Ctrl-C): the command is waited for,
 * the check and the removal run, and the exit code is the one of the signal (130, 143) unless the command failed.
 * A terminal sends Ctrl-C to the whole process group, so the command has got it too; one that has not ended `graceMs`
 * after a SIGINT is ended here. A SIGTERM goes to the command at once.
 */
export async function main(argv, { graceMs = 10_000 } = {}) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const { flags, command } = parsed;
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "run-with-temp-"));
  console.log(`temp dir of this command: ${dir}`);
  const env = { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir };

  let child;
  let signalled = null;
  const timers = [];
  const handlers = Object.keys(SIGNALS).map((signal) => {
    const handler = () => {
      signalled ??= signal;
      if (signal === "SIGTERM") stop(child);
      else timers.push(setTimeout(() => stop(child), graceMs));
    };
    process.on(signal, handler);
    return [signal, handler];
  });

  const ran = await runCommand(command, env, (started) => {
    child = started;
  });
  for (const timer of timers) clearTimeout(timer);
  for (const [signal, handler] of handlers) process.off(signal, handler);

  const looked = spawnSync(process.execPath, [check, "--dir", dir, ...flags], { stdio: "inherit" });
  try {
    removeTree(dir, { retries: 20, delay: 100 });
  } catch (e) {
    // a cache the tool still holds; the folder is not the tests' and not a failure of them
    console.error(`could not remove ${dir}: ${e.message}`);
  }
  if (ran.error) console.error(`could not run ${command[0]}: ${ran.error.message}`);
  if (signalled !== null) return SIGNALS[signalled];
  if (ran.status !== 0) return ran.status ?? 1;
  return looked.status ?? 1;
}
