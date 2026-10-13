#!/bin/sh
# Test scripts/install.sh and scripts/uninstall.sh against a built tasks-hub.
#
#   scripts/test-install.sh PATH/TO/tasks-hub
#
# Everything happens in a temporary folder: the install folder, the settings folder and HOME
# are set there, the login entry and the link of this machine are left alone
# (TASKS_DESKTOP_NO_LOGIN_SYNC), and nothing is downloaded (--archive). Exit 0 when all pass.

set -eu

[ $# -eq 1 ] || {
    echo "usage: test-install.sh PATH/TO/tasks-hub" >&2
    exit 2
}
BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[ -f "$BIN" ] || {
    echo "no such program: $BIN" >&2
    exit 2
}
HERE="$(cd "$(dirname "$0")" && pwd)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/tasks-desktop-test-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

mkdir -p "$TMP/home"
export HOME="$TMP/home"
export XDG_DATA_HOME="$TMP/home/data"
export XDG_CONFIG_HOME="$TMP/home/config"
export TASKS_DESKTOP_INSTALL_DIR="$TMP/bin"
export TASKS_DESKTOP_CONFIG_DIR="$TMP/cfg"
export TASKS_DESKTOP_NO_LOGIN_SYNC=1

failures=0
pass() { printf 'ok   %s\n' "$1"; }
nope() {
    printf 'FAIL %s\n' "$1"
    failures=$((failures + 1))
}

# check NAME COMMAND...: the command must succeed
check() {
    name="$1"
    shift
    if "$@"; then pass "$name"; else nope "$name"; fi
}
# refuses NAME COMMAND...: the command must fail
refuses() {
    name="$1"
    shift
    if "$@" >"$TMP/out" 2>&1; then nope "$name (it succeeded)"; else pass "$name"; fi
}
# runs NAME COMMAND...: the command must succeed; its output is kept in $TMP/out
runs() {
    name="$1"
    shift
    if "$@" >"$TMP/out" 2>&1; then
        pass "$name"
    else
        nope "$name"
        cat "$TMP/out"
    fi
}
# says PATTERN NAME: the last output must hold the pattern
says() {
    if grep -q -- "$1" "$TMP/out"; then pass "$2"; else nope "$2"; fi
}

installed() { [ -f "$TMP/bin/tasks-hub" ] || [ -f "$TMP/bin/tasks-hub.exe" ]; }

# A release archive and its sums, made from the program under test.
mkdir -p "$TMP/release/stage"
cp "$BIN" "$TMP/release/stage/$(basename "$BIN")"
tar -czf "$TMP/release/tasks-hub-0.0.0-test.tar.gz" -C "$TMP/release/stage" "$(basename "$BIN")"
HASH="$(cd "$TMP/release" && { sha256sum tasks-hub-0.0.0-test.tar.gz 2>/dev/null || shasum -a 256 tasks-hub-0.0.0-test.tar.gz; } | cut -d ' ' -f 1)"
printf '%s  tasks-hub-0.0.0-test.tar.gz\n' "$HASH" >"$TMP/release/SHA256SUMS"
ARCHIVE="$TMP/release/tasks-hub-0.0.0-test.tar.gz"

# 1. No checksum, no install; a wrong one, no install.
cp "$ARCHIVE" "$TMP/loose.tar.gz"
refuses "an archive without a checksum is refused" sh "$HERE/install.sh" --archive "$TMP/loose.tar.gz"
says "no checksum" "  and it says why"
refuses "a wrong checksum is refused" sh "$HERE/install.sh" --archive "$ARCHIVE" --sha256 "0000000000000000000000000000000000000000000000000000000000000000"
says "does not match" "  and it says why"
refuses "a file that is not listed is refused" sh "$HERE/install.sh" --archive "$TMP/loose.tar.gz" --sums "$TMP/release/SHA256SUMS"
check "nothing was installed by any of them" sh -c "! [ -e '$TMP/bin' ]"
refuses "an unknown option is refused" sh "$HERE/install.sh" --nope

# 2. A good archive installs, with the sums beside it.
runs "install from an archive" sh "$HERE/install.sh" --archive "$ARCHIVE"
check "the program is in the install folder" installed
if [ -f "$TMP/bin/tasks-hub" ]; then P="$TMP/bin/tasks-hub"; else P="$TMP/bin/tasks-hub.exe"; fi
check "it runs" "$P" --version
check "no .new file is left" sh -c "! ls '$TMP'/bin/*.new >/dev/null 2>&1"

# 3. Again: it is found and repaired, not installed beside.
runs "install again" sh "$HERE/install.sh" --archive "$ARCHIVE"
says "repairing" "  it says it repairs"
check "still one program" sh -c "[ \$(ls '$TMP/bin' | wc -l) -eq 1 ]"

# 4. Uninstall keeps the settings; a file that is not ours stays in any case.
mkdir -p "$TMP/cfg"
echo '{}' >"$TMP/cfg/config.json"
echo 'mine' >"$TMP/cfg/notes.txt"
runs "uninstall" sh "$HERE/uninstall.sh"
check "the program is gone" sh -c "! [ -e '$TMP/bin/tasks-hub' ] && ! [ -e '$TMP/bin/tasks-hub.exe' ]"
check "the install folder is gone" sh -c "! [ -d '$TMP/bin' ]"
check "the settings stay" [ -f "$TMP/cfg/config.json" ]

# 5. Uninstall twice is not an error.
runs "uninstall again" sh "$HERE/uninstall.sh"
says "nothing to remove" "  it says so"

# 6. --purge-settings removes the files of the app and nothing else.
sh "$HERE/install.sh" --archive "$ARCHIVE" >"$TMP/out" 2>&1 || nope "install before purge"
runs "uninstall --purge-settings" sh "$HERE/uninstall.sh" --purge-settings
check "the settings file is gone" sh -c "! [ -e '$TMP/cfg/config.json' ]"
check "a file that is not the app's stays" [ -f "$TMP/cfg/notes.txt" ]

# 7. A program that cannot be removed is an error (a folder without write rights; not on Windows,
# where the mode bits mean nothing).
case "$(uname -s)" in
    Linux | Darwin)
        sh "$HERE/install.sh" --archive "$ARCHIVE" >"$TMP/out" 2>&1 || nope "install before the locked removal"
        chmod a-w "$TMP/bin"
        refuses "a program that cannot be removed is an error" sh "$HERE/uninstall.sh"
        if grep -q '^removed ' "$TMP/out"; then nope "  and it does not say removed"; else pass "  and it does not say removed"; fi
        check "  and it is still there" installed
        chmod u+w "$TMP/bin"
        runs "  once it can be removed the uninstall goes through" sh "$HERE/uninstall.sh"
        ;;
esac

# 8. A folder that holds other files stays when the program goes.
mkdir -p "$TMP/bin"
echo 'mine' >"$TMP/bin/other.txt"
sh "$HERE/install.sh" --archive "$ARCHIVE" >"$TMP/out" 2>&1 || nope "install into a folder with other files"
sh "$HERE/uninstall.sh" >"$TMP/out" 2>&1 || nope "uninstall from a folder with other files"
check "the other file and so the folder stay" [ -f "$TMP/bin/other.txt" ]

if [ "$failures" -ne 0 ]; then
    printf '\n%s check(s) failed\n' "$failures"
    exit 1
fi
printf '\nall checks passed\n'
