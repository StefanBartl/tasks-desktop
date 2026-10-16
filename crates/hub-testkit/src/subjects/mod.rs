//! The apps the security matrix runs for.

mod demo;
mod tasks;

pub use self::demo::{Demo, IDENTITY as DEMO_IDENTITY};
pub use self::tasks::Tasks;
