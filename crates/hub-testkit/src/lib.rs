//! Test support for the hubs of the apps.
//!
//! * [`wire`]: requests written as raw bytes over a TCP socket, because a real HTTP client would
//!   "repair" the very things under test (the `Host` header, a header that is too long, a type).
//! * [`subject`]: what the matrix needs to know about an app: its names, how to start its hub,
//!   and the routes that need a session.
//! * [`security`]: the security tests of the guard (concept 5.5), written once and run for every
//!   app with [`security_matrix!`].
//! * [`subjects`]: the apps the matrix runs for here: the tasks hub, and a second, minimal app
//!   that is built on `hub-kit` alone and so proves the guard knows nothing of `tasks`.

pub mod dialect;
pub mod security;
pub mod subject;
pub mod subjects;
pub mod wire;
