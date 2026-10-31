// The data classes of the areas in the web variant: `areas.json` of the vault folder, read the way crates/tasks-hub/src/
// classes.rs reads it. The same two schemas, the same refusals, the same fail-closed rule: an area the file does not
// name is `unclassified`, and so is every area when the file is not usable.
//
// Differences from the Rust hub, all on purpose:
//   - The hub reads `<config>/areas.json`, outside the vault. A page without an install has no config folder, so the
//     file is the one at the root of the folder the person chose (the one place the page can read).
//   - The hub does not start with a file that cannot be used. The page does start (it is a tool for reading) but shows
//     every area as unclassified, which releases nothing; `problem` says why, for the person to see.
//   - A page has one vault. It is the vault `main` of the file: schema 1 is the classes of `main`, and of schema 2 the
//     entries `main:<area>` and the `default` of `main`. Entries of other vaults are checked (a typo in them still
//     refuses the file, as in Rust) and then not used.
//
// The parser is strict the way serde_json is: where this and Rust could differ, the file must be refused here. A JSON
// parser of the browser takes what serde refuses (a duplicate key in an entry keeps the last value, `1.0` is a 1, a lone
// surrogate becomes U+FFFD), and `{"class":"private","class":"public"}` would then release an area that Rust keeps
// closed. So the text is parsed by hand into a tree that keeps duplicates and the spelling of numbers.

import type { DataClass } from './hub.ts';
import { validAreaName } from './hub.ts';
import type { Skipped } from './vault-files.ts';

/** The largest file that is read (`MAX_FILE_BYTES` of classes.rs). */
export const MAX_FILE_BYTES = 256 * 1024;
/** The most areas a file may name (`MAX_AREAS`). */
export const MAX_AREAS = 1000;
/** The vault of this page: the only one the file is asked about. */
export const VAULT = 'main';

const CLASS_WORDS = ['public', 'internal', 'private'] as const;
type Class = (typeof CLASS_WORDS)[number];

// -- JSON, as strictly as serde_json -------------------------------------------------------------------------------

type Json =
  | { kind: 'null' }
  | { kind: 'bool' }
  | { kind: 'number'; text: string }
  | { kind: 'string'; value: string }
  | { kind: 'array'; items: Json[] }
  | { kind: 'object'; pairs: Array<[string, Json]> };

/** serde_json refuses a value nested 128 levels deep (its `remaining_depth` runs out at the 128th container). */
const MAX_DEPTH = 127;

function reject(why: string): never {
  throw new Error(why);
}

function parseStrict(text: string): Json {
  let at = 0;

  const skip = (): void => {
    // JSON white space, nothing more (not U+00A0, not a byte order mark).
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d) at += 1;
      else break;
    }
  };

  const hex4 = (): number => {
    const part = text.slice(at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(part)) reject('invalid \\u escape');
    at += 4;
    return parseInt(part, 16);
  };

  const string = (): string => {
    at += 1; // the opening quote
    let out = '';
    for (;;) {
      if (at >= text.length) reject('unterminated string');
      const c = text[at] as string;
      const code = text.charCodeAt(at);
      at += 1;
      if (c === '"') return out;
      if (code < 0x20) reject('control character in string');
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = text[at];
      at += 1;
      switch (e) {
        case '"':
        case '\\':
        case '/':
          out += e;
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const first = hex4();
          if (first >= 0xdc00 && first <= 0xdfff) reject('lone surrogate in escape');
          if (first >= 0xd800 && first <= 0xdbff) {
            if (text[at] !== '\\' || text[at + 1] !== 'u') reject('lone surrogate in escape');
            at += 2;
            const second = hex4();
            if (second < 0xdc00 || second > 0xdfff) reject('lone surrogate in escape');
            out += String.fromCharCode(first, second);
          } else {
            out += String.fromCharCode(first);
          }
          break;
        }
        default:
          reject('invalid escape');
      }
    }
  };

  const number = (): Json => {
    const start = at;
    if (text[at] === '-') at += 1;
    if (text[at] === '0') {
      at += 1;
      if (/[0-9]/.test(text[at] ?? '')) reject('leading zero');
    } else if (/[1-9]/.test(text[at] ?? '')) {
      while (/[0-9]/.test(text[at] ?? '')) at += 1;
    } else {
      reject('invalid number');
    }
    if (text[at] === '.') {
      at += 1;
      if (!/[0-9]/.test(text[at] ?? '')) reject('invalid number');
      while (/[0-9]/.test(text[at] ?? '')) at += 1;
    }
    if (text[at] === 'e' || text[at] === 'E') {
      at += 1;
      if (text[at] === '+' || text[at] === '-') at += 1;
      if (!/[0-9]/.test(text[at] ?? '')) reject('invalid number');
      while (/[0-9]/.test(text[at] ?? '')) at += 1;
    }
    return { kind: 'number', text: text.slice(start, at) };
  };

  const word = (literal: string): void => {
    if (text.slice(at, at + literal.length) !== literal) reject('invalid literal');
    at += literal.length;
  };

  const value = (depth: number): Json => {
    skip();
    const c = text[at];
    if (c === '{') {
      if (depth >= MAX_DEPTH) reject('nested too deep');
      at += 1;
      const pairs: Array<[string, Json]> = [];
      skip();
      if (text[at] === '}') {
        at += 1;
        return { kind: 'object', pairs };
      }
      for (;;) {
        skip();
        if (text[at] !== '"') reject('a key must be a string');
        const key = string();
        skip();
        if (text[at] !== ':') reject('expected a colon');
        at += 1;
        pairs.push([key, value(depth + 1)]);
        skip();
        if (text[at] === ',') {
          at += 1;
          continue;
        }
        if (text[at] === '}') {
          at += 1;
          return { kind: 'object', pairs };
        }
        reject('expected a comma or the end of the object');
      }
    }
    if (c === '[') {
      if (depth >= MAX_DEPTH) reject('nested too deep');
      at += 1;
      const items: Json[] = [];
      skip();
      if (text[at] === ']') {
        at += 1;
        return { kind: 'array', items };
      }
      for (;;) {
        items.push(value(depth + 1));
        skip();
        if (text[at] === ',') {
          at += 1;
          continue;
        }
        if (text[at] === ']') {
          at += 1;
          return { kind: 'array', items };
        }
        reject('expected a comma or the end of the list');
      }
    }
    if (c === '"') return { kind: 'string', value: string() };
    if (c === 't' || c === 'f') {
      word(c === 't' ? 'true' : 'false');
      return { kind: 'bool' };
    }
    if (c === 'n') {
      word('null');
      return { kind: 'null' };
    }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number();
    return reject(c === undefined ? 'unexpected end of the file' : 'unexpected character');
  };

  const top = value(0);
  skip();
  if (at !== text.length) reject('characters after the value');
  return top;
}

// -- the shapes of classes.rs ------------------------------------------------------------------------------------

/**
 * A serde struct with `deny_unknown_fields`: a JSON object (a name twice is an error, so is a name that is not a field)
 * or a JSON list in the order of the fields (serde_json reads a struct from either; more elements than fields is an
 * error). Fields the input leaves out are `undefined`.
 */
function struct(json: Json, names: readonly string[], what: string): Array<Json | undefined> {
  const slots: Array<Json | undefined> = names.map(() => undefined);
  if (json.kind === 'object') {
    for (const [key, item] of json.pairs) {
      const index = names.indexOf(key);
      if (index < 0) reject(`${what}: unknown field ${JSON.stringify(key.slice(0, 40))}`);
      if (slots[index] !== undefined) reject(`${what}: duplicate field ${key}`);
      slots[index] = item;
    }
    return slots;
  }
  if (json.kind === 'array') {
    if (json.items.length > names.length) reject(`${what}: too many elements`);
    json.items.forEach((item, index) => {
      slots[index] = item;
    });
    return slots;
  }
  return reject(`${what}: expected an object`);
}

/** A serde map with string keys: an object. A key twice is not an error; the last value wins. */
function mapOf<T>(json: Json | undefined, what: string, one: (item: Json, key: string) => T): Map<string, T> {
  if (json === undefined) return reject(`${what}: missing`);
  if (json.kind !== 'object') return reject(`${what}: expected an object`);
  const out = new Map<string, T>();
  // Every value is read, also one a later duplicate replaces: a bad one refuses the file.
  for (const [key, item] of json.pairs) out.set(key, one(item, key));
  return out;
}

const isClassWord = (word: string): word is Class => (CLASS_WORDS as readonly string[]).includes(word);

/**
 * A `Class`, a unit enum, read as serde_json reads it: the name as a text (`"public"`), or a map of exactly one pair,
 * the name and `null` (`{"public":null}`, the externally tagged form of a unit variant). An empty map, two names, a value
 * that is not null, an unknown name and a list are refused, as by serde.
 */
function asClass(json: Json | undefined, what: string): Class {
  if (json?.kind === 'string' && isClassWord(json.value)) return json.value;
  if (json?.kind === 'object' && json.pairs.length === 1) {
    const [name, unit] = json.pairs[0] as [string, Json];
    if (isClassWord(name) && unit.kind === 'null') return name;
  }
  return reject(`${what}: not one of public, internal, private`);
}

/** `Option<Class>`: left out or `null` is none. */
function optionalClass(json: Json | undefined, what: string): Class | null {
  return json === undefined || json.kind === 'null' ? null : asClass(json, what);
}

/** A `u32`: an integer written without a point or an exponent, up to 4294967295. */
function asU32(json: Json | undefined): number {
  if (json?.kind === 'number' && /^(0|[1-9][0-9]*)$/.test(json.text) && BigInt(json.text) <= 0xffffffffn) {
    return Number(json.text);
  }
  return reject('schema: not a whole number');
}

interface Entry {
  class: Class;
  repo: string | null;
}

function entry(json: Json, key: string): Entry {
  const [cls, repo] = struct(json, ['class', 'repo'], `area ${JSON.stringify(key.slice(0, 40))}`);
  if (cls === undefined) reject(`area ${JSON.stringify(key.slice(0, 40))}: class is missing`);
  if (repo !== undefined && repo.kind !== 'null' && repo.kind !== 'string') {
    reject(`area ${JSON.stringify(key.slice(0, 40))}: repo is not a text`);
  }
  return {
    class: asClass(cls, `area ${JSON.stringify(key.slice(0, 40))}`),
    repo: repo?.kind === 'string' ? repo.value : null,
  };
}

/** `AreaPolicy::new`: not too many, every name acceptable (the repo too). */
function checked(areas: Map<string, Entry>, where: string): Map<string, Entry> {
  if (areas.size > MAX_AREAS) reject(`${where}more than ${MAX_AREAS} areas`);
  for (const [name, item] of areas) {
    if (!validAreaName(name)) reject(`${where}area ${JSON.stringify(name.slice(0, 40))}: not a name a folder may have`);
    if (item.repo !== null && !validAreaName(item.repo)) {
      reject(`${where}area ${JSON.stringify(name.slice(0, 40))}: repo is not a plain name`);
    }
  }
  return areas;
}

/** `known_vault_name`: `main`, or 1 to 40 of letters, digits, dot, dash, underscore, not starting with a dot. */
function knownVault(name: string): void {
  if (name === VAULT) return;
  if (name === '' || name.length > 40 || name.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(name)) {
    reject(`vault ${JSON.stringify(name.slice(0, 40))}: not a name for a vault`);
  }
}

interface Table {
  areas: Map<string, Entry>;
  fallback: Class | null;
}

function table(text: string): Table {
  const top = parseStrict(text);
  if (top.kind !== 'object') reject('expected an object');
  // `Peek`: the schema, the rest ignored (the struct below refuses what does not belong).
  const schemas = top.pairs.filter(([key]) => key === 'schema');
  if (schemas.length !== 1) reject(schemas.length === 0 ? 'schema is missing' : 'duplicate field schema');
  const schema = asU32(schemas[0]?.[1]);

  if (schema === 1) {
    const [, fallback, areas] = struct(top, ['schema', 'default', 'areas'], 'areas.json');
    return { areas: checked(mapOf(areas, 'areas', entry), ''), fallback: optionalClass(fallback, 'default') };
  }
  if (schema === 2) {
    const [, vaults, areas] = struct(top, ['schema', 'vaults', 'areas'], 'areas.json');
    // `vaults` is a map with a default: left out is empty, `null` is not a map.
    const rules = vaults === undefined ? new Map<string, Class | null>() : mapOf(vaults, 'vaults', rule);
    const all = mapOf(areas, 'areas', entry);
    if (all.size > MAX_AREAS) reject(`more than ${MAX_AREAS} areas`);
    const grouped = new Map<string, Map<string, Entry>>();
    for (const vault of rules.keys()) {
      knownVault(vault);
      grouped.set(vault, new Map());
    }
    for (const [key, item] of all) {
      const colon = key.indexOf(':');
      if (colon < 0) reject(`key ${JSON.stringify(key.slice(0, 40))} is not <vault>:<area>`);
      const vault = key.slice(0, colon);
      knownVault(vault);
      let group = grouped.get(vault);
      if (!group) grouped.set(vault, (group = new Map()));
      group.set(key.slice(colon + 1), item);
    }
    // Every vault of the file is checked, the one of this page is used.
    for (const [vault, group] of grouped) checked(group, `vault ${JSON.stringify(vault)}: `);
    return { areas: grouped.get(VAULT) ?? new Map(), fallback: rules.get(VAULT) ?? null };
  }
  return reject(`schema ${schema} is not 1 or 2`);
}

function rule(json: Json, key: string): Class | null {
  const [fallback] = struct(json, ['default'], `vault ${JSON.stringify(key.slice(0, 40))}`);
  return optionalClass(fallback, 'default');
}

// -- what the page asks ------------------------------------------------------------------------------------------

/** The classes of the areas of the vault. */
export interface AreaClasses {
  /** The class an area is shown with. An area the file does not name, and any area when `problem` is set, is `unclassified`. */
  shown(area: string): DataClass;
  /** Why `areas.json` could not be used (then nothing is classified); `null` for no file and for a usable one. */
  readonly problem: string | null;
  /** How many areas the file names. */
  readonly size: number;
  /** Equal for equal decisions: the page compares it to see that the classes changed. */
  readonly signature: string;
}

function unusable(problem: string | null): AreaClasses {
  return { shown: () => 'unclassified', problem, size: 0, signature: problem === null ? 'none' : `problem:${problem}` };
}

/** No file, nothing classified. */
export const NO_CLASSES: AreaClasses = unusable(null);

/** Read the bytes of an `areas.json`. A file that cannot be used classifies nothing and says why in `problem`. */
export function readClasses(bytes: Uint8Array): AreaClasses {
  if (bytes.byteLength > MAX_FILE_BYTES) return unusable(`larger than ${MAX_FILE_BYTES / 1024} KiB`);
  let text: string;
  try {
    // Invalid UTF-8 is an error (Rust's `read_to_string`), and a byte order mark stays in the text, where JSON refuses it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return unusable('not valid UTF-8');
  }
  let read: Table;
  try {
    read = table(text);
  } catch (error) {
    return unusable(error instanceof Error ? error.message.slice(0, 200) : 'not usable');
  }
  const { areas, fallback } = read;
  const decided = [...areas].map(([name, item]) => [name, item.class] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    shown: (area) => areas.get(area)?.class ?? fallback ?? 'unclassified',
    problem: null,
    size: areas.size,
    signature: JSON.stringify([fallback, decided]),
  };
}

/**
 * The classes of a vault that was read: its `areas.json`. Missing is no classes; present but left out by the reader (too
 * large, unreadable) is a problem, the same as a file that is not valid.
 */
export function classesOfVault(files: ReadonlyMap<string, Uint8Array>, skipped: readonly Skipped[]): AreaClasses {
  const left = skipped.find((s) => s.path === 'areas.json');
  if (left) return unusable(`areas.json was not read (${left.reason})`);
  const bytes = files.get('areas.json');
  return bytes === undefined ? NO_CLASSES : readClasses(bytes);
}
