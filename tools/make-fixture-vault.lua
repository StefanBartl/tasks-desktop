-- Build the synthetic fixture vault of tasks.nvim (the one its contract golden files are made from)
-- into a folder of this repository, so the hub and the end-to-end tests have a vault that holds
-- every readiness state, a hostile title, a non-ASCII title and a broken task, and no real data.
--
--     nvim --headless -u NONE -l tools/make-fixture-vault.lua <tasks.nvim dir> <lib.nvim dir> <out dir>
--
-- The vault ends up in `<out dir>/vault`. The areas that have no ROADMAP/ or Backlog/ are named by
-- `TASKS_EXTRA_AREAS`, see `e2e/fixture.json`. Every file is written byte for byte (LF, no BOM);
-- `.gitattributes` keeps git from changing them, because every `etag` is a hash of the bytes.

local engine_dir, lib_dir, out = arg[1], arg[2], arg[3]
if not (engine_dir and lib_dir and out) then
  io.stderr:write("usage: make-fixture-vault.lua <tasks.nvim dir> <lib.nvim dir> <out dir>\n")
  os.exit(2)
end

vim.opt.rtp:prepend(lib_dir)
vim.opt.rtp:prepend(engine_dir)

out = vim.fs.normalize(out)
vim.fn.delete(out .. "/vault", "rf")
vim.fn.mkdir(out, "p")

local H = {
  tmpdir = function()
    return out
  end,
  write = function(path, content)
    vim.fn.mkdir(vim.fn.fnamemodify(path, ":h"), "p")
    local f = assert(io.open(path, "wb"))
    f:write(content)
    f:close()
  end,
}

local fixture = dofile(vim.fs.normalize(engine_dir) .. "/TESTS/contract_fixture.lua")
local root = fixture.build(H)
io.stdout:write("fixture vault: " .. root .. "\n")
