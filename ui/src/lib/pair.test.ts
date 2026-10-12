import { describe, expect, it } from 'vitest';
import { takePairingCode } from './pair';

function run(hash: string) {
  const calls: unknown[][] = [];
  const code = takePairingCode(
    { hash, pathname: '/', search: '' },
    { replaceState: (...args: unknown[]) => void calls.push(args) },
  );
  return { code, calls };
}

describe('takePairingCode', () => {
  const good = 'ab'.repeat(16);
  it('takes the code and clears the fragment', () => {
    const { code, calls } = run(`#pair=${good}`);
    expect(code).toBe(good);
    expect(calls).toEqual([[null, '', '/']]);
  });
  it('refuses a code that is not hex of the right size, but still clears', () => {
    for (const hash of ['#pair=zz', '#pair=ab', `#pair=${good}x`, '#other=1']) {
      const { code, calls } = run(hash);
      expect(code).toBeNull();
      expect(calls.length).toBe(1);
    }
  });
  it('does nothing without a fragment', () => {
    const { code, calls } = run('');
    expect(code).toBeNull();
    expect(calls).toEqual([]);
  });
});
