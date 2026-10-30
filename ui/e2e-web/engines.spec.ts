// What each engine offers of the browser APIs the page needs, asked in the page itself (opened from disk): the record
// of the README's table of browsers is this test, not a web page about them. Each project names what it must have;
// the rest is written to the report (`engine-apis.json`) as found.

import { expect, test } from '@playwright/test';
import { pageUrl } from './page';

interface Apis {
  userAgent: string;
  secureContext: boolean;
  showDirectoryPicker: boolean;
  webkitdirectory: boolean;
  /** Origin Private File System (`navigator.storage.getDirectory`), opened for real. */
  opfs: string;
  decompressionStream: boolean;
  fromBase64: boolean;
  indexedDb: boolean;
  /** A classic worker made from a blob URL that instantiates a tiny WebAssembly module. */
  blobWorkerWasm: string;
}

test('the browser APIs of the page, as this engine has them', async ({ page }, testInfo) => {
  await page.goto(pageUrl());
  await expect(page.getByRole('heading', { name: /Open a vault|Vault öffnen/ })).toBeVisible();
  const apis: Apis = await page.evaluate(async () => {
    const opfs = await (async () => {
      try {
        await navigator.storage.getDirectory();
        return 'yes';
      } catch (error) {
        return `no (${error instanceof Error ? error.name : String(error)})`;
      }
    })();
    const blobWorkerWasm = await new Promise<string>((resolve) => {
      // The smallest valid module: magic and version.
      const source = `onmessage = async () => { try { await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0])); postMessage('yes'); } catch (e) { postMessage('no (' + e + ')'); } };`;
      try {
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        worker.onmessage = (event) => resolve(String(event.data));
        worker.onerror = () => resolve('no (worker error)');
        worker.postMessage(0);
      } catch (error) {
        resolve(`no (${String(error)})`);
      }
    });
    return {
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      showDirectoryPicker: typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function',
      webkitdirectory: 'webkitdirectory' in document.createElement('input'),
      opfs,
      decompressionStream: typeof DecompressionStream === 'function',
      fromBase64: typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 === 'function',
      indexedDb: typeof indexedDB === 'object' && indexedDB !== null,
      blobWorkerWasm,
    };
  });
  await testInfo.attach('engine-apis.json', { body: JSON.stringify({ project: testInfo.project.name, ...apis }, null, 2), contentType: 'application/json' });
  console.log(`[engine-apis] ${testInfo.project.name} ${JSON.stringify(apis)}`);

  // What the page needs in every engine it starts in: the engine itself, its bytes, the way in to a folder.
  expect(apis.blobWorkerWasm).toBe('yes');
  expect(apis.decompressionStream).toBe(true);
  expect(apis.indexedDb).toBe(true);
  expect(apis.webkitdirectory).toBe(true);
  // The picker is Chromium's alone; the read only way in is for the others (readonly.spec.ts).
  expect(apis.showDirectoryPicker).toBe(testInfo.project.name === 'chrome');
});
