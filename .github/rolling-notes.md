**This is not a release.** It is the newest state of `main`, rebuilt after every green CI run and replaced each time. Nothing here is signed or tested by hand; use a release for anything that matters.

- **Windows:** `tasks-hub-windows-x86_64.exe`. A double click starts the hub in the background and opens the browser (a second click finds the running hub). Windows SmartScreen warns about an unsigned program: "More info", then "Run anyway".
- **Linux:** `tasks-hub-linux-x86_64.tar.gz`. Unpack it and run `./tasks-hub` (without an argument it does the same as the double click).
- `SHA256SUMS` holds the checksums of both files.

The program needs **Neovim 0.10 or newer** and checkouts of `tasks.nvim` and `lib.nvim` (the engine); it finds them through `TASKS_ENGINE_DIR` and `LIB_NVIM_DIR`, `REPOS_DIR`, or the settings file. Your vault is set with `TASKS_VAULT`. Without them the page says what is missing. `tasks-hub --version` names the commit this file was built from; `tasks-hub stop` ends the hub.
