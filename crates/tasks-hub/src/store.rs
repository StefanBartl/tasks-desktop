//! The snapshot the hub holds, and the events that tell it changed: the store is the kit's, this
//! module states what the tasks hub calls its documents.

pub use appkit_hub::store::{
    spawn_refresher, Cached, Change, RefreshOptions, SnapshotShape, SnapshotStore, StoreOptions,
};

use crate::engine::Calls;

/// The snapshot of the tasks engine: the list is `tasks`, the event is `tasks`, and these problems
/// pass by while a file is in the middle of a change.
pub const SHAPE: SnapshotShape = SnapshotShape {
    call: Calls::Snapshot,
    items_key: "tasks",
    event: "tasks",
    transitional: &["duplicate-id", "unreadable"],
};

#[cfg(test)]
mod tests {
    use super::*;

    /// A client listens for `event: tasks`, and the engine writes its list under `tasks`: both are
    /// part of the contract, a rename is a migration.
    #[test]
    fn the_names_of_the_tasks_contract_stay() {
        assert_eq!(SHAPE.items_key, "tasks");
        assert_eq!(SHAPE.event, "tasks");
        assert_eq!(SHAPE.call, Calls::Snapshot);
        let c = Change {
            seq: 1,
            rev: None,
            cause: "fs",
            changed: Vec::new(),
            added: Vec::new(),
            removed: Vec::new(),
            truncated: false,
        };
        assert!(c.to_sse(SHAPE.event).starts_with("event: tasks\ndata: {"));
    }

    /// `done` puts the copy in place before the original is gone: two tasks of one id for a moment.
    #[test]
    fn a_moment_of_two_ids_or_an_unreadable_file_is_waited_out() {
        assert!(SHAPE.transitional.contains(&"duplicate-id"));
        assert!(SHAPE.transitional.contains(&"unreadable"));
        assert!(!SHAPE.transitional.contains(&"missing-title"));
    }
}
