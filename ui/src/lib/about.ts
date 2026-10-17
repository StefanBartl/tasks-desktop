// The Info dialog and the bug report (rule APP-09): the words of `GET /api/tasks/about` as a text a person can read and
// paste, and the address of a new issue with that text filled in. The page sends nothing: the person sees the form in
// the browser and sends it, or does not.

import { translate, type Lang } from './i18n';

/** Where a problem is reported: a new issue of the public repository, the fields filled by the address. */
export const ISSUES_URL = 'https://github.com/StefanBartl/tasks-desktop/issues/new';

/** What the hub says about the build and the engine: versions and commits only, never a path (ENG-06). */
export interface About {
  app: string;
  version: string;
  /** The commit of a rolling build; `null` in a release and in a local build. */
  build: string | null;
  os: string;
  arch: string;
  /** `null` while no engine runs. */
  engine: { version: string | null; git: string | null; nvim: string | null } | null;
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

/** Does the engine that answers match the commit this build was tested with? `null` when one of the two is unknown. */
export function engineMatchesPin(about: About): boolean | null {
  const running = about.engine?.git ?? null;
  const pinned = about.pinned.engine;
  if (!running || !pinned) return null;
  const a = running.toLowerCase();
  const b = pinned.toLowerCase();
  return a.length >= 7 && (b.startsWith(a) || a.startsWith(b));
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
