// Full-text search over the texts of the tasks for the web variant: the search of the Rust hub (appkit-hub
// `search.rs`, the `SearchIndex` behind `GET /api/tasks/search`), done in the page. The texts come from the engine's
// own call `bodies`, as the Rust hub asks for them, and are kept in memory; the hub (hub.ts) throws them away when the
// vault was read again and reads them anew on the next search.
//
// The rules are those of the Rust hub, so that a query finds the same tasks in both: a query is up to eight words,
// all of which must be in a text; case is folded one character to one character (the first of its lowercase form),
// so that a position in the folded text is the position in the text that is shown; the score counts each word up to
// five times and adds ten when the words stand together as the query has them; a snippet is the text from 60
// characters before the first match to 100 after it, its marks in UTF-16 units. Positions are counted in characters
// (code points) as Rust counts them, never in UTF-16 units, except for the marks.

/** Tasks asked for in one call (the engine ends a page earlier by bytes). */
export const PAGE = 1000;
/** Pages read before the reading gives up (a loop that does not end). */
const MAX_PAGES = 50;
/** Tries when the vault changes while the pages are read. */
const BUILD_TRIES = 3;
/** The most text held (the bodies in UTF-8 bytes, as Rust counts them). Beyond it the rest is not searched. */
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;

export const MAX_QUERY_CHARS = 200;
export const MAX_TOKENS = 8;
export const MIN_QUERY_CHARS = 2;
export const MAX_HITS = 50;
/** How much text before and after the first match a snippet carries, in characters. */
const BEFORE = 60;
const AFTER = 100;

const CONTROL = /\p{Cc}/u;
const WHITE = /\p{White_Space}+/u;

const foldedChars = new Map<string, string>();

/** One character folded: the first character of its lowercase form. */
function foldChar(c: string): string {
  let out = foldedChars.get(c);
  if (out === undefined) {
    const lower = c.toLowerCase();
    out = String.fromCodePoint(lower.codePointAt(0) ?? c.codePointAt(0) ?? 0);
    foldedChars.set(c, out);
  }
  return out;
}

/**
 * Lowercase, one character for one (`fold` of the Rust hub). Not `toLowerCase` of the whole text: that one turns a
 * character into two (`İ`) and looks at the neighbours of a sigma, and the positions would no longer be the text's.
 */
export function fold(text: string): string {
  return text.replace(/[A-Z]+|[^\x00-\x7f]/gu, (m) => (m.charCodeAt(0) < 0x80 ? m.toLowerCase() : foldChar(m)));
}

/** The number of characters (code points) of `text`. */
function charCount(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // A low surrogate after a high one is the second half of one character.
    if (c < 0xdc00 || c > 0xdfff || i === 0 || text.charCodeAt(i - 1) < 0xd800 || text.charCodeAt(i - 1) > 0xdbff) n++;
  }
  return n;
}

/** The length of `text` in UTF-8 bytes, without encoding it. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** A query, read: folded words, all of which must be in a text. */
export interface Query {
  tokens: string[];
  /** The words in their order, joined by one space: a text that holds it whole ranks higher. */
  phrase: string;
}

/** The query of `text`, or a word of why it is not one (`Query::parse`). */
export function parseQuery(text: string): Query | string {
  if (CONTROL.test(text)) return 'the query holds a control character';
  const words = fold(text)
    .split(WHITE)
    .filter((w) => w !== '');
  const tokens: string[] = [];
  for (const word of words) if (!tokens.includes(word)) tokens.push(word);
  const chars = tokens.reduce((sum, t) => sum + charCount(t), 0);
  if (tokens.length === 0 || chars < MIN_QUERY_CHARS) return 'the query is too short';
  if (charCount(text) > MAX_QUERY_CHARS) return 'the query is too long';
  if (tokens.length > MAX_TOKENS) return 'the query has too many words';
  return { tokens, phrase: words.join(' ') };
}

/** What `encodeURIComponent` leaves alone, and the escapes. Nothing else is on the line. */
const ESCAPED = /^[A-Za-z0-9%\-_.!~*'()]*$/;

/** The text of an escaped value, or the word of why it is none. */
function percentDecode(value: string): { text: string } | string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '%') {
      const hex = value.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return 'a broken escape';
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(value.charCodeAt(i));
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)) };
  } catch {
    return 'the query is not UTF-8';
  }
}

/** The text of the `q` of a request, percent-decoded, and `limit` (`parse_request`); or a word of what is wrong. */
export function parseRequest(raw: string): { text: string; limit: number } | string {
  if (raw === '') return 'q is needed';
  let q: string | null = null;
  let limit = 20;
  for (const pair of raw.split('&')) {
    const cut = pair.indexOf('=');
    if (cut < 0) return 'a query part has no value';
    const key = pair.slice(0, cut);
    const value = pair.slice(cut + 1);
    if (!ESCAPED.test(value)) return 'a query value is not escaped text';
    if (key === 'q') {
      if (q !== null) return 'q is given twice';
      const decoded = percentDecode(value);
      if (typeof decoded === 'string') return decoded;
      q = decoded.text;
    } else if (key === 'limit') {
      const n = /^[0-9]+$/.test(value) ? Number(value) : NaN;
      if (!(n >= 1 && n <= MAX_HITS)) return `limit is 1 to ${MAX_HITS}`;
      limit = n;
    } else return 'unknown query parameter';
  }
  return q === null ? 'q is needed' : { text: q, limit };
}

export interface Entry {
  id: string;
  body: string;
  folded: string;
}

export interface Corpus {
  /** The `rev` of the bodies: the state of the vault they were read from. */
  rev: string | null;
  entries: Entry[];
  /** Not every text is in: the limit was reached. */
  partial: boolean;
}

/** A piece of a body around a match. `marks` are `[start, end)` in UTF-16 units of `text`. */
export interface Snippet {
  text: string;
  marks: Array<[number, number]>;
  more_before: boolean;
  more_after: boolean;
}

export interface Hit {
  id: string;
  score: number;
  snippet: Snippet;
}

export interface Outcome {
  total: number;
  hits: Hit[];
}

export function entryOf(id: string, body: string): Entry {
  return { id, body, folded: fold(body) };
}

/** How many times `token` is in `folded`, without overlap, at most `max`. */
function count(folded: string, token: string, max: number): number {
  let n = 0;
  for (let at = folded.indexOf(token); at >= 0 && n < max; at = folded.indexOf(token, at + token.length)) n++;
  return n;
}

function matchesIn(folded: string, query: Query): number | null {
  let score = 0;
  for (const token of query.tokens) {
    const n = count(folded, token, 5);
    if (n === 0) return null;
    score += n;
  }
  if (query.tokens.length > 1 && folded.includes(query.phrase)) score += 10;
  return score;
}

/** Every `[start, end)` of a token in the characters `from`..`to` of `chars`, in characters, ordered and merged. */
function tokenRanges(chars: string[], tokens: string[], from: number, to: number): Array<[number, number]> {
  const window = chars.slice(from, to);
  const text = window.join('');
  // UTF-16 offset of a character of the window -> its index.
  const indexOf = new Map<number, number>();
  for (let i = 0, at = 0; i <= window.length; i++) {
    indexOf.set(at, i);
    at += window[i]?.length ?? 0;
  }
  const found: Array<[number, number]> = [];
  for (const token of tokens) {
    const tokenChars = charCount(token);
    for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + token.length)) {
      const start = from + (indexOf.get(at) ?? 0);
      found.push([start, start + tokenChars]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of found) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function snippet(entry: Entry, query: Query): Snippet {
  const folded = Array.from(entry.folded);
  // The first place the whole phrase is, else the first word.
  const anchor = query.tokens.length > 1 && entry.folded.includes(query.phrase) ? query.phrase : query.tokens[0] ?? '';
  const at = entry.folded.indexOf(anchor);
  const anchorChars = at < 0 ? 0 : charCount(entry.folded.slice(0, at));
  const start = Math.max(0, anchorChars - BEFORE);
  const end = Math.min(anchorChars + charCount(anchor) + AFTER, folded.length);
  const body = Array.from(entry.body);
  const shown = body.slice(Math.min(start, body.length), Math.min(end, body.length)).map((c) => (CONTROL.test(c) ? ' ' : c));
  // UTF-16 offsets of every character of the window.
  const units: number[] = [];
  let unit = 0;
  for (const c of shown) {
    units.push(unit);
    unit += c.length;
  }
  units.push(unit);
  const marks: Array<[number, number]> = [];
  for (const [s, e] of tokenRanges(folded, query.tokens, start, end)) {
    const a = units[s - start];
    const b = units[e - start];
    if (a !== undefined && b !== undefined) marks.push([a, b]);
  }
  return { text: shown.join(''), marks, more_before: start > 0, more_after: end < folded.length };
}

/** The hits for a query, best first; among equals in the order of the corpus (the plan order of the engine). */
export function search(corpus: Corpus, query: Query, limit: number): Outcome {
  const scored: Array<[number, number]> = [];
  corpus.entries.forEach((e, i) => {
    const score = matchesIn(e.folded, query);
    if (score !== null) scored.push([score, i]);
  });
  scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const hits: Hit[] = [];
  for (const [score, i] of scored.slice(0, Math.min(Math.max(limit, 1), MAX_HITS))) {
    const entry = corpus.entries[i];
    if (entry) hits.push({ id: entry.id, score, snippet: snippet(entry, query) });
  }
  return { total: scored.length, hits };
}

/** One page of the engine's `bodies`, as far as the search needs it. */
interface Page {
  rev?: unknown;
  items?: Array<{ id?: unknown; body?: unknown }>;
  next_offset?: unknown;
}

/**
 * Read every body, a page at a time, as the Rust hub builds its index (`read_all`): a page whose `rev` differs from
 * the first one's means the vault changed under the reading, and it starts again. `page` asks the engine for one page
 * and answers its document, or throws.
 */
export async function readCorpus(
  page: (params: { offset: number; limit: number }) => Promise<string>,
  maxBytes = MAX_INDEX_BYTES,
): Promise<Corpus> {
  tries: for (let attempt = 0; attempt < BUILD_TRIES; attempt++) {
    const entries: Entry[] = [];
    let rev: string | null = null;
    let offset = 0;
    let bytes = 0;
    for (let n = 0; n < MAX_PAGES; n++) {
      const doc = JSON.parse(await page({ offset, limit: PAGE })) as Page;
      const pageRev = typeof doc.rev === 'string' ? doc.rev : null;
      // The vault changed under the reading.
      if (entries.length > 0 && pageRev !== rev) continue tries;
      rev = pageRev;
      for (const item of doc.items ?? []) {
        if (typeof item.id !== 'string') continue;
        const body = typeof item.body === 'string' ? item.body : '';
        bytes += utf8Length(body);
        if (bytes > maxBytes) return { rev, entries, partial: true };
        entries.push(entryOf(item.id, body));
      }
      const next = doc.next_offset;
      if (typeof next === 'number' && next > offset) offset = next;
      else return { rev, entries, partial: false };
    }
    throw new Error('the bodies did not end');
  }
  throw new Error('the vault kept changing while it was read');
}
