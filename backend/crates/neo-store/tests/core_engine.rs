//! The domain Engine's tests from `neo-core`, run against the SQLite store instead of the in-memory repository.
// Each included test file brings the shared harness with it.
#![allow(clippy::duplicate_mod)]

use std::sync::Arc;

fn test_repo() -> Arc<dyn neo_core::ports::Repositories> {
    Arc::new(neo_store::Store::memory())
}

#[path = "../../neo-core/tests/engine.rs"]
mod engine;
#[path = "../../neo-core/tests/lifecycle.rs"]
mod lifecycle;
#[path = "../../neo-core/tests/tickets.rs"]
mod tickets;
