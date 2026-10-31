// The kit's hand-written declarations (appkit-web/pack, appkit-web/e2e) against the callers of this app and against
// Playwright's own Page. The callers of these two modules are plain JavaScript (web/pack.mjs, probe/build.mjs) or lie
// outside the type check of src/ (e2e-web/), so without this file a declaration that drifted from them, or a `PageLike`
// that a Playwright `Page` no longer is, would pass `pnpm check`. Nothing here runs: `pnpm check` type-checks it
// (tsconfig.kit.json).

import type { Page } from '@playwright/test';
import {
  assemble,
  checkPartIds,
  CSP_STRICT,
  CSP_WASM_WORKER,
  inlineScript,
  inlineStyle,
  packPart,
  policyProblems,
  readDist,
  verify,
  verifyShell,
  writePage,
  type PageInput,
} from 'appkit-web/pack';
import { idbWrites, spyOnIndexedDb, violations, watchPage, type IdbWrite, type PageLike, type Watch } from 'appkit-web/e2e';

// -- appkit-web/pack, as web/pack.mjs and probe/build.mjs call it ------------------------------------------------

const PART_IDS = ['worker', 'wasm', 'bundle', 'shim'] as const;
const bytes = new Uint8Array([1, 2, 3]);
const parts: Record<string, Uint8Array> = Object.fromEntries(PART_IDS.map((id) => [id, bytes]));
const { css, js }: { css: string; js: string } = readDist('dist-web', 'index.web.html');
const input: PageInput = { css, js, partIds: PART_IDS, parts, csp: CSP_WASM_WORKER, title: 'tasks', comment: 'build' };
const html: string = assemble(input);
// A page without parts: partIds and parts may be left out.
assemble({ css: inlineStyle(css), js: inlineScript(js), csp: CSP_STRICT, title: 'a', comment: 'b' });
const problems: string[] = [...verifyShell(html, { partIds: PART_IDS }), ...verifyShell(html), ...verify(html, { allowUrls: ['https://example.invalid/'] }), ...verify(html)];
const loose: string[] = policyProblems(CSP_STRICT);
const ids: readonly string[] = checkPartIds(PART_IDS);
const packed: string = packPart(bytes);
const sha: string = writePage('dist-web', 'tasks.html', html);

// -- appkit-web/e2e, with Playwright's Page as e2e-web/page.ts gives it ------------------------------------------

declare const page: Page;
// A Playwright Page is the kit's PageLike.
const like: PageLike = page;
async function watched(): Promise<[Watch, string[], IdbWrite[]]> {
  const watch: Watch = await watchPage(page, { pageUrl: 'file:///tasks.html' });
  await spyOnIndexedDb(page);
  const writes: IdbWrite[] = await idbWrites(page);
  const said: string[] = await violations(like);
  const all: string[] = [...watch.requests, ...watch.violations, ...watch.errors];
  return [watch, [...said, ...all], writes.filter((w) => w.db !== '' && w.store !== '' && w.json !== '' && w.op !== 'clear')];
}

export const checked = [problems, loose, ids, packed, sha, watched] as const;
