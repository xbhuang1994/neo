//! Neo kernel: persistent agent Sessions over the Antigravity CLI command-line runtime.
//!
//! A [`session::Session`] owns the transcript ([`journal::Journal`]) and the delivery rules; a [`session::Driver`] owns
//! one runtime process and only runs the model.
#![deny(missing_docs)]

pub mod antigravity;
pub mod journal;
pub mod process;
pub mod session;
pub mod types;
