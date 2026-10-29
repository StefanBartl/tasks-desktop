//! Making a new, empty vault: a folder with one area that has the folders the engine looks for.
//!
//! The page asks for a folder it has shown to the person, with a confirmation (the route checks that). This is the
//! part that touches the disk, so it is strict: an absolute path without `..`, a parent that exists, and a target that
//! does not exist yet or is an empty folder. Nothing that is already there is written over or merged into.

use std::path::{Component, Path};

use crate::config::valid_area_name;

/// Why a vault was not made: a short code for the page and a text without a path.
#[derive(Debug, PartialEq, Eq)]
pub struct Refused {
    pub code: &'static str,
    pub why: &'static str,
}

const fn refused(code: &'static str, why: &'static str) -> Refused {
    Refused { code, why }
}

/// Make `path` a vault with one `area` (`<path>/<area>/ROADMAP/tasks`).
///
/// # Errors
///
/// [`Refused`] when the path or the area is not acceptable, the folder is not empty, or the disk says no.
pub fn create(path: &Path, area: &str) -> Result<(), Refused> {
    if valid_area_name(area).is_err() {
        return Err(refused("bad_area", "the area is not a plain name"));
    }
    let plain = path.components().all(|c| {
        matches!(
            c,
            Component::Prefix(_) | Component::RootDir | Component::Normal(_)
        )
    });
    if !path.is_absolute() || !plain {
        return Err(refused(
            "bad_path",
            "the folder must be an absolute path without . or ..",
        ));
    }
    if !path.parent().is_some_and(Path::is_dir) {
        return Err(refused("no_parent", "the folder above it does not exist"));
    }
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            let empty = std::fs::read_dir(path)
                .map_err(|_| refused("not_readable", "the folder cannot be read"))?
                .next()
                .is_none();
            // What an earlier try left (the page makes the folder, then remembers it; a refusal of the second step
            // must not lock the person out of the same folder): the same bare structure is taken as it is.
            if !empty && is_bare_vault(path, area) {
                return Ok(());
            }
            if !empty {
                return Err(refused("not_empty", "the folder is not empty"));
            }
        }
        Ok(_) => return Err(refused("exists", "something is there already")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(refused("not_readable", "the folder cannot be read")),
    }
    std::fs::create_dir_all(path.join(area).join("ROADMAP").join("tasks"))
        .map_err(|_| refused("not_writable", "the folders could not be made"))
}

/// Is `dir` a plain folder that holds exactly one plain folder called `name`, and nothing else? Gives that folder.
fn only_folder(dir: &Path, name: &str) -> Option<std::path::PathBuf> {
    let mut entries = std::fs::read_dir(dir).ok()?;
    let entry = entries.next()?.ok()?;
    if entries.next().is_some() || entry.file_name() != name {
        return None;
    }
    let kind = entry.file_type().ok()?;
    (kind.is_dir() && !kind.is_symlink()).then(|| entry.path())
}

/// Does `path` hold exactly `<area>/ROADMAP/tasks`, with nothing in the last one?
fn is_bare_vault(path: &Path, area: &str) -> bool {
    let tasks = only_folder(path, area)
        .and_then(|a| only_folder(&a, "ROADMAP"))
        .and_then(|r| only_folder(&r, "tasks"));
    tasks.is_some_and(|t| std::fs::read_dir(t).is_ok_and(|mut d| d.next().is_none()))
}

#[cfg(test)]
mod tests {
    use hub_testkit::scratch::Scratch;

    use super::*;

    /// A folder of its own, removed when the value drops.
    fn scratch(name: &str) -> Scratch {
        Scratch::new(&format!("newvault-{name}"))
    }

    #[test]
    fn a_new_folder_gets_the_structure_the_engine_looks_for() {
        let base = scratch("new");
        let vault = base.join("v");
        create(&vault, "alpha.nvim").unwrap();
        assert!(vault.join("alpha.nvim/ROADMAP/tasks").is_dir());
    }

    #[test]
    fn an_empty_folder_is_taken_a_full_one_is_not() {
        let base = scratch("full");
        let empty = base.join("empty");
        std::fs::create_dir(&empty).unwrap();
        create(&empty, "a").unwrap();
        let full = base.join("full");
        std::fs::create_dir(&full).unwrap();
        std::fs::write(full.join("x.md"), "x").unwrap();
        assert_eq!(create(&full, "a").unwrap_err().code, "not_empty");
        assert!(!full.join("a").exists());
        let file = base.join("file");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(create(&file, "a").unwrap_err().code, "exists");
    }

    #[test]
    fn the_folder_an_earlier_try_made_is_taken_again_but_nothing_else_that_is_there() {
        let base = scratch("again");
        let vault = base.join("v");
        create(&vault, "a").unwrap();
        // The same area again: the second step of the page may have been refused, and the person tries once more.
        create(&vault, "a").unwrap();
        // Another area, or a task in it, is something that is there.
        assert_eq!(create(&vault, "b").unwrap_err().code, "not_empty");
        std::fs::write(vault.join("a/ROADMAP/tasks/t.md"), "x").unwrap();
        assert_eq!(create(&vault, "a").unwrap_err().code, "not_empty");
    }

    #[test]
    fn paths_and_areas_that_are_not_plain_are_refused() {
        let base = scratch("bad");
        assert_eq!(
            create(Path::new("relative/v"), "a").unwrap_err().code,
            "bad_path"
        );
        assert_eq!(
            create(&base.join("..").join("v"), "a").unwrap_err().code,
            "bad_path"
        );
        assert_eq!(
            create(&base.join("no").join("v"), "a").unwrap_err().code,
            "no_parent"
        );
        for area in ["", "..", "a/b", "a\\b", ".hidden"] {
            assert_eq!(
                create(&base.join("v"), area).unwrap_err().code,
                "bad_area",
                "{area:?}"
            );
        }
        assert!(!base.join("v").exists());
    }
}
