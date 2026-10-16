//! The vaults the page may choose from: the program's side of the list and the routes under `/api/vaults`.

use crate::*;

/// One vault of the list the page shows: a name and the last part of its
/// folder (never the whole path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultInfo {
    pub name: String,
    pub label: String,
    pub main: bool,
}

/// The list of vaults and the one that is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultList {
    pub active: String,
    pub vaults: Vec<VaultInfo>,
}

/// A future that is boxed, so that a trait object can answer with it.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the routes under `/api/vaults` ask of the program: which vaults there
/// are, adding and removing one, and choosing the one to read. An error is a
/// short text for the page: no path, no engine output.
pub trait VaultAdmin<T>: Send + Sync {
    fn list(&self) -> VaultList;
    /// Remember a vault by name. The folder must exist; whether it holds a
    /// vault is found out when it is chosen.
    fn add<'a>(&'a self, name: &'a str, path: &'a str) -> BoxFuture<'a, Result<(), String>>;
    /// Forget a vault (never its files). The one that is read cannot go.
    fn remove<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), String>>;
    /// Set up the engine for a vault and remember the choice; the server then
    /// reads it. A vault that does not work is refused and nothing changes.
    fn select<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<T, String>>;
}

/// The text a request of the vault routes carries: one JSON object with a few
/// short fields.
// The error is the answer to send, as everywhere in this file: a response is large, and rare.
#[allow(clippy::result_large_err)]
pub fn vault_request(
    body: &Bytes,
    fields: &[&str],
) -> Result<serde_json::Map<String, serde_json::Value>, Response> {
    let bad = |why: &str| error_body(StatusCode::BAD_REQUEST, "bad_request", why);
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| bad("the body is not JSON"))?;
    let serde_json::Value::Object(map) = value else {
        return Err(bad("the body must be an object"));
    };
    if let Some(key) = map.keys().find(|k| !fields.contains(&k.as_str())) {
        return Err(bad(&format!("unknown field {key:?}")));
    }
    Ok(map)
}

// The error is the answer to send, as everywhere in this file: a response is large, and rare.
#[allow(clippy::result_large_err)]
pub fn vault_text(
    map: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    longest: usize,
) -> Result<String, Response> {
    match map.get(key).and_then(serde_json::Value::as_str) {
        Some(text)
            if !text.is_empty()
                && text.chars().count() <= longest
                && !text.chars().any(char::is_control) =>
        {
            Ok(text.to_owned())
        }
        _ => Err(error_body(
            StatusCode::BAD_REQUEST,
            "bad_request",
            &format!("{key}: text of 1 to {longest} characters, no control characters"),
        )),
    }
}

pub fn vaults_unavailable() -> Response {
    error_body(
        StatusCode::NOT_FOUND,
        "vaults_unavailable",
        "this hub has no list of vaults",
    )
}

/// `GET /api/vaults`: the vaults the person may choose from and the one that
/// is read. Names and the last part of a folder; never a whole path.
pub async fn vaults_list<R: Runtime>(
    State(st): State<Arc<Core<R>>>,
    RawQuery(query): RawQuery,
) -> Response {
    if let Some(response) = no_query(query.as_deref()) {
        return response;
    }
    let Some(admin) = &st.vaults else {
        return vaults_unavailable();
    };
    let list = admin.list();
    let vaults: Vec<serde_json::Value> = list
        .vaults
        .iter()
        .map(|v| json!({ "name": v.name, "label": v.label, "main": v.main }))
        .collect();
    axum::Json(
        json!({ "schema": 1, "kind": "hub.vaults", "active": list.active, "vaults": vaults }),
    )
    .into_response()
}

/// `POST /api/vaults/add` `{ "name", "path", "confirm": true }`: remember a
/// vault. The folder is the person's choice and the page asks first: the
/// request must say it was confirmed.
pub async fn vaults_add<R: Runtime>(State(st): State<Arc<Core<R>>>, body: Bytes) -> Response {
    let Some(admin) = &st.vaults else {
        return vaults_unavailable();
    };
    let map = match vault_request(&body, &["name", "path", "confirm"]) {
        Ok(m) => m,
        Err(r) => return r,
    };
    if map.get("confirm").and_then(serde_json::Value::as_bool) != Some(true) {
        return error_body(
            StatusCode::BAD_REQUEST,
            "confirm_required",
            "adding a vault must be confirmed",
        );
    }
    let (name, path) = match (vault_text(&map, "name", 40), vault_text(&map, "path", 1024)) {
        (Ok(n), Ok(p)) => (n, p),
        (Err(r), _) | (_, Err(r)) => return r,
    };
    match admin.add(&name, &path).await {
        Ok(()) => axum::Json(json!({ "ok": true })).into_response(),
        Err(why) => error_body(StatusCode::BAD_REQUEST, "vault_refused", &why),
    }
}

/// `POST /api/vaults/remove` `{ "name" }`: forget a vault; its files stay.
pub async fn vaults_remove<R: Runtime>(State(st): State<Arc<Core<R>>>, body: Bytes) -> Response {
    let Some(admin) = &st.vaults else {
        return vaults_unavailable();
    };
    let map = match vault_request(&body, &["name"]) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let name = match vault_text(&map, "name", 40) {
        Ok(n) => n,
        Err(r) => return r,
    };
    match admin.remove(&name).await {
        Ok(()) => axum::Json(json!({ "ok": true })).into_response(),
        Err(why) => error_body(StatusCode::BAD_REQUEST, "vault_refused", &why),
    }
}

/// `POST /api/vaults/select` `{ "name" }`: read another vault. What belongs to
/// the old one (the snapshot, the search, the watcher, the open streams) goes
/// with it; the page reads again. A vault that does not work is refused and
/// the old one stays.
pub async fn vaults_select<R: Runtime>(State(st): State<Arc<Core<R>>>, body: Bytes) -> Response {
    let Some(admin) = &st.vaults else {
        return vaults_unavailable();
    };
    let map = match vault_request(&body, &["name"]) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let name = match vault_text(&map, "name", 40) {
        Ok(n) => n,
        Err(r) => return r,
    };
    let _one_at_a_time = st.switching.lock().await;
    let target = match admin.select(&name).await {
        Ok(t) => t,
        Err(why) => return error_body(StatusCode::BAD_REQUEST, "vault_refused", &why),
    };
    let next = (st.build)(target);
    let old = {
        let mut slot = st
            .runtime
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::mem::replace(&mut *slot, Arc::new(next))
    };
    // The open streams of the old vault end: their store is closed with it.
    old.stop();
    drop(old);
    axum::Json(json!({ "ok": true, "active": name })).into_response()
}
