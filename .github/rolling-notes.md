**This is not a release.** It is the newest state of `main`, rebuilt after every green CI run and replaced each time. Nothing here is signed or tested by hand; use a release for anything that matters.

**Windows only** (x86-64). The files of this page are public: no GitHub login is needed.

**Install it with the script** (for the current user, no administrator rights, and no SmartScreen stop: the script downloads the program itself and checks it against `SHA256SUMS`). In your own PowerShell (not elevated):

```
powershell -ExecutionPolicy Bypass -c "irm https://github.com/WKDSteve/tasks-desktop/releases/download/latest/install.ps1 | iex"
```

Or save `install.ps1` from this page and run `.\install.ps1`.

Run it again to update to the newest rolling build.

Or take the file yourself: `tasks-hub-windows-x86_64.exe`. A double click starts the hub in the background and opens the browser (a second click finds the running hub). Windows SmartScreen warns about an unsigned program: "More info", then "Run anyway". `uninstall.ps1` removes it again; `SHA256SUMS` holds the checksums of all files.

The program needs **Neovim 0.10 or newer** and checkouts of `tasks.nvim` and `lib.nvim` (the engine); it finds them through `TASKS_ENGINE_DIR` and `LIB_NVIM_DIR`, `REPOS_DIR`, or the settings file. Your vault is set with `TASKS_VAULT`. Without them the page says what is missing. `tasks-hub --version` names the commit this file was built from; `tasks-hub stop` ends the hub.
