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
  it('asks the hub once and gives the ids in the order the engine named them', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: unknown) => {
      urls.push(String(url));
      const doc = { kind: 'tasks.order', sort: 'roi', total: 3, ids: ['a/3', 'a/1', 'a/2'], incomplete: [] };
      return new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const hub = new Hub(fetchFn);
    expect((await hub.order('roi')).ids).toEqual(['a/3', 'a/1', 'a/2']);
    expect(urls).toEqual(['/api/tasks/order?sort=roi']);
  });

  it('passes a refusal of the hub on', async () => {
    const hub = new Hub((async () => new Response('{}', { status: 400 })) as typeof fetch);
    await expect(hub.order('roi')).rejects.toBeDefined();
  });
});
