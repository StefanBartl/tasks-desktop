# Releasing

A release is a deliberate act that ends with a person trying the result. The workflow
[`release.yml`](../.github/workflows/release.yml) makes a **draft**; nothing is published by a
machine.

## What a release holds

| File | What |
| ---- | ---- |
| `tasks-hub-X.Y.Z-x86_64-pc-windows-msvc.zip` | the program for Windows |
| `tasks-hub-X.Y.Z-x86_64-unknown-linux-gnu.tar.gz` | the program for Linux |
| `tasks-hub-X.Y.Z-aarch64-apple-darwin.tar.gz` | the program for macOS (built, **not tried on a Mac**; the notes say so) |
| `install.sh`, `install.ps1`, `uninstall.sh`, `uninstall.ps1` | the scripts of `scripts/` at this tag |
| `SHA256SUMS` | the checksum of every file above |

The native shell with a Setup (`*-setup.exe`, `.dmg`, a Linux package) is the Tauri task; this
workflow gets a `bundle` job when it exists. The scripts stay in any case: they are the way for a
person without administrator rights or with a program that is not signed.

## Steps

1. **Main is green** (the `ci` workflow, all jobs), the engine pin `engine.lock` is the one you mean.
2. **Bump the version** in `crates/tasks-hub/Cargo.toml`, in its own commit, and push it. The tag
   must be `v` plus exactly that version; the workflow refuses otherwise.
3. **Wait for the CI of that commit.** The workflow looks for a green `ci` run of the very commit
   that the tag points at and stops without one.
4. **Tag and push:** `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow
   - checks the tag, the version, that the commit is on `main`, and the green CI (`check`),
   - makes the draft with the notes of `.github/release-notes.md` (`draft`),
   - builds the interface and then the program on each system, packs it, unpacks it again in
     another folder to ask it for its version, and runs the install and uninstall scripts against
     it in a folder of their own (`build`, rule `REL-12`),
   - adds `SHA256SUMS` and the scripts (`sums`).
5. **Open the draft on a clean user account** and, per system you have. The files of a draft can
   be downloaded only by people who may write to the repository (logged in, in the browser), so the
   script cannot fetch them by itself yet: download the archive of your system, `SHA256SUMS` and
   `install.*` into one folder and run `install.* --archive <the archive>` there (the sums are
   found beside it). Start the hub, run it again (repair), run `uninstall.*` with and without
   `--purge-settings`. The download path of the scripts (`--version <tag>`, no `--archive`) is tried
   after publishing, once: `install.sh --version vX.Y.Z`. A green build is not a program that was
   tried (`REL-07`). Do this in a normal terminal of the user, not from an agent session
   (`WIN-03`). A build machine that runs elevated needs `-AllowElevated` (PowerShell) for the
   scripts; a user session does not and should not.
6. **Publish the draft** within about a day (`REL-09`). If the tree moved on, delete the draft and
   the tag and cut again from `main`.
7. A **published release is never cut again** (`REL-10`): a mistake is fixed in the next patch
   version.

## When something is wrong

- *the tag says X but Cargo.toml says Y*: bump the version (step 2) and tag again; delete the tag
  first (`git push origin :refs/tags/vX.Y.Z`).
- *no green CI run for the commit*: the tag points at a commit CI has not passed. Wait, or fix.
- *a release exists already*: delete the draft in GitHub (a published one stays, see step 7).
- *a system is missing from the sums*: one `build` job failed; read it, delete the draft, tag again.

## Not yet

Code signing (Authenticode, notarisation) and the updater key are separate decisions
(`TAU-10`); the scripts and the notes say that the program is unsigned.
