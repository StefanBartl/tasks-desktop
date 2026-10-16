//! Full-text search over the bodies of the tasks: the index is the kit's. The tasks hub asks for
//! the text with its call `bodies` ([`crate::engine::Calls::Bodies`]) when it builds one.

pub use appkit_hub::search::*;
