//! The security matrix of the guard (concept 5.5), run for `Demo`: a minimal app on `appkit-hub`
//! alone, with its own identity and namespace. That it passes shows that the guard depends on no
//! app. Every app that has a hub runs the same matrix for itself.

mod demo {
    appkit_testkit::security_matrix!(appkit_testkit::subjects::Demo);
}
