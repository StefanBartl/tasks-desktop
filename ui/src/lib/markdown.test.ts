import { describe, expect, it } from 'vitest';
import { hostOf, parseMarkdown, safeHref, type Block, type Inline } from './markdown';

/** Every link target and every kind of node in a tree. */
function walk(blocks: Block[], out: { hrefs: (string | null)[]; kinds: Set<string> }): void {
  const inline = (items: Inline[]): void => {
    for (const item of items) {
      out.kinds.add(item.t);
      if (item.t === 'link') {
        out.hrefs.push(item.href);
        inline(item.children);
      } else if (item.t === 'em' || item.t === 'strong' || item.t === 'del') {
        inline(item.children);
      }
    }
  };
  for (const block of blocks) {
    out.kinds.add(block.t);
    if (block.t === 'p' || block.t === 'h') inline(block.children);
    else if (block.t === 'quote') walk(block.children, out);
    else if (block.t === 'list') for (const item of block.items) walk(item, out);
    else if (block.t === 'table') {
      for (const cell of block.head) inline(cell);
      for (const row of block.rows) for (const cell of row) inline(cell);
    }
  }
}

function inspect(source: string) {
  const out = { hrefs: [] as (string | null)[], kinds: new Set<string>() };
  walk(parseMarkdown(source), out);
  return out;
}

describe('safeHref', () => {
  it('lets http, https and mailto through, and nothing else', () => {
    expect(safeHref('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeHref('http://example.org')).toBe('http://example.org/');
    expect(safeHref('mailto:a@example.org')).toBe('mailto:a@example.org');
    for (const bad of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.org/x',
      '//example.org',
      '/relative/path',
      'ROADMAP/tasks/x.md',
      '',
      'x'.repeat(3000),
    ]) {
      expect(safeHref(bad), bad).toBeNull();
    }
  });
});

describe('hostOf', () => {
  it('names where a link goes, so that its text cannot say otherwise', () => {
    expect(hostOf('https://example.org:8443/a?b')).toBe('example.org:8443');
    expect(hostOf('mailto:someone@example.org')).toBe('example.org');
    const [p] = parseMarkdown('[https://bank.example](https://evil.example/login)');
    expect(p?.t === 'p' && p.children[0]?.t === 'link' ? p.children[0].host : null).toBe(
      'evil.example',
    );
  });
});

describe('parseMarkdown', () => {
  it('reads the usual blocks', () => {
    const blocks = parseMarkdown(
      '# T\n\nText with *em*, **strong** and `code`.\n\n- a\n- b\n\n1. x\n\n> q\n\n```js\nlet a;\n```\n\n---\n',
    );
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'list', 'list', 'quote', 'pre', 'hr']);
  });

  it('reads a table', () => {
    const [table] = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(table?.t).toBe('table');
    if (table?.t === 'table') {
      expect(table.head.length).toBe(2);
      expect(table.rows.length).toBe(1);
    }
  });

  describe('hostile input', () => {
    it('never makes a node out of raw HTML', () => {
      const kinds = inspect(
        '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<svg onload=alert(1)>\n\n<iframe src="javascript:alert(1)"></iframe>\n\ntext <b onmouseover=alert(1)>x</b>',
      ).kinds;
      // Paragraphs of text, nothing that is a tag.
      expect([...kinds].sort()).toEqual(['p', 'text']);
    });

    it('drops the target of a link that is not http, https or mailto', () => {
      const { hrefs } = inspect(
        [
          '[a](javascript:alert(1))',
          '[b](JAVASCRIPT:alert(1))',
          '[c](data:text/html;base64,PHNjcmlwdD4=)',
          '[d](vbscript:x)',
          '[e](  javascript:alert(1))',
          '[f](java&#115;cript:alert(1))',
          '[g][ref]',
          '<javascript:alert(1)>',
          '[h](https://example.org)',
          '',
          '[ref]: javascript:alert(1)',
        ].join('\n\n'),
      );
      expect(hrefs.filter((h) => h !== null)).toEqual(['https://example.org/']);
    });

    it('turns an image into its description, not into a request', () => {
      const out = inspect('![alt text](https://tracker.example/pixel.png)\n\n![x](data:image/svg+xml,<svg onload=alert(1)>)');
      expect(out.kinds.has('image')).toBe(true);
      // The tree has no field that holds an address of an image.
      const blocks = parseMarkdown('![alt](https://tracker.example/pixel.png)');
      expect(JSON.stringify(blocks)).not.toContain('tracker.example');
    });

    it('survives deep nesting', () => {
      const source = `${'> '.repeat(500)}deep\n\n${'- a\n'.repeat(2)}${'  '.repeat(30)}- x`;
      const blocks = parseMarkdown(source);
      expect(Array.isArray(blocks)).toBe(true);
      let depth = 0;
      let node: Block | undefined = blocks[0];
      while (node && node.t === 'quote') {
        depth += 1;
        node = node.children[0];
      }
      expect(depth).toBeLessThanOrEqual(13);
    });

    it('shows a source over the limit as it is', () => {
      const big = '# x\n'.repeat(80_000);
      const blocks = parseMarkdown(big);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.t).toBe('pre');
    });
  });
});
