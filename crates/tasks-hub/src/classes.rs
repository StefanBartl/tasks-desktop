//! Data classes of the areas, per device (concept 5.7, decision 13.6).
//!
//! `areas.json` lives in the app's config folder, not in the vault: the vault
//! is synced and changed by pull requests, and a release written there could
//! be set by a third party. **Fail closed:** an area without an entry is
//! "unclassified", and an unclassified area is not released for anything
//! that leaves the hub (another panel, a cloud runner). It is still shown to
//! the user, marked as unclassified.
//!
//! ```json
//! { "schema": 1,
//!   "default": "internal",
//!   "areas": { "lib.nvim": { "class": "internal", "repo": "lib.nvim" },
//!              "secret-area": { "class": "private" } } }
//! ```
//!
//! `default` is optional and is the owner's explicit choice of a class for
//! every area the file does not name (a new area needs no decision then).
//! Without it an area with no entry stays unclassified.
//!
//! That is schema 1, and it holds the entries of the vault `main`. The hub reads
//! several vaults, one at a time, and two of them may have an area of the same
//! name: schema 2 keys an entry by `<vault>:<area>`, so each vault has its own
//! (a vault without an entry for an area has it unclassified, never "as in main"):
//!
//! ```json
//! { "schema": 2,
//!   "vaults": { "work": { "default": "internal" } },
//!   "areas": { "main:lib.nvim": { "class": "internal" },
//!              "work:lib.nvim": { "class": "private" } } }
//! ```

use std::collections::BTreeMap;
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::{valid_area_name, valid_vault_name as vault_name_of_list, MAIN_VAULT};

/// The class of an area.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    /// May leave the hub, e.g. into a public report.
    Public,
    /// Mine and not secret: may go to another panel of the same user, to a
    /// cloud runner after a consent (the consent is not in this crate yet).
    Internal,
    /// Never leaves the hub: not to another panel, not to a cloud runner,
    /// not into a cache of the client, not with a title into a log.
    Private,
}

/// What an area may be used for. Showing it to the user on this machine is
/// always allowed and is not a use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Use {
    /// An answer for another panel of the app.
    CrossPanel,
    /// A prompt that goes to a runner outside this machine.
    CloudRunner,
    /// Kept by the client in a cache that outlives the session.
    ClientCache,
}

/// The class an area is shown with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Shown {
    Public,
    Internal,
    Private,
    Unclassified,
}

/// One entry of the file.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub class: Class,
    /// The repository folder of the area (they are not named alike:
    /// `wkdbook-tasks.nvim` is `tasks.nvim`). Optional, a plain name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct File {
    schema: u32,
    /// The class of an area that has no entry (the owner's explicit choice).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default: Option<Class>,
    areas: BTreeMap<String, Entry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FileV2 {
    schema: u32,
    /// What a vault decides for all of its areas that have no entry.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    vaults: BTreeMap<String, VaultRule>,
    /// Keys are `<vault>:<area>`.
    areas: BTreeMap<String, Entry>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct VaultRule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default: Option<Class>,
}

/// Which schema a file says it has.
#[derive(Deserialize)]
struct Peek {
    schema: u32,
}

/// The schema of `areas.json` that only knows the vault `main`.
pub const SCHEMA: u32 = 1;
/// The schema whose keys are `<vault>:<area>`.
pub const SCHEMA_VAULTS: u32 = 2;

/// The most areas a file may name; a vault has about fifty.
const MAX_AREAS: usize = 1000;
/// The largest file that is read.
const MAX_FILE_BYTES: u64 = 256 * 1024;

/// What is known about the areas of this device.
#[derive(Debug, Clone, Default)]
pub struct AreaPolicy {
    areas: BTreeMap<String, Entry>,
    default: Option<Class>,
}

/// Why `areas.json` is not usable. The hub does not start with a file it
/// cannot read: a typo must not turn into "everything unclassified" unseen.
#[derive(Debug)]
pub enum ClassesError {
    Unreadable(PathBuf, std::io::Error),
    Invalid(PathBuf, String),
}

impl fmt::Display for ClassesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable(p, e) => write!(f, "cannot read {}: {e}", p.display()),
            Self::Invalid(p, e) => write!(f, "invalid {}: {e}", p.display()),
        }
    }
}

impl std::error::Error for ClassesError {}

/// The path of the active file in a config folder.
#[must_use]
pub fn path(dir: &Path) -> PathBuf {
    dir.join("areas.json")
}

/// The path of the proposal (never read by the hub).
#[must_use]
pub fn proposal_path(dir: &Path) -> PathBuf {
    dir.join("areas.proposed.json")
}

/// A vault of the file: `main`, or a name the list of vaults accepts (that list refuses `main` for an added one).
fn known_vault_name(name: &str) -> Result<(), &'static str> {
    if name == MAIN_VAULT {
        Ok(())
    } else {
        vault_name_of_list(name)
    }
}

fn plain_repo_name(name: &str) -> bool {
    valid_area_name(name).is_ok()
}

/// What `areas.json` says for every vault: one [`AreaPolicy`] each.
#[derive(Debug, Clone)]
pub struct Classes {
    vaults: BTreeMap<String, AreaPolicy>,
    /// The file is of schema 1 (or there is none): it can be written the same way.
    plain: bool,
}

/// No file: nothing is classified, and a proposal is written the way schema 1 is.
impl Default for Classes {
    fn default() -> Self {
        Self {
            vaults: BTreeMap::new(),
            plain: true,
        }
    }
}

impl Classes {
    /// Load `areas.json` from the config folder. No file classifies nothing.
    ///
    /// # Errors
    ///
    /// [`ClassesError`] for a file that exists and cannot be used.
    pub fn load(dir: &Path) -> Result<Self, ClassesError> {
        let file_path = path(dir);
        let file = match std::fs::File::open(&file_path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(ClassesError::Unreadable(file_path, e)),
        };
        let mut text = String::new();
        if let Err(e) = file.take(MAX_FILE_BYTES + 1).read_to_string(&mut text) {
            return Err(ClassesError::Unreadable(file_path, e));
        }
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(ClassesError::Invalid(
                file_path,
                format!("larger than {} KiB", MAX_FILE_BYTES / 1024),
            ));
        }
        let invalid = |why: String| ClassesError::Invalid(file_path.clone(), why);
        let peek: Peek = serde_json::from_str(&text).map_err(|e| invalid(e.to_string()))?;
        match peek.schema {
            SCHEMA => {
                let parsed: File =
                    serde_json::from_str(&text).map_err(|e| invalid(e.to_string()))?;
                let policy = AreaPolicy::new(parsed.areas)
                    .map(|p| p.with_default(parsed.default))
                    .map_err(invalid)?;
                Ok(Self {
                    vaults: BTreeMap::from([(MAIN_VAULT.to_owned(), policy)]),
                    plain: true,
                })
            }
            SCHEMA_VAULTS => Self::from_v2(&text, &invalid),
            other => Err(invalid(format!(
                "schema {other} is not {SCHEMA} or {SCHEMA_VAULTS}"
            ))),
        }
    }

    fn from_v2(text: &str, invalid: &dyn Fn(String) -> ClassesError) -> Result<Self, ClassesError> {
        let parsed: FileV2 = serde_json::from_str(text).map_err(|e| invalid(e.to_string()))?;
        if parsed.areas.len() > MAX_AREAS {
            return Err(invalid(format!("more than {MAX_AREAS} areas")));
        }
        let vault_name = |vault: &str| {
            known_vault_name(vault).map_err(|why| invalid(format!("vault {vault:?}: {why}")))
        };
        let mut grouped: BTreeMap<String, BTreeMap<String, Entry>> = BTreeMap::new();
        for vault in parsed.vaults.keys() {
            vault_name(vault)?;
            grouped.entry(vault.clone()).or_default();
        }
        for (key, entry) in parsed.areas {
            let Some((vault, area)) = key.split_once(':') else {
                return Err(invalid(format!("key {key:?} is not <vault>:<area>")));
            };
            vault_name(vault)?;
            grouped
                .entry(vault.to_owned())
                .or_default()
                .insert(area.to_owned(), entry);
        }
        let mut vaults = BTreeMap::new();
        for (vault, areas) in grouped {
            let default = parsed.vaults.get(&vault).and_then(|r| r.default);
            let policy = AreaPolicy::new(areas)
                .map(|p| p.with_default(default))
                .map_err(|why| invalid(format!("vault {vault:?}: {why}")))?;
            vaults.insert(vault, policy);
        }
        Ok(Self {
            vaults,
            plain: false,
        })
    }

    /// The classes of one vault. A vault the file does not name classifies nothing.
    #[must_use]
    pub fn for_vault(&self, vault: &str) -> AreaPolicy {
        self.vaults.get(vault).cloned().unwrap_or_default()
    }
}

impl AreaPolicy {
    /// Build a policy from entries, checking every name.
    ///
    /// # Errors
    ///
    /// The reason for the first name that is not acceptable.
    pub fn new(areas: BTreeMap<String, Entry>) -> Result<Self, String> {
        if areas.len() > MAX_AREAS {
            return Err(format!("more than {MAX_AREAS} areas"));
        }
        for (name, entry) in &areas {
            valid_area_name(name).map_err(|why| format!("area {name:?}: {why}"))?;
            let bad_repo = entry.repo.as_deref().filter(|r| !plain_repo_name(r));
            if let Some(repo) = bad_repo {
                return Err(format!("area {name:?}: repo {repo:?} is not a plain name"));
            }
        }
        Ok(Self {
            areas,
            default: None,
        })
    }

    /// The class of an area the entries do not name. `None` keeps such an
    /// area unclassified.
    #[must_use]
    pub fn with_default(mut self, default: Option<Class>) -> Self {
        self.default = default;
        self
    }

    /// Load `areas.json` from the config folder: the classes of the vault `main`. No file is a policy in
    /// which nothing is classified.
    ///
    /// # Errors
    ///
    /// [`ClassesError`] for a file that exists and cannot be used.
    pub fn load(dir: &Path) -> Result<Self, ClassesError> {
        Classes::load(dir).map(|c| c.for_vault(MAIN_VAULT))
    }

    /// The class an area is shown with.
    #[must_use]
    pub fn shown(&self, area: &str) -> Shown {
        match self.areas.get(area).map(|e| e.class).or(self.default) {
            Some(Class::Public) => Shown::Public,
            Some(Class::Internal) => Shown::Internal,
            Some(Class::Private) => Shown::Private,
            None => Shown::Unclassified,
        }
    }

    /// May the area be used for this? An unclassified area may not: nothing
    /// is released until somebody said so.
    #[must_use]
    pub fn allows(&self, area: &str, usage: Use) -> bool {
        // Today every use has the same rule. The parameter is there so a
        // caller says what it wants, and a later rule can tell the uses apart.
        let _ = usage;
        matches!(self.shown(area), Shown::Public | Shown::Internal)
    }

    /// The entry of an area, if the file has one.
    #[must_use]
    pub fn entry(&self, area: &str) -> Option<&Entry> {
        self.areas.get(area)
    }

    /// The repository folder named for an area, if the file says one.
    #[must_use]
    pub fn repo_of(&self, area: &str) -> Option<&str> {
        self.areas.get(area)?.repo.as_deref()
    }

    /// The areas of `all` that are private.
    #[must_use]
    pub fn private_areas<'a>(&self, all: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
        all.into_iter()
            .filter(|a| self.shown(a) == Shown::Private)
            .collect()
    }

    /// The areas of `all` that have no entry.
    #[must_use]
    pub fn unclassified<'a>(&self, all: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
        all.into_iter()
            .filter(|a| self.shown(a) == Shown::Unclassified)
            .collect()
    }

    /// How many entries the file has.
    #[must_use]
    pub fn len(&self) -> usize {
        self.areas.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.areas.is_empty()
    }
}

/// The text of a proposal. What `existing` already says is kept as it is: a
/// proposal that turned a private area back into `internal` would, once
/// somebody renames it to `areas.json` without reading it, release the
/// area. An area that is new gets `internal` (or `private` when it is in
/// `private`, which wins over `existing` too) and the repository that
/// carries its name (or the name without a `wkdbook-` prefix) when
/// `repo_exists` says it is there. The result is a *proposal for a person
/// to read*: it is written next to the real file, not as the real file.
///
/// # Errors
///
/// The reason when a name is not acceptable.
pub fn propose<'a>(
    areas: impl IntoIterator<Item = &'a str>,
    private: &[String],
    existing: &AreaPolicy,
    repo_exists: &dyn Fn(&str) -> bool,
) -> Result<String, String> {
    let map = proposal_map(areas, private, existing, repo_exists)?;
    render(&File {
        schema: SCHEMA,
        default: existing.default,
        areas: map,
    })
}

/// [`propose`] for the vault `vault` of a file that may know several: the entries of the other vaults stay as they
/// are. A file of schema 1 (or none) for the vault `main` is written the same way as before; in any other case the
/// proposal is of schema 2.
///
/// # Errors
///
/// The reason when a name is not acceptable.
pub fn propose_in<'a>(
    vault: &str,
    areas: impl IntoIterator<Item = &'a str>,
    private: &[String],
    classes: &Classes,
    repo_exists: &dyn Fn(&str) -> bool,
) -> Result<String, String> {
    known_vault_name(vault).map_err(|why| format!("vault {vault:?}: {why}"))?;
    let existing = classes.for_vault(vault);
    if classes.plain && vault == MAIN_VAULT {
        return propose(areas, private, &existing, repo_exists);
    }
    let map = proposal_map(areas, private, &existing, repo_exists)?;
    let mut keyed = BTreeMap::new();
    let mut rules = BTreeMap::new();
    for (other, policy) in &classes.vaults {
        if other == vault {
            continue;
        }
        for (area, entry) in &policy.areas {
            keyed.insert(format!("{other}:{area}"), entry.clone());
        }
        if policy.default.is_some() {
            rules.insert(
                other.clone(),
                VaultRule {
                    default: policy.default,
                },
            );
        }
    }
    for (area, entry) in map {
        keyed.insert(format!("{vault}:{area}"), entry);
    }
    if existing.default.is_some() {
        rules.insert(
            vault.to_owned(),
            VaultRule {
                default: existing.default,
            },
        );
    }
    render(&FileV2 {
        schema: SCHEMA_VAULTS,
        vaults: rules,
        areas: keyed,
    })
}

fn render<T: Serialize>(file: &T) -> Result<String, String> {
    serde_json::to_string_pretty(file)
        .map(|t| format!("{t}\n"))
        .map_err(|e| e.to_string())
}

fn proposal_map<'a>(
    areas: impl IntoIterator<Item = &'a str>,
    private: &[String],
    existing: &AreaPolicy,
    repo_exists: &dyn Fn(&str) -> bool,
) -> Result<BTreeMap<String, Entry>, String> {
    let mut map = BTreeMap::new();
    for name in areas {
        let forced_private = private.iter().any(|p| p == name);
        let old = existing.entry(name);
        let guess = || {
            [Some(name), name.strip_prefix("wkdbook-")]
                .into_iter()
                .flatten()
                .find(|c| plain_repo_name(c) && repo_exists(c))
                .map(str::to_owned)
        };
        let entry = match (old, forced_private) {
            (Some(old), false) => old.clone(),
            (Some(old), true) => Entry {
                class: Class::Private,
                repo: old.repo.clone().or_else(guess),
            },
            (None, forced) => Entry {
                class: if forced {
                    Class::Private
                } else {
                    Class::Internal
                },
                repo: guess(),
            },
        };
        map.insert(name.to_owned(), entry);
    }
    // The same checks as for a file that is loaded.
    AreaPolicy::new(map.clone())?;
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str, text: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tasks-desktop-classes-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(path(&dir), text).unwrap();
        dir
    }

    const GOOD: &str = r#"{"schema":1,"areas":{
        "alpha.nvim":{"class":"internal","repo":"alpha.nvim"},
        "pub-area":{"class":"public"},
        "secret-area":{"class":"private"}}}"#;

    #[test]
    fn a_missing_file_classifies_nothing() {
        let dir = std::env::temp_dir().join("tasks-desktop-classes-none");
        let policy = AreaPolicy::load(&dir).unwrap();
        assert!(policy.is_empty());
        assert_eq!(policy.shown("anything"), Shown::Unclassified);
    }

    #[test]
    fn a_default_class_covers_the_areas_without_an_entry() {
        let text = r#"{"schema":1,"default":"internal",
            "areas":{"secret-area":{"class":"private"}}}"#;
        let policy = AreaPolicy::load(&temp("default", text)).unwrap();
        assert_eq!(policy.shown("anything"), Shown::Internal);
        assert!(policy.allows("anything", Use::ClientCache));
        // An entry wins over the default, in both directions.
        assert_eq!(policy.shown("secret-area"), Shown::Private);
        assert!(!policy.allows("secret-area", Use::ClientCache));
        assert!(policy.unclassified(["anything", "x"]).is_empty());
        // A proposal keeps the choice.
        let out = propose(["anything"], &[], &policy, &|_| false).unwrap();
        assert!(out.contains("\"default\": \"internal\""), "{out}");
    }

    #[test]
    fn unclassified_and_private_leave_nothing() {
        let policy = AreaPolicy::load(&temp("good", GOOD)).unwrap();
        for usage in [Use::CrossPanel, Use::CloudRunner, Use::ClientCache] {
            assert!(policy.allows("alpha.nvim", usage));
            assert!(policy.allows("pub-area", usage));
            assert!(!policy.allows("secret-area", usage), "private {usage:?}");
            assert!(
                !policy.allows("never-heard-of", usage),
                "unclassified {usage:?}"
            );
        }
    }

    #[test]
    fn a_new_area_is_marked_unclassified() {
        let policy = AreaPolicy::load(&temp("new", GOOD)).unwrap();
        let all = ["alpha.nvim", "secret-area", "brand-new.nvim"];
        assert_eq!(policy.unclassified(all), ["brand-new.nvim"]);
        assert_eq!(policy.private_areas(all), ["secret-area"]);
        assert_eq!(policy.repo_of("alpha.nvim"), Some("alpha.nvim"));
        assert_eq!(policy.repo_of("pub-area"), None);
    }

    #[test]
    fn a_file_that_is_not_right_is_refused() {
        for (name, text) in [
            ("typo", r#"{"schema":1,"areas":{"a":{"clas":"private"}}}"#),
            ("class", r#"{"schema":1,"areas":{"a":{"class":"secret"}}}"#),
            ("schema", r#"{"schema":3,"areas":{}}"#),
            ("extra", r#"{"schema":1,"areas":{},"more":1}"#),
            (
                "traversal",
                r#"{"schema":1,"areas":{"../x":{"class":"private"}}}"#,
            ),
            (
                "repo",
                r#"{"schema":1,"areas":{"a":{"class":"public","repo":"../x"}}}"#,
            ),
            ("json", "{"),
        ] {
            let got = AreaPolicy::load(&temp(name, text));
            assert!(
                matches!(got, Err(ClassesError::Invalid(..))),
                "{name}: {got:?}"
            );
        }
    }

    #[test]
    fn a_huge_file_is_refused() {
        let mut text = String::from(r#"{"schema":1,"areas":{"#);
        for i in 0..20_000 {
            text.push_str(&format!(r#""area{i}":{{"class":"public"}},"#));
        }
        text.push_str(r#""z":{"class":"public"}}}"#);
        let got = AreaPolicy::load(&temp("huge", &text));
        assert!(matches!(got, Err(ClassesError::Invalid(..))), "{got:?}");
    }

    #[test]
    fn a_proposal_round_trips_through_the_loader() {
        let exists = |c: &str| c == "tasks.nvim" || c == "lib.nvim";
        let text = propose(
            ["lib.nvim", "wkdbook-tasks.nvim", "secret-area", "other"],
            &["secret-area".to_owned()],
            &AreaPolicy::default(),
            &exists,
        )
        .unwrap();
        let dir = temp("proposal", &text);
        let policy = AreaPolicy::load(&dir).unwrap();
        assert_eq!(policy.shown("secret-area"), Shown::Private);
        assert_eq!(policy.shown("other"), Shown::Internal);
        assert_eq!(policy.repo_of("lib.nvim"), Some("lib.nvim"));
        assert_eq!(policy.repo_of("wkdbook-tasks.nvim"), Some("tasks.nvim"));
        assert_eq!(policy.repo_of("other"), None);
    }

    #[test]
    fn a_proposal_keeps_what_was_decided() {
        // A person made `secret-area` private and `open-area` public. A new
        // proposal must not turn either back into `internal`.
        let existing = AreaPolicy::load(&temp(
            "decided",
            r#"{"schema":1,"areas":{
                "secret-area":{"class":"private","repo":"secret-repo"},
                "open-area":{"class":"public"}}}"#,
        ))
        .unwrap();
        let text = propose(
            ["secret-area", "open-area", "fresh-area"],
            &[],
            &existing,
            &|_| false,
        )
        .unwrap();
        let policy = AreaPolicy::load(&temp("decided-out", &text)).unwrap();
        assert_eq!(policy.shown("secret-area"), Shown::Private);
        assert_eq!(policy.repo_of("secret-area"), Some("secret-repo"));
        assert_eq!(policy.shown("open-area"), Shown::Public);
        assert_eq!(policy.shown("fresh-area"), Shown::Internal);
        // An explicit --private wins over the file, never the other way.
        let text = propose(["open-area"], &["open-area".to_owned()], &existing, &|_| {
            false
        })
        .unwrap();
        let policy = AreaPolicy::load(&temp("decided-forced", &text)).unwrap();
        assert_eq!(policy.shown("open-area"), Shown::Private);
    }

    const TWO: &str = r#"{"schema":2,
        "vaults":{"work":{"default":"internal"}},
        "areas":{
            "main:shared.nvim":{"class":"public"},
            "work:shared.nvim":{"class":"private"},
            "work:only-work":{"class":"internal","repo":"w"}}}"#;

    #[test]
    fn schema_two_keeps_a_class_for_each_vault_even_for_the_same_area_name() {
        let classes = Classes::load(&temp("two", TWO)).unwrap();
        let main = classes.for_vault("main");
        let work = classes.for_vault("work");
        // The same name, a class in each: this is what one table by name could not say.
        assert_eq!(main.shown("shared.nvim"), Shown::Public);
        assert_eq!(work.shown("shared.nvim"), Shown::Private);
        // An area of one vault is nothing in the other, and a vault's default is its own.
        assert_eq!(main.shown("only-work"), Shown::Unclassified);
        assert_eq!(work.shown("only-work"), Shown::Internal);
        assert_eq!(work.shown("anything"), Shown::Internal);
        assert_eq!(main.shown("anything"), Shown::Unclassified);
        assert_eq!(work.repo_of("only-work"), Some("w"));
        // A vault the file does not name classifies nothing: it does not take over `main`.
        let other = classes.for_vault("third");
        assert!(other.is_empty());
        assert_eq!(other.shown("shared.nvim"), Shown::Unclassified);
    }

    #[test]
    fn schema_one_is_the_vault_main_and_nothing_else() {
        let classes = Classes::load(&temp("one", GOOD)).unwrap();
        assert_eq!(
            classes.for_vault("main").shown("secret-area"),
            Shown::Private
        );
        assert_eq!(
            classes.for_vault("work").shown("secret-area"),
            Shown::Unclassified
        );
        assert_eq!(
            AreaPolicy::load(&temp("one-load", GOOD))
                .unwrap()
                .shown("alpha.nvim"),
            Shown::Internal
        );
    }

    #[test]
    fn a_schema_two_file_that_is_not_right_is_refused() {
        for (name, text) in [
            (
                "nokey",
                r#"{"schema":2,"areas":{"plain":{"class":"public"}}}"#,
            ),
            (
                "novault",
                r#"{"schema":2,"areas":{":a":{"class":"public"}}}"#,
            ),
            (
                "dotvault",
                r#"{"schema":2,"areas":{".x:a":{"class":"public"}}}"#,
            ),
            (
                "badarea",
                r#"{"schema":2,"areas":{"main:../x":{"class":"public"}}}"#,
            ),
            (
                "rule",
                r#"{"schema":2,"vaults":{"main":{"class":"public"}},"areas":{}}"#,
            ),
            ("extra", r#"{"schema":2,"areas":{},"more":1}"#),
        ] {
            let got = Classes::load(&temp(name, text));
            assert!(
                matches!(got, Err(ClassesError::Invalid(..))),
                "{name}: {got:?}"
            );
        }
    }

    #[test]
    fn a_proposal_for_a_vault_keeps_the_others_and_main_stays_schema_one() {
        let exists = |_: &str| false;
        // Schema 1 and the vault main: written the old way.
        let plain = Classes::load(&temp("p1", GOOD)).unwrap();
        let text = propose_in("main", ["alpha.nvim"], &[], &plain, &exists).unwrap();
        assert!(text.contains("\"schema\": 1"), "{text}");
        // Another vault on a schema 1 file: schema 2, main's entries move to `main:`.
        let text = propose_in("work", ["w.nvim"], &[], &plain, &exists).unwrap();
        let back = Classes::load(&temp("p1-out", &text)).unwrap();
        assert_eq!(back.for_vault("main").shown("secret-area"), Shown::Private);
        assert_eq!(back.for_vault("work").shown("w.nvim"), Shown::Internal);
        assert_eq!(
            back.for_vault("work").shown("secret-area"),
            Shown::Unclassified
        );
        // A schema 2 file: what was decided in either vault stays, the default of a vault too.
        let two = Classes::load(&temp("p2", TWO)).unwrap();
        let text = propose_in("work", ["shared.nvim", "fresh"], &[], &two, &exists).unwrap();
        let back = Classes::load(&temp("p2-out", &text)).unwrap();
        assert_eq!(back.for_vault("work").shown("shared.nvim"), Shown::Private);
        assert_eq!(back.for_vault("work").shown("fresh"), Shown::Internal);
        assert_eq!(back.for_vault("main").shown("shared.nvim"), Shown::Public);
        assert_eq!(back.for_vault("work").shown("anything"), Shown::Internal);
        // No file at all, the vault main: schema 1 like before.
        let none = Classes::default();
        let text = propose_in("main", ["a"], &[], &none, &exists).unwrap();
        assert!(text.contains("\"schema\": 1"), "{text}");
    }

    #[test]
    fn a_proposal_never_proposes_a_bad_name() {
        let err = propose(["../x"], &[], &AreaPolicy::default(), &|_| false).unwrap_err();
        assert!(err.contains("not allowed") || err.contains("must"), "{err}");
    }
}
