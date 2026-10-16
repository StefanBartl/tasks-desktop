//! A call of the engine contract as data: what it is called, what the answer must be, and the few
//! ways the engine seam treats one call differently from another.
//!
//! The list of calls belongs to the app that speaks the contract (a table of [`MethodSpec`]); the
//! seam (`CliEngine`, the host, the routes) only reads the spec. A [`Method`] is a handle on one
//! entry of such a table, so it cannot be made from a string that came from outside (concept 5.5
//! Nr. 8): the only way from a name to a method is a lookup in the app's own table.

/// What the engine seam needs to know about one call.
#[derive(Debug, PartialEq, Eq, Hash)]
pub struct MethodSpec {
    /// The name the engine knows it by, and the name of a route or a request.
    pub name: &'static str,
    /// The `kind` the answer must carry.
    pub reply_kind: &'static str,
    /// Whether the call carries parameters at all (a call that does not refuses them).
    pub takes_params: bool,
    /// Whether the call cannot be made without a request (a write has nothing to do without one).
    pub needs_params: bool,
    /// Whether the call changes the engine's data (unless the request says `dry_run`): it is
    /// always carried out once started, and a failure of it leaves the outcome open.
    pub writes: bool,
    /// Whether the call runs for minutes and so runs beside the others, not in their queue.
    pub aside: bool,
}

impl MethodSpec {
    /// A call that only reads: it may carry parameters, and waits in the queue.
    #[must_use]
    pub const fn read(name: &'static str, reply_kind: &'static str) -> Self {
        Self {
            name,
            reply_kind,
            takes_params: true,
            needs_params: false,
            writes: false,
            aside: false,
        }
    }

    /// The same, for a call that takes no parameters at all.
    #[must_use]
    pub const fn bare(name: &'static str, reply_kind: &'static str) -> Self {
        Self {
            takes_params: false,
            ..Self::read(name, reply_kind)
        }
    }

    /// A call that writes: it needs a request.
    #[must_use]
    pub const fn write(name: &'static str, reply_kind: &'static str) -> Self {
        Self {
            needs_params: true,
            writes: true,
            ..Self::read(name, reply_kind)
        }
    }

    /// A read that runs beside the queue.
    #[must_use]
    pub const fn aside(name: &'static str, reply_kind: &'static str) -> Self {
        Self {
            aside: true,
            ..Self::read(name, reply_kind)
        }
    }
}

/// One entry of an app's table of calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Method(&'static MethodSpec);

impl Method {
    #[must_use]
    pub const fn new(spec: &'static MethodSpec) -> Self {
        Self(spec)
    }

    /// The name the engine knows it by.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        self.0.name
    }

    /// The `kind` the answer must carry.
    #[must_use]
    pub fn reply_kind(self) -> &'static str {
        self.0.reply_kind
    }

    /// Whether the method carries a request or parameters at all.
    #[must_use]
    pub fn takes_params(self) -> bool {
        self.0.takes_params
    }

    /// Whether the method cannot be called without a request.
    #[must_use]
    pub fn needs_params(self) -> bool {
        self.0.needs_params
    }

    /// Whether the method changes data (see [`MethodSpec::writes`]).
    #[must_use]
    pub fn writes(self) -> bool {
        self.0.writes
    }

    /// Whether the method runs beside the queue (see [`MethodSpec::aside`]).
    #[must_use]
    pub fn is_aside(self) -> bool {
        self.0.aside
    }

    /// The method of `table` with this name. Nothing else is accepted.
    #[must_use]
    pub fn find(table: &[Method], name: &str) -> Option<Method> {
        table.iter().copied().find(|m| m.0.name == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static SPECS: [MethodSpec; 4] = [
        MethodSpec::bare("hello", "x.hello"),
        MethodSpec::read("list", "x.list"),
        MethodSpec::write("put", "x.result"),
        MethodSpec::aside("scan", "x.scan"),
    ];

    fn table() -> Vec<Method> {
        SPECS.iter().map(Method::new).collect()
    }

    #[test]
    fn a_name_finds_only_its_own_entry() {
        let t = table();
        assert_eq!(Method::find(&t, "list"), Some(t[1]));
        for bad in ["", "List", "list ", "x.list", "../list"] {
            assert_eq!(Method::find(&t, bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_flags_come_from_the_spec() {
        let t = table();
        assert!(!t[0].takes_params());
        assert!(t[1].takes_params() && !t[1].needs_params() && !t[1].writes());
        assert!(t[2].needs_params() && t[2].writes() && !t[2].is_aside());
        assert!(t[3].is_aside() && !t[3].writes());
    }
}
