#!/bin/sh
# Remove tasks-hub for the current user (Linux, macOS), without administrator rights.
#
#   scripts/uninstall.sh [--purge-settings]
#
# It asks the installed program to take its place in the system away (`tasks-hub uninstall`:
# stop the hub, the login entry, the launcher), then removes the program file from the install
# folder ($TASKS_DESKTOP_INSTALL_DIR, else ${XDG_DATA_HOME:-~/.local/share}/tasks-desktop/bin).
# Your settings stay unless you ask: --purge-settings removes the files of the app in the
# settings folder. The vault and your tasks are never touched. A second run finds nothing to do
# and says so; it is not an error.
#
# If taking the system entries away fails, the program is NOT removed (a login entry that points
# at a missing program is worse than a program that is still there): read the message and run it
# again.

set -eu

PURGE=""

say() { printf '%s\n' "$*"; }
fail() {
    printf 'uninstall.sh: %s\n' "$*" >&2
    exit 1
}

usage() {
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --purge-settings)
            PURGE="--purge-settings"
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

if [ "$(id -u)" = "0" ]; then
    fail "do not run this as root: it removes the installation of one user"
fi

if [ -n "${TASKS_DESKTOP_INSTALL_DIR:-}" ]; then
    dir="$TASKS_DESKTOP_INSTALL_DIR"
else
    dir="${XDG_DATA_HOME:-$HOME/.local/share}/tasks-desktop/bin"
fi

program=""
for candidate in "$dir/tasks-hub" "$dir/tasks-hub.exe"; do
    if [ -f "$candidate" ]; then
        program="$candidate"
        break
    fi
done

if [ -z "$program" ]; then
    say "nothing to remove: no tasks-hub in $dir"
    exit 0
fi

# shellcheck disable=SC2086 # the flag is one word or empty
"$program" uninstall $PURGE || fail "tasks-hub uninstall failed (see above): the program stays in $dir"

# Only the files the installer puts there; a folder that holds anything else stays.
rm -f "$program" "$dir/tasks-hub.new" "$dir/tasks-hub.exe.new"
rmdir "$dir" 2>/dev/null || true
# The parent only when it is the folder the installer makes (never a folder you chose).
parent="$(dirname "$dir")"
if [ "$(basename "$dir")" = "bin" ] && [ "$(basename "$parent")" = "tasks-desktop" ]; then
    rmdir "$parent" 2>/dev/null || true
fi

say ""
say "removed $program"
if [ -z "$PURGE" ]; then
    say "your settings were kept (--purge-settings removes them); your vault was not touched"
fi
