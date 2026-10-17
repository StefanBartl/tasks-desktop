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
