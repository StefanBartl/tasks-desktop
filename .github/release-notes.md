The hub as a program for each system, with the interface inside it.

**This is a draft.** Before it is published a person installs from it and clicks through the
result (install, start, repair, uninstall). A green build is not a tried program.

## Install

Without administrator rights, for one user. Download the script of your system from this
release and run it in your own terminal; it downloads the archive and checks it against
`SHA256SUMS`:

```
# Linux and macOS
sh install.sh --version <tag> [--autostart] [--shortcut]

# Windows (PowerShell, not elevated)
.\install.ps1 -Version <tag> [-Autostart] [-Shortcut]
```

Run the same script again to repair or to update; remove the program with `uninstall.sh` or
`uninstall.ps1` (your settings stay unless you add `--purge-settings` or `-PurgeSettings`; your
vault is never touched). The scripts are the same files as `scripts/` in the repository at this
tag, and are listed in `SHA256SUMS` too.

## Files

| System | Archive |
| ------ | ------- |
| Windows (x86-64) | `tasks-hub-<version>-x86_64-pc-windows-msvc.zip` |
| Linux (x86-64) | `tasks-hub-<version>-x86_64-unknown-linux-gnu.tar.gz` |
| macOS (Apple silicon) | `tasks-hub-<version>-aarch64-apple-darwin.tar.gz`, **built but not tried on a Mac** |

`SHA256SUMS` lists the checksum of every archive:

```
sha256sum -c SHA256SUMS --ignore-missing
```

The program is not signed yet: Windows may show SmartScreen, macOS may refuse to open it until
you allow it. The scripts do not need either.

The tasks engine (`tasks.nvim`, Neovim 0.12 or newer) is not part of the archive.
