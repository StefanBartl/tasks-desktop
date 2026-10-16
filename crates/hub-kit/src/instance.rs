//! Which hub of an app runs on this machine: the config folder that holds its `hub.json`, and the
//! question whether the hub that file names is really there.

use std::path::{Path, PathBuf};

use app_core::identity::AppIdentity;
use app_core::registry::{self, HubRecord};
use serde_json::Value;

use crate::client;
use crate::env::Env;

/// The config folder of the app, for `hub.json` and `control.secret`.
///
/// # Errors
///
/// The reason there is none (no `APPDATA`, `XDG_CONFIG_HOME` or `HOME`, and no variable that names it).
pub fn config_folder(env: &Env, identity: &AppIdentity) -> Result<PathBuf, String> {
    crate::config::config_dir(env, identity).ok_or_else(|| {
        format!(
            "no config folder: set {} (APPDATA, XDG_CONFIG_HOME or HOME is missing)",
            identity.var("CONFIG_DIR")
        )
    })
}

/// Is a hub of this app running according to `hub.json`? It is only believed when the process on
/// that port says the same instance.
pub async fn running_hub(dir: &Path, identity: &AppIdentity) -> Option<HubRecord> {
    let record = registry::read_record(dir).ok().flatten()?;
    if record.app != identity.app {
        return None;
    }
    let doc = hello_of(record.port, identity).await?;
    (doc["instance"].as_str() == Some(record.instance.as_str())).then_some(record)
}

/// What the program on `port` says to `hello`, if it is a hub of this app.
pub async fn hello_of(port: u16, identity: &AppIdentity) -> Option<Value> {
    let reply = client::request(port, "GET", &identity.route("hello"), &[], "")
        .await
        .ok()?;
    let doc: Value = serde_json::from_str(&reply.body).ok()?;
    (reply.status == 200 && doc["app"] == identity.app).then_some(doc)
}
