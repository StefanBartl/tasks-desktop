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

vim.NIL = setmetatable({}, {
  __tostring = function()
    return "vim.NIL"
  end,
})

local EMPTY_DICT = {}
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
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or math.type(k) == "float" and k ~= math.floor(k) then
      return false
    end
    n = n + 1
  end
  return n == #t
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

local function tbl_extend(behavior, deep, ...)
  local ret = {}
  for i = 1, select("#", ...) do
    local tbl = select(i, ...)
    if tbl then
      for k, v in pairs(tbl) do
        if
          deep
          and type(v) == "table"
          and type(ret[k]) == "table"
          and not vim.islist(v)
          and not vim.islist(ret[k])
        then
          ret[k] = tbl_extend(behavior, true, ret[k], v)
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

function vim.trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
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
      if j < i then
        j = i
        parts[#parts + 1] = s:sub(start, i)
        start = i + 1
        if start > #s then
          parts[#parts + 1] = ""
          break
        end
      else
        parts[#parts + 1] = s:sub(start, i - 1)
        start = j + 1
      end
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

function vim.inspect(v)
  local function dump(x, depth)
    if type(x) == "string" then
      return string.format("%q", x)
    elseif type(x) ~= "table" then
      return tostring(x)
    elseif depth > 3 then
      return "{...}"
    end
    local parts = {}
    for k, val in vim.spairs(x) do
      parts[#parts + 1] = (type(k) == "string" and k or "[" .. tostring(k) .. "]")
        .. " = "
        .. dump(val, depth + 1)
    end
    return "{ " .. table.concat(parts, ", ") .. " }"
  end
  return dump(v, 0)
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

local function encode_number(n)
  if n ~= n or n == math.huge or n == -math.huge then
    error("vim.json.encode: cannot encode " .. tostring(n))
  end
  if math.type(n) == "integer" then
    return tostring(n)
  end
  if n == math.floor(n) and math.abs(n) < 1e15 then
    return string.format("%d", n)
  end
  return string.format("%.14g", n)
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

local function decode_error(s, pos, what)
  error(("Expected %s at character %d"):format(what, pos), 0)
end

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
        decode_error(s, pos, "closing quote")
      elseif c == '"' then
        pos = pos + 1
        return table.concat(out)
      elseif c == "\\" then
        local e = s:sub(pos + 1, pos + 1)
        local map = {
          b = "\b",
          f = "\f",
          n = "\n",
          r = "\r",
          t = "\t",
          ['"'] = '"',
          ["\\"] = "\\",
          ["/"] = "/",
        }
        if map[e] then
          out[#out + 1] = map[e]
          pos = pos + 2
        elseif e == "u" then
          local cp = tonumber(s:sub(pos + 2, pos + 5), 16) or decode_error(s, pos, "hex digits")
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
          decode_error(s, pos, "escape")
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
          decode_error(s, pos, "object key")
        end
        local k = str()
        ws()
        if s:sub(pos, pos) ~= ":" then
          decode_error(s, pos, "colon")
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
          decode_error(s, pos - 1, "comma or closing brace")
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
          decode_error(s, pos - 1, "comma or closing bracket")
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
      decode_error(s, pos, "value")
    end
    pos = pos + #num
    local n = tonumber(num)
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
  local abs = path:sub(1, 1) == "/"
  local parts = {}
  for part in path:gmatch("[^/]+") do
    if part == ".." and #parts > 0 and parts[#parts] ~= ".." then
      parts[#parts] = nil
    elseif part ~= "." then
      parts[#parts + 1] = part
    end
  end
  local out = (abs and "/" or "") .. table.concat(parts, "/")
  if out == "" then
    return abs and "/" or "."
  end
  return out
end

function fs.dirname(path)
  if path == nil then
    return nil
  end
  path = path:gsub("\\", "/")
  if path == "/" then
    return "/"
  end
  path = path:gsub("/+$", "")
  local dir = path:match("^(.*)/[^/]*$")
  if dir == nil then
    return "."
  end
  return dir == "" and "/" or dir
end

function fs.basename(path)
  if path == nil then
    return nil
  end
  path = path:gsub("\\", "/"):gsub("/+$", "")
  return path:match("([^/]*)$")
end

function fs.joinpath(...)
  return (table.concat({ ... }, "/"):gsub("//+", "/"))
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

-- `web.readdir(path)` answers "name\tkind\n..." (kind: file or directory) or nil.
local function readdir(path)
  local text = web.readdir(path)
  if text == nil then
    return nil
  end
  local entries = {}
  for name, kind in text:gmatch("([^\t\n]+)\t([^\n]+)") do
    entries[#entries + 1] = { name = name, type = kind }
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

function uv.fs_scandir(path)
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

local function sha256(msg)
  local k = {
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2,
  }
  local M32 = 0xffffffff
  local function rotr(x, n)
    return ((x >> n) | (x << (32 - n))) & M32
  end
  local h = {
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  }
  local len = #msg
  msg = msg .. "\128" .. string.rep("\0", (55 - len) % 64) .. string.pack(">I8", len * 8)
  for chunk = 1, #msg, 64 do
    local w = {}
    for i = 0, 15 do
      w[i] = string.unpack(">I4", msg, chunk + i * 4)
    end
    for i = 16, 63 do
      local s0 = rotr(w[i - 15], 7) ~ rotr(w[i - 15], 18) ~ (w[i - 15] >> 3)
      local s1 = rotr(w[i - 2], 17) ~ rotr(w[i - 2], 19) ~ (w[i - 2] >> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M32
    end
    local a, b, c, d, e, f, g, hh = h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]
    for i = 0, 63 do
      local S1 = rotr(e, 6) ~ rotr(e, 11) ~ rotr(e, 25)
      local ch = (e & f) ~ (~e & g)
      local t1 = (hh + S1 + ch + k[i + 1] + w[i]) & M32
      local S0 = rotr(a, 2) ~ rotr(a, 13) ~ rotr(a, 22)
      local maj = (a & b) ~ (a & c) ~ (b & c)
      local t2 = (S0 + maj) & M32
      hh, g, f, e, d, c, b, a = g, f, e, (d + t1) & M32, c, b, a, (t1 + t2) & M32
    end
    h[1], h[2], h[3], h[4] = (h[1] + a) & M32, (h[2] + b) & M32, (h[3] + c) & M32, (h[4] + d) & M32
    h[5], h[6], h[7], h[8] = (h[5] + e) & M32, (h[6] + f) & M32, (h[7] + g) & M32, (h[8] + hh) & M32
  end
  return string.format(string.rep("%08x", 8), table.unpack(h))
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
      path = path:match("([^/\\]*)[/\\]?$") or path
    elseif mod == "r" then
      path = path:match("^(.*)%.[^./\\]*$") or path
    elseif mod == "e" then
      path = path:match("%.([^./\\]*)$") or ""
    elseif mod == "~" or mod == "." then
      -- no home and no current folder that differ from the paths the page gives
    end
  end
  return path
end)

rawset(fn, "strchars", function(s)
  return utf8.len(s) or #s
end)

rawset(fn, "strcharpart", function(s, start, len)
  local n = utf8.len(s)
  if not n then
    return s:sub(start + 1, len and start + len or nil)
  end
  local first = math.max(start, 0)
  local last = len and math.min(start + len, n) or n
  if last <= first then
    return ""
  end
  local i = utf8.offset(s, first + 1)
  local j = utf8.offset(s, last + 1)
  return s:sub(i, (j or #s + 1) - 1)
end)

rawset(fn, "strdisplaywidth", function(s)
  return utf8.len(s) or #s
end)

rawset(fn, "tolower", string.lower)
rawset(fn, "toupper", string.upper)

rawset(fn, "isdirectory", function(path)
  local st = stat(path)
  return st and st.type == "directory" and 1 or 0
end)

rawset(fn, "filereadable", function(path)
  local st = stat(path)
  return st and st.type == "file" and 1 or 0
end)

rawset(fn, "mkdir", function(path, flags)
  return web.mkdir(path, flags == "p") and 1 or 0
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
  if feature:match("^nvim%-0%.") then
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

function vim.wait(_, cond)
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

-- The one call the page makes: a method of the contract, the answer as "<code>\n<text>" (code empty for an answer).
function __web_call(method, request, root, today)
  local ok, text, code = pcall(function()
    return require("tasks_nvim.api").call(method, request ~= "" and request or nil, {
      root = root ~= "" and root or nil,
      today = today ~= "" and today or nil,
    })
  end)
  vim._drain()
  if not ok then
    return "internal\n" .. tostring(text)
  end
  return (code or "") .. "\n" .. text
end
