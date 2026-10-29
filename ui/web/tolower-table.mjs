// Makes the LOWER table of ui/src/web/vim-shim.lua from Neovim itself: every code point up to U+1FFFF that
// `vim.fn.tolower` changes, compressed into runs { first, last, step, delta }.
//
//   node web/tolower-table.mjs        (from ui/; needs nvim on PATH; prints the rows of the table)
//
// Run it when Neovim's case tables change (the comparison in web/engine.test.mjs, TASKS_WEB_COMPARE=1, tells), and
// put the rows between `local LOWER = {` and `}` in the shim.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeTree, tempDir } from './tmp.mjs';

const DUMP = `
local function utf8char(cp)
  if cp < 0x80 then return string.char(cp) end
  if cp < 0x800 then return string.char(0xC0 + math.floor(cp / 0x40), 0x80 + cp % 0x40) end
  if cp < 0x10000 then
    return string.char(0xE0 + math.floor(cp / 0x1000), 0x80 + math.floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
  end
  return string.char(0xF0 + math.floor(cp / 0x40000), 0x80 + math.floor(cp / 0x1000) % 0x40,
    0x80 + math.floor(cp / 0x40) % 0x40, 0x80 + cp % 0x40)
end
local out = {}
for cp = 0x41, 0x1FFFF do
  if cp < 0xD800 or cp > 0xDFFF then
    local c = utf8char(cp)
    local l = vim.fn.tolower(c)
    if l ~= c then
      out[#out + 1] = string.format("%x %s", cp, (l:gsub(".", function(b) return string.format("%02x", b:byte()) end)))
    end
  end
end
io.stdout:write(table.concat(out, "\\n"), "\\n")
`;

/** Pairs [code point, lowered code point], sorted, compressed into runs of equal delta and step 1 or 2. */
export function runs(pairs) {
  const out = [];
  for (const [cp, lo] of pairs) {
    const delta = lo - cp;
    const last = out[out.length - 1];
    if (last && last.delta === delta) {
      const step = cp - last.last;
      if ((last.first === last.last && (step === 1 || step === 2)) || step === last.step) {
        last.step = step;
        last.last = cp;
        continue;
      }
    }
    out.push({ first: cp, last: cp, step: 1, delta });
  }
  return out;
}

function main() {
  const dir = tempDir('tolower');
  try {
    const script = join(dir, 'dump.lua');
    writeFileSync(script, DUMP);
    const text = execFileSync('nvim', ['--headless', '-u', 'NONE', '-l', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const pairs = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [cp, hex] = line.split(' ');
        const lowered = [...Buffer.from(hex, 'hex').toString('utf8')];
        if (lowered.length !== 1) throw new Error(`U+${cp} lowers to more than one character`);
        return [parseInt(cp, 16), lowered[0].codePointAt(0)];
      });
    const hex = (n) => '0x' + n.toString(16).toUpperCase();
    for (const r of runs(pairs)) console.log(`  { ${hex(r.first)}, ${hex(r.last)}, ${r.step}, ${r.delta} },`);
    console.error(`${pairs.length} code points, ${runs(pairs).length} runs`);
  } finally {
    removeTree(dir);
  }
}

main();
