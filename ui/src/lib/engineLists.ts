// The named lists of the engine (built-in, saved with the editor, from its configuration), laid onto the filter of the
// page. A list is written in the option words of the command line (`effort: "<=S"`, `status: "open,doing"`); the page
// has its own filter, which says most of them. What it cannot say is named when the list is applied, never left out
// without a word: a list that selects less than it should would only look like the engine's.

import type { NamedLists, TaskEntry } from './contract';
import { boundOptions, freshFilter, type Bound, type FieldKey, type Filter } from './filter';
import { parseSort, type SortWord } from './sort';

export type EngineList = NamedLists['lists'][number];

/** What the page can do beyond its filter: whether the engine gave the quick wins of this state. */
export interface Context {
  quickWins: boolean;
}

/** What a list comes to on the page. */
export interface Applied {
  filter: Filter;
  sort: SortWord;
  /** The options the page cannot say (`--stale=30`, `--blocked`, ...): the list selects more than the page shows. */
  unsupported: string[];
}

const split = (text: string): string[] =>
  text
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

/** The fields of the page that take the words of a list as they are. */
const FIELDS: readonly (readonly [string, FieldKey])[] = [
  ['kind', 'kind'],
  ['category', 'category'],
  ['severity', 'severity'],
  ['tag', 'tag'],
  ['plan', 'plan'],
  ['phase', 'phase'],
];

/** The options that are only a name for the list or are dealt with on their own. */
const HANDLED = new Set(['status', 'prio', 'effort', 'value', 'actor', 'area', 'sort', 'reminders', 'readiness', 'quick_win']);

/**
 * The filter and the order of `list`. `tasks` are the tasks of the vault: an effort bound (`<=S`) compares by the days
 * the engine worked out for the tasks that have that size, so a size no task has cannot be placed and is named.
 */
export function fromEngineList(list: EngineList, tasks: readonly TaskEntry[], context: Context = { quickWins: false }): Applied {
  const filter = freshFilter();
  const unsupported: string[] = [];
  const options = list.options as Record<string, string | boolean | undefined>;
  const text = (key: string): string | undefined => {
    const value = options[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };

  const status = text('status');
  if (status) filter.statuses = split(status);
  const actor = text('actor');
  if (actor) filter.actors = split(actor);
  const area = text('area');
  if (area) filter.areas = [area];
  if (options.reminders === true) filter.reminder = 'set';
  // The engine's `--ready` is a task whose readiness is ready or decision, `--waiting` one that waits or is stuck: the
  // states of the page's own choice of that name, so the words mean the same.
  const readiness = text('readiness');
  if (readiness === 'ready') filter.fields.state = ['ready', 'decision'];
  else if (readiness === 'waiting') filter.fields.state = ['waiting', 'stuck'];
  else if (readiness) unsupported.push(`readiness: ${readiness}`);
  // A quick win is the engine's own figure (its thresholds are its settings): the ids it counted, or it cannot be said.
  if (options.quick_win === true) {
    if (context.quickWins) filter.quickWin = true;
    else unsupported.push('quick_win');
  }
  for (const [word, key] of FIELDS) {
    const value = text(word);
    if (value) filter.fields[key] = split(value);
  }

  const prio = text('prio');
  if (prio) {
    const max = /^<=([0-9]+)$/.exec(prio);
    if (max) filter.ranges.prio = { max: { label: max[1]!, n: Number(max[1]) } };
    else filter.fields.prio = split(prio);
  }
  const value = text('value');
  if (value) {
    const min = /^>=([0-9]+)$/.exec(value);
    if (min) filter.ranges.value = { min: { label: min[1]!, n: Number(min[1]) } };
    else filter.fields.value = split(value);
  }
  const effort = text('effort');
  if (effort) {
    const max = /^<=(.+)$/.exec(effort);
    if (max) {
      const found: Bound | undefined = boundOptions(tasks, 'effort').find(
        (b) => b.label.toLocaleLowerCase() === max[1]!.toLocaleLowerCase(),
      );
      if (found) filter.ranges.effort = { max: found };
      else unsupported.push(`effort: ${effort}`);
    } else {
      filter.fields.effort = split(effort);
    }
  }

  let sort: SortWord = 'default';
  const word = text('sort');
  if (word) {
    sort = parseSort(word);
    if (sort === 'default' && word !== 'default') unsupported.push(`sort: ${word}`);
  }

  // Everything else the engine knows and the page does not say: a switch is named by its word, a value with it.
  for (const [key, raw] of Object.entries(options)) {
    if (HANDLED.has(key) || FIELDS.some(([w]) => w === key) || raw === undefined || raw === '' || raw === false) continue;
    unsupported.push(raw === true ? key : `${key}: ${String(raw)}`);
  }
  return { filter, sort, unsupported };
}
