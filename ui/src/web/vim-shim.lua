-- The `vim` the engine sees in the browser: what the machine contract of tasks.nvim (`call <method>`) needs, on Lua 5.4
-- (wasmoon) instead of Neovim's LuaJIT.
--
-- Rules:
--  * Behave like Neovim where the engine can tell: JSON (`{}` is `[]`, `vim.empty_dict()` is `{}`, null is `vim.NIL`),
--    paths, string helpers. A whole number decoded from JSON is an integer, as `tostring` shows it on LuaJIT ("3",
--    never "3.0").
--  * Anything of the editor (windows, buffers, keymaps, commands, the UI) is not here. An unknown `vim.fn.*` or
--    `vim.api.*` raises an error that names it, so a gap shows at once instead of as a wrong answer.
--  * Files: Lua's `io` and `os` work on the in-memory file system of the VM (Emscripten MEMFS); `__web` (set by the
--    page before this file runs) answers what Lua cannot ask itself: stat, list a folder, make folders, the
--    environment, the clock.

local web = assert(__web, "vim-shim: __web is missing")

-- ── Lua 5.1 / LuaJIT names the engine may use ──────────────────────────────────

unpack = unpack or table.unpack
loadstring = loadstring or load
---@diagnostic disable-next-line: deprecated
table.unpack = table.unpack or unpack
math.pow = math.pow or function(x, y)
  return x ^ y
end

-- LuaJIT has one number type, Lua 5.4 two: tonumber("2.0") is a float there, and its text is "2.0" where LuaJIT
-- writes "2". The engine reads numbers from text this way (`prio: 2.0` -> `tostring` -> "^[123]$"), so a whole number
-- read from text is an integer here. A float made by arithmetic (0.5 * 2) cannot be caught here: `..` formats it
-- inside the VM; the comparison with nvim (web/engine.test.mjs) is the guard for those.
local raw_tonumber = tonumber
function tonumber(v, base)
  local n = raw_tonumber(v, base)
  if math.type(n) == "float" and n == n and n ~= 0 then
    return math.tointeger(n) or n
  end
  return n
end

local vim = {}
_G.vim = vim

local function missing(space)
  return setmetatable({}, {
    __index = function(_, name)
      return function()
        error(("vim.%s.%s is not available in the browser"):format(space, name), 2)
      end
    end,
  })
end

-- ── sentinels ──────────────────────────────────────────────────────────────────

-- `vim.NIL` (JSON null) is a userdata in Neovim: engine code that asks `type(x) == "table"` must not take it for one.
-- Lua 5.4 has no `newproxy`; a file handle of the VM's in-memory file system is a full userdata of its own, closed and
-- given a metatable that only names it.
local NIL_MT = {
  __name = "vim.NIL",
  __tostring = function()
    return "vim.NIL"
  end,
}
vim.NIL = (function()
  local handle = io.tmpfile()
  if not handle then
    return setmetatable({}, NIL_MT)
  end
  handle:close()
  return debug.setmetatable(handle, NIL_MT)
end)()

local EMPTY_DICT = {
  -- as Neovim names it; vim.inspect prints an empty one this way
  __tostring = function()
    return "vim.empty_dict()"
  end,
}
-- Neovim's name for it: vim.inspect and lib.nvim.json.canonical look for this metatable.
vim._empty_dict_mt = EMPTY_DICT
function vim.empty_dict()
  return setmetatable({}, EMPTY_DICT)
end

vim.log = { levels = { TRACE = 0, DEBUG = 1, INFO = 2, WARN = 3, ERROR = 4, OFF = 5 } }

-- ── tables ─────────────────────────────────────────────────────────────────────

function vim.islist(t)
  if type(t) ~= "table" then
    return false
  end
  if next(t) == nil then
    return getmetatable(t) ~= EMPTY_DICT
  end
  -- as Neovim counts: as many keys as there are values at 1, 2, 3, ... (`#t` is any border of a table with holes)
  local j = 1
  for _ in pairs(t) do
    if t[j] == nil then
      return false
    end
    j = j + 1
  end
  return true
end
vim.tbl_islist = vim.islist

function vim.isarray(t)
  if type(t) ~= "table" then
    return false
  end
  for k in pairs(t) do
    if type(k) ~= "number" or k ~= math.floor(k) then
      return false
    end
  end
  return true
end

function vim.deepcopy(orig, noref)
  local seen = {}
  local function copy(o)
    if type(o) ~= "table" or o == vim.NIL then
      return o
    end
    if not noref and seen[o] then
      return seen[o]
    end
    local res = {}
    seen[o] = res
    for k, v in pairs(o) do
      res[copy(k)] = copy(v)
    end
    return setmetatable(res, getmetatable(o))
  end
  return copy(orig)
end

-- Neovim's rules: an empty table merges too (it is no list there), a list is replaced; the first table being
-- `vim.empty_dict()` makes the result one; `behavior` may be a function(key, previous, value).
local function can_merge(v)
  return type(v) == "table" and (next(v) == nil or not vim.islist(v))
end

local function tbl_extend(behavior, deep, ...)
  local ret = getmetatable((...)) == EMPTY_DICT and vim.empty_dict() or {}
  for i = 1, select("#", ...) do
    local tbl = select(i, ...)
    if tbl then
      for k, v in pairs(tbl) do
        if deep and can_merge(v) and can_merge(ret[k]) then
          ret[k] = tbl_extend(behavior, true, ret[k], v)
        elseif type(behavior) == "function" then
          ret[k] = behavior(k, ret[k], v)
        elseif behavior ~= "force" and ret[k] ~= nil then
          if behavior == "error" then
            error("key found in more than one map: " .. tostring(k))
          end
        else
          ret[k] = v
        end
      end
    end
  end
  return ret
end

function vim.tbl_extend(behavior, ...)
  return tbl_extend(behavior, false, ...)
end

function vim.tbl_deep_extend(behavior, ...)
  return tbl_extend(behavior, true, ...)
end

function vim.tbl_keys(t)
  local keys = {}
  for k in pairs(t) do
    keys[#keys + 1] = k
  end
  return keys
end

function vim.tbl_values(t)
  local values = {}
  for _, v in pairs(t) do
    values[#values + 1] = v
  end
  return values
end

function vim.tbl_map(fn, t)
  local ret = {}
  for k, v in pairs(t) do
    ret[k] = fn(v)
  end
  return ret
end

function vim.tbl_filter(fn, t)
  local ret = {}
  for _, v in pairs(t) do
    if fn(v) then
      ret[#ret + 1] = v
    end
  end
  return ret
end

function vim.tbl_contains(t, value, opts)
  local pred = opts and opts.predicate
  for _, v in pairs(t) do
    if pred and value(v) or (not pred and v == value) then
      return true
    end
  end
  return false
end

function vim.list_contains(t, value)
  for _, v in ipairs(t) do
    if v == value then
      return true
    end
  end
  return false
end

function vim.tbl_isempty(t)
  return next(t) == nil
end

function vim.tbl_count(t)
  local n = 0
  for _ in pairs(t) do
    n = n + 1
  end
  return n
end

function vim.tbl_get(t, ...)
  local v = t
  for i = 1, select("#", ...) do
    if type(v) ~= "table" then
      return nil
    end
    v = v[select(i, ...)]
  end
  return v
end

function vim.list_extend(dst, src, start, finish)
  for i = start or 1, finish or #src do
    dst[#dst + 1] = src[i]
  end
  return dst
end

function vim.list_slice(list, start, finish)
  local ret = {}
  for i = start or 1, finish or #list do
    ret[#ret + 1] = list[i]
  end
  return ret
end

function vim.spairs(t)
  local keys = vim.tbl_keys(t)
  table.sort(keys, function(a, b)
    return tostring(a) < tostring(b)
  end)
  local i = 0
  return function()
    i = i + 1
    if keys[i] ~= nil then
      return keys[i], t[keys[i]]
    end
  end
end

-- ── strings ────────────────────────────────────────────────────────────────────

-- Neovim's form: both steps are anchored at the start, so a long run of whitespace inside the string costs linear time
-- (`gsub("%s+$", "")` tries every position of such a run and is quadratic).
function vim.trim(s)
  return s:gsub("^%s+", ""):match("^.*%S") or ""
end

function vim.startswith(s, prefix)
  return s:sub(1, #prefix) == prefix
end

function vim.endswith(s, suffix)
  return #suffix == 0 or s:sub(-#suffix) == suffix
end

function vim.pesc(s)
  return (s:gsub("[%(%)%.%%%+%-%*%?%[%]%^%$]", "%%%1"))
end

function vim.gsplit(s, sep, opts)
  local plain = type(opts) == "boolean" and opts or (type(opts) == "table" and opts.plain)
  local trimempty = type(opts) == "table" and opts.trimempty
  local parts = {}
  local start = 1
  if sep == "" then
    for i = 1, #s do
      parts[#parts + 1] = s:sub(i, i)
    end
  else
    while true do
      local i, j = s:find(sep, start, plain)
      if not i then
        parts[#parts + 1] = s:sub(start)
        break
      end
      -- a pattern that matches the empty string would never move on; Neovim refuses it the same way
      assert(j >= i, "Infinite loop detected")
      parts[#parts + 1] = s:sub(start, i - 1)
      start = j + 1
    end
  end
  if trimempty then
    while parts[1] == "" do
      table.remove(parts, 1)
    end
    while parts[#parts] == "" do
      table.remove(parts)
    end
  end
  local i = 0
  return function()
    i = i + 1
    return parts[i]
  end
end

function vim.split(s, sep, opts)
  local ret = {}
  for part in vim.gsplit(s, sep, opts) do
    ret[#ret + 1] = part
  end
  return ret
end

function vim.validate()
  return true
end

-- Neovim's own inspect.lua (vendor/inspect.lua, the bundle's module `vim.inspect`): the engine puts its output into
-- messages of the documents ("prio must be 1, 2 or 3, got ...").
function vim.inspect(...)
  return require("vim.inspect")(...)
end

-- ── JSON (Neovim's rules, see the head of this file) ───────────────────────────

local json = {}
vim.json = json

local ESC = {
  ['"'] = '\\"',
  ["\\"] = "\\\\",
  ["\b"] = "\\b",
  ["\f"] = "\\f",
  ["\n"] = "\\n",
  ["\r"] = "\\r",
  ["\t"] = "\\t",
}

local function encode_string(s)
  return '"'
    .. s:gsub('[%c"\\]', function(c)
      return ESC[c] or string.format("\\u%04x", c:byte())
    end)
    .. '"'
end

-- As Neovim writes a number (LuaJIT has doubles only, checked against nvim in web/shim-parity.lua): "%.16g" for every
-- number, an integer too, so 1/3 is "0.3333333333333333", 1e20 is "1e+20" and -0.0 is "-0".
local function encode_number(n)
  if n ~= n or n == math.huge or n == -math.huge then
    error("vim.json.encode: cannot encode " .. tostring(n))
  end
  return string.format("%.16g", n)
end

function json.encode(v)
  local t = type(v)
  if v == nil or v == vim.NIL then
    return "null"
  elseif t == "boolean" then
    return tostring(v)
  elseif t == "number" then
    return encode_number(v)
  elseif t == "string" then
    return encode_string(v)
  elseif t == "table" then
    if getmetatable(v) == EMPTY_DICT and next(v) == nil then
      return "{}"
    end
    if vim.islist(v) then
      local parts = {}
      for i = 1, #v do
        parts[i] = json.encode(v[i])
      end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do
      keys[#keys + 1] = tostring(k)
    end
    table.sort(keys)
    local parts = {}
    for _, k in ipairs(keys) do
      local val = v[k]
      if val == nil then
        val = v[tonumber(k)]
      end
      parts[#parts + 1] = encode_string(k) .. ":" .. json.encode(val)
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  error("vim.json.encode: cannot encode a " .. t)
end

local function decode_error(pos, what)
  error(("Expected %s at character %d"):format(what, pos), 0)
end

local UNESCAPE = {
  b = "\b",
  f = "\f",
  n = "\n",
  r = "\r",
  t = "\t",
  ['"'] = '"',
  ["\\"] = "\\",
  ["/"] = "/",
}

function json.decode(s, opts)
  local luanil_object = opts and opts.luanil and opts.luanil.object
  local luanil_array = opts and opts.luanil and opts.luanil.array
  local pos = 1
  local function ws()
    pos = s:find("[^ \t\r\n]", pos) or #s + 1
  end
  local value
  local function str()
    local out = {}
    pos = pos + 1
    while true do
      local c = s:sub(pos, pos)
      if c == "" then
        decode_error(pos, "closing quote")
      elseif c == '"' then
        pos = pos + 1
        return table.concat(out)
      elseif c == "\\" then
        local e = s:sub(pos + 1, pos + 1)
        if UNESCAPE[e] then
          out[#out + 1] = UNESCAPE[e]
          pos = pos + 2
        elseif e == "u" then
          local digits = s:sub(pos + 2, pos + 5)
          local cp = digits:match("^%x%x%x%x$") and tonumber(digits, 16)
            or decode_error(pos, "hex digits")
          pos = pos + 6
          if cp >= 0xD800 and cp <= 0xDBFF and s:sub(pos, pos + 1) == "\\u" then
            local lo = tonumber(s:sub(pos + 2, pos + 5), 16)
            if lo and lo >= 0xDC00 and lo <= 0xDFFF then
              cp = 0x10000 + (cp - 0xD800) * 0x400 + (lo - 0xDC00)
              pos = pos + 6
            end
          end
          out[#out + 1] = utf8.char(cp)
        else
          decode_error(pos, "escape")
        end
      else
        local j = s:find('["\\]', pos) or #s + 1
        out[#out + 1] = s:sub(pos, j - 1)
        pos = j
      end
    end
  end
  function value()
    ws()
    local c = s:sub(pos, pos)
    if c == "{" then
      pos = pos + 1
      local obj = {}
      ws()
      if s:sub(pos, pos) == "}" then
        pos = pos + 1
        return vim.empty_dict()
      end
      while true do
        ws()
        if s:sub(pos, pos) ~= '"' then
          decode_error(pos, "object key")
        end
        local k = str()
        ws()
        if s:sub(pos, pos) ~= ":" then
          decode_error(pos, "colon")
        end
        pos = pos + 1
        local v = value()
        if v == vim.NIL and luanil_object then
          v = nil
        end
        obj[k] = v
        ws()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "}" then
          return obj
        elseif d ~= "," then
          decode_error(pos - 1, "comma or closing brace")
        end
      end
    elseif c == "[" then
      pos = pos + 1
      local arr = {}
      local n = 0
      ws()
      if s:sub(pos, pos) == "]" then
        pos = pos + 1
        return arr
      end
      while true do
        local v = value()
        n = n + 1
        if not (v == vim.NIL and luanil_array) then
          arr[n] = v
        end
        ws()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "]" then
          return arr
        elseif d ~= "," then
          decode_error(pos - 1, "comma or closing bracket")
        end
      end
    elseif c == '"' then
      return str()
    elseif s:sub(pos, pos + 3) == "true" then
      pos = pos + 4
      return true
    elseif s:sub(pos, pos + 4) == "false" then
      pos = pos + 5
      return false
    elseif s:sub(pos, pos + 3) == "null" then
      pos = pos + 4
      return vim.NIL
    end
    local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
    if not num or num == "" or num == "-" then
      decode_error(pos, "value")
    end
    local n = tonumber(num)
    if not n then
      -- "1e", "1-": the pattern takes them, no number reads them; never a silent nil in an array
      decode_error(pos, "value")
    end
    pos = pos + #num
    -- LuaJIT has one number type: a whole number is shown without ".0", so make it an integer here
    return math.tointeger(n) or n
  end
  local ok, res = pcall(value)
  if not ok then
    error(res, 0)
  end
  ws()
  if pos <= #s then
    error(("Expected the end but found invalid token at character %d"):format(pos), 0)
  end
  return res
end

-- ── paths and files ────────────────────────────────────────────────────────────

local fs = {}
vim.fs = fs

function fs.normalize(path, opts)
  if path == nil or path == "" then
    return path
  end
  path = path:gsub("\\", "/")
  if path:sub(1, 1) == "~" then
    path = web.home() .. path:sub(2)
  end
  -- as Neovim: `$VAR` is replaced when it is set and stays as it is when not; `{ expand_env = false }` keeps it
  if not (opts and opts.expand_env == false) then
    path = path:gsub("%$([%w_]+)", function(name)
      return web.env(name)
    end)
  end
  local abs = path:sub(1, 1) == "/"
  local parts = {}
  for part in path:gmatch("[^/]+") do
    if part == ".." and #parts > 0 and parts[#parts] ~= ".." then
      parts[#parts] = nil
    elseif part ~= "." and not (part == ".." and abs) then
      -- (nothing is above the root: "/.." is "/")
      parts[#parts + 1] = part
    end
  end
  local out = (abs and "/" or "") .. table.concat(parts, "/")
  if out == "" then
    return abs and "/" or "."
  end
  return out
end

-- dirname, basename and joinpath follow Neovim's rules on a system with "/" (the VM's file system): a trailing "/"
-- is cut once by dirname ("/a/b/" -> "/a/b") and makes the basename empty; joinpath drops empty parts.
function fs.dirname(path)
  if path == nil then
    return nil
  end
  if not path:match("/") then
    return "."
  elseif path == "/" or path:match("^/[^/]+$") then
    return "/"
  end
  return path:match("/$") and path:sub(1, #path - 1) or path:match("^(/?.+)/")
end

function fs.basename(path)
  if path == nil then
    return nil
  end
  return path:match("/$") and "" or path:match("[^/]*$")
end

function fs.joinpath(...)
  local parts = {}
  for i = 1, select("#", ...) do
    local part = select(i, ...)
    if part ~= "" then
      parts[#parts + 1] = part
    end
  end
  return (table.concat(parts, "/"):gsub("//+", "/"))
end

-- `web.stat(path)` answers "file <size> <mtime_sec> <mtime_nsec>", "directory ...", or nil.
local function stat(path)
  local line = web.stat(path)
  if line == nil then
    return nil
  end
  local kind, size, sec, nsec = line:match("^(%a+) (%d+) (%d+) (%d+)$")
  return {
    type = kind,
    size = math.tointeger(tonumber(size)),
    mtime = { sec = math.tointeger(tonumber(sec)), nsec = math.tointeger(tonumber(nsec)) },
    ctime = { sec = math.tointeger(tonumber(sec)), nsec = math.tointeger(tonumber(nsec)) },
  }
end

-- `web.readdir(path)` answers a JSON array of [name, kind] (kind: file or directory) or nil. JSON, not separators: a
-- name may hold a tab or a newline on the system the folder comes from.
local function readdir(path)
  local text = web.readdir(path)
  if text == nil then
    return nil
  end
  local entries = {}
  for _, pair in ipairs(json.decode(text)) do
    entries[#entries + 1] = { name = pair[1], type = pair[2] }
  end
  table.sort(entries, function(a, b)
    return a.name < b.name
  end)
  return entries
end

function fs.dir(path)
  local entries = readdir(fs.normalize(path)) or {}
  local i = 0
  return function()
    i = i + 1
    local e = entries[i]
    if e then
      return e.name, e.type
    end
  end
end

-- ── uv (vim.uv / vim.loop) ─────────────────────────────────────────────────────

local uv = {}
vim.uv = uv
vim.loop = uv

local function enoent(path)
  return nil, "ENOENT: no such file or directory: " .. tostring(path), "ENOENT"
end

function uv.fs_stat(path, callback)
  assert(callback == nil, "uv.fs_stat: callbacks are not available in the browser")
  local st = stat(path)
  if not st then
    return enoent(path)
  end
  return st
end
uv.fs_lstat = uv.fs_stat

function uv.fs_scandir(path, callback)
  -- loud, not a callback that never comes
  assert(callback == nil, "uv.fs_scandir: callbacks are not available in the browser")
  local entries = readdir(path)
  if not entries then
    return enoent(path)
  end
  return { entries = entries, i = 0 }
end

function uv.fs_scandir_next(handle)
  handle.i = handle.i + 1
  local e = handle.entries[handle.i]
  if e then
    return e.name, e.type
  end
end

-- MEMFS has no links the page makes: the real path is the normalized one, if it exists.
function uv.fs_realpath(path)
  local p = fs.normalize(path)
  if not stat(p) then
    return enoent(path)
  end
  return p
end

function uv.fs_unlink(path)
  local ok, err = os.remove(path)
  if not ok then
    return nil, err, "ENOENT"
  end
  return true
end

function uv.fs_rename(from, to)
  local ok, err = os.rename(from, to)
  if not ok then
    return nil, err
  end
  return true
end

function uv.fs_mkdir(path)
  if web.mkdir(path, false) then
    return true
  end
  return nil, "EEXIST: file already exists: " .. path, "EEXIST"
end

function uv.fs_rmdir(path)
  if web.rmdir(path) then
    return true
  end
  return nil, "ENOTEMPTY: directory not empty: " .. path
end

function uv.hrtime()
  return math.tointeger(math.floor(tonumber(web.now_ms()) * 1e6))
end

function uv.now()
  return math.tointeger(math.floor(tonumber(web.now_ms())))
end

function uv.os_homedir()
  return web.home()
end

function uv.os_getenv(name)
  return web.env(name)
end

function uv.cwd()
  return "/"
end

function uv.os_uname()
  return { sysname = "Browser", release = "", machine = "wasm32", version = "" }
end

setmetatable(uv, {
  __index = function(_, name)
    return function()
      error(("vim.uv.%s is not available in the browser"):format(name), 2)
    end
  end,
})

-- ── fn ─────────────────────────────────────────────────────────────────────────

local fn = missing("fn")
vim.fn = fn

-- SHA-256 (FIPS 180-4) on Lua 5.4 integers. The constants are made once; a block's 16 words are read in one unpack.
-- stylua: ignore
local SHA_K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}
local M32 = 0xffffffff

local function rotr(x, n)
  return ((x >> n) | (x << (32 - n))) & M32
end

local function sha256(msg)
  local h1, h2, h3, h4 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
  local h5, h6, h7, h8 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  local len = #msg
  msg = msg .. "\128" .. string.rep("\0", (55 - len) % 64) .. string.pack(">I8", len * 8)
  local w = {}
  for chunk = 1, #msg, 64 do
    w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8], w[9], w[10], w[11], w[12], w[13], w[14], w[15] =
      string.unpack(">I4I4I4I4I4I4I4I4I4I4I4I4I4I4I4I4", msg, chunk)
    for i = 16, 63 do
      local a, b = w[i - 15], w[i - 2]
      local s0 = rotr(a, 7) ~ rotr(a, 18) ~ (a >> 3)
      local s1 = rotr(b, 17) ~ rotr(b, 19) ~ (b >> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M32
    end
    local a, b, c, d, e, f, g, hh = h1, h2, h3, h4, h5, h6, h7, h8
    for i = 0, 63 do
      local S1 = rotr(e, 6) ~ rotr(e, 11) ~ rotr(e, 25)
      local ch = (e & f) ~ (~e & g)
      local t1 = (hh + S1 + ch + SHA_K[i + 1] + w[i]) & M32
      local S0 = rotr(a, 2) ~ rotr(a, 13) ~ rotr(a, 22)
      local maj = (a & b) ~ (a & c) ~ (b & c)
      local t2 = (S0 + maj) & M32
      hh, g, f, e, d, c, b, a = g, f, e, (d + t1) & M32, c, b, a, (t1 + t2) & M32
    end
    h1, h2, h3, h4 = (h1 + a) & M32, (h2 + b) & M32, (h3 + c) & M32, (h4 + d) & M32
    h5, h6, h7, h8 = (h5 + e) & M32, (h6 + f) & M32, (h7 + g) & M32, (h8 + hh) & M32
  end
  return string.format(string.rep("%08x", 8), h1, h2, h3, h4, h5, h6, h7, h8)
end
vim._sha256 = sha256

rawset(fn, "sha256", sha256)

rawset(fn, "fnamemodify", function(path, mods)
  path = path or ""
  for mod in (mods or ""):gmatch(":(%a)") do
    if mod == "p" then
      if path:sub(1, 1) ~= "/" then
        path = "/" .. path
      end
      path = fs.normalize(path)
      local st = stat(path)
      if st and st.type == "directory" and path:sub(-1) ~= "/" then
        path = path .. "/"
      end
    elseif mod == "h" then
      path = fs.dirname(path)
    elseif mod == "t" then
      -- Vim's tail: after the last separator, so "/a/b/" has an empty one
      path = path:match("[^/\\]*$")
    elseif mod == "r" or mod == "e" then
      -- the extension follows the last dot of the tail; a dot that starts the tail (".hidden") starts no extension
      local head, tail = path:match("^(.-)([^/\\]*)$")
      local dot = tail:match("^.+()%.")
      if mod == "r" then
        path = dot and head .. tail:sub(1, dot - 1) or path
      else
        path = dot and tail:sub(dot + 1) or ""
      end
    end
    -- ":~" and ":.": no home and no current folder that differ from the paths the page gives
  end
  return path
end)

-- (strchars and strcharpart follow tolower: they read characters the same way.)

-- (No strdisplaywidth: only the editor's modules ask it (tabs, wide and combining characters need the screen's
-- rules); asked anyway, it fails with its name instead of counting wrong.)

-- `vim.fn.tolower` as Neovim does it (Vim's simple case mapping): the engine makes slugs with it (`mutate`) and folds
-- paths (`lib.nvim.contract.doc`), and the titles are German. Neovim reads the string character by character; a byte
-- that starts no valid sequence is read as a Latin-1 character and written back as UTF-8 (two bytes), an overlong NUL
-- ends the string. LOWER holds the code points that change, as runs { first, last, step, delta }, sorted and apart;
-- it is made from nvim itself (`node web/tolower-table.mjs`, the comparison in web/engine.test.mjs checks every code
-- point up to U+1FFFF against nvim).
-- stylua: ignore
local LOWER = {
  { 0x41, 0x5A, 1, 32 },
  { 0xC0, 0xD6, 1, 32 },
  { 0xD8, 0xDE, 1, 32 },
  { 0x100, 0x12E, 2, 1 },
  { 0x130, 0x130, 1, -199 },
  { 0x132, 0x136, 2, 1 },
  { 0x139, 0x147, 2, 1 },
  { 0x14A, 0x176, 2, 1 },
  { 0x178, 0x178, 1, -121 },
  { 0x179, 0x17D, 2, 1 },
  { 0x181, 0x181, 1, 210 },
  { 0x182, 0x184, 2, 1 },
  { 0x186, 0x186, 1, 206 },
  { 0x187, 0x187, 1, 1 },
  { 0x189, 0x18A, 1, 205 },
  { 0x18B, 0x18B, 1, 1 },
  { 0x18E, 0x18E, 1, 79 },
  { 0x18F, 0x18F, 1, 202 },
  { 0x190, 0x190, 1, 203 },
  { 0x191, 0x191, 1, 1 },
  { 0x193, 0x193, 1, 205 },
  { 0x194, 0x194, 1, 207 },
  { 0x196, 0x196, 1, 211 },
  { 0x197, 0x197, 1, 209 },
  { 0x198, 0x198, 1, 1 },
  { 0x19C, 0x19C, 1, 211 },
  { 0x19D, 0x19D, 1, 213 },
  { 0x19F, 0x19F, 1, 214 },
  { 0x1A0, 0x1A4, 2, 1 },
  { 0x1A6, 0x1A6, 1, 218 },
  { 0x1A7, 0x1A7, 1, 1 },
  { 0x1A9, 0x1A9, 1, 218 },
  { 0x1AC, 0x1AC, 1, 1 },
  { 0x1AE, 0x1AE, 1, 218 },
  { 0x1AF, 0x1AF, 1, 1 },
  { 0x1B1, 0x1B2, 1, 217 },
  { 0x1B3, 0x1B5, 2, 1 },
  { 0x1B7, 0x1B7, 1, 219 },
  { 0x1B8, 0x1B8, 1, 1 },
  { 0x1BC, 0x1BC, 1, 1 },
  { 0x1C4, 0x1C4, 1, 2 },
  { 0x1C5, 0x1C5, 1, 1 },
  { 0x1C7, 0x1C7, 1, 2 },
  { 0x1C8, 0x1C8, 1, 1 },
  { 0x1CA, 0x1CA, 1, 2 },
  { 0x1CB, 0x1DB, 2, 1 },
  { 0x1DE, 0x1EE, 2, 1 },
  { 0x1F1, 0x1F1, 1, 2 },
  { 0x1F2, 0x1F4, 2, 1 },
  { 0x1F6, 0x1F6, 1, -97 },
  { 0x1F7, 0x1F7, 1, -56 },
  { 0x1F8, 0x21E, 2, 1 },
  { 0x220, 0x220, 1, -130 },
  { 0x222, 0x232, 2, 1 },
  { 0x23A, 0x23A, 1, 10795 },
  { 0x23B, 0x23B, 1, 1 },
  { 0x23D, 0x23D, 1, -163 },
  { 0x23E, 0x23E, 1, 10792 },
  { 0x241, 0x241, 1, 1 },
  { 0x243, 0x243, 1, -195 },
  { 0x244, 0x244, 1, 69 },
  { 0x245, 0x245, 1, 71 },
  { 0x246, 0x24E, 2, 1 },
  { 0x370, 0x372, 2, 1 },
  { 0x376, 0x376, 1, 1 },
  { 0x37F, 0x37F, 1, 116 },
  { 0x386, 0x386, 1, 38 },
  { 0x388, 0x38A, 1, 37 },
  { 0x38C, 0x38C, 1, 64 },
  { 0x38E, 0x38F, 1, 63 },
  { 0x391, 0x3A1, 1, 32 },
  { 0x3A3, 0x3AB, 1, 32 },
  { 0x3CF, 0x3CF, 1, 8 },
  { 0x3D8, 0x3EE, 2, 1 },
  { 0x3F4, 0x3F4, 1, -60 },
  { 0x3F7, 0x3F7, 1, 1 },
  { 0x3F9, 0x3F9, 1, -7 },
  { 0x3FA, 0x3FA, 1, 1 },
  { 0x3FD, 0x3FF, 1, -130 },
  { 0x400, 0x40F, 1, 80 },
  { 0x410, 0x42F, 1, 32 },
  { 0x460, 0x480, 2, 1 },
  { 0x48A, 0x4BE, 2, 1 },
  { 0x4C0, 0x4C0, 1, 15 },
  { 0x4C1, 0x4CD, 2, 1 },
  { 0x4D0, 0x52E, 2, 1 },
  { 0x531, 0x556, 1, 48 },
  { 0x10A0, 0x10C5, 1, 7264 },
  { 0x10C7, 0x10C7, 1, 7264 },
  { 0x10CD, 0x10CD, 1, 7264 },
  { 0x13A0, 0x13EF, 1, 38864 },
  { 0x13F0, 0x13F5, 1, 8 },
  { 0x1C89, 0x1C89, 1, 1 },
  { 0x1C90, 0x1CBA, 1, -3008 },
  { 0x1CBD, 0x1CBF, 1, -3008 },
  { 0x1E00, 0x1E94, 2, 1 },
  { 0x1E9E, 0x1E9E, 1, -7615 },
  { 0x1EA0, 0x1EFE, 2, 1 },
  { 0x1F08, 0x1F0F, 1, -8 },
  { 0x1F18, 0x1F1D, 1, -8 },
  { 0x1F28, 0x1F2F, 1, -8 },
  { 0x1F38, 0x1F3F, 1, -8 },
  { 0x1F48, 0x1F4D, 1, -8 },
  { 0x1F59, 0x1F5F, 2, -8 },
  { 0x1F68, 0x1F6F, 1, -8 },
  { 0x1F88, 0x1F8F, 1, -8 },
  { 0x1F98, 0x1F9F, 1, -8 },
  { 0x1FA8, 0x1FAF, 1, -8 },
  { 0x1FB8, 0x1FB9, 1, -8 },
  { 0x1FBA, 0x1FBB, 1, -74 },
  { 0x1FBC, 0x1FBC, 1, -9 },
  { 0x1FC8, 0x1FCB, 1, -86 },
  { 0x1FCC, 0x1FCC, 1, -9 },
  { 0x1FD8, 0x1FD9, 1, -8 },
  { 0x1FDA, 0x1FDB, 1, -100 },
  { 0x1FE8, 0x1FE9, 1, -8 },
  { 0x1FEA, 0x1FEB, 1, -112 },
  { 0x1FEC, 0x1FEC, 1, -7 },
  { 0x1FF8, 0x1FF9, 1, -128 },
  { 0x1FFA, 0x1FFB, 1, -126 },
  { 0x1FFC, 0x1FFC, 1, -9 },
  { 0x2126, 0x2126, 1, -7517 },
  { 0x212A, 0x212A, 1, -8383 },
  { 0x212B, 0x212B, 1, -8262 },
  { 0x2132, 0x2132, 1, 28 },
  { 0x2160, 0x216F, 1, 16 },
  { 0x2183, 0x2183, 1, 1 },
  { 0x24B6, 0x24CF, 1, 26 },
  { 0x2C00, 0x2C2F, 1, 48 },
  { 0x2C60, 0x2C60, 1, 1 },
  { 0x2C62, 0x2C62, 1, -10743 },
  { 0x2C63, 0x2C63, 1, -3814 },
  { 0x2C64, 0x2C64, 1, -10727 },
  { 0x2C67, 0x2C6B, 2, 1 },
  { 0x2C6D, 0x2C6D, 1, -10780 },
  { 0x2C6E, 0x2C6E, 1, -10749 },
  { 0x2C6F, 0x2C6F, 1, -10783 },
  { 0x2C70, 0x2C70, 1, -10782 },
  { 0x2C72, 0x2C72, 1, 1 },
  { 0x2C75, 0x2C75, 1, 1 },
  { 0x2C7E, 0x2C7F, 1, -10815 },
  { 0x2C80, 0x2CE2, 2, 1 },
  { 0x2CEB, 0x2CED, 2, 1 },
  { 0x2CF2, 0x2CF2, 1, 1 },
  { 0xA640, 0xA66C, 2, 1 },
  { 0xA680, 0xA69A, 2, 1 },
  { 0xA722, 0xA72E, 2, 1 },
  { 0xA732, 0xA76E, 2, 1 },
  { 0xA779, 0xA77B, 2, 1 },
  { 0xA77D, 0xA77D, 1, -35332 },
  { 0xA77E, 0xA786, 2, 1 },
  { 0xA78B, 0xA78B, 1, 1 },
  { 0xA78D, 0xA78D, 1, -42280 },
  { 0xA790, 0xA792, 2, 1 },
  { 0xA796, 0xA7A8, 2, 1 },
  { 0xA7AA, 0xA7AA, 1, -42308 },
  { 0xA7AB, 0xA7AB, 1, -42319 },
  { 0xA7AC, 0xA7AC, 1, -42315 },
  { 0xA7AD, 0xA7AD, 1, -42305 },
  { 0xA7AE, 0xA7AE, 1, -42308 },
  { 0xA7B0, 0xA7B0, 1, -42258 },
  { 0xA7B1, 0xA7B1, 1, -42282 },
  { 0xA7B2, 0xA7B2, 1, -42261 },
  { 0xA7B3, 0xA7B3, 1, 928 },
  { 0xA7B4, 0xA7C2, 2, 1 },
  { 0xA7C4, 0xA7C4, 1, -48 },
  { 0xA7C5, 0xA7C5, 1, -42307 },
  { 0xA7C6, 0xA7C6, 1, -35384 },
  { 0xA7C7, 0xA7C9, 2, 1 },
  { 0xA7CB, 0xA7CB, 1, -42343 },
  { 0xA7CC, 0xA7DA, 2, 1 },
  { 0xA7DC, 0xA7DC, 1, -42561 },
  { 0xA7F5, 0xA7F5, 1, 1 },
  { 0xFF21, 0xFF3A, 1, 32 },
  { 0x10400, 0x10427, 1, 40 },
  { 0x104B0, 0x104D3, 1, 40 },
  { 0x10570, 0x1057A, 1, 39 },
  { 0x1057C, 0x1058A, 1, 39 },
  { 0x1058C, 0x10592, 1, 39 },
  { 0x10594, 0x10595, 1, 39 },
  { 0x10C80, 0x10CB2, 1, 64 },
  { 0x10D50, 0x10D65, 1, 32 },
  { 0x118A0, 0x118BF, 1, 32 },
  { 0x16E40, 0x16E5F, 1, 32 },
  { 0x16EA0, 0x16EB8, 1, 27 },
  { 0x1E900, 0x1E921, 1, 34 },
}

local function lower_cp(cp)
  local lo, hi = 1, #LOWER
  while lo <= hi do
    local mid = (lo + hi) // 2
    local run = LOWER[mid]
    if cp < run[1] then
      hi = mid - 1
    elseif cp > run[2] then
      lo = mid + 1
    else
      return (cp - run[1]) % run[3] == 0 and cp + run[4] or cp
    end
  end
  return cp
end

-- The length of the sequence a lead byte starts, as Neovim's utf8len_tab: 1 for a byte that starts none.
local function seq_len(b)
  if b >= 0xFC and b <= 0xFD then
    return 6
  elseif b >= 0xF8 and b <= 0xFB then
    return 5
  elseif b >= 0xF0 and b <= 0xF7 then
    return 4
  elseif b >= 0xE0 then
    return b <= 0xEF and 3 or 1
  elseif b >= 0xC0 then
    return 2
  end
  return 1
end

local function tolower(s)
  if not s:find("[A-Z\128-\255]") then
    return s
  end
  if not s:find("[\128-\255]") then
    return (s:lower())
  end
  local out = {}
  local i, n = 1, #s
  while i <= n do
    local b = s:byte(i)
    if b < 0x80 then
      local j = s:find("[\128-\255]", i) or n + 1
      out[#out + 1] = s:sub(i, j - 1):lower()
      i = j
    else
      local len = seq_len(b)
      local cp
      if len > 1 and i + len - 1 <= n then
        cp = b & (0x7F >> len)
        for k = i + 1, i + len - 1 do
          local c = s:byte(k)
          if c & 0xC0 ~= 0x80 then
            cp = nil
            break
          end
          cp = (cp << 6) | (c & 0x3F)
        end
      end
      if cp then
        i = i + len
      else
        cp = b
        i = i + 1
      end
      if cp == 0 then
        break
      end
      out[#out + 1] = utf8.char(lower_cp(cp))
    end
  end
  return table.concat(out)
end
vim._tolower = tolower

rawset(fn, "tolower", tolower)

-- The byte offsets of the characters of `s`, as Neovim counts them: a byte that starts no valid sequence is one
-- character (text in Windows-1252 among UTF-8), so a cut never falls inside a character.
local function char_starts(s)
  local starts, i, n = {}, 1, #s
  while i <= n do
    starts[#starts + 1] = i
    local b = s:byte(i)
    local len = b < 0x80 and 1 or seq_len(b)
    if len > 1 then
      if i + len - 1 > n then
        len = 1
      else
        for k = i + 1, i + len - 1 do
          if s:byte(k) & 0xC0 ~= 0x80 then
            len = 1
            break
          end
        end
      end
    end
    i = i + len
  end
  return starts
end

rawset(fn, "strchars", function(s)
  if not s:find("[\128-\255]") then
    return #s
  end
  return #char_starts(s)
end)

-- A `len` that is given as nil is v:null in Neovim, a length of 0; only a missing one means "to the end".
rawset(fn, "strcharpart", function(s, start, ...)
  local len = nil
  if select("#", ...) > 0 then
    len = (...) or 0
  end
  local first = math.max(start, 0)
  if not s:find("[\128-\255]") then
    local last = len and start + len or #s
    return last > first and s:sub(first + 1, last) or ""
  end
  local starts = char_starts(s)
  local n = #starts
  local last = len and math.min(start + len, n) or n
  if last <= first or first >= n then
    return ""
  end
  local j = starts[last + 1]
  return s:sub(starts[first + 1], (j or #s + 1) - 1)
end)

rawset(fn, "isdirectory", function(path)
  local st = stat(path)
  return st and st.type == "directory" and 1 or 0
end)

rawset(fn, "filereadable", function(path)
  local st = stat(path)
  return st and st.type == "file" and 1 or 0
end)

-- As Neovim: 1, or the error E739 (a folder that exists without "p", a missing parent); the engine's atomic write
-- tells a failure by the error, not by the number.
rawset(fn, "mkdir", function(path, flags)
  if not web.mkdir(path, flags == "p") then
    error("Vim:E739: Cannot create directory " .. path, 2)
  end
  return 1
end)

rawset(fn, "readdir", function(path)
  local names = {}
  for _, e in ipairs(readdir(path) or {}) do
    names[#names + 1] = e.name
  end
  return names
end)

rawset(fn, "delete", function(path, flags)
  if flags == "rf" or flags == "d" then
    return web.rmdir(path, flags == "rf") and 0 or -1
  end
  return os.remove(path) and 0 or -1
end)

rawset(fn, "has", function(feature)
  if feature == "nvim" or feature:match("^nvim%-0%.") then
    return 1
  end
  return 0
end)

rawset(fn, "executable", function()
  return 0
end)

rawset(fn, "getcwd", function()
  return "/"
end)

rawset(fn, "expand", function(s)
  return s
end)

rawset(fn, "stdpath", function(what)
  return "/web/" .. what
end)

local temp_n = 0
rawset(fn, "tempname", function()
  temp_n = temp_n + 1
  web.mkdir("/tmp", true)
  return "/tmp/web-" .. temp_n
end)

-- ── environment, options, editor stubs ─────────────────────────────────────────

vim.env = setmetatable({}, {
  __index = function(_, name)
    return web.env(name)
  end,
  __newindex = function(_, name, value)
    web.set_env(name, value)
  end,
})

vim.g = {}
vim.b = {}
vim.w = {}
vim.t = {}
vim.o = { columns = 120, lines = 40 }
vim.opt = {}
vim.bo = setmetatable({}, {
  __index = function()
    return {}
  end,
})
vim.wo = vim.bo

local queue = {}
function vim.schedule(cb)
  queue[#queue + 1] = cb
end
function vim.schedule_wrap(cb)
  return function(...)
    local args = table.pack(...)
    vim.schedule(function()
      cb(table.unpack(args, 1, args.n))
    end)
  end
end
function vim.defer_fn(cb)
  vim.schedule(cb)
  return {}
end
-- Run what was scheduled; the page calls this after every request, as Neovim's loop would after the script.
function vim._drain()
  local rounds = 0
  while #queue > 0 and rounds < 100 do
    local q = queue
    queue = {}
    for _, cb in ipairs(q) do
      local ok, err = pcall(cb)
      if not ok then
        web.log(vim.log.levels.ERROR, tostring(err))
      end
    end
    rounds = rounds + 1
  end
end

-- Neovim runs the loop while it waits, so what was scheduled has run when `cond` is asked. There is no time to wait
-- for here: the condition is asked once, after the queue ran.
function vim.wait(_, cond)
  vim._drain()
  if cond then
    return cond() and true or false
  end
  return true
end

function vim.in_fast_event()
  return false
end

function vim.notify(msg, level)
  web.log(level or vim.log.levels.INFO, tostring(msg))
end

function vim.print(...)
  local parts = {}
  for i = 1, select("#", ...) do
    parts[#parts + 1] = vim.inspect((select(i, ...)))
  end
  web.log(vim.log.levels.INFO, table.concat(parts, " "))
end

-- No Neovim runs here: the version the documents name (`engine.nvim`, from `tostring(vim.version())`) says so
-- instead of pretending one, e.g. "web+Lua5.4". The numbers are those of the API this shim follows.
local VERSION_MT = {
  __tostring = function()
    return "web+" .. _VERSION:gsub(" ", "")
  end,
}
vim.version = setmetatable({ major = 0, minor = 11, patch = 0 }, {
  __call = function(self)
    return setmetatable({ major = self.major, minor = self.minor, patch = self.patch }, VERSION_MT)
  end,
})

vim.api = missing("api")
vim.ui = missing("ui")
vim.keymap = missing("keymap")
vim.diagnostic = { severity = { ERROR = 1, WARN = 2, INFO = 3, HINT = 4 } }
function vim.cmd()
  error("vim.cmd is not available in the browser", 2)
end
function vim.system()
  error("vim.system is not available in the browser", 2)
end

-- ── modules: the bundle, never a file ──────────────────────────────────────────

package.path = ""
package.cpath = ""
for name in web.module_names():gmatch("[^\n]+") do
  package.preload[name] = function(...)
    local chunk, err = load(web.source(name), "@" .. name, "t")
    if not chunk then
      error(err, 0)
    end
    return chunk(...)
  end
end

-- `os.exit` would end the VM itself (Emscripten's exit), not a script: the engine's command line uses it, the call
-- door never; here it is an error instead.
---@diagnostic disable-next-line: duplicate-set-field
function os.exit()
  error("os.exit is not available in the browser", 2)
end

-- The one call the page makes: a method of the contract, the answer as "<code>\n<text>" (code empty for an answer).
-- The text is always one JSON document: the engine's door never throws, and should loading it fail, the error is a
-- `tasks.error` made here, so a reader never meets a line of Lua where it expects JSON.
function __web_call(method, request, root, today)
  local ok, text, code = pcall(function()
    return require("tasks_nvim.api").call(method, request ~= "" and request or nil, {
      root = root ~= "" and root or nil,
      today = today ~= "" and today or nil,
    })
  end)
  vim._drain()
  if not ok then
    return "internal\n"
      .. json.encode({
        kind = "tasks.error",
        code = "internal",
        message = tostring(text),
        plugin = "tasks.nvim",
        retryable = false,
        schema = 1,
      })
  end
  return (code or "") .. "\n" .. text
end
