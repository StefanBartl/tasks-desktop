// The Info dialog and the bug report (rule APP-09): the words of `GET /api/tasks/about` as a text a person can read and
// paste, and the address of a new issue with that text filled in. The page sends nothing: the person sees the form in
// the browser and sends it, or does not.

import { translate, type Lang } from './i18n';

/** Where a problem is reported: a new issue of the public repository, the fields filled by the address. */
export const ISSUES_URL = 'https://github.com/WKDSteve/tasks-desktop/issues/new';

/**
 * The repositories a report may belong to, each with the page of its issues and the words that say what lives there
 * (a problem with the rules of the tasks is the engine's, one with the page or the hub is the app's).
 */
export const REPORT_REPOS = [
  { name: 'tasks-desktop', url: 'https://github.com/WKDSteve/tasks-desktop/issues', note: 'about.repo.app' },
  { name: 'tasks.nvim', url: 'https://github.com/WKDSteve/tasks.nvim/issues', note: 'about.repo.engine' },
  { name: 'appkit', url: 'https://github.com/WKDSteve/appkit/issues', note: 'about.repo.appkit' },
] as const;

/** What the hub says about the build and the engine: versions and commits only, never a path (ENG-06). */
export interface About {
  app: string;
  version: string;
  /** The commit of a rolling build; `null` in a release and in a local build. */
  build: string | null;
  os: string;
  arch: string;
  /** `null` while no engine runs, or while the one that runs did not answer (then `engineProblem` says why). */
  engine: { version: string | null; git: string | null; nvim: string | null } | null;
  /** The code of the hub when an engine is there but did not answer `hello` (`engine_timeout`, `engine_busy`, ...). */
  engineProblem: string | null;
  /** The commits `engine.lock` pins: what this build was tested with. */
  pinned: { engine: string | null; lib: string | null };
}

/** A value for one line of the report: one line, trimmed, never longer than a commit message's subject. */
function word(value: string | null | undefined, unknown: string): string {
  if (value === null || value === undefined) return unknown;
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean === '' ? unknown : clean.slice(0, 120);
}

/** A commit as the engine or the lock names it: 7 to 40 hex digits (the engine says "unknown" when it has none). */
const COMMIT = /^[0-9a-f]{7,40}$/i;

/**
 * Does the engine that answers match the commit this build was tested with? `null` when one of the two is unknown:
 * a word that is no commit says nothing about a difference, so it is no warning either.
 */
export function engineMatchesPin(about: About): boolean | null {
  const running = about.engine?.git ?? null;
  const pinned = about.pinned.engine;
  if (!running || !pinned || !COMMIT.test(running) || !COMMIT.test(pinned)) return null;
  const a = running.toLowerCase();
  const b = pinned.toLowerCase();
  return b.startsWith(a) || a.startsWith(b);
}

/** The report as a text: the versions, then the three questions the person answers. */
export function reportText(lang: Lang, about: About): string {
  const t = (key: Parameters<typeof translate>[1], params: Record<string, string | number> = {}) =>
    translate(lang, key, params);
  const unknown = t('about.unknown');
  const build = about.build ? t('about.report.build', { build: word(about.build, unknown) }) : '';
  const lines = [
    t('about.report.line_app', {
      version: word(about.version, unknown),
      build,
      os: word(about.os, unknown),
      arch: word(about.arch, unknown),
    }),
    about.engine
      ? t('about.report.line_engine', {
          version: word(about.engine.version, unknown),
          git: word(about.engine.git, unknown),
          nvim: word(about.engine.nvim, unknown),
        })
      : about.engineProblem
        ? t('about.report.line_engine_failed', { problem: word(about.engineProblem, unknown) })
        : t('about.report.line_engine_none'),
    t('about.report.line_pinned', {
      engine: word(about.pinned.engine, unknown),
      lib: word(about.pinned.lib, unknown),
    }),
    '',
    t('about.report.what'),
    '',
    t('about.report.expected'),
    '',
    t('about.report.steps'),
    '',
  ];
  return lines.join('\n');
}

/** The address of a new issue with the title and the report filled in. */
export function issueUrl(lang: Lang, about: About): string {
  const params = new URLSearchParams({
    title: translate(lang, 'about.report.title', { version: word(about.version, translate(lang, 'about.unknown')) }),
    body: reportText(lang, about),
  });
  return `${ISSUES_URL}?${params.toString()}`;
}
