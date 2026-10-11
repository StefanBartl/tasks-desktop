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
vim.fn.mkdir(out, "p")

-- `<out>/vault` is deleted before it is built again. Only do that to a folder this script made:
-- it leaves a marker next to the vault, and without the marker an existing `vault` is left alone.
local marker = out .. "/.make-fixture-vault"
if vim.uv.fs_stat(out .. "/vault") then
  if not vim.uv.fs_stat(marker) then
    io.stderr:write(
      "refusing to delete " .. out .. "/vault: it was not made by this script (no marker)\n"
    )
    os.exit(2)
  end
  vim.fn.delete(out .. "/vault", "rf")
end

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
H.write(marker, "made by tools/make-fixture-vault.lua\n")
io.stdout:write("fixture vault: " .. root .. "\n")
