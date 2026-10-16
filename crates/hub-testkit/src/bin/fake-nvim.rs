//! A stand-in for `nvim --headless -u NONE -l scripts/tasks.lua call <method>` and for the
//! persistent host `scripts/tasks-host.lua`: the machine of `appkit_testkit::fake_engine` with the
//! names and the documents of the tasks engine.

use appkit_testkit::fake_engine::run;
use hub_testkit::dialect::TASKS;
use hub_testkit::documents::TASKS_DOCUMENTS;

fn main() {
    run(&[&TASKS], TASKS_DOCUMENTS);
}
