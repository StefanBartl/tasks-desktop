#!/bin/sh
# Install tasks-hub for the current user (Linux, macOS), without administrator rights.
#
#   scripts/install.sh [--version vX.Y.Z] [--autostart] [--shortcut]
#   scripts/install.sh --archive FILE [--sums FILE | --sha256 HEX] [--autostart] [--shortcut]
#
# It downloads the release archive of this system from GitHub, checks it against SHA256SUMS,
# and hands over to `tasks-hub install`, which copies the program to its fixed place
# ($TASKS_DESKTOP_INSTALL_DIR, else ${XDG_DATA_HOME:-~/.local/share}/tasks-desktop/bin) in one
# step and brings a running hub back from there. Run it again to repair or to update: an
# installation that is there is found and replaced, never a second one beside it.
#
# Options:
#   --version TAG   the release to install (default: the latest published one)
#   --repo OWNER/NAME  where the releases are (default: StefanBartl/tasks-desktop)
#   --archive FILE  install from a file you have already (no download); the checksum then
#                   comes from --sums FILE, --sha256 HEX, or a SHA256SUMS next to the file
#   --autostart     start the hub with your login
#   --shortcut      add a launcher "Tasks" to the application menu
#   --help          this text
#
# Needs: sh, tar, and curl or wget (for a download), sha256sum or shasum. Run it in your own
# terminal, not as root and not from inside another program's sandbox.

set -eu

REPO="StefanBartl/tasks-desktop"
VERSION=""
ARCHIVE=""
SUMS=""
SHA256=""
AUTOSTART=""
SHORTCUT=""

say() { printf '%s\n' "$*"; }
fail() {
    printf 'install.sh: %s\n' "$*" >&2
    exit 1
}

usage() {
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            [ $# -ge 2 ] || fail "--version needs a value"
            VERSION="$2"
            shift 2
            ;;
        --repo)
            [ $# -ge 2 ] || fail "--repo needs a value"
            REPO="$2"
            shift 2
            ;;
        --archive)
            [ $# -ge 2 ] || fail "--archive needs a file"
            ARCHIVE="$2"
            shift 2
            ;;
        --sums)
            [ $# -ge 2 ] || fail "--sums needs a file"
            SUMS="$2"
            shift 2
            ;;
        --sha256)
            [ $# -ge 2 ] || fail "--sha256 needs a value"
            SHA256="$2"
            shift 2
            ;;
        --autostart)
            AUTOSTART="--autostart"
            shift
            ;;
        --shortcut)
            SHORTCUT="--shortcut"
            shift
            ;;
        --help | -h)
            usage
            exit 0
            ;;
        *)
            fail "unknown option: $1 (try --help)"
            ;;
    esac
done

# The program belongs to one user: as root it would be the account of root.
if [ "$(id -u)" = "0" ]; then
    fail "do not run this as root: it installs for one user, without administrator rights"
fi

case "$REPO" in
    */* ) ;;
    *) fail "--repo must be OWNER/NAME" ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tasks-desktop-install.XXXXXX")" || fail "no temporary folder"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

have() { command -v "$1" >/dev/null 2>&1; }

fetch() { # fetch URL FILE
    if have curl; then
        curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$2" "$1"
    elif have wget; then
        wget --quiet --https-only --output-document="$2" "$1"
    else
        fail "need curl or wget to download"
    fi
}

sha256_of() { # sha256_of FILE -> hex
    if have sha256sum; then
        sha256sum "$1" | cut -d ' ' -f 1
    elif have shasum; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    else
        fail "need sha256sum or shasum to check the download"
    fi
}

target_triple() {
    os="$(uname -s)"
    cpu="$(uname -m)"
    case "$os:$cpu" in
        Linux:x86_64 | Linux:amd64) say "x86_64-unknown-linux-gnu" ;;
        Darwin:arm64 | Darwin:aarch64) say "aarch64-apple-darwin" ;;
        *) fail "no release for $os on $cpu (Windows: scripts/install.ps1)" ;;
    esac
}

if [ -z "$ARCHIVE" ]; then
    triple="$(target_triple)"
    if [ -z "$VERSION" ]; then
        say "looking for the latest release of $REPO"
        fetch "https://api.github.com/repos/$REPO/releases/latest" "$WORK/latest.json"
        VERSION="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WORK/latest.json" | head -n 1)"
        [ -n "$VERSION" ] || fail "no published release found (pass --version TAG)"
    fi
    # A tag is a plain word: it goes into a URL and a file name.
    case "$VERSION" in
        *[!A-Za-z0-9._-]* | "") fail "the version has a character that is not allowed: $VERSION" ;;
    esac
    name="tasks-hub-${VERSION#v}-$triple.tar.gz"
    base="https://github.com/$REPO/releases/download/$VERSION"
    say "downloading $name"
    fetch "$base/$name" "$WORK/$name"
    fetch "$base/SHA256SUMS" "$WORK/SHA256SUMS"
    ARCHIVE="$WORK/$name"
    SUMS="$WORK/SHA256SUMS"
else
    [ -f "$ARCHIVE" ] || fail "no such file: $ARCHIVE"
fi

# The checksum: never skipped. A file you have already needs one of the three sources.
actual="$(sha256_of "$ARCHIVE")"
if [ -z "$SHA256" ]; then
    if [ -z "$SUMS" ]; then
        beside="$(dirname "$ARCHIVE")/SHA256SUMS"
        [ -f "$beside" ] && SUMS="$beside"
    fi
    [ -n "$SUMS" ] || fail "no checksum for $ARCHIVE: give --sums FILE or --sha256 HEX"
    [ -f "$SUMS" ] || fail "no such file: $SUMS"
    file="$(basename "$ARCHIVE")"
    # Lines are "<hash>  <file>"; the file name must match whole.
    SHA256="$(awk -v f="$file" '{ n = $2; sub(/^\*/, "", n); if (n == f) { print $1; exit } }' "$SUMS")"
    [ -n "$SHA256" ] || fail "$file is not listed in $SUMS"
fi
expected="$(printf '%s' "$SHA256" | tr 'A-F' 'a-f')"
if [ "$actual" != "$expected" ]; then
    fail "the checksum of $ARCHIVE does not match (expected $expected, got $actual): nothing was installed"
fi
say "checksum ok"

mkdir -p "$WORK/unpacked"
tar -xzf "$ARCHIVE" -C "$WORK/unpacked" || fail "cannot unpack $ARCHIVE"
program=""
for candidate in "$WORK/unpacked/tasks-hub" "$WORK/unpacked/tasks-hub.exe"; do
    if [ -f "$candidate" ]; then
        program="$candidate"
        break
    fi
done
[ -n "$program" ] || fail "the archive holds no tasks-hub program"
chmod +x "$program"
new_version="$("$program" --version)" || fail "the program in the archive does not run"

# An installation that is there: told, then replaced in place (repair or update).
if [ -n "${TASKS_DESKTOP_INSTALL_DIR:-}" ]; then
    dir="$TASKS_DESKTOP_INSTALL_DIR"
else
    dir="${XDG_DATA_HOME:-$HOME/.local/share}/tasks-desktop/bin"
fi
for existing in "$dir/tasks-hub" "$dir/tasks-hub.exe"; do
    if [ -f "$existing" ]; then
        old_version="$("$existing" --version 2>/dev/null || say "unreadable")"
        if [ "$old_version" = "$new_version" ]; then
            say "found $old_version in $dir: repairing it"
        else
            say "found $old_version in $dir: replacing it with $new_version"
        fi
    fi
done

# `install` copies beside the target, moves over it, and brings a running hub back (it never
# leaves the hub down); its exit status is ours.
# shellcheck disable=SC2086 # the two flags are single words or empty
"$program" install $AUTOSTART $SHORTCUT || fail "tasks-hub install failed (see above)"

say ""
say "installed $new_version in $dir"
say "start it with: $dir/tasks-hub start --open"
case ":$PATH:" in
    *":$dir:"*) ;;
    *) say "(put $dir on your PATH to call it as tasks-hub)" ;;
esac
