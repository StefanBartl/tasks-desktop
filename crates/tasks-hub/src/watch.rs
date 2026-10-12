//! What changed in the vault, as a hint.
//!
//! The watcher does not say *what* changed, only that something that may
//! matter did. Everything that follows is one rescan by the engine (the
//! hub never reads task files itself). Events can be lost (Windows drops
//! some under a burst and says nothing), so a full scan on a timer is the
//! net under this.
//!
//! The folders are those the Neovim dashboard watches
//! (`<area>/ROADMAP/tasks` with folder tasks, `plans`, `Backlog/FEATURES`
//! and `Backlog/TASKS`) plus the vault root, which the dashboard does not
//! see: a new area appears there.
//!
//! A folder task is moved or renamed as a whole (`done`, `move_area`). The
//! system then reports the folder and not the files in it, so an entry that
//! sits directly in one of those folders counts when it is a folder, too.

use std::path::{Path, PathBuf};

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use tokio::sync::mpsc::UnboundedSender;

/// Why the refresher is woken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hint {
    /// A path that matters changed.
    Changed,
    /// The watcher itself failed (a lost event, an overflow): rescan, do
    /// not trust what was seen.
    Lost,
}

/// What sits at a path right now, as far as the question "does it matter"
/// needs to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// A regular file, or a folder that only says something inside it
    /// changed (the files in it have their own events).
    File,
    /// A folder (or a link: it may lead to one).
    Folder,
    /// Not there any more: removed, or the old name of a rename.
    Gone,
}

impl Entry {
    /// Look at a path. One `lstat`.
    #[must_use]
    pub fn of(path: &Path) -> Self {
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.is_file() => Self::File,
            Ok(_) => Self::Folder,
            Err(_) => Self::Gone,
        }
    }
}

/// Names that are tools' leftovers, not tasks: temp files of the engine
/// (`*.tasks-tmp.*`, `*.frontmatter.*`), lock files, editor backups and
/// swap files, Vim's probe file (`4913`), sync conflicts.
fn ignored_name(name: &str) -> bool {
    name.contains(".tasks-tmp.")
        || name.contains(".frontmatter.")
        || name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".swo")
        || name.ends_with(".swn")
        || name.ends_with(".swx")
        || name.starts_with(".#")
        || name.contains(".sync-conflict-")
        || name.contains(" (conflicted copy)")
        || (name.starts_with('.') && name.ends_with(".lock"))
        || (!name.is_empty() && name.bytes().all(|b| b.is_ascii_digit()))
}

fn is_markdown(name: &str) -> bool {
    Path::new(name)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Is a change at this path, given relative to the vault, worth a rescan?
///
/// `entry` says what is at the path; it is asked only when the place of the
/// path could matter at all (it costs a system call, and a vault that is a
/// git repository makes hundreds of events under `.git`).
#[must_use]
pub fn relevant(relative: &Path, entry: impl FnOnce() -> Entry) -> bool {
    let Some(parts) = relative
        .components()
        .map(|c| c.as_os_str().to_str())
        .collect::<Option<Vec<&str>>>()
    else {
        // A name that is not text: the periodic scan will see what it is.
        return false;
    };
    match parts.as_slice() {
        [] => false,
        // A new or removed area (or any entry of the vault root). A hidden
        // name (`.git`, `.obsidian`, a tool's state file) is not an area, and
        // a scan that is woken by its own tools would never rest. An area is
        // a folder: a file in the root is not one.
        [name] => !name.starts_with('.') && !ignored_name(name) && entry() != Entry::File,
        // The structure of an area: its two folders and the folders of the
        // tasks and plans. A folder only.
        [_, "ROADMAP" | "Backlog"]
        | [_, "ROADMAP", "tasks" | "plans"]
        | [_, "Backlog", "FEATURES" | "TASKS"] => entry() != Entry::File,
        // What sits directly in them: a task file, or the folder of a folder
        // task (which is moved, renamed and removed as a whole).
        [_, "ROADMAP", "tasks" | "plans", name] | [_, "Backlog", "FEATURES" | "TASKS", name] => {
            !ignored_name(name) && (is_markdown(name) || entry() != Entry::File)
        }
        // Deeper: the files of a folder task.
        [_, "ROADMAP", "tasks" | "plans", .., last]
        | [_, "Backlog", "FEATURES" | "TASKS", .., last] => {
            is_markdown(last) && !ignored_name(last)
        }
        _ => false,
    }
}

/// What an event of the watcher asks of the refresher, if anything.
#[must_use]
pub fn hint_for(event: &Event, bases: &[PathBuf]) -> Option<Hint> {
    // The backend says it dropped events (an overflowing queue): nothing
    // that was seen can be trusted, and there is no path to judge.
    if event.need_rescan() {
        return Some(Hint::Lost);
    }
    if matches!(event.kind, EventKind::Access(_)) {
        return None;
    }
    // A folder whose content changed is reported for the folder too
    // (Windows does); the files in it are what matter, and they have their
    // own events. A folder that was renamed is not that: it is a change of
    // the folder itself.
    let content_only =
        matches!(event.kind, EventKind::Modify(kind) if !matches!(kind, ModifyKind::Name(_)));
    let matters = event.paths.iter().any(|path| {
        let Some(relative) = bases.iter().find_map(|base| path.strip_prefix(base).ok()) else {
            // A path that does not sit under the root in any spelling we
            // know: a needless rescan is cheaper than a missed change.
            return true;
        };
        relevant(relative, || match Entry::of(path) {
            Entry::Folder if content_only => Entry::File,
            other => other,
        })
    });
    matters.then_some(Hint::Changed)
}

/// A running watcher; dropping it stops it.
pub struct Watcher {
    _inner: RecommendedWatcher,
}

/// Watch the vault and send a hint for every change that matters.
///
/// # Errors
///
/// The watcher could not be created or could not watch the folder.
pub fn start(vault: &Path, hints: UnboundedSender<Hint>) -> notify::Result<Watcher> {
    let root: PathBuf = vault.to_path_buf();
    // The root as it was written, and as the system may report it: FSEvents
    // (macOS) names the real path (`/private/var` for `/var`). Without the
    // second spelling every event would be "not under the root" and the
    // events of `.git` would wake a scan each.
    let mut bases = vec![root.clone()];
    if let Some(real) = root.canonicalize().ok().filter(|real| *real != root) {
        bases.push(real);
    }
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let hint = match result {
            Ok(event) => hint_for(&event, &bases),
            Err(_) => Some(Hint::Lost),
        };
        if let Some(hint) = hint {
            let _ = hints.send(hint);
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    Ok(Watcher { _inner: watcher })
}

#[cfg(test)]
mod tests {
    use notify::event::{CreateKind, Flag, ModifyKind, RemoveKind, RenameMode};

    use super::*;

    /// A path that holds a file.
    fn file(p: &str) -> bool {
        relevant(Path::new(p), || Entry::File)
    }

    fn folder(p: &str) -> bool {
        relevant(Path::new(p), || Entry::Folder)
    }

    fn gone(p: &str) -> bool {
        relevant(Path::new(p), || Entry::Gone)
    }

    #[test]
    fn tasks_plans_and_backlogs_matter() {
        for yes in [
            "lib.nvim/ROADMAP/tasks/alpha.md",
            "lib.nvim/ROADMAP/tasks/folder-task/folder-task.md",
            "lib.nvim/ROADMAP/tasks/folder-task/deep/er/note.md",
            "lib.nvim/ROADMAP/plans/the-plan.md",
            "lib.nvim/Backlog/FEATURES/2026-10-12_x.md",
            "lib.nvim/Backlog/TASKS/2026-10-12_y.md",
            "lib.nvim/Backlog/TASKS/a-folder-task/a-folder-task.md",
            "lib.nvim/ROADMAP/tasks/UPPER.MD",
        ] {
            assert!(file(yes), "{yes}");
        }
    }

    #[test]
    fn a_new_area_or_its_folders_matter() {
        for yes in [
            "brand-new.nvim",
            "brand-new.nvim/ROADMAP",
            "brand-new.nvim/Backlog",
            "brand-new.nvim/ROADMAP/tasks",
            "brand-new.nvim/Backlog/FEATURES",
        ] {
            assert!(folder(yes), "{yes}");
            assert!(gone(yes), "{yes}");
        }
    }

    #[test]
    fn a_folder_task_moved_as_a_whole_matters() {
        // `done` and `move_area` rename the folder; the system reports the
        // folder, not the files in it. The new name is a folder, the old
        // name is gone.
        for path in [
            "lib.nvim/ROADMAP/tasks/folder-task",
            "lib.nvim/ROADMAP/tasks/v1.2-release",
            "lib.nvim/Backlog/TASKS/folder-task",
            "lib.nvim/Backlog/FEATURES/folder-task",
        ] {
            assert!(folder(path), "{path}");
            assert!(gone(path), "{path}");
        }
        // A file that is not markdown in the folder of the tasks is not a
        // task; one that was removed might have been a folder.
        assert!(!file("lib.nvim/ROADMAP/tasks/notes.txt"));
        assert!(gone("lib.nvim/ROADMAP/tasks/notes.txt"));
    }

    #[test]
    fn a_file_in_the_root_is_not_an_area() {
        assert!(!file("README.md"));
        assert!(!file("INDEX"));
        assert!(folder("brand-new.nvim"));
    }

    #[test]
    fn what_the_engine_or_an_editor_leaves_does_not_matter() {
        for no in [
            "lib.nvim/ROADMAP/tasks/alpha.tasks-tmp.123.md",
            "lib.nvim/ROADMAP/tasks/alpha.frontmatter.md",
            "lib.nvim/ROADMAP/tasks/.alpha.md.lock",
            "lib.nvim/ROADMAP/tasks/alpha.md~",
            "lib.nvim/ROADMAP/tasks/alpha.md.swp",
            "lib.nvim/ROADMAP/tasks/.alpha.md.swo",
            "lib.nvim/ROADMAP/tasks/.#alpha.md",
            "lib.nvim/ROADMAP/tasks/4913",
            "lib.nvim/ROADMAP/tasks/alpha.sync-conflict-20261012.md",
            "lib.nvim/ROADMAP/tasks/alpha (conflicted copy).md",
            "lib.nvim/ROADMAP/tasks/notes.txt",
            "lib.nvim/ROADMAP/tasks/folder/image.png",
        ] {
            assert!(!file(no), "{no}");
        }
        // Even when they are gone again (an editor's temp file is made and
        // removed within a moment): the name says what they are.
        for no in [
            "lib.nvim/ROADMAP/tasks/alpha.tasks-tmp.123.md",
            "lib.nvim/ROADMAP/tasks/alpha.md~",
            "lib.nvim/ROADMAP/tasks/.alpha.md.swp",
            "lib.nvim/ROADMAP/tasks/4913",
        ] {
            assert!(!gone(no), "{no}");
        }
    }

    #[test]
    fn the_generated_overviews_and_everything_else_do_not_matter() {
        for no in [
            "lib.nvim/ROADMAP/TASKS.md",
            "lib.nvim/Backlog/README.md",
            "lib.nvim/README.md",
            "lib.nvim/docs/notes.md",
            "lib.nvim/ROADMAP/other/x.md",
            "lib.nvim/.git/HEAD",
            "lib.nvim/Backlog/OTHER/x.md",
            ".DS_Store~",
            ".git",
            ".obsidian",
            ".hidden-state-file",
            "",
        ] {
            assert!(!file(no), "{no}");
            assert!(!folder(no), "{no}");
            assert!(!gone(no), "{no}");
        }
    }

    #[test]
    fn the_file_system_is_asked_only_where_it_can_matter() {
        // Hundreds of events come from `.git` when the vault is a repository:
        // none of them may cost a system call.
        for path in [
            ".git",
            ".git/index.lock",
            "lib.nvim/.git/objects/ab/cdef",
            "lib.nvim/docs/notes.md",
            "lib.nvim/ROADMAP/tasks/alpha.md",
            "lib.nvim/ROADMAP/tasks/folder/note.md",
            "lib.nvim/ROADMAP/tasks/alpha.md~",
        ] {
            let _ = relevant(Path::new(path), || panic!("asked for {path}"));
        }
    }

    fn event(kind: EventKind, path: &str) -> Event {
        Event::new(kind).add_path(PathBuf::from("vault").join(path))
    }

    #[test]
    fn a_dropped_event_is_a_lost_one() {
        // inotify and FSEvents say it as an event of its own, with no path.
        let overflow = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert_eq!(hint_for(&overflow, &bases()), Some(Hint::Lost));
    }

    fn bases() -> Vec<PathBuf> {
        vec![PathBuf::from("vault")]
    }

    #[test]
    fn the_real_path_of_the_root_is_known_too() {
        // FSEvents reports `/private/var/...` for a vault given as `/var/...`.
        let both = vec![PathBuf::from("vault"), PathBuf::from("real").join("vault")];
        let under_git = Event::new(EventKind::Create(CreateKind::Any)).add_path(
            PathBuf::from("real")
                .join("vault")
                .join("lib.nvim")
                .join(".git")
                .join("HEAD"),
        );
        assert_eq!(hint_for(&under_git, &both), None);
        // A spelling nobody told us of is not told apart: it rescans.
        assert_eq!(hint_for(&under_git, &bases()), Some(Hint::Changed));
    }

    #[test]
    fn events_are_told_apart_by_kind_and_path() {
        let base = &bases();
        let task = "lib.nvim/ROADMAP/tasks/alpha.md";
        assert_eq!(
            hint_for(&event(EventKind::Create(CreateKind::File), task), base),
            Some(Hint::Changed)
        );
        assert_eq!(
            hint_for(&event(EventKind::Remove(RemoveKind::File), task), base),
            Some(Hint::Changed)
        );
        // A read is not a change.
        assert_eq!(
            hint_for(
                &event(EventKind::Access(notify::event::AccessKind::Any), task),
                base
            ),
            None
        );
        // A leftover of a tool, or something else in the vault.
        assert_eq!(
            hint_for(
                &event(
                    EventKind::Remove(RemoveKind::Any),
                    "lib.nvim/ROADMAP/tasks/x.md~"
                ),
                base
            ),
            None
        );
        assert_eq!(
            hint_for(
                &event(EventKind::Create(CreateKind::Any), "lib.nvim/.git/HEAD"),
                base
            ),
            None
        );
        // The old name of a rename is gone, and a folder task that was
        // renamed as a whole is told by that name alone.
        let old = event(
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            "lib.nvim/ROADMAP/tasks/folder-task",
        );
        assert_eq!(hint_for(&old, base), Some(Hint::Changed));
    }
}
