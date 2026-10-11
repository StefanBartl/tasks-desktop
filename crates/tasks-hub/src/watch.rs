//! What changed in the vault, as a hint.
//!
//! The watcher does not say *what* changed, only that something that may
//! matter did. Everything that follows is one rescan by the engine (the
//! hub never reads task files itself). Events can be lost (Windows drops
//! some under a burst), so a full scan on a timer is the net under this.
//!
//! The folders are those the Neovim dashboard watches
//! (`<area>/ROADMAP/tasks` with folder tasks, `plans`, `Backlog/FEATURES`
//! and `Backlog/TASKS`) plus the vault root, which the dashboard does not
//! see: a new area appears there.

use std::path::{Path, PathBuf};

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

/// Names that are tools' leftovers, not tasks: temp files of the engine
/// (`*.tasks-tmp.*`, `*.frontmatter.*`), lock files, editor backups and
/// swap files, Vim's probe file (`4913`), sync conflicts.
fn ignored_name(name: &str) -> bool {
    name.contains(".tasks-tmp.")
        || name.contains(".frontmatter.")
        || name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".swx")
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
#[must_use]
pub fn relevant(relative: &Path) -> bool {
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
        // a scan that is woken by its own tools would never rest.
        [name] => !name.starts_with('.') && !ignored_name(name),
        // The structure of an area: its two folders and their children.
        [_, "ROADMAP" | "Backlog"] => true,
        [_, "ROADMAP", "tasks" | "plans"] | [_, "Backlog", "FEATURES" | "TASKS"] => true,
        [_, "ROADMAP", "tasks" | "plans", .., last]
        | [_, "Backlog", "FEATURES" | "TASKS", .., last] => {
            is_markdown(last) && !ignored_name(last)
        }
        _ => false,
    }
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
    let base = root.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        match result {
            Ok(event) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                let modify = matches!(event.kind, EventKind::Modify(_));
                let matters = event.paths.iter().any(|p| {
                    // A folder whose content changed is reported for the
                    // folder too (Windows does); the files in it are what
                    // matter, and they have their own events.
                    if modify && p.is_dir() {
                        return false;
                    }
                    match p.strip_prefix(&base) {
                        Ok(relative) => relevant(relative),
                        // A path that does not sit under the root as we wrote
                        // it (another spelling of the same folder): a needless
                        // rescan is cheaper than a missed change.
                        Err(_) => true,
                    }
                });
                if matters {
                    let _ = hints.send(Hint::Changed);
                }
            }
            Err(_) => {
                let _ = hints.send(Hint::Lost);
            }
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    Ok(Watcher { _inner: watcher })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(p: &str) -> bool {
        relevant(Path::new(p))
    }

    #[test]
    fn tasks_plans_and_backlogs_matter() {
        for yes in [
            "lib.nvim/ROADMAP/tasks/alpha.md",
            "lib.nvim/ROADMAP/tasks/folder-task/index.md",
            "lib.nvim/ROADMAP/tasks/folder-task/deep/er/note.md",
            "lib.nvim/ROADMAP/plans/the-plan.md",
            "lib.nvim/Backlog/FEATURES/2026-10-12_x.md",
            "lib.nvim/Backlog/TASKS/2026-10-12_y.md",
            "lib.nvim/ROADMAP/tasks/UPPER.MD",
        ] {
            assert!(rel(yes), "{yes}");
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
            assert!(rel(yes), "{yes}");
        }
    }

    #[test]
    fn what_the_engine_or_an_editor_leaves_does_not_matter() {
        for no in [
            "lib.nvim/ROADMAP/tasks/alpha.tasks-tmp.123.md",
            "lib.nvim/ROADMAP/tasks/alpha.frontmatter.md",
            "lib.nvim/ROADMAP/tasks/.alpha.md.lock",
            "lib.nvim/ROADMAP/tasks/alpha.md~",
            "lib.nvim/ROADMAP/tasks/alpha.md.swp",
            "lib.nvim/ROADMAP/tasks/4913",
            "lib.nvim/ROADMAP/tasks/alpha.sync-conflict-20261012.md",
            "lib.nvim/ROADMAP/tasks/alpha (conflicted copy).md",
            "lib.nvim/ROADMAP/tasks/notes.txt",
            "lib.nvim/ROADMAP/tasks/folder/image.png",
        ] {
            assert!(!rel(no), "{no}");
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
            assert!(!rel(no), "{no}");
        }
    }
}
