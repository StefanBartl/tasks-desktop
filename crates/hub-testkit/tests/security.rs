//! The security matrix of the guard (concept 5.5), run for every app that has a hub.
//!
//! The tests are written once, in `hub_testkit::security`, and take the app as a parameter. The
//! tasks hub is the app that is shipped. `Demo` is a second, minimal app on `hub-kit` alone, with
//! its own identity and namespace: that it passes the very same tests shows that the guard does
//! not depend on `tasks`.

mod tasks {
    hub_testkit::security_matrix!(hub_testkit::subjects::Tasks);
}

mod demo {
    hub_testkit::security_matrix!(hub_testkit::subjects::Demo);
}
