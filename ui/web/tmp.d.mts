// Types of tmp.mjs, for the Playwright projects (TypeScript) that use it.

export interface RemoveOptions {
  /** how often a busy file is tried again (the loop is in tmp.mjs; `fs.rmSync` retries nothing) */
  retries?: number;
  /** ms between two tries */
  delay?: number;
  /** replaces `fs.rmSync`; for the tests of tmp.mjs */
  rm?: (path: string, options: { recursive: boolean; force: boolean }) => void;
  /** replaces the wait between two tries; for the tests of tmp.mjs */
  sleep?: (ms: number) => void;
}

export function removeTree(path: string, options?: RemoveOptions): void;
export function cleanUp(options?: RemoveOptions): void;
export function tempRoot(name?: string): string;
export function tempDir(label: string, root?: string): string;
export function testDir(t: { after: (fn: () => void) => void }, label: string): string;
