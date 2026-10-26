import { describe, expect, it } from 'vitest';
import source from '../views/Capture.svelte?raw';

// The fields of the capture dialog are those of `:Tasks new` of tasks.nvim, which are those of the engine's `new`
// (minus the slug). The same list is in `TESTS/tasks_form_spec.lua` there; a field added on one side has to be
// added on the other, or the test names it.
const FORM_FIELDS = [
  'actor',
  'category',
  'effort',
  'kind',
  'links',
  'prio',
  'refs',
  'severity',
  'status',
  'summary',
  'tags',
  'value',
];

describe('the capture dialog', () => {
  it('sends the fields of the :Tasks new form, no more and no fewer', () => {
    const sent = [...new Set([...source.matchAll(/fields\['([a-z_]+)'\]/g)].map((m) => m[1]))].sort();
    expect(sent).toEqual(FORM_FIELDS);
  });
});
