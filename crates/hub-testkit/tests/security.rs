//! The security matrix of the guard (concept 5.5), run for the tasks hub. The tests are written
//! once, in `appkit_testkit::security`; the kit runs them for its own minimal app, and every app
//! that has a hub runs them for itself.

mod tasks {
    appkit_testkit::security_matrix!(hub_testkit::subjects::Tasks);
}
