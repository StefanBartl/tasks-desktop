import { describe, expect, it } from 'vitest';
import { Hub } from './api';

/** A fetch that answers each call with the next response, after the next gate. */
function scripted(steps: { status: number; gate?: Promise<void> }[], sent: (auth: string | null) => void): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    sent(new Headers(init?.headers).get('Authorization'));
    const step = steps.shift() ?? { status: 200 };
    if (step.gate) await step.gate;
    return new Response('{}', { status: step.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

describe('the hub client and a refusal', () => {
  it('tells the page the session is gone when the token that was sent is the one it holds', async () => {
    const hub = new Hub(scripted([{ status: 401 }], () => undefined));
    hub.setToken('old');
    let told = 0;
    hub.onUnauthorized = () => (told += 1);
    await expect(hub.areas()).rejects.toBeDefined();
    expect(told).toBe(1);
  });

  it('ignores a late refusal of a question asked with a token that is no longer the one held', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const seen: (string | null)[] = [];
    const hub = new Hub(scripted([{ status: 401, gate }], (a) => seen.push(a)));
    hub.setToken('old');
    let told = 0;
    hub.onUnauthorized = () => (told += 1);
    const late = hub.areas().catch(() => undefined);
    // The page got a fresh session while the old question was on its way.
    hub.setToken('fresh');
    release();
    await late;
    expect(seen).toEqual(['Bearer old']);
    expect(told).toBe(0);
  });
});

describe('the order of the list', () => {
  /** A hub that answers `list` pages from the tasks it holds; `change` runs before the page at that index is answered. */
  function listing(pages: { ids: string[]; total: number }[], urls: string[]): typeof fetch {
    let n = 0;
    return (async (url: unknown) => {
      urls.push(String(url));
      const page = pages[Math.min(n, pages.length - 1)]!;
      const last = n >= pages.length - 1;
      n += 1;
      const doc = {
        rev: 'rev:1',
        total: page.total,
        items: page.ids.map((id) => ({ id })),
        ...(last ? {} : { next_offset: n * 100 }),
      };
      return new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  }

  it('puts the pages together in the order the engine gave them', async () => {
    const urls: string[] = [];
    const hub = new Hub(
      listing(
        [
          { ids: ['a/1', 'a/2'], total: 3 },
          { ids: ['a/3'], total: 3 },
        ],
        urls,
      ),
    );
    expect((await hub.order('roi')).ids).toEqual(['a/1', 'a/2', 'a/3']);
    expect(urls).toEqual([
      '/api/tasks/list?sort=roi&limit=100&offset=0',
      '/api/tasks/list?sort=roi&limit=100&offset=100',
    ]);
  });

  it('reads the pages again when the number of tasks changed between two of them', async () => {
    const urls: string[] = [];
    const hub = new Hub(
      listing(
        [
          { ids: ['a/1'], total: 2 },
          { ids: ['a/2'], total: 3 },
          { ids: ['a/1', 'a/2'], total: 3 },
          { ids: ['a/3'], total: 3 },
        ],
        urls,
      ),
    );
    expect((await hub.order('severity')).ids).toEqual(['a/1', 'a/2', 'a/3']);
    expect(urls.length).toBe(4);
  });
});
