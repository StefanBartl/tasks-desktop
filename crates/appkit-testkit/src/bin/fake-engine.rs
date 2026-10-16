//! The fake engine of this kit: it plays `rules.nvim` (see `appkit_testkit::dialect::RULES`) with
//! no documents of its own, which is enough to test the seam of the engine.

use appkit_testkit::dialect::RULES;
use appkit_testkit::fake_engine::{run, NO_DOCUMENTS};

fn main() {
    run(&[&RULES], NO_DOCUMENTS);
}
