// The plan wizard: what the form holds and the one operation it makes of it. The rules of a plan (the name, the
// phases, the target, the gate) are the engine's: the wizard asks it for a dry run while the person types and shows
// its answer, so the page keeps no second copy of them.

import type { Op } from './api';
import { parseTags } from './fields';

export type PlanStatus = 'planning' | 'doing' | 'parked';
export const PLAN_STATUSES: readonly PlanStatus[] = ['planning', 'doing', 'parked'];

export interface PlanForm {
  title: string;
  /** The area whose `ROADMAP/plans/` holds the file. */
  area: string;
  /** The areas the plan covers (may be none). */
  areas: string[];
  status: PlanStatus;
  /** The phases in order, comma separated. */
  phases: string;
  /** The task a finished plan is aiming at (`<area>/<slug>`), or empty. */
  target: string;
  /** Each phase waits for the one before (`gate: hard`). */
  hard: boolean;
  summary: string;
}

export function emptyForm(area = ''): PlanForm {
  return { title: '', area, areas: area ? [area] : [], status: 'planning', phases: '', target: '', hard: false, summary: '' };
}

/** The phases as typed: trimmed words in order, no empty one, no repeat. */
export function parsePhases(text: string): string[] {
  return parseTags(text);
}

/**
 * The `plan_new` operation of a form. Only what was filled in is sent: the engine has its own defaults, and an empty
 * list or text is "not given", never an empty value.
 */
export function planOp(form: PlanForm): Op {
  const phases = parsePhases(form.phases);
  const summary = form.summary.trim();
  const target = form.target.trim();
  return {
    op: 'plan_new',
    area: form.area,
    title: form.title.trim(),
    ...(form.areas.length > 0 ? { areas: form.areas } : {}),
    ...(phases.length > 0 ? { phases } : {}),
    ...(target !== '' ? { target } : {}),
    ...(form.hard ? { gate: 'hard' } : {}),
    ...(form.status !== 'planning' ? { status: form.status } : {}),
    ...(summary !== '' ? { summary } : {}),
  };
}

/** What the dry run said. */
export type PlanPreview =
  | { kind: 'ok'; id: string; renamed: boolean }
  | { kind: 'refused'; message: string }
  | { kind: 'unknown' };

/** Whether the form can be sent: a title and an area, and the engine did not refuse the last dry run. */
export function canCreate(form: PlanForm, preview: PlanPreview | null): boolean {
  return form.title.trim() !== '' && form.area !== '' && preview?.kind === 'ok';
}
