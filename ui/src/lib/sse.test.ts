import { describe, expect, it } from 'vitest';
import { backoffSeconds, MAX_BUFFER, readStream, SseParser } from './sse';

describe('SseParser', () => {
  it('returns a message only when it is complete', () => {
    const p = new SseParser();
    expect(p.push('event: tasks\ndata: {"seq"')).toEqual([]);
    expect(p.push(':1}\n\n')).toEqual([{ event: 'tasks', data: '{"seq":1}' }]);
  });
  it('skips the heartbeat comment', () => {
    expect(new SseParser().push(': ping\n\n')).toEqual([]);
  });
  it('reads several messages and CRLF', () => {
    const out = new SseParser().push('event: hello\r\ndata: {}\r\n\r\nevent: resync\ndata: {}\n\n');
    expect(out.map((m) => m.event)).toEqual(['hello', 'resync']);
  });
  it('joins data lines and takes a message without an event as `message`', () => {
    expect(new SseParser().push('data: a\ndata: b\n\n')).toEqual([
      { event: 'message', data: 'a\nb' },
    ]);
  });
  it('backs off to thirty seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffSeconds)).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
  });
});

describe('SseParser limits', () => {
  it('gives up on a message that never ends', () => {
    const p = new SseParser();
    expect(() => p.push('data: ' + 'x'.repeat(MAX_BUFFER + 1))).toThrow();
  });
});

describe('readStream', () => {
  it('cuts a stream that says nothing for too long', async () => {
    // A body that never yields and ends only when it is cancelled.
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    let opened = false;
    const started = Date.now();
    await expect(
      readStream(
        fetchFn,
        '/x',
        't',
        { onOpen: () => (opened = true), onMessage: () => {} },
        new AbortController().signal,
        60,
      ),
    ).rejects.toThrow();
    expect(opened).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports a refusal with its status', async () => {
    const fetchFn = (async () => new Response('', { status: 401 })) as typeof fetch;
    await expect(
      readStream(fetchFn, '/x', 't', { onOpen: () => {}, onMessage: () => {} }, new AbortController().signal),
    ).rejects.toMatchObject({ status: 401 });
  });
});
