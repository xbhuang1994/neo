//! Neo application layer: settings and policy, the effect queue, sessions, the executor, sources and tools.
#![deny(missing_docs)]

pub mod accounts;
pub mod app;
mod assess;
pub mod blocked;
pub mod cards;
pub mod chat;
pub mod effects;
pub mod executor;
pub mod health;
pub mod http;
pub mod kernels;
pub mod notices;
pub mod outbox;
pub mod passes;
pub mod policy;
pub mod procinfo;
pub mod prompts;
pub mod resources;
pub mod sessions;
pub mod settings;
mod sidecar;
pub mod text;
pub mod tools;
pub mod views;
pub mod watchdog;
pub mod wechat;
pub mod wechat_protocol;
mod wechat_typing;
