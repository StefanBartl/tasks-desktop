//! The files of the user interface, held in memory.
//!
//! The built UI (`ui/dist`) is read once at start into a table keyed by the
//! name the page asks for. A request is answered from the table or not at
//! all: no path is ever joined and opened per request, so there is nothing
//! to traverse. Package 6 replaces the source of the table with the files
//! embedded in the binary; the table stays.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use axum::body::Bytes;

/// The most one file may be, and all together.
const MAX_FILE: u64 = 4 * 1024 * 1024;
const MAX_TOTAL: u64 = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct UiFile {
    pub bytes: Bytes,
    pub content_type: &'static str,
}

#[derive(Clone, Default)]
pub struct UiFiles {
    files: HashMap<String, UiFile>,
}

impl UiFiles {
    /// No interface: the hub answers with its placeholder page.
    #[must_use]
    pub fn none() -> Self {
        Self::default()
    }

    /// Is there a page to serve?
    #[must_use]
    pub fn has_index(&self) -> bool {
        self.files.contains_key("index.html")
    }

    /// The file for a request path (`/`, `/index.html`, `/assets/x.js`).
    #[must_use]
    pub fn get(&self, request_path: &str) -> Option<&UiFile> {
        let key = match request_path {
            "/" => "index.html",
            other => other.strip_prefix('/')?,
        };
        self.files.get(key)
    }

    /// Read a build folder: `index.html` and the files directly in `assets/`.
    ///
    /// # Errors
    ///
    /// The folder has no `index.html`, or a file cannot be read.
    pub fn load(dir: &Path) -> std::io::Result<Self> {
        let mut files = HashMap::new();
        let mut total = 0u64;
        let mut add = |key: String, path: &Path| -> std::io::Result<()> {
            let Some(content_type) = content_type(path) else {
                return Ok(());
            };
            let meta = std::fs::metadata(path)?;
            if !meta.is_file() || meta.len() > MAX_FILE {
                return Ok(());
            }
            total += meta.len();
            if total > MAX_TOTAL {
                return Err(std::io::Error::other(
                    "the interface is larger than allowed",
                ));
            }
            files.insert(
                key,
                UiFile {
                    bytes: Bytes::from(std::fs::read(path)?),
                    content_type,
                },
            );
            Ok(())
        };
        add("index.html".to_owned(), &dir.join("index.html"))?;
        if let Ok(entries) = std::fs::read_dir(dir.join("assets")) {
            for entry in entries.flatten() {
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if plain_name(&name) {
                    add(format!("assets/{name}"), &entry.path())?;
                }
            }
        }
        if !files.contains_key("index.html") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no index.html in the interface folder",
            ));
        }
        Ok(Self { files })
    }
}

fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn content_type(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => return None,
    })
}

/// Where a built interface may be: the setting, else next to the binary
/// (`ui/`), else the repository's `ui/dist` when run from `target/<profile>`.
#[must_use]
pub fn find_dir(setting: Option<&Path>, exe: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = setting {
        candidates.push(dir.to_path_buf());
    }
    if let Some(exe_dir) = exe.and_then(Path::parent) {
        candidates.push(exe_dir.join("ui"));
        if let Some(root) = exe_dir.parent().and_then(Path::parent) {
            candidates.push(root.join("ui").join("dist"));
        }
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("index.html").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tasks-desktop-ui-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        dir
    }

    #[test]
    fn a_build_is_served_by_name_and_only_by_name() {
        let dir = temp("serve");
        std::fs::write(dir.join("index.html"), "<html></html>").unwrap();
        std::fs::write(dir.join("assets").join("app-1.js"), "x").unwrap();
        std::fs::write(dir.join("assets").join("notes.txt"), "no").unwrap();
        std::fs::write(dir.join("secret.html"), "no").unwrap();
        let ui = UiFiles::load(&dir).unwrap();
        assert!(ui.has_index());
        assert_eq!(
            ui.get("/").unwrap().content_type,
            "text/html; charset=utf-8"
        );
        assert!(ui.get("/index.html").is_some());
        assert!(ui.get("/assets/app-1.js").is_some());
        for no in [
            "/assets/notes.txt",
            "/secret.html",
            "/assets/../index.html",
            "/assets/",
            "/assets",
            "/..",
            "assets/app-1.js",
        ] {
            assert!(ui.get(no).is_none(), "{no}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_without_an_index_is_an_error() {
        let dir = temp("empty");
        assert!(UiFiles::load(&dir).is_err());
        assert!(!UiFiles::none().has_index());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_are_plain() {
        for ok in ["a.js", "index-C2Rauptk.js", "x_y-1.css"] {
            assert!(plain_name(ok), "{ok}");
        }
        for bad in ["", ".hidden", "a b.js", "a/b.js", "a\\b.js", "a%2e.js"] {
            assert!(!plain_name(bad), "{bad}");
        }
    }
}
