//! The one place tests of this workspace get a folder in the temp dir from.
//!
//! A test that makes its own `tasks-desktop-<name>-<pid>` folder and forgets (or panics before) the
//! removal leaves it behind for good: tens of thousands of them filled the temp dir of the machines
//! the tests ran on. A [`Scratch`] is removed when it is dropped, so also when the test fails or
//! panics (the stack unwinds, the value drops). CI counts what is left after the tests
//! (`tools/check-temp-leftovers.mjs`).
//!
//! Declare a `Scratch` before anything that holds files inside it (a spawned hub, an open file): locals
//! drop in reverse order, so the holder is gone when the folder is removed. Windows refuses to remove
//! a folder a running process still has open; the removal retries for a few seconds (a virus scanner
//! may hold a file just as long) and then fails the test loudly, it never leaves the folder silently.

use std::ffi::OsStr;
use std::ops::Deref;
use std::path::Path;
use std::time::Duration;

use tempfile::TempDir;

/// How often and how long the removal tries before it gives up.
const REMOVE_TRIES: u32 = 40;
const REMOVE_PAUSE: Duration = Duration::from_millis(100);

/// A fresh, empty folder in the temp dir, named `tasks-desktop-<name>-<random>`, removed on drop.
/// It derefs to its [`Path`], so `dir.join("file")` and `&dir` where a `&Path` is wanted just work.
#[derive(Debug)]
pub struct Scratch {
    dir: Option<TempDir>,
}

impl Scratch {
    /// A new folder. `name` says what the test uses it for; it is part of the folder's name only.
    pub fn new(name: &str) -> Self {
        let dir = tempfile::Builder::new()
            .prefix(&format!("tasks-desktop-{name}-"))
            .tempdir()
            .unwrap_or_else(|e| panic!("cannot make a scratch folder for {name}: {e}"));
        Self { dir: Some(dir) }
    }

    /// The folder.
    pub fn path(&self) -> &Path {
        self.dir
            .as_ref()
            .expect("a scratch folder lives until it is dropped")
            .path()
    }
}

impl Deref for Scratch {
    type Target = Path;

    fn deref(&self) -> &Path {
        self.path()
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        self.path()
    }
}

impl AsRef<OsStr> for Scratch {
    fn as_ref(&self) -> &OsStr {
        self.path().as_os_str()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let Some(dir) = self.dir.take() else { return };
        let path = dir.path().to_path_buf();
        let mut last = None;
        for _ in 0..REMOVE_TRIES {
            match std::fs::remove_dir_all(&path) {
                Ok(()) => return,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                Err(e) => last = Some(e),
            }
            std::thread::sleep(REMOVE_PAUSE);
        }
        let message = format!(
            "cannot remove the scratch folder {}: {} (a process of the test still holds a file in it?)",
            path.display(),
            last.map(|e| e.to_string()).unwrap_or_default()
        );
        // A panic while the stack already unwinds would abort the test binary and hide the first failure.
        if std::thread::panicking() {
            eprintln!("{message}");
        } else {
            panic!("{message}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_folder_exists_while_held_and_is_gone_after_the_drop() {
        let dir = Scratch::new("scratch-drop");
        let path = dir.to_path_buf();
        std::fs::write(dir.join("file"), "x").unwrap();
        std::fs::create_dir(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested").join("file"), "x").unwrap();
        assert!(path.is_dir());
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("tasks-desktop-scratch-drop-"), "{name}");
        drop(dir);
        assert!(!path.exists(), "{} is left", path.display());
    }

    #[test]
    fn the_folder_is_gone_after_a_panic_too() {
        let path = std::sync::Mutex::new(None);
        let result = std::panic::catch_unwind(|| {
            let dir = Scratch::new("scratch-panic");
            std::fs::write(dir.join("file"), "x").unwrap();
            *path.lock().unwrap() = Some(dir.to_path_buf());
            panic!("the test fails");
        });
        assert!(result.is_err());
        let path = path.lock().unwrap().clone().expect("the closure ran");
        assert!(!path.exists(), "{} is left", path.display());
    }

    #[test]
    fn two_folders_of_one_name_are_two_folders() {
        let a = Scratch::new("scratch-same");
        let b = Scratch::new("scratch-same");
        assert_ne!(a.path(), b.path());
    }
}
