// A server-sent-event parser for a `fetch` stream. `EventSource` cannot
// send an Authorization header, so the stream is read by hand (concept 5.6).

export interface SseMessage {
  event: string;
  data: string;
}

/** Feed it text as it arrives; it returns the messages that are complete. */
export class SseParser {
  private buffer = '';

  push(text: string): SseMessage[] {
    this.buffer += text;
    const out: SseMessage[] = [];
    // A message ends with an empty line; line ends may be \n, \r\n or \r.
    for (;;) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = parseBlock(block);
      if (message) out.push(message);
    }
    return out;
  }
}

function parseBlock(block: string): SseMessage | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line === '' || line.startsWith(':')) continue; // a comment: the heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0 && event === 'message') return null;
  return { event, data: data.join('\n') };
}

export interface StreamHandlers {
  onOpen(): void;
  onMessage(message: SseMessage): void;
}

/**
 * Read one stream to its end. Resolves when the server closes it, rejects on
 * a refusal or a broken connection; the caller reconnects.
 */
export async function readStream(
  fetchFn: typeof fetch,
  url: string,
  token: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    cache: 'no-store',
    signal,
  });
  if (!response.ok || !response.body) {
    throw new StreamRefused(response.status);
  }
  handlers.onOpen();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      handlers.onMessage(message);
    }
  }
}

export class StreamRefused extends Error {
  constructor(readonly status: number) {
    super(`event stream refused: ${status}`);
  }
}

/** Seconds to wait before the n-th reconnect: 1, 2, 4 ... 30. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30, 2 ** Math.max(0, attempt));
}
