-- Measure how long the engine takes for ONE request with many `move_area` operations: the figures behind
-- `MOVE_MAX` in `ui/src/lib/bulk.ts` (the hub gives one engine call 30 s, past them the answer is `outcome_unknown`).
--
--     nvim --headless -u NONE -l tools/measure-bulk-move.lua <tasks.nvim dir> <lib.nvim dir> [tasks] [moves,...]
--
-- Builds a throw-away vault in the temp folder: `tasks` open tasks (default 650) in the area `src`, the first
-- `moves` of them each named by three others (`blocked_by`), so a move has references to rewrite. For every number of
-- moves a fresh vault is built, ONE request with that many `move_area` operations (to the area `dst`) is made through
-- the engine's own door (`tasks_nvim.api`) and the time it takes is printed, with how many moves were made.
-- Nothing of the real vault is read. The figures depend on the machine: the measured ones are in the comment at
-- `MOVE_MAX`; measure again when the engine changes how a move works.

local engine_dir, lib_dir = arg[1], arg[2]
if not (engine_dir and lib_dir) then
  io.stderr:write(
    "usage: measure-bulk-move.lua <tasks.nvim dir> <lib.nvim dir> [tasks] [moves,...]\n"
  )
  os.exit(2)
end
local task_count = tonumber(arg[3]) or 650
local steps = {}
for n in (arg[4] or "20,50,100"):gmatch("%d+") do
  steps[#steps + 1] = tonumber(n)
end

vim.opt.rtp:prepend(lib_dir)
vim.opt.rtp:prepend(engine_dir)

local api = require("tasks_nvim.api")
local base = vim.fs.joinpath(vim.fn.tempname() .. "-measure-bulk-move")

---@param root string
---@param area string
local function area_dirs(root, area)
  vim.fn.mkdir(root .. "/" .. area .. "/ROADMAP/tasks", "p")
  vim.fn.mkdir(root .. "/" .. area .. "/Backlog/FEATURES", "p")
  vim.fn.mkdir(root .. "/" .. area .. "/Backlog/TASKS", "p")
  local f = assert(io.open(root .. "/" .. area .. "/Backlog/README.md", "wb"))
  f:write("# X — Backlog\n\n## FEATURES (0)\n\n_noch leer_\n\n## TASKS (0)\n\n_noch leer_\n")
  f:close()
end

---@param root string
---@param slug string
---@param extra? string
local function task(root, slug, extra)
  local f = assert(io.open(root .. "/src/ROADMAP/tasks/" .. slug .. ".md", "wb"))
  f:write(
    ("---\ntitle: Task %s\nstatus: open\nprio: 2\n%s---\n\nBody of %s.\n"):format(
      slug,
      extra or "",
      slug
    )
  )
  f:close()
end

for _, moves in ipairs(steps) do
  local root = base .. "-" .. moves .. "/vault"
  area_dirs(root, "src")
  area_dirs(root, "dst")
  local slugs = {}
  for i = 1, task_count do
    slugs[i] = ("t%04d"):format(i)
  end
  -- the first `moves` tasks are named by three later ones each
  for i = 1, task_count do
    local extra
    if i > moves then
      local target = (i - moves - 1) % moves + 1
      extra = ("blocked_by: [src/%s]\n"):format(slugs[target])
    end
    task(root, slugs[i], extra)
  end
  local ops = {}
  for i = 1, moves do
    ops[i] = { op = "move_area", id = "src/" .. slugs[i], to_area = "dst" }
  end
  local started = vim.uv.hrtime()
  local text =
    api.call("ops", vim.json.encode({ ops = ops }), { root = root, today = "2026-10-18" })
  local seconds = (vim.uv.hrtime() - started) / 1e9
  local doc = vim.json.decode(text)
  local made = 0
  for _, r in ipairs(doc.results or {}) do
    if r.ok and r.outcome == "moved" then
      made = made + 1
    end
  end
  print(("%4d tasks, %3d moves: %6.2f s, %d made"):format(task_count, moves, seconds, made))
  vim.fn.delete(vim.fs.dirname(root), "rf")
end
