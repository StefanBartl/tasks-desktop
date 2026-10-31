// The cases of `areas.json` that the page (src/web/classes.ts) and the Rust hub (crates/tasks-hub/src/classes.rs) must
// answer alike. The first block is the cases of the tests of classes.rs; the rest are the edges where a JSON parser of
// the browser and serde_json differ, which is where a page could release an area that Rust keeps closed.
//
// A case is a file (`text`, or raw `bytes`) and what the vault `main` shows for the areas it names: `shows` maps an area
// to its class (`unclassified` for one the file does not decide), or `refused` says the file is not usable (then the
// page shows every area as unclassified, and the hub does not start). Expectations are what `Classes::load` answers, and
// that is held: the Rust test crates/tasks-hub/tests/classes_cases.rs reads these cases (through classes-cases-dump.mjs)
// and checks every one against the real classes.rs, in the same CI job as `pnpm web:test`. A case that is added here
// and answered differently by the hub fails there; so does a change of classes.rs that the page does not follow.
//
// Escapes: a case that is about a `\u` escape must have the backslash in the file. Use `raw` (a plain string would turn
// `é` into the letter at once) and look at the bytes: a raw letter in a case about an escape tests nothing.

const enc = (text) => new TextEncoder().encode(text);
const raw = String.raw;

/** `n` areas `a0 ... a<n-1>` as the body of an `areas` object. */
const many = (n, cls = 'public') => Array.from({ length: n }, (_, i) => `"a${i}":{"class":"${cls}"}`).join(',');
/** A file of exactly `size` bytes: a valid one, padded with white space. */
const padded = (size) => {
  const head = '{"schema":1,"areas":{"x":{"class":"public"}}}';
  return enc(head + ' '.repeat(size - head.length));
};

const GOOD = raw`{"schema":1,"areas":{
        "alpha.nvim":{"class":"internal","repo":"alpha.nvim"},
        "pub-area":{"class":"public"},
        "secret-area":{"class":"private"}}}`;

const TWO = raw`{"schema":2,
        "vaults":{"work":{"default":"internal"}},
        "areas":{
            "main:shared.nvim":{"class":"public"},
            "work:shared.nvim":{"class":"private"},
            "work:only-work":{"class":"internal","repo":"w"}}}`;

export const CASES = [
  // -- the tests of classes.rs ---------------------------------------------------------------------------------------
  {
    name: 'a file of schema 1 classifies the areas it names and nothing else',
    text: GOOD,
    shows: { 'alpha.nvim': 'internal', 'pub-area': 'public', 'secret-area': 'private', 'never-heard-of': 'unclassified' },
  },
  {
    name: 'a default class covers the areas without an entry, an entry wins in both directions',
    text: raw`{"schema":1,"default":"internal","areas":{"secret-area":{"class":"private"}}}`,
    shows: { anything: 'internal', x: 'internal', 'secret-area': 'private' },
  },
  { name: 'a typo in a field name refuses the file', text: raw`{"schema":1,"areas":{"a":{"clas":"private"}}}`, refused: true },
  { name: 'a class that does not exist refuses the file', text: raw`{"schema":1,"areas":{"a":{"class":"secret"}}}`, refused: true },
  { name: 'a schema that is not 1 or 2 refuses the file', text: raw`{"schema":3,"areas":{}}`, refused: true },
  { name: 'an unknown top-level field refuses the file', text: raw`{"schema":1,"areas":{},"more":1}`, refused: true },
  { name: 'an area name that leads out of the vault refuses the file', text: raw`{"schema":1,"areas":{"../x":{"class":"private"}}}`, refused: true },
  { name: 'a repo that is not a plain name refuses the file', text: raw`{"schema":1,"areas":{"a":{"class":"public","repo":"../x"}}}`, refused: true },
  { name: 'text that is not JSON refuses the file', text: '{', refused: true },
  {
    name: 'a file over 256 KiB is refused',
    bytes: padded(256 * 1024 + 1),
    refused: true,
  },
  { name: 'a file of exactly 256 KiB is read', bytes: padded(256 * 1024), shows: { x: 'public', y: 'unclassified' } },
  {
    name: 'schema 2 keeps a class for each vault, the page is the vault main',
    text: TWO,
    shows: { 'shared.nvim': 'public', 'only-work': 'unclassified', anything: 'unclassified' },
  },
  { name: 'schema 2 without an entry for main classifies nothing there', text: raw`{"schema":2,"areas":{"work:a":{"class":"public"}}}`, shows: { a: 'unclassified' } },
  { name: 'schema 2: an area key without a vault is refused', text: raw`{"schema":2,"areas":{"plain":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: an empty vault name is refused', text: raw`{"schema":2,"areas":{":a":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: a vault name that starts with a dot is refused', text: raw`{"schema":2,"areas":{".x:a":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: an area name that leads out of the vault is refused', text: raw`{"schema":2,"areas":{"main:../x":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: a rule with a field that is not default is refused', text: raw`{"schema":2,"vaults":{"main":{"class":"public"}},"areas":{}}`, refused: true },
  { name: 'schema 2: an unknown top-level field is refused', text: raw`{"schema":2,"areas":{},"more":1}`, refused: true },

  // -- the schemas ----------------------------------------------------------------------------------------------------
  { name: 'an empty list of areas is a file that classifies nothing', text: raw`{"schema":1,"areas":{}}`, shows: { a: 'unclassified' } },
  { name: 'areas as a list is refused', text: raw`{"schema":1,"areas":[]}`, refused: true },
  { name: 'a file without areas is refused', text: raw`{"schema":1}`, refused: true },
  { name: 'a file without a schema is refused', text: raw`{"areas":{}}`, refused: true },
  { name: 'a default of null is no default', text: raw`{"schema":1,"default":null,"areas":{"a":{"class":"private"}}}`, shows: { a: 'private', b: 'unclassified' } },
  { name: 'a default that is not a class is refused', text: raw`{"schema":1,"default":"Internal","areas":{}}`, refused: true },
  { name: 'a default of an empty text is refused', text: raw`{"schema":1,"default":"","areas":{}}`, refused: true },
  { name: 'a default of a number is refused', text: raw`{"schema":1,"default":1,"areas":{}}`, refused: true },
  { name: 'a class in capitals is refused', text: raw`{"schema":1,"areas":{"a":{"class":"Public"}}}`, refused: true },
  { name: 'a class of null is refused', text: raw`{"schema":1,"areas":{"a":{"class":null}}}`, refused: true },
  { name: 'an entry without a class is refused', text: raw`{"schema":1,"areas":{"a":{}}}`, refused: true },
  { name: 'an entry that is null is refused', text: raw`{"schema":1,"areas":{"a":null}}`, refused: true },
  { name: 'an entry that is a text is refused', text: raw`{"schema":1,"areas":{"a":"public"}}`, refused: true },
  { name: 'an entry with a field of its own is refused', text: raw`{"schema":1,"areas":{"a":{"class":"public","note":"x"}}}`, refused: true },
  { name: 'a repo of null is no repo', text: raw`{"schema":1,"areas":{"a":{"class":"public","repo":null}}}`, shows: { a: 'public' } },
  { name: 'a repo that is a number is refused', text: raw`{"schema":1,"areas":{"a":{"class":"public","repo":1}}}`, refused: true },
  { name: 'a repo that is empty is refused', text: raw`{"schema":1,"areas":{"a":{"class":"public","repo":""}}}`, refused: true },
  { name: 'schema 1 with a vaults field is refused', text: raw`{"schema":1,"vaults":{},"areas":{}}`, refused: true },
  { name: 'schema 2 with a default of its own is refused', text: raw`{"schema":2,"default":"public","areas":{}}`, refused: true },
  { name: 'schema 2: the rule of main is the default of the page', text: raw`{"schema":2,"vaults":{"main":{"default":"public"}},"areas":{"main:p":{"class":"private"}}}`, shows: { p: 'private', other: 'public' } },
  { name: 'schema 2: the rule of another vault is not the page\'s', text: raw`{"schema":2,"vaults":{"work":{"default":"public"}},"areas":{}}`, shows: { a: 'unclassified' } },
  { name: 'schema 2: vaults as null is refused', text: raw`{"schema":2,"vaults":null,"areas":{}}`, refused: true },
  { name: 'schema 2: vaults as a list is refused', text: raw`{"schema":2,"vaults":[],"areas":{}}`, refused: true },
  { name: 'schema 2: an empty rule and a rule of null are no default', text: raw`{"schema":2,"vaults":{"main":{},"work":{"default":null}},"areas":{"main:a":{"class":"public"}}}`, shows: { a: 'public', b: 'unclassified' } },
  { name: 'schema 2: a rule that is null is refused', text: raw`{"schema":2,"vaults":{"work":null},"areas":{}}`, refused: true },
  { name: 'schema 2: a vault name with a space is refused', text: raw`{"schema":2,"areas":{"my vault:a":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: a vault name of 41 characters is refused', text: raw`{"schema":2,"areas":{"${'v'.repeat(41)}:a":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: a vault name of 40 characters is read', text: raw`{"schema":2,"areas":{"${'v'.repeat(40)}:a":{"class":"public"},"main:a":{"class":"private"}}}`, shows: { a: 'private' } },
  { name: 'schema 2: a vault name that is not ASCII is refused', text: raw`{"schema":2,"areas":{"wörk:a":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: an empty area name is refused', text: raw`{"schema":2,"areas":{"main:":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: a second colon is a character the area name may not have', text: raw`{"schema":2,"areas":{"main:a:b":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: Main is another vault than main', text: raw`{"schema":2,"areas":{"Main:a":{"class":"public"}}}`, shows: { a: 'unclassified' } },
  { name: 'schema 2: a bad area in another vault refuses the whole file', text: raw`{"schema":2,"areas":{"work:../x":{"class":"public"},"main:a":{"class":"public"}}}`, refused: true },
  { name: 'schema 2: a bad repo in another vault refuses the whole file', text: raw`{"schema":2,"areas":{"work:a":{"class":"public","repo":"a/b"}}}`, refused: true },
  { name: 'schema 2: a vault name in the rules that is not valid refuses the file', text: raw`{"schema":2,"vaults":{".hidden":{}},"areas":{}}`, refused: true },

  // -- a struct may be written as a list, as serde_json reads it -------------------------------------------------------
  { name: 'an entry written as a list of its fields', text: raw`{"schema":1,"areas":{"a":["private"],"b":["public","repo-b"],"c":["internal",null]}}`, shows: { a: 'private', b: 'public', c: 'internal' } },
  { name: 'an entry written as an empty list is refused', text: raw`{"schema":1,"areas":{"a":[]}}`, refused: true },
  { name: 'an entry written as a list with a field too many is refused', text: raw`{"schema":1,"areas":{"a":["public","r",1]}}`, refused: true },
  { name: 'an entry written as a list with a class that is not one is refused', text: raw`{"schema":1,"areas":{"a":[1]}}`, refused: true },
  { name: 'a rule written as a list of its fields', text: raw`{"schema":2,"vaults":{"main":["public"],"a":[],"b":[null]},"areas":{}}`, shows: { x: 'public' } },
  { name: 'a rule written as a list with a field too many is refused', text: raw`{"schema":2,"vaults":{"main":["public",1]},"areas":{}}`, refused: true },
  { name: 'the whole file written as a list is refused', text: raw`[1,null,{}]`, refused: true },
  { name: 'a file that is null is refused', text: 'null', refused: true },

  // -- a class may be written as a map of one name to null, as serde_json reads a unit variant -------------------------
  { name: 'a class written as a map of its name to null', text: raw`{"schema":1,"areas":{"a":{"class":{"public":null}},"b":{"class":{"internal":null}},"c":{"class":{"private":null}}}}`, shows: { a: 'public', b: 'internal', c: 'private' } },
  { name: 'a default written as a map of its name to null', text: raw`{"schema":1,"default":{"internal":null},"areas":{"a":{"class":"private"}}}`, shows: { a: 'private', x: 'internal' } },
  { name: 'schema 2: the default of a rule written as a map of its name to null', text: raw`{"schema":2,"vaults":{"main":{"default":{"public":null}},"work":{"default":{"private":null}}},"areas":{"main:p":{"class":{"private":null}}}}`, shows: { p: 'private', x: 'public' } },
  { name: 'a class map inside an entry written as a list', text: raw`{"schema":1,"areas":{"a":[{"private":null},"r"]}}`, shows: { a: 'private' } },
  { name: 'a class map with white space and an escaped name', text: `{"schema":1,"areas":{"a":{"class": { "p${String.fromCharCode(92)}u0075blic" : null } }}}`, shows: { a: 'public' } },
  { name: 'a class map that is empty is refused', text: raw`{"schema":1,"areas":{"a":{"class":{}}}}`, refused: true },
  { name: 'a class map with two names is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"public":null,"private":null}}}}`, refused: true },
  { name: 'a class map with the same name twice is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"public":null,"public":null}}}}`, refused: true },
  { name: 'a class map with a text for null is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"public":"x"}}}}`, refused: true },
  { name: 'a class map with an empty map for null is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"public":{}}}}}`, refused: true },
  { name: 'a class map with an empty list for null is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"public":[]}}}}`, refused: true },
  { name: 'a class map with false for null is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"public":false}}}}`, refused: true },
  { name: 'a class map with a name that is not a class is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"secret":null}}}}`, refused: true },
  { name: 'a class map with a name in capitals is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"Public":null}}}}`, refused: true },
  { name: 'a class map nested in a class map is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"public":{"public":null}}}}}`, refused: true },
  { name: 'a class written as a list of its name is refused', text: raw`{"schema":1,"areas":{"a":{"class":["public"]}}}`, refused: true },
  { name: 'a default map with two names is refused', text: raw`{"schema":1,"default":{"public":null,"internal":null},"areas":{}}`, refused: true },
  { name: 'a default map that is empty is refused', text: raw`{"schema":1,"default":{},"areas":{}}`, refused: true },
  { name: 'a default map with a text for null is refused', text: raw`{"schema":1,"default":{"internal":"x"},"areas":{}}`, refused: true },
  { name: 'schema 2: a rule default map with an unknown name is refused', text: raw`{"schema":2,"vaults":{"work":{"default":{"secret":null}}},"areas":{}}`, refused: true },
  { name: 'schema 2: a rule default map with a value that is not null is refused', text: raw`{"schema":2,"vaults":{"main":{"default":{"public":1}}},"areas":{}}`, refused: true },
  { name: 'schema 2: a rule written as a list with a class map', text: raw`{"schema":2,"vaults":{"main":[{"public":null}]},"areas":{}}`, shows: { x: 'public' } },
  { name: 'a class map named __proto__ is refused', text: raw`{"schema":1,"areas":{"a":{"class":{"__proto__":null}}}}`, refused: true },

  // -- a key twice: an object whose fields are known refuses it, a map keeps the last ---------------------------------
  { name: 'a field twice in an entry is refused, whichever class comes last', text: raw`{"schema":1,"areas":{"a":{"class":"private","class":"public"}}}`, refused: true },
  { name: 'a field twice in an entry is refused also when both agree', text: raw`{"schema":1,"areas":{"a":{"class":"public","class":"public"}}}`, refused: true },
  { name: 'a schema twice is refused', text: raw`{"schema":1,"schema":1,"areas":{}}`, refused: true },
  { name: 'areas twice is refused', text: raw`{"schema":1,"areas":{"a":{"class":"public"}},"areas":{}}`, refused: true },
  { name: 'default twice is refused', text: raw`{"schema":1,"default":"private","default":"public","areas":{}}`, refused: true },
  { name: 'a rule with default twice is refused', text: raw`{"schema":2,"vaults":{"main":{"default":"private","default":"public"}},"areas":{}}`, refused: true },
  { name: 'an area named twice: the last entry wins', text: raw`{"schema":1,"areas":{"a":{"class":"private"},"a":{"class":"public"}}}`, shows: { a: 'public' } },
  { name: 'an area named twice: the last entry wins, also in the other direction', text: raw`{"schema":1,"areas":{"a":{"class":"public"},"a":{"class":"private"}}}`, shows: { a: 'private' } },
  { name: 'an area named twice: the first entry is checked too', text: raw`{"schema":1,"areas":{"a":{"class":"bad"},"a":{"class":"public"}}}`, refused: true },
  { name: 'an area named twice, once with an escape, is the same area', text: raw`{"schema":1,"areas":{"caf\u00e9":{"class":"private"},"café":{"class":"public"}}}`, shows: { 'caf\u00e9': 'public' } },
  { name: 'an area named twice, the escape last, is the same area too', text: raw`{"schema":1,"areas":{"café":{"class":"public"},"caf\u00e9":{"class":"private"}}}`, shows: { 'caf\u00e9': 'private' } },
  { name: 'a vault named twice in the rules: the last rule wins', text: raw`{"schema":2,"vaults":{"main":{"default":"private"},"main":{"default":"public"}},"areas":{}}`, shows: { x: 'public' } },
  { name: 'a field name written with an escape is the same field', text: raw`{"sch\u0065ma":1,"ar\u0065as":{"a":{"cl\u0061ss":"public"}}}`, shows: { a: 'public' } },
  { name: 'an escaped field name is still checked: a typo with an escape is refused', text: raw`{"schema":1,"areas":{"a":{"cl\u0061s":"private"}}}`, refused: true },
  { name: 'a field twice, once with an escape, is refused', text: raw`{"schema":1,"sch\u0065ma":1,"areas":{}}`, refused: true },
  { name: 'a field twice in an entry, once with an escape, is refused', text: raw`{"schema":1,"areas":{"a":{"class":"private","cl\u0061ss":"public"}}}`, refused: true },

  // -- numbers: the schema is a whole number, as written -------------------------------------------------------------
  { name: 'a schema written as a text is refused', text: raw`{"schema":"1","areas":{}}`, refused: true },
  { name: 'a schema written with a decimal point is refused', text: raw`{"schema":1.0,"areas":{}}`, refused: true },
  { name: 'a schema written with an exponent is refused', text: raw`{"schema":1e0,"areas":{}}`, refused: true },
  { name: 'a schema that is negative is refused', text: raw`{"schema":-1,"areas":{}}`, refused: true },
  { name: 'a schema of minus zero is refused', text: raw`{"schema":-0,"areas":{}}`, refused: true },
  { name: 'a schema with a leading zero is refused', text: raw`{"schema":01,"areas":{}}`, refused: true },
  { name: 'a schema that does not fit 32 bits is refused', text: raw`{"schema":4294967297,"areas":{}}`, refused: true },
  { name: 'a schema of 2.0 is refused', text: raw`{"schema":2.0,"areas":{}}`, refused: true },
  { name: 'a schema of true is refused', text: raw`{"schema":true,"areas":{}}`, refused: true },
  { name: 'a schema of null is refused', text: raw`{"schema":null,"areas":{}}`, refused: true },
  { name: 'a number with a point and no digit is refused', text: raw`{"schema":1.,"areas":{}}`, refused: true },
  { name: 'a number with a plus sign is refused', text: raw`{"schema":+1,"areas":{}}`, refused: true },
  { name: 'NaN is refused', text: raw`{"schema":NaN,"areas":{}}`, refused: true },
  { name: 'a number of a thousand digits is refused', text: `{"schema":1${'0'.repeat(1000)},"areas":{}}`, refused: true },

  // -- the form of the text -----------------------------------------------------------------------------------------
  { name: 'text after the value is refused', text: raw`{"schema":1,"areas":{}} x`, refused: true },
  { name: 'a second value after the first is refused', text: raw`{"schema":1,"areas":{}}{"schema":1,"areas":{}}`, refused: true },
  { name: 'a comma after the last field is refused', text: raw`{"schema":1,"areas":{},}`, refused: true },
  { name: 'a comma after the last area is refused', text: raw`{"schema":1,"areas":{"a":{"class":"public"},}}`, refused: true },
  { name: 'a comment is refused', text: raw`{"schema":1,/* x */"areas":{}}`, refused: true },
  { name: 'single quotes are refused', text: "{'schema':1,'areas':{}}", refused: true },
  { name: 'an unquoted key is refused', text: raw`{schema:1,"areas":{}}`, refused: true },
  { name: 'an empty file is refused', text: '', refused: true },
  { name: 'a file of white space only is refused', text: ' \n\t ', refused: true },
  { name: 'tabs, line feeds and CRLF are white space', text: '\t{\r\n"schema":1,\r\n"areas":{"a":{"class":"public"}}\r\n}\r\n', shows: { a: 'public' } },
  { name: 'a no-break space is not white space', text: '{"schema":1,\u00a0"areas":{}}', refused: true },
  { name: 'a vertical tab is not white space', text: '{"schema":1,\u000b"areas":{}}', refused: true },
  { name: 'a byte order mark is refused', bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{"schema":1,"areas":{}}')]), refused: true },
  { name: 'a file that is not UTF-8 is refused', bytes: new Uint8Array([...enc('{"schema":1,"areas":{"a\u0001'), 0xff, ...enc('":{"class":"public"}}}')]), refused: true },
  { name: 'a lone byte of UTF-8 in a name is refused', bytes: new Uint8Array([...enc('{"schema":1,"areas":{"a'), 0xc3, ...enc('":{"class":"public"}}}')]), refused: true },
  { name: 'an unterminated text is refused', text: raw`{"schema":1,"areas":{"a`, refused: true },
  { name: 'a literal that is cut short is refused', text: raw`{"schema":1,"default":nul,"areas":{}}`, refused: true },
  { name: 'a literal with letters after it is refused', text: raw`{"schema":1,"default":nullx,"areas":{}}`, refused: true },
  { name: 'a value nested 200 levels is refused', text: `{"schema":1,"areas":{},"x":${'['.repeat(200)}${']'.repeat(200)}}`, refused: true },

  // -- escapes in texts --------------------------------------------------------------------------------------------
  { name: 'an area written with a unicode escape', text: raw`{"schema":1,"areas":{"caf\u00e9":{"class":"private"}}}`, shows: { 'caf\u00e9': 'private', cafe: 'unclassified' } },
  { name: 'an escape in capitals and in lower case is the same letter', text: raw`{"schema":1,"areas":{"caf\u00C9":{"class":"private"},"x\u00aB\u00Ab\u00AB":{"class":"public"}}}`, shows: { 'caf\u00c9': 'private', 'x\u00ab\u00ab\u00ab': 'public' } },
  { name: 'a pair of surrogates is one character', text: raw`{"schema":1,"areas":{"\ud83d\ude00":{"class":"private"}}}`, shows: { '\u{1F600}': 'private' } },
  { name: 'a pair of surrogates in capitals is one character too', text: raw`{"schema":1,"areas":{"a\uD83D\uDE00":{"class":"private"}}}`, shows: { 'a\u{1F600}': 'private' } },
  { name: 'a pair of surrogates and the character itself are the same area', text: raw`{"schema":1,"areas":{"\ud83d\ude00":{"class":"private"},"😀":{"class":"public"}}}`, shows: { '\u{1F600}': 'public' } },
  { name: 'a lone leading surrogate is refused', text: raw`{"schema":1,"areas":{"a\ud83d":{"class":"private"}}}`, refused: true },
  { name: 'a lone trailing surrogate is refused', text: raw`{"schema":1,"areas":{"a\ude00":{"class":"private"}}}`, refused: true },
  { name: 'a leading surrogate and something that is not a trailing one is refused', text: raw`{"schema":1,"areas":{"\ud83dA":{"class":"private"}}}`, refused: true },
  { name: 'a leading surrogate and a second leading one is refused', text: raw`{"schema":1,"areas":{"\ud83d\ud83d":{"class":"private"}}}`, refused: true },
  { name: 'a leading surrogate and a plain letter is refused', text: raw`{"schema":1,"areas":{"\ud83dx":{"class":"private"}}}`, refused: true },
  { name: 'an escape that does not exist is refused', text: raw`{"schema":1,"areas":{"a\x":{"class":"private"}}}`, refused: true },
  { name: 'a unicode escape with too few digits is refused', text: raw`{"schema":1,"areas":{"a\u00e":{"class":"private"}}}`, refused: true },
  { name: 'a unicode escape with a letter that is not a digit is refused', text: raw`{"schema":1,"areas":{"a\u00g0":{"class":"private"}}}`, refused: true },
  // The next four would read as the letter "a" (U+0061), and the key as "class", if the four characters only had to be a
  // number for a parser (parseInt takes a sign, a space and a 0x prefix). A file that says "class" in such a way is not
  // valid JSON, and the Rust hub refuses it.
  { name: 'a unicode escape with a plus sign for a digit is refused', text: raw`{"schema":1,"areas":{"A":{"cl\u+061ss":"public"}}}`, refused: true },
  { name: 'a unicode escape with a minus sign for a digit is refused', text: raw`{"schema":1,"areas":{"A":{"cl\u-061ss":"public"}}}`, refused: true },
  { name: 'a unicode escape with a space for a digit is refused', text: raw`{"schema":1,"areas":{"A":{"cl\u 061ss":"public"}}}`, refused: true },
  { name: 'a unicode escape with a hex prefix for digits is refused', text: raw`{"schema":1,"areas":{"A":{"cl\u0x61ss":"public"}}}`, refused: true },
  { name: 'an escaped slash is a slash, and a slash is no part of a name', text: raw`{"schema":1,"areas":{"a\/b":{"class":"private"}}}`, refused: true },
  { name: 'an escaped backslash is a backslash, and a backslash is no part of a name', text: raw`{"schema":1,"areas":{"a\\b":{"class":"private"}}}`, refused: true },
  { name: 'an escaped quote is a quote, and a quote is no part of a name', text: raw`{"schema":1,"areas":{"a\"b":{"class":"private"}}}`, refused: true },
  { name: 'an escaped NUL is a control character, no part of a name', text: raw`{"schema":1,"areas":{"a\u0000b":{"class":"private"}}}`, refused: true },
  { name: 'an escaped DEL is a control character, no part of a name', text: raw`{"schema":1,"areas":{"a\u007fb":{"class":"private"}}}`, refused: true },
  { name: 'an escaped next-line character is a control character, no part of a name', text: raw`{"schema":1,"areas":{"a\u0085b":{"class":"private"}}}`, refused: true },
  { name: 'a no-break space is not a control character', text: '{"schema":1,"areas":{"a\u00a0b":{"class":"private"}}}', shows: { 'a\u00a0b': 'private' } },
  { name: 'a raw tab inside a text is refused', text: '{"schema":1,"areas":{"a\tb":{"class":"private"}}}', refused: true },
  { name: 'a raw line feed inside a text is refused', text: '{"schema":1,"areas":{"a\nb":{"class":"private"}}}', refused: true },
  { name: 'an escaped tab is a control character, no part of a name', text: raw`{"schema":1,"areas":{"a\tb":{"class":"private"}}}`, refused: true },
  { name: 'an escaped class word is the class', text: raw`{"schema":1,"areas":{"a":{"class":"p\u0075blic"}}}`, shows: { a: 'public' } },
  { name: 'an escaped class word in capitals is not the class', text: raw`{"schema":1,"areas":{"a":{"class":"\u0050ublic"}}}`, refused: true },
  { name: 'an escaped default is the default', text: raw`{"schema":1,"default":"\u0069nternal","areas":{}}`, shows: { x: 'internal' } },

  // -- the names an area may have ------------------------------------------------------------------------------------
  { name: 'a name that starts with a dot is refused', text: raw`{"schema":1,"areas":{".a":{"class":"public"}}}`, refused: true },
  { name: 'a name that ends with a dot is refused', text: raw`{"schema":1,"areas":{"a.":{"class":"public"}}}`, refused: true },
  { name: 'a name that ends with a space is refused', text: raw`{"schema":1,"areas":{"a ":{"class":"public"}}}`, refused: true },
  { name: 'a name with a space inside is read', text: raw`{"schema":1,"areas":{"a b":{"class":"public"}}}`, shows: { 'a b': 'public' } },
  { name: 'a name that starts with a space is read', text: raw`{"schema":1,"areas":{" a":{"class":"public"}}}`, shows: { ' a': 'public' } },
  { name: 'a name with a dot inside, and nvim names, are read', text: raw`{"schema":1,"areas":{"lib.nvim":{"class":"public"},"wkdbook-lib.nvim":{"class":"private"}}}`, shows: { 'lib.nvim': 'public', 'wkdbook-lib.nvim': 'private' } },
  { name: 'a name with a comma is refused', text: raw`{"schema":1,"areas":{"a,b":{"class":"public"}}}`, refused: true },
  { name: 'a name with a colon is refused in schema 1', text: raw`{"schema":1,"areas":{"a:b":{"class":"public"}}}`, refused: true },
  { name: 'a name with a star is refused', text: raw`{"schema":1,"areas":{"a*":{"class":"public"}}}`, refused: true },
  { name: 'a name with a question mark is refused', text: raw`{"schema":1,"areas":{"a?":{"class":"public"}}}`, refused: true },
  { name: 'a name with an angle bracket is refused', text: raw`{"schema":1,"areas":{"a<b":{"class":"public"}}}`, refused: true },
  { name: 'a name with a pipe is refused', text: raw`{"schema":1,"areas":{"a|b":{"class":"public"}}}`, refused: true },
  { name: 'an empty name is refused', text: raw`{"schema":1,"areas":{"":{"class":"public"}}}`, refused: true },
  { name: 'a name of one dot is refused', text: raw`{"schema":1,"areas":{".":{"class":"public"}}}`, refused: true },
  { name: 'a name of 128 characters is read', text: `{"schema":1,"areas":{"${'n'.repeat(128)}":{"class":"public"}}}`, shows: { ['n'.repeat(128)]: 'public' } },
  { name: 'a name of 129 characters is refused', text: `{"schema":1,"areas":{"${'n'.repeat(129)}":{"class":"public"}}}`, refused: true },
  { name: 'a name counts characters, not bytes or UTF-16 units: 128 emoji are read', text: `{"schema":1,"areas":{"${'\u{1F600}'.repeat(128)}":{"class":"public"}}}`, shows: { ['\u{1F600}'.repeat(128)]: 'public' } },
  { name: '129 emoji are refused', text: `{"schema":1,"areas":{"${'\u{1F600}'.repeat(129)}":{"class":"public"}}}`, refused: true },
  { name: 'a repo of 129 characters is refused', text: `{"schema":1,"areas":{"a":{"class":"public","repo":"${'r'.repeat(129)}"}}}`, refused: true },
  { name: 'an area is found by its exact name: case and a different normal form are other names', text: raw`{"schema":1,"areas":{"Lib":{"class":"private"}}}`, shows: { Lib: 'private', lib: 'unclassified', LIB: 'unclassified' } },

  // -- how many areas -----------------------------------------------------------------------------------------------
  { name: '1000 areas are read', text: `{"schema":1,"areas":{${many(1000)}}}`, shows: { a0: 'public', a999: 'public', a1000: 'unclassified' } },
  { name: '1001 areas are refused', text: `{"schema":1,"areas":{${many(1001)}}}`, refused: true },
  { name: '1001 entries of which one is named twice are 1000 areas', text: `{"schema":1,"areas":{${many(1000)},"a0":{"class":"private"}}}`, shows: { a0: 'private', a1: 'public' } },
  { name: 'schema 2: 1000 areas are read', text: `{"schema":2,"areas":{${many(1000).replace(/"a(\d+)"/g, '"main:a$1"')}}}`, shows: { a0: 'public', a999: 'public' } },
  { name: 'schema 2: 1001 areas are refused', text: `{"schema":2,"areas":{${many(1001).replace(/"a(\d+)"/g, '"main:a$1"')}}}`, refused: true },
  { name: 'schema 2: 1001 areas over two vaults are refused as a whole', text: `{"schema":2,"areas":{${many(500).replace(/"a(\d+)"/g, '"main:a$1"')},${many(501).replace(/"a(\d+)"/g, '"work:a$1"')}}}`, refused: true },
];
