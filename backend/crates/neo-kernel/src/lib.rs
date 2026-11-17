//! Neo kernels: persistent agent Sessions over the Claude Code, Oh My Pi, Antigravity and Hermes Agent command-line
//! runtimes.
//!
//! A [`session::Session`] is the same for any kernel. It owns the transcript ([`journal::Journal`]) and the
//! delivery rules; a [`session::Driver`] owns one runtime process and only runs the model.
#![deny(missing_docs)]

pub mod antigravity;
pub mod claude;
pub mod hermes;
pub mod journal;
pub mod omp;
pub mod process;
pub mod session;
pub mod types;
