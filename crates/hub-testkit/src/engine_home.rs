//! A cache folder of its own for the real engine of a test.
//!
//! Neovim keeps its cache (`stdpath("cache")`) in `$TEMP/nvim` on Windows and in `~/.cache/nvim`
//! elsewhere, and lib.nvim makes the checkpoints of a move below it (`nvim/lib.nvim/checkpoints`).
//! Tests that run at once share that folder. On a fresh runner it does not exist yet, several engine
//! processes make it in the same moment, and the one that loses gets `E739 ... file already exists`
//! (lib.nvim's `mkdir_p` tries a second time only): the move answers `io` and the test is red by
//! chance. Measured 2026-10-30 with lib.nvim 5a4444d: 24 processes that make the same chain at once,
//! 183 of 360 makes failed. With a folder of its own per test there is no one to race with.

use std::path::{Path, PathBuf};

use tasks_hub::config::Env;

/// The process environment with the folders Neovim's cache is found from moved into `home`: the
/// temp folder (`TEMP`, `TMP`, `TMPDIR`: the cache on Windows) and, off Windows, `HOME` (the cache is
/// `~/.cache` there). `HOME` stays on Windows, where it is not the cache and git reads its settings
/// from it. Give it to the engine only, not to the discovery: the setup is found as everywhere else.
///
/// `home` must not be inside the vault: the checkpoints written there would reach the watcher.
pub fn engine_env(home: &Path) -> Env {
    let temp = temp_of(home);
    std::fs::create_dir_all(&temp)
        .unwrap_or_else(|e| panic!("cannot make {}: {e}", temp.display()));
    let mut moved: Vec<(&str, PathBuf)> = vec![
        ("TEMP", temp.clone()),
        ("TMP", temp.clone()),
        ("TMPDIR", temp),
    ];
    if !cfg!(windows) {
        moved.push(("HOME", home.to_path_buf()));
    }
    let mut vars: Vec<(String, std::ffi::OsString)> = std::env::vars_os()
        .filter_map(|(k, v)| k.into_string().ok().map(|k| (k, v)))
        .filter(|(k, _)| !moved.iter().any(|(m, _)| m.eq_ignore_ascii_case(k)))
        .collect();
    vars.extend(moved.into_iter().map(|(k, v)| (k.to_owned(), v.into())));
    Env::from_pairs(vars)
}

/// The temp folder the engine gets in `home`.
pub fn temp_of(home: &Path) -> PathBuf {
    home.join("tmp")
}

/// Where the engine's Neovim keeps its cache with [`engine_env`]`(home)`.
pub fn cache_of(home: &Path) -> PathBuf {
    if cfg!(windows) {
        temp_of(home).join("nvim")
    } else {
        home.join(".cache").join("nvim")
    }
}
