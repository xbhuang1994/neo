//! Neo kernels: persistent agent Sessions over the Claude Code, Oh My Pi and Antigravity command-line runtimes.
//!
//! A [`session::Session`] is the same for either kernel. It owns the transcript ([`journal::Journal`]) and the
//! delivery rules; a [`session::Driver`] owns one runtime process and only runs the model.
#![deny(missing_docs)]

pub mod antigravity;
pub mod claude;
pub mod journal;
pub mod omp;
pub mod process;
pub mod session;
pub mod types;
