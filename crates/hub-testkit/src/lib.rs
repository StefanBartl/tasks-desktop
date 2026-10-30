//! Test support for the tasks hub. What every app's hub shares is in `appkit-testkit`; here is what
//! is the tasks hub's own:
//!
//! * [`subjects::Tasks`]: the tasks hub as a subject of the security matrix of `appkit-testkit`.
//! * [`scratch::Scratch`]: the one way tests get a folder in the temp dir, removed on drop.
//! * [`engine_home::engine_env`]: a cache folder of its own for the real engine of a test.
//! * [`dialect::TASKS`] and [`documents::TASKS_DOCUMENTS`]: what the fake tasks engine calls things
//!   and the documents it answers with; the binary `fake-nvim` plays it.

pub mod dialect;
pub mod documents;
pub mod engine_home;
pub mod scratch;
pub mod subjects;
