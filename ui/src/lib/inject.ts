// What a native shell hands the page before it runs: read once and cleared, so the page keeps no copy of a code.

/**
 * Take the value of the global `name` and remove it. A shell may have defined the global so that it cannot be
 * deleted; in a module `delete` then throws, and the page must still start: the value is overwritten instead, and
 * when that is refused too it stays where it is (the code is also checked and spent by the hub on the first use).
 */
export function takeInjected(target: object, name: string): unknown {
  const holder = target as Record<string, unknown>;
  let value: unknown;
  try {
    value = holder[name];
  } catch {
    return undefined;
  }
  try {
    delete holder[name];
  } catch {
    try {
      holder[name] = undefined;
    } catch {
      // Nothing more can be done: the value is the shell's.
    }
  }
  return value;
}
