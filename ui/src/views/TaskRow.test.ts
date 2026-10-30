// The marks of a row of the list, rendered on the server side of Svelte.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { TaskEntry } from '../lib/contract';
import TaskRow from './TaskRow.svelte';

const row = (task: Partial<TaskEntry>, extra: Record<string, unknown> = {}) =>
  render(TaskRow, {
    props: {
      ...extra,
      task: { id: 'a/one', area: 'a', title: 'One', valid: true, ...task } as unknown as TaskEntry,
      lang: 'de',
      today: '2026-10-30',
      onselect: () => undefined,
      onmark: () => false,
      markLabel: 'mark',
    },
  }).body.replace(/<!--.*?-->/g, '');

describe('the status and the state of a row', () => {
  it('shows "geparkt" once for a parked task', () => {
    const out = row({ status: 'parked', readiness: { state: 'parked' } as TaskEntry['readiness'] });
    expect(out.match(/>geparkt</g)).toHaveLength(1);
  });

  it('shows both marks when they differ', () => {
    const out = row({ status: 'open', readiness: { state: 'ready' } as TaskEntry['readiness'] });
    expect(out).toContain('>offen<');
    expect(out).toContain('>startbar<');
  });
});

describe('the unsaved changes of a row', () => {
  it('names how many fields are held, for the eye and for a screen reader; none, no mark', () => {
    const out = row({ status: 'open' }, { drafted: 2 });
    expect(out).toContain('✎ 2');
    expect(out).toContain('ungespeicherte Änderungen: 2');
    expect(row({ status: 'open' })).not.toContain('✎');
  });
});
