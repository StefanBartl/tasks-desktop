std = "lua51"
globals = { "vim" }
max_line_length = false

-- The engine of the web variant runs on Lua 5.4 (wasmoon); the shim sets the LuaJIT names the engine uses and the
-- door the page calls.
files["ui/src/web/vim-shim.lua"] = {
  std = "lua54",
  globals = { "vim", "unpack", "loadstring", "__web_call", "os", "math", "table" },
  read_globals = { "__web" },
}
-- Neovim's inspect.lua, kept as it is (see its head).
exclude_files = { "ui/src/web/vendor/**" }
