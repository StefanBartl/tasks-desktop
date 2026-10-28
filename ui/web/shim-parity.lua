-- Cases the vim shim of the web variant must answer as Neovim does. The same file runs in nvim (LuaJIT) and in the web
-- engine's VM (Lua 5.4 with ui/src/web/vim-shim.lua); both return the same text, one line per case: "<name>\t<value>".
-- web/engine.test.mjs compares the two (TASKS_WEB_COMPARE=1). Only Lua that runs on both: no integer operators, no
-- utf8 library, no goto.

local out = {}

local function utf8char(cp)
  if cp < 0x80 then
    return string.char(cp)
  elseif cp < 0x800 then
    return string.char(0xC0 + math.floor(cp / 0x40), 0x80 + cp % 0x40)
  elseif cp < 0x10000 then
    return string.char(
      0xE0 + math.floor(cp / 0x1000),
      0x80 + math.floor(cp / 0x40) % 0x40,
      0x80 + cp % 0x40
    )
  end
  return string.char(
    0xF0 + math.floor(cp / 0x40000),
    0x80 + math.floor(cp / 0x1000) % 0x40,
    0x80 + math.floor(cp / 0x40) % 0x40,
    0x80 + cp % 0x40
  )
end

local function hex(s)
  return (s:gsub(".", function(c)
    return string.format("%02x", c:byte())
  end))
end

-- One form for every value, the same on LuaJIT and Lua 5.4: a whole number without ".0", a string with every byte
-- outside [A-Za-z0-9 ] as \xHH, a table with its keys sorted, `vim.NIL` and `vim.empty_dict()` named.
local function ser(v)
  if v == vim.NIL then
    return "NIL"
  end
  local t = type(v)
  if t == "string" then
    return '"'
      .. v:gsub("[^A-Za-z0-9 ]", function(c)
        return string.format("\\x%02x", c:byte())
      end)
      .. '"'
  elseif t == "number" then
    if v == math.floor(v) and math.abs(v) < 2 ^ 53 then
      return string.format("%d", v)
    end
    return string.format("%.17g", v)
  elseif t == "table" then
    if next(v) == nil then
      return getmetatable(v) == vim._empty_dict_mt and "{}d" or "{}"
    end
    local items = {}
    for k, val in pairs(v) do
      items[#items + 1] = ser(k) .. "=" .. ser(val)
    end
    table.sort(items)
    return "{" .. table.concat(items, ",") .. "}"
  end
  return t == "boolean" and tostring(v) or t
end

local function case(name, fn)
  local ok, a, b = pcall(fn)
  out[#out + 1] = name
    .. "\t"
    .. (ok and (ser(a) .. (b ~= nil and (" | " .. ser(b)) or "")) or "error")
end

-- sentinels
case("nil.type", function()
  return type(vim.NIL), tostring(vim.NIL)
end)
case("nil.index", function()
  return vim.NIL.x
end)

-- strings
for i, s in ipairs({ "  a b \n\t", " \n ", "", "x", "a\0 b ", "\n\n  über  \n" }) do
  case("trim." .. i, function()
    return vim.trim(s)
  end)
end
-- a long run of whitespace inside the text: `gsub("%s+$", "")` would try every position of it (quadratic)
case("trim.long", function()
  return #vim.trim(" x" .. string.rep(" ", 20000) .. "y ")
end)
local splits = {
  { "a,b,,c", "," },
  { ",a,,b,", ",", { trimempty = true } },
  { "a.b", ".", { plain = true } },
  { "a.b", "." },
  { "abc", "" },
  { "a  b\tc", "%s+" },
  { "a\nb\n", "\n", { plain = true } },
  { "a,b", ",*" },
  { "x", "," },
  { "", "," },
}
for i, a in ipairs(splits) do
  case("split." .. i, function()
    return vim.split(a[1], a[2], a[3])
  end)
end
case("startswith", function()
  return {
    vim.startswith("abc", "ab"),
    vim.startswith("abc", ""),
    vim.endswith("abc", "bc"),
    vim.endswith("abc", ""),
  }
end)
case("pesc", function()
  return vim.pesc("a.b%c(d)[e]^$*+-?")
end)

-- tables
case("deep.empty", function()
  return vim.tbl_deep_extend("force", { a = { x = 1 } }, { a = {} })
end)
case("deep.list", function()
  return vim.tbl_deep_extend("force", { a = { 1, 2 } }, { a = { 3 } })
end)
case("deep.keep", function()
  return vim.tbl_deep_extend("keep", { a = { x = 1 } }, { a = { x = 2, y = 3 }, b = 4 })
end)
case("deep.error", function()
  return vim.tbl_deep_extend("error", { a = 1 }, { a = 2 })
end)
case("extend.fn", function()
  return vim.tbl_extend(function(_, prev, v)
    return (prev or 0) + v
  end, { a = 1 }, { a = 2, b = 3 })
end)
case("extend.empty_dict", function()
  return vim.tbl_extend("force", vim.empty_dict(), {})
end)
case("islist", function()
  return {
    vim.islist({}),
    vim.islist(vim.empty_dict()),
    vim.islist({ 1, 2 }),
    vim.islist({ 1, nil, 3 }),
    vim.islist({ a = 1 }),
    vim.islist({ [1] = 1, [3] = 3 }),
    vim.islist(vim.NIL),
  }
end)
case("deepcopy", function()
  local t = vim.empty_dict()
  local c = vim.deepcopy({ a = { b = { 1, 2 } }, e = t })
  return c, getmetatable(c.e) == vim._empty_dict_mt
end)
case("tbl", function()
  local keys = vim.tbl_keys({ a = 1, b = 2 })
  table.sort(keys)
  return {
    keys,
    vim.tbl_contains({ 1, 2 }, 2),
    vim.tbl_count({ a = 1, 2 }),
    vim.tbl_get({ a = { b = 3 } }, "a", "b"),
    vim.tbl_isempty({}),
    vim.list_slice({ 1, 2, 3, 4 }, 2, 3),
    vim.list_extend({ 1 }, { 2, 3 }),
  }
end)

-- JSON
local encodes = {
  {},
  vim.empty_dict(),
  { 1, 2 },
  { a = vim.NIL },
  3,
  3.5,
  0.1,
  1e20,
  -0.0,
  123456789012345,
  1 / 3,
  'a/b"\n\127ä\0\1',
  -- (no table with several keys: Neovim writes them in hash order)
}
for i, v in ipairs(encodes) do
  case("json.encode." .. i, function()
    return vim.json.encode(v)
  end)
end
local decodes = {
  '{"a":null,"b":[],"c":{},"n":3,"f":3.0,"e":1e2,"m":-2.5}',
  '"\\u00e4\\ud83d\\ude00\\n\\/"',
  "[1-]",
  "[1e]",
  "[1,]",
  "{",
  '"\\u12"',
  "tru",
  " [ 1 , 2 ] ",
  "[1] x",
}
for i, s in ipairs(decodes) do
  case("json.decode." .. i, function()
    return vim.json.decode(s)
  end)
end

-- paths
for i, p in ipairs({ "/a/./b/../c/", "a/../../b", "/", "./x", "a//b", "", "/..", "/../a", "a/.." }) do
  case("normalize." .. i, function()
    return vim.fs.normalize(p)
  end)
end
for i, p in ipairs({ "/a", "a", "/a/b/", "/", "a/b", "a//b", "/a/b.c" }) do
  case("dirname." .. i, function()
    return vim.fs.dirname(p), vim.fs.basename(p)
  end)
end
case("joinpath", function()
  return {
    vim.fs.joinpath("foo/", "/bar"),
    vim.fs.joinpath("", "after/plugin"),
    vim.fs.joinpath("a", "b", "c"),
  }
end)
for i, a in ipairs({
  { "/x/y.tar.gz", ":t:r" },
  { "/x/y.tar.gz", ":e" },
  { "y", ":h" },
  { "/a/b/", ":t" },
  { "/a/b/", ":h" },
  { "/x.y/z", ":r" },
  { "/x/.hidden", ":e" },
  { "a/b", ":h:h" },
}) do
  case("fnamemodify." .. i, function()
    return vim.fn.fnamemodify(a[1], a[2])
  end)
end

-- characters
for i, a in ipairs({
  { "äöü", 1, 1 },
  { "äöü", -1, 2 },
  { "abc", 5 },
  { "abc", 0 },
  { "aé", 1, 5 },
}) do
  case("strcharpart." .. i, function()
    return vim.fn.strcharpart(a[1], a[2], a[3])
  end)
end
case("strchars", function()
  return { vim.fn.strchars("äöü"), vim.fn.strchars(""), vim.fn.strchars("a😀") }
end)
-- a byte that is no UTF-8 (Windows-1252 among UTF-8) is one character, a cut never splits a character
case("strchars.bad", function()
  return {
    vim.fn.strchars("ü\228xyz"),
    vim.fn.strcharpart("ü\228xyz", 0, 2),
    vim.fn.strcharpart("ü\228xyz", 1, 2),
    vim.fn.strchars("\195"),
    vim.fn.strcharpart("a\226\130b", 1, 1),
  }
end)

-- numbers read from text: LuaJIT shows a whole one without ".0"
case("tonumber", function()
  return {
    tostring(tonumber("2.0")),
    tostring(tonumber("2.5")),
    tostring(tonumber("1e2")),
    tostring(tonumber("0x10")),
    tostring(tonumber("ff", 16)),
    tostring(tonumber("x")),
  }
end)

-- the editor bits the engine may ask
case("has", function()
  return { vim.fn.has("nvim"), vim.fn.has("nvim-0.10") }
end)
case("wait", function()
  local ran = false
  vim.schedule(function()
    ran = true
  end)
  return vim.wait(10, function()
    return ran
  end), ran
end)
case("tolower.text", function()
  return vim.fn.tolower("ÄÖÜẞ Übersicht İ Ⱥ K ÆØÅ ΣΑΒ ДЖ")
end)
case("tolower.codepoints", function()
  local changed = {}
  for cp = 0x41, 0x1FFFF do
    if cp < 0xD800 or cp > 0xDFFF then
      local c = utf8char(cp)
      local l = vim.fn.tolower(c)
      if l ~= c then
        changed[#changed + 1] = string.format("%x:%s", cp, hex(l))
      end
    end
  end
  return #changed .. " " .. table.concat(changed, ";")
end)
case("tolower.bytes", function()
  local res = {}
  for b = 0x80, 0xFF do
    res[#res + 1] = hex(vim.fn.tolower(string.char(b) .. "x"))
  end
  for _, s in ipairs({
    "\195",
    "\226\130",
    "\237\160\128",
    "\192\128",
    "\244\144\128\128",
    "\195\132\132",
    "\193\129",
  }) do
    res[#res + 1] = hex(vim.fn.tolower("A" .. s .. "Bx"))
  end
  return table.concat(res, ";")
end)

-- inspect: its output reaches the documents ("got ...")
local inspects = {
  'a\nb"c\\',
  "it's",
  4.5,
  { 1, x = { y = "z" } },
  vim.NIL,
  vim.empty_dict(),
  { 1, 2, { a = 1 } },
  "\0\1\127",
}
for i, v in ipairs(inspects) do
  case("inspect." .. i, function()
    return vim.inspect(v)
  end)
end
case("inspect.depth", function()
  return vim.inspect({ a = { b = { c = 1 } } }, { depth = 1 })
end)

-- digests
case("sha256", function()
  return {
    vim.fn.sha256(""),
    vim.fn.sha256("abc"),
    vim.fn.sha256(string.rep("a", 1000)),
    vim.fn.sha256("äöü\0"),
  }
end)

return table.concat(out, "\n")
