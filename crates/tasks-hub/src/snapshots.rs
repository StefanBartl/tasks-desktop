//! The text snapshots of the test sheets (testing.nvim): read-only files of the plugin checkouts next to the vault.
//!
//! A task's sheet block names them as `<repo>/TESTS/__snapshots__/<path>.snap`. The page never sends a real path:
//! it sends that name, and the hub resolves it under the folder of the checkouts (`REPOS_DIR`) after it has kept
//! everything else out.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// The most bytes of a snapshot the hub answers with (a screen grid is a few kilobytes).
pub const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024;

/// Resolve `name` (`<repo>/TESTS/__snapshots__/<path>.snap`) under `root` and read it.
///
/// # Errors
///
/// A short reason, no path.
pub fn read_snapshot(root: &Path, name: &str) -> Result<String, &'static str> {
    let relative = checked_name(name)?;
    let joined = root.join(&relative);
    let meta = std::fs::symlink_metadata(&joined).map_err(|_| "the snapshot is not there")?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("the snapshot is not a plain file");
    }
    let real = joined
        .canonicalize()
        .map_err(|_| "the snapshot is not there")?;
    let base = root
        .canonicalize()
        .map_err(|_| "the folder of the checkouts is not there")?;
    if !real.starts_with(&base) {
        return Err("the snapshot lies outside the checkouts");
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&real)
        .and_then(|file| file.take(MAX_SNAPSHOT_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| "the snapshot could not be read")?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err("the snapshot is too large");
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The relative path of a snapshot name, or why the name is none: `<repo>/TESTS/__snapshots__/...<name>.snap`, plain
/// components only.
fn checked_name(name: &str) -> Result<PathBuf, &'static str> {
    if name.is_empty() || name.len() > 400 || name.contains('\\') || name.contains('\0') {
        return Err("not a snapshot name");
    }
    let relative = Path::new(name);
    let parts: Vec<&str> = name.split('/').collect();
    let plain = relative
        .components()
        .all(|c| matches!(c, Component::Normal(_)));
    if !plain
        || parts.len() < 4
        || parts
            .iter()
            .any(|p| p.is_empty() || p.starts_with('.') || p.contains(':'))
        || crate::config::valid_area_name(parts[0]).is_err()
        || parts[1] != "TESTS"
        || parts[2] != "__snapshots__"
        || !name.ends_with(".snap")
    {
        return Err("not a snapshot name");
    }
    Ok(relative.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rig(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tasks-hub-snap-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let snap = dir.join("ui.nvim/TESTS/__snapshots__/sheets/a.sheet");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("float.80x24.snap"), "row one\nrow two\n").unwrap();
        std::fs::write(dir.join("secret.snap"), "no").unwrap();
        std::fs::write(dir.join("ui.nvim/TESTS/other.snap"), "no").unwrap();
        std::fs::create_dir_all(dir.join("ui.nvim/TESTS/fixtures/deep")).unwrap();
        std::fs::write(dir.join("ui.nvim/TESTS/fixtures/deep/a.snap"), "no").unwrap();
        dir
    }

    #[test]
    fn a_snapshot_of_a_checkout_is_read() {
        let dir = rig("ok");
        let text = read_snapshot(
            &dir,
            "ui.nvim/TESTS/__snapshots__/sheets/a.sheet/float.80x24.snap",
        );
        assert_eq!(text.as_deref(), Ok("row one\nrow two\n"));
    }

    #[test]
    fn a_name_that_climbs_or_leaves_the_snapshot_folder_is_refused() {
        let dir = rig("refuse");
        for bad in [
            "",
            "../secret.snap",
            "ui.nvim/TESTS/__snapshots__/../../../secret.snap",
            "ui.nvim/TESTS/other.snap",
            "ui.nvim/TESTS/fixtures/deep/a.snap",
            "ui.nvim/src/__snapshots__/x/a.snap",
            "/etc/passwd.snap",
            "C:/x/TESTS/__snapshots__/a.snap",
            "ui.nvim\\TESTS\\__snapshots__\\a.snap",
            "ui.nvim/TESTS/__snapshots__/sheets/a.sheet/float.80x24.txt",
            ".git/TESTS/__snapshots__/x/a.snap",
            "ui.nvim/TESTS/__snapshots__/.hidden/a.snap",
        ] {
            assert!(read_snapshot(&dir, bad).is_err(), "{bad:?} was read");
        }
    }

    #[test]
    fn a_missing_or_huge_snapshot_is_refused() {
        let dir = rig("size");
        assert_eq!(
            read_snapshot(&dir, "ui.nvim/TESTS/__snapshots__/sheets/a.sheet/none.snap"),
            Err("the snapshot is not there")
        );
        let big = dir.join("ui.nvim/TESTS/__snapshots__/sheets/a.sheet/big.snap");
        std::fs::write(&big, vec![b'x'; (MAX_SNAPSHOT_BYTES + 1) as usize]).unwrap();
        assert_eq!(
            read_snapshot(&dir, "ui.nvim/TESTS/__snapshots__/sheets/a.sheet/big.snap"),
            Err("the snapshot is too large")
        );
    }
}
