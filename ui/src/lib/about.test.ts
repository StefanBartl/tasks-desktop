import { describe, expect, it } from 'vitest';
import { engineMatchesPin, issueUrl, reportText, type About } from './about';

const about: About = {
  app: 'tasks-desktop',
  version: '0.4.1',
  build: 'abc1234',
  os: 'windows',
  arch: 'x86_64',
  engine: { version: '0.9.0', git: 'faf2078', nvim: '0.12.2' },
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
    expect(url.origin + url.pathname).toBe('https://github.com/StefanBartl/tasks-desktop/issues/new');
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
    // A commit too short to say anything is no match.
    expect(engineMatchesPin({ ...about, engine: { ...about.engine!, git: 'fa' } })).toBe(false);
  });
});
