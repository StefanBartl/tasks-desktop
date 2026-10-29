import { describe, expect, it } from 'vitest';
import { REPORT_REPOS, engineMatchesPin, issueUrl, reportText, type About } from './about';

const about: About = {
  app: 'tasks-desktop',
  version: '0.4.1',
  build: 'abc1234',
  os: 'windows',
  arch: 'x86_64',
  mode: null,
  engine: { version: '0.9.0', git: 'faf2078', nvim: '0.12.2' },
  engineProblem: null,
  pinned: { engine: 'faf2078d08ee7632a884bde2b2dee95fef7dfe25', lib: '6f302183bd289417de806aaed11a5a6a4b4724ab' },
};

describe('reportText', () => {
  it('names the build, the engine and the pins, then the three questions', () => {
    const text = reportText('en', about);
    expect(text).toContain('tasks-desktop 0.4.1 (build abc1234) on windows x86_64');
    expect(text).toContain('Engine: tasks.nvim 0.9.0, commit faf2078, Neovim 0.12.2');
    expect(text).toContain('Tested with: tasks.nvim faf2078d08ee7632a884bde2b2dee95fef7dfe25, lib.nvim 6f302183bd289417de806aaed11a5a6a4b4724ab');
    expect(text).toContain('What happened:');
    expect(reportText('de', about)).toContain('Was ist passiert:');
  });
  it('says so when there is no engine and when a word is missing; a release has no build', () => {
    const text = reportText('en', { ...about, build: null, engine: null, pinned: { engine: null, lib: null } });
    expect(text).toContain('tasks-desktop 0.4.1 on windows x86_64');
    expect(text).not.toContain('build');
    expect(text).toContain('Engine: none is running');
    expect(text).toContain('Tested with: tasks.nvim unknown, lib.nvim unknown');
  });
  it('tells an engine that runs but did not answer apart from no engine', () => {
    const text = reportText('en', { ...about, engine: null, engineProblem: 'engine_timeout' });
    expect(text).toContain('Engine: running, but it did not answer (engine_timeout)');
    expect(text).not.toContain('none is running');
    expect(reportText('de', { ...about, engine: null, engineProblem: 'engine_busy' })).toContain('hat aber nicht geantwortet (engine_busy)');
  });
  it('names the web variant and the runtime of the browser, never a Neovim it does not run in', () => {
    const web: About = { ...about, os: 'web', arch: 'wasm', mode: 'web', engine: { version: '0.9.0', git: 'faf2078', nvim: 'web+Lua5.4' } };
    const text = reportText('en', web);
    expect(text).toContain('Mode: web variant (in the browser, no hub)');
    expect(text).toContain('Engine: tasks.nvim 0.9.0, commit faf2078, in the browser (web+Lua5.4)');
    expect(text).not.toContain('Neovim');
    expect(reportText('de', web)).toContain('Modus: Web-Variante');
    expect(reportText('en', about)).not.toContain('Mode:');
  });
  it('keeps every value on one line and short, whatever the hub said', () => {
    const text = reportText('en', { ...about, version: ' 1.0\n\u0000evil' + String.fromCharCode(0x200b) + ' ' + 'x'.repeat(500) });
    const line = text.split('\n')[0] ?? '';
    expect(line).toMatch(/^tasks-desktop 1\.0 evil x+ \(build abc1234\)/);
    expect(line.length).toBeLessThan(200);
    expect(text).not.toContain('\u0000');
  });
});

describe('issueUrl', () => {
  it('points at a new issue with the title and the report filled in', () => {
    const url = new URL(issueUrl('en', about));
    expect(url.origin + url.pathname).toBe('https://github.com/WKDSteve/tasks-desktop/issues/new');
    expect(url.searchParams.get('title')).toBe('tasks-desktop 0.4.1: ');
    expect(url.searchParams.get('body')).toBe(reportText('en', about));
  });
});

describe('engineMatchesPin', () => {
  it('compares the short commit of the engine with the pinned one', () => {
    expect(engineMatchesPin(about)).toBe(true);
    expect(engineMatchesPin({ ...about, engine: { ...about.engine!, git: 'deadbee' } })).toBe(false);
    expect(engineMatchesPin({ ...about, engine: null })).toBeNull();
    expect(engineMatchesPin({ ...about, pinned: { engine: null, lib: null } })).toBeNull();
    // A word that is no commit says nothing about a difference: the engine says "unknown" when it has no git, and a
    // warning that the engine differs would be a claim nobody can back.
    expect(engineMatchesPin({ ...about, engine: { ...about.engine!, git: 'unknown' } })).toBeNull();
    expect(engineMatchesPin({ ...about, engine: { ...about.engine!, git: 'not-hex-7' } })).toBeNull();
    expect(engineMatchesPin({ ...about, engine: { ...about.engine!, git: 'fa' } })).toBeNull();
    expect(engineMatchesPin({ ...about, pinned: { ...about.pinned, engine: 'moved' } })).toBeNull();
  });
});

describe('REPORT_REPOS', () => {
  it('names the app, the engine and appkit, each with the page of its issues', () => {
    expect(REPORT_REPOS.map((r) => r.name)).toEqual(['tasks-desktop', 'tasks.nvim', 'appkit']);
    for (const repo of REPORT_REPOS) {
      expect(repo.url).toBe(`https://github.com/WKDSteve/${repo.name}/issues`);
    }
  });
});
