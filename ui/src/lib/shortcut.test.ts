import { describe, expect, it } from 'vitest';
import { chromeTarget, pageAddress } from './shortcut';

describe('shortcut', () => {
  it('opens the page itself, not the task or the view after #', () => {
    expect(pageAddress('file:///C:/repos/tasks-web/tasks.html#task=a/b')).toBe('file:///C:/repos/tasks-web/tasks.html');
    expect(pageAddress('file:///C:/x/tasks.html')).toBe('file:///C:/x/tasks.html');
  });

  it('starts Chrome with a window of its own, the address one argument', () => {
    expect(chromeTarget('file:///C:/my%20vault/tasks.html')).toBe(
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --app=file:///C:/my%20vault/tasks.html',
    );
    expect(chromeTarget('file:///C:/a"b c/tasks.html')).toBe(
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --app=file:///C:/a%22b%20c/tasks.html',
    );
  });
});
