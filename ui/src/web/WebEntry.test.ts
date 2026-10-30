// The way in of the web variant, rendered on the server side of Svelte: what each state of the machine shows, in both
// languages. The clicks are the machine's (web/entry.test.mjs); the page in a browser is looked at by the Playwright
// run of the web variant.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import WebEntry from './WebEntry.svelte';
import type { EntryState } from './entry';

/** A machine that is only a state: the page reads `state` and subscribes. */
const machine = (state: EntryState) => ({ state, subscribe: () => () => {}, pick() {}, openRecent() {}, forget() {} });
const html = (state: EntryState, lang: 'en' | 'de' = 'en') =>
  render(WebEntry, { props: { entry: machine(state), lang } as never }).body.replace(/<!--.*?-->/g, '');

describe('the way in', () => {
  it('says why a browser that cannot choose a folder cannot, and offers no picker', () => {
    const missing = html({ step: 'unsupported', reason: 'missing' });
    expect(missing).toContain('role="alert"');
    expect(missing).toContain('File System Access API');
    expect(missing).not.toContain('<button');
    expect(html({ step: 'unsupported', reason: 'insecure' })).toContain('secure context');
    expect(html({ step: 'unsupported', reason: 'missing' }, 'de')).toContain('kann keinen Ordner wählen');
  });

  it('offers the picker, and the folders used before with what each needs', () => {
    const out = html({
      step: 'choose',
      notice: null,
      readOnly: false,
      recent: [
        { id: 'a', name: 'work', access: 'granted' },
        { id: 'b', name: 'home', access: 'prompt' },
        { id: 'c', name: 'moved', access: 'gone' },
      ],
    });
    expect(out).toContain('Choose folder ...');
    expect(out.match(/<li[ >]/g)).toHaveLength(3);
    const label = (word: string) => new RegExp(`>\\s*${word}\\s*</button>`, 'g');
    expect(out.match(label('Open'))).toHaveLength(1);
    expect(out.match(label('Allow access'))).toHaveLength(1);
    // a folder that is not there can only be forgotten
    expect(out.match(label('Forget'))).toHaveLength(3);
    expect(out).toContain('needs your permission');
    expect(out).toContain('The browser asks again');
  });

  it('shows no list and no hint when nothing was used before', () => {
    const out = html({ step: 'choose', notice: null, recent: [], readOnly: false });
    expect(out).not.toContain('Used before');
    expect(out).not.toContain('The browser asks again');
  });

  it('tells the reason the last try did not lead into a vault', () => {
    const notice = (code: 'cancelled' | 'blocked' | 'failed' | 'denied' | 'gone' | 'limit', detail?: string) =>
      html({ step: 'choose', recent: [], notice: { code, detail }, readOnly: false });
    expect(notice('cancelled')).toContain('No folder was chosen.');
    expect(notice('blocked')).toContain('policy of your organisation');
    expect(notice('denied')).toContain('Access was not allowed');
    expect(notice('gone')).toContain('not there any more');
    expect(notice('failed', 'disk full')).toContain('could not be opened: disk full');
    expect(notice('limit', 'more than 5 files')).toContain('too large to read: more than 5 files');
    expect(notice('gone')).toContain('role="alert"');
  });

  it('writes a name from the folder as text, never as markup', () => {
    const out = html({ step: 'choose', notice: null, recent: [{ id: 'x', name: '<img src=x onerror=alert(1)>', access: 'granted' }], readOnly: false });
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('tells a browser without a picker that it reads only, offers the one button and no list', () => {
    const out = html({ step: 'choose', notice: null, recent: [], readOnly: true });
    expect(out).toContain('cannot write into a folder');
    expect(out).toContain('Choose folder ...');
    expect(out).not.toContain('Used before');
    expect(html({ step: 'choose', notice: null, recent: [], readOnly: true }, 'de')).toContain('kann nicht in einen Ordner schreiben');
    expect(html({ step: 'choose', notice: null, recent: [], readOnly: false })).not.toContain('cannot write into a folder');
  });

  it('shows the reading, and the files that were left out', () => {
    expect(html({ step: 'opening', name: 'work' })).toContain('Reading work ...');
    const done = html({ step: 'open', name: 'work', files: 9, skipped: [{ path: 'a', reason: 'too-large' }, { path: 'b', reason: 'unreadable' }], folder: null, readOnly: false });
    expect(done).toContain('2 files were left out');
    expect(html({ step: 'opening', name: 'arbeit' }, 'de')).toContain('Lese arbeit ...');
  });
});
