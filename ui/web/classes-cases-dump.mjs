// The cases of classes-cases.mjs as JSON on stdout, for the Rust test that holds the hub to the same answers
// (crates/tasks-hub/tests/classes_cases.rs). The file of a case is hex, so that bytes that are not text and white space
// survive the trip as they are.
//
//   node --experimental-strip-types web/classes-cases-dump.mjs        (from ui/)

import { CASES } from './classes-cases.mjs';

const enc = new TextEncoder();

const cases = CASES.map((c) => ({
  name: c.name,
  hex: Buffer.from(c.bytes ?? enc.encode(c.text)).toString('hex'),
  refused: c.refused === true,
  shows: c.shows ?? {},
}));

process.stdout.write(JSON.stringify(cases));
