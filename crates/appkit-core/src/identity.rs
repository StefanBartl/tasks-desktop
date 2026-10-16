//! The names an app gives itself: what it is called to the outside, on disk and in the environment.
//!
//! Everything that would otherwise be a fixed name in the hub (the config folder, the `Run`
//! value, the environment variables, the login entries, the program file, the port, the route
//! namespace) is derived from one value, so a second app on the same building blocks cannot
//! collide with the first: another port, another `hub.json`, another login entry.

/// The names of one app. All fields are fixed at build time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppIdentity {
    /// What the app says in `hello` and in `hub.json`, and the name of its config folder, its
    /// install folder and its `Run` value (`tasks-desktop`).
    pub app: &'static str,
    /// The program, without the platform's extension (`tasks-hub`).
    pub binary: &'static str,
    /// The prefix of the environment variables (`TASKS_DESKTOP`).
    pub env_prefix: &'static str,
    /// The name that a person sees on a link or a launcher (`Tasks`).
    pub title: &'static str,
    /// The default port. It is part of the origin, so it is fixed per app.
    pub default_port: u16,
    /// The namespace of the app's routes below `/api/` (`tasks` gives `/api/tasks/hello`).
    pub route_ns: &'static str,
}

impl AppIdentity {
    /// The environment variable `<PREFIX>_<suffix>`: `var("PORT")` is `TASKS_DESKTOP_PORT`.
    #[must_use]
    pub fn var(&self, suffix: &str) -> String {
        format!("{}_{suffix}", self.env_prefix)
    }

    /// The file name of the program on this platform (`tasks-hub.exe` on Windows).
    #[must_use]
    pub fn program_file(&self) -> String {
        if cfg!(windows) {
            format!("{}.exe", self.binary)
        } else {
            self.binary.to_owned()
        }
    }

    /// The freedesktop entry (`tasks-desktop.desktop`).
    #[must_use]
    pub fn desktop_file(&self) -> String {
        format!("{}.desktop", self.app)
    }

    /// The label of the launchd agent (`dev.tasks-desktop.hub`).
    #[must_use]
    pub fn agent_label(&self) -> String {
        format!("dev.{}.hub", self.app)
    }

    /// The file of the launchd agent (`dev.tasks-desktop.hub.plist`).
    #[must_use]
    pub fn agent_file(&self) -> String {
        format!("{}.plist", self.agent_label())
    }

    /// The path of a route of this app: `route("hello")` is `/api/tasks/hello`.
    #[must_use]
    pub fn route(&self, name: &str) -> String {
        format!("/api/{}/{name}", self.route_ns)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASKS: AppIdentity = AppIdentity {
        app: "tasks-desktop",
        binary: "tasks-hub",
        env_prefix: "TASKS_DESKTOP",
        title: "Tasks",
        default_port: 17615,
        route_ns: "tasks",
    };

    const RULES: AppIdentity = AppIdentity {
        app: "rules-desktop",
        binary: "rules-hub",
        env_prefix: "RULES_DESKTOP",
        title: "Rules",
        default_port: 17625,
        route_ns: "rules",
    };

    #[test]
    fn names_are_derived_from_the_one_value() {
        assert_eq!(TASKS.var("PORT"), "TASKS_DESKTOP_PORT");
        assert_eq!(TASKS.desktop_file(), "tasks-desktop.desktop");
        assert_eq!(TASKS.agent_label(), "dev.tasks-desktop.hub");
        assert_eq!(TASKS.agent_file(), "dev.tasks-desktop.hub.plist");
        assert_eq!(TASKS.route("hello"), "/api/tasks/hello");
        let exe = if cfg!(windows) {
            "tasks-hub.exe"
        } else {
            "tasks-hub"
        };
        assert_eq!(TASKS.program_file(), exe);
    }

    #[test]
    fn a_second_app_shares_none_of_the_names() {
        let (a, b) = (TASKS, RULES);
        assert_ne!(a.app, b.app);
        assert_ne!(a.var("CONFIG_DIR"), b.var("CONFIG_DIR"));
        assert_ne!(a.var("PORT"), b.var("PORT"));
        assert_ne!(a.default_port, b.default_port);
        assert_ne!(a.desktop_file(), b.desktop_file());
        assert_ne!(a.agent_label(), b.agent_label());
        assert_ne!(a.program_file(), b.program_file());
        assert_ne!(a.route("hello"), b.route("hello"));
    }
}
