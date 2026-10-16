//! What changed in the vault, as a hint.
//!
//! The watcher does not say *what* changed, only that something that may matter did. Everything
//! that follows is one rescan by the engine (the hub never reads the documents itself). Events can
//! be lost (Windows drops some under a burst and says nothing), so a full scan on a timer is the
//! net under this.
//!
//! Which paths matter is the app's rule, a [`Filter`] it hands in: the kit cannot know the layout
//! of a vault, and an app cannot make the kit watch less than the filter says.

use std::path::{Path, PathBuf};

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use tokio::sync::mpsc::UnboundedSender;

/// Why the refresher is woken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hint {
    /// A path that matters changed.
    Changed,
    /// The watcher itself failed (a lost event, an overflow): rescan, do not trust what was seen.
    Lost,
}

/// What sits at a path right now, as far as the question "does it matter" needs to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// A regular file, or a folder that only says something inside it changed (the files in it have
    /// their own events).
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

/// Is a change at this path, given relative to the vault, worth a rescan?
///
/// The second argument says what is at the path. A filter asks it only when the place of the path
/// could matter at all: it costs a system call, and a vault that is a git repository makes
/// hundreds of events under `.git`.
pub type Filter = fn(&Path, &dyn Fn() -> Entry) -> bool;

/// What an event of the watcher asks of the refresher, if anything.
#[must_use]
pub fn hint_for(event: &Event, bases: &[PathBuf], filter: Filter) -> Option<Hint> {
    // The backend says it dropped events (an overflowing queue): nothing that was seen can be
    // trusted, and there is no path to judge.
    if event.need_rescan() {
        return Some(Hint::Lost);
    }
    if matches!(event.kind, EventKind::Access(_)) {
        return None;
    }
    // A folder whose content changed is reported for the folder too (Windows does); the files in
    // it are what matter, and they have their own events. A folder that was renamed is not that:
    // it is a change of the folder itself.
    let content_only =
        matches!(event.kind, EventKind::Modify(kind) if !matches!(kind, ModifyKind::Name(_)));
    let matters = event.paths.iter().any(|path| {
        let Some(relative) = bases.iter().find_map(|base| path.strip_prefix(base).ok()) else {
            // A path that does not sit under the root in any spelling we know: a needless rescan
            // is cheaper than a missed change.
            return true;
        };
        filter(relative, &|| match Entry::of(path) {
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

/// Watch the vault and send a hint for every change the filter says matters.
///
/// # Errors
///
/// The watcher could not be created or could not watch the folder.
pub fn start(
    vault: &Path,
    hints: UnboundedSender<Hint>,
    filter: Filter,
) -> notify::Result<Watcher> {
    let root: PathBuf = vault.to_path_buf();
    // The root as it was written, and as the system may report it: FSEvents (macOS) names the real
    // path (`/private/var` for `/var`). Without the second spelling every event would be "not under
    // the root" and the events of `.git` would wake a scan each.
    let mut bases = vec![root.clone()];
    if let Some(real) = root.canonicalize().ok().filter(|real| *real != root) {
        bases.push(real);
    }
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let hint = match result {
            Ok(event) => hint_for(&event, &bases, filter),
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
    use notify::event::{CreateKind, Flag, RemoveKind, RenameMode};

    use super::*;

    /// The rule of a made-up app: a `.rule` file in a folder `rules`, and a folder `rules` itself.
    fn rule_filter(relative: &Path, entry: &dyn Fn() -> Entry) -> bool {
        let parts: Vec<&str> = relative
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect();
        match parts.as_slice() {
            ["rules"] => entry() != Entry::File,
            ["rules", name] => name.ends_with(".rule") || entry() != Entry::File,
            _ => false,
        }
    }

    fn event(kind: EventKind, path: &str) -> Event {
        Event::new(kind).add_path(PathBuf::from("vault").join(path))
    }

    fn bases() -> Vec<PathBuf> {
        vec![PathBuf::from("vault")]
    }

    fn hint(kind: EventKind, path: &str) -> Option<Hint> {
        hint_for(&event(kind, path), &bases(), rule_filter)
    }

    #[test]
    fn a_dropped_event_is_a_lost_one() {
        // inotify and FSEvents say it as an event of its own, with no path.
        let overflow = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert_eq!(
            hint_for(&overflow, &bases(), |_, _| false),
            Some(Hint::Lost)
        );
    }

    #[test]
    fn the_filter_of_the_app_decides_and_a_read_is_not_a_change() {
        assert_eq!(
            hint(EventKind::Create(CreateKind::File), "rules/a.rule"),
            Some(Hint::Changed)
        );
        assert_eq!(
            hint(EventKind::Remove(RemoveKind::File), "rules/a.rule"),
            Some(Hint::Changed)
        );
        assert_eq!(
            hint(
                EventKind::Access(notify::event::AccessKind::Any),
                "rules/a.rule"
            ),
            None
        );
        // What the filter does not name does not matter, whatever the kind.
        assert_eq!(hint(EventKind::Create(CreateKind::Any), ".git/HEAD"), None);
        assert_eq!(
            hint(EventKind::Remove(RemoveKind::Any), "elsewhere/x.rule~"),
            None
        );
    }

    #[test]
    fn the_real_path_of_the_root_is_known_too() {
        // FSEvents reports `/private/var/...` for a vault given as `/var/...`.
        let both = vec![PathBuf::from("vault"), PathBuf::from("real").join("vault")];
        let under_git = Event::new(EventKind::Create(CreateKind::Any)).add_path(
            PathBuf::from("real")
                .join("vault")
                .join(".git")
                .join("HEAD"),
        );
        assert_eq!(hint_for(&under_git, &both, rule_filter), None);
        // A spelling nobody told us of is not told apart: it rescans.
        assert_eq!(
            hint_for(&under_git, &bases(), rule_filter),
            Some(Hint::Changed)
        );
    }

    #[test]
    fn a_folder_that_only_changed_inside_is_not_a_change_of_the_folder() {
        // The folder is real here, so the file system answers `Folder`.
        let dir = std::env::temp_dir().join(format!("appkit-hub-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("rules")).unwrap();
        let modified =
            |kind: ModifyKind| Event::new(EventKind::Modify(kind)).add_path(dir.join("rules"));
        let base = vec![dir.clone()];
        // Windows reports the folder when a file in it changed: the file has its own event.
        assert_eq!(
            hint_for(&modified(ModifyKind::Any), &base, rule_filter),
            None
        );
        // A rename is a change of the folder itself.
        assert_eq!(
            hint_for(
                &modified(ModifyKind::Name(RenameMode::To)),
                &base,
                rule_filter
            ),
            Some(Hint::Changed)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
