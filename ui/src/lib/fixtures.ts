// Test helpers: a task with the required fields.

import type { TaskEntry } from './contract';

export function task(id: string, extra: Partial<TaskEntry> = {}): TaskEntry {
  const [area = '', slug = ''] = id.split('/');
  return {
    id,
    area,
    slug,
    title: `Task ${id}`,
    tags: [],
    category: [],
    blocked_by: [],
    after: [],
    refs: [],
    summary: '',
    folder: false,
    file: `${area}/ROADMAP/tasks/${slug}.md`,
    valid: true,
    problems: [],
    ...extra,
  };
}
