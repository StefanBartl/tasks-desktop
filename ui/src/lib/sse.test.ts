import { describe, expect, it } from 'vitest';
import { backoffSeconds, SseParser } from './sse';

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
