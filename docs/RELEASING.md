# Releasing

A release is a deliberate act that ends with a person trying the result. The workflow
[`release.yml`](../.github/workflows/release.yml) makes a **draft**; nothing is published by a
machine.

## What a release holds

| File | What |
| ---- | ---- |
| `tasks-hub-X.Y.Z-x86_64-pc-windows-msvc.zip` | the program for Windows |
| `install.ps1` | the install script of appkit's release-kit, stamped for this tag: it installs exactly this release |
| `uninstall.ps1` | the script of `scripts/` at this tag |
| `SHA256SUMS` | the checksum of every file above |

(Earlier releases also held a Linux and a macOS archive, `install.sh` and `uninstall.sh`; they were built on
hosted runners, which this repository no longer uses. See *The runner* below.)

The rolling build `latest` ([`rolling.yml`](../.github/workflows/rolling.yml)) carries the same
script, stamped for `latest`, beside its Windows program. `rolling.yml` takes the actions `prepare`
and `publish` of the release-kit, `release.yml` takes `publish` (its own `check` decides), both by
the commit of the appkit tag that `Cargo.lock` pins;
`tools/check-appkit-pin.py` fails when the two disagree, so a raised appkit tag raises them too.

The native shell with a Setup (`*-setup.exe`, and, if they return, `.dmg` and a Linux package) is the Tauri task; this
workflow gets a `bundle` job when it exists. The scripts stay in any case: they are the way for a
person without administrator rights or with a program that is not signed.

## Steps

1. **Main is green** (the `ci` workflow, all jobs), the engine pin `engine.lock` is the one you mean.
2. **Bump the version** in `crates/tasks-hub/Cargo.toml`, in its own commit, and push it. The tag
   must be `v` plus exactly that version; the workflow refuses otherwise.
3. **Wait for the CI of that commit.** The workflow looks for a green `ci` run of the very commit
   that the tag points at and stops without one.
4. **Tag and push:** `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow
   - checks the tag, the version, that the commit is on `main`, the green CI, and that no published
     release of the tag exists (`check`),
   - builds the interface and then the program for Windows, packs it, unpacks it again in
     another folder to ask it for its version, and runs the install script of the release-kit and
     the uninstall script against it in a folder of their own (`build`, rule `NREL-12`),
   - makes the draft with the notes of `.github/release-notes.md` (`{tag}` in them becomes the tag; the
     notes stay on the page when it is published, so they say nothing about being a draft) and adds the
     archive, the stamped install script, the uninstall script and `SHA256SUMS` (`publish`).
5. **Open the draft on a clean user account.** The files of a draft can
   be downloaded only by people who may write to the repository (logged in, in the browser), so the
   script cannot fetch them by itself yet: download the archive, `SHA256SUMS` and
   `install.ps1` into one folder and run `install.ps1 -File <the archive>` there
   (the sums are found beside it). Start the hub, run it again (repair), run `uninstall.ps1` with and
   without `--purge-settings`. The download path of the script (no `-File`) is tried after
   publishing, once, with the line of the notes. A green build is not a program that was
   tried (`NREL-07`). Do this in a normal terminal of the user, not from an agent session
   (`WIN-03`). A build machine that runs elevated needs `-AllowElevated` (PowerShell) for the
   scripts; a user session does not and should not.
6. **Publish the draft** within about a day (`NREL-09`). If the tree moved on, delete the draft and
   the tag and cut again from `main`.
7. A **published release is never cut again** (`NREL-10`): a mistake is fixed in the next patch
   version.

## When something is wrong

- *the tag says X but Cargo.toml says Y*: bump the version (step 2) and tag again; delete the tag
  first (`git push origin :refs/tags/vX.Y.Z`).
- *no green CI run for the commit*: the tag points at a commit CI has not passed. Wait, or fix.
- *a release exists already*: delete the draft in GitHub (a published one stays, see step 7).
- *a file is missing from the sums*: the `build` job failed; read it, delete the draft, tag again.
- *nothing happens after the tag*: the runner is not running; `runners.ps1 status tasks-desktop`.

## The runner

CI (`ci.yml`), the rolling build (`rolling.yml`) and the release (`release.yml`) all run on the self-hosted Windows
runner of the maintainer (`runs-on: [self-hosted, windows]`, Git Bash by its full path); without it a push or a tag
stays "queued" (no red mark, discarded after 24 h). No workflow has a `pull_request` trigger: a pull request, from a
fork too, must never run its own workflow on that machine.

- Only Windows is built and tested: there is no Linux or macOS archive and no `install.sh` any more.
- The other sources (the engine at the pinned commit of `engine.lock`, appkit through Cargo and pnpm) are public
  and read without credentials. There is no token secret.
- `release-kit` of appkit runs on the runner from v0.23.1 on (Git Bash by its full path); the apps pin it by the
  commit of the tag that `Cargo.lock` pins.
- The repository is public: installing is an anonymous download (`irm .../releases/download/<tag>/install.ps1 | iex`,
  no `GH_TOKEN`); see the notes of the release page and the release-kit README of appkit.

## Not yet

Code signing (Authenticode, notarisation) and the updater key are separate decisions
(`TAU-10`); the scripts and the notes say that the program is unsigned.
