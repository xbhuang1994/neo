//! Neo Agent domain core: triggers, threads, evals, decisions, tickets and assignments.
//!
//! The core does no I/O. It mutates its aggregates through the [`ports::Repositories`] port inside one transaction per
//! command and queues every side effect through the other ports, which the application implements.
#![deny(missing_docs)]

pub mod assignments;
pub mod engine;
pub mod errors;
mod evals;
pub mod ids;
mod intake;
pub mod memory;
pub mod model;
pub mod ports;
pub mod reasons;
pub mod replies;
pub mod stage;
mod tickets;
pub mod time;

pub use engine::{Engine, EngineOptions, ReceiveResult};
pub use errors::{Result, UserError};
