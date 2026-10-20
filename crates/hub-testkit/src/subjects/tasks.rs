//! The tasks hub as a subject of the matrix.

use std::sync::Arc;

use appkit_core::identity::AppIdentity;
use appkit_hub::{BoxFuture, RunningServer};
use tasks_hub::classes::AreaPolicy;
use tasks_hub::server::{start, ServerConfig};

use appkit_testkit::subject::{StartConfig, Subject};

/// `tasks-hub`, with no engine, no vault and no page.
pub struct Tasks;

impl Subject for Tasks {
    fn identity(&self) -> &'static AppIdentity {
        &tasks_hub::IDENTITY
    }

    fn start(&self, cfg: StartConfig) -> BoxFuture<'_, std::io::Result<RunningServer>> {
        Box::pin(async move {
            start(ServerConfig {
                addr: cfg.addr,
                limits: cfg.limits,
                clock: cfg.clock,
                pairing_ttl: cfg.pairing_ttl,
                control_secret: cfg.control_secret,
                instance: cfg.instance,
                engine: None,
                policy: Arc::new(AreaPolicy::default()),
                usage: None,
                ui: tasks_hub::ui::UiFiles::none(),
                watch: None,
                status: cfg.status,
            })
            .await
        })
    }

    fn data_routes(&self) -> Vec<&'static str> {
        vec![
            "snapshot",
            "task",
            "next",
            "areas",
            "about",
            "links",
            "groupings",
            "finished",
            "events",
            "ops",
        ]
    }
}
