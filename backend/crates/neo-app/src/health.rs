//! Component health, shown in the app: each part reports its own entry.

use neo_core::time::now_iso;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// How a component is doing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Health {
    /// `ready`, `waiting` or `error`.
    pub state: &'static str,
    /// In words.
    pub detail: String,
    /// When it was reported.
    pub at: String,
}

impl Health {
    /// The component works.
    pub fn ready(detail: impl Into<String>) -> Health {
        Health { state: "ready", detail: detail.into(), at: now_iso() }
    }
    /// The component waits for something outside it.
    pub fn waiting(detail: impl Into<String>) -> Health {
        Health { state: "waiting", detail: detail.into(), at: now_iso() }
    }
    /// The component fails.
    pub fn error(detail: impl Into<String>) -> Health {
        Health { state: "error", detail: detail.into(), at: now_iso() }
    }
}

/// Every component's latest health, by name.
#[derive(Clone, Default)]
pub struct HealthBoard {
    entries: Arc<Mutex<BTreeMap<String, Health>>>,
}

impl HealthBoard {
    /// An empty board.
    pub fn new() -> HealthBoard {
        HealthBoard::default()
    }
    /// Report a component's health.
    pub fn set(&self, name: &str, health: Health) {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(name.to_string(), health);
    }
    /// A component's latest health.
    pub fn get(&self, name: &str) -> Option<Health> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(name).cloned()
    }
    /// Every entry, by name.
    pub fn all(&self) -> BTreeMap<String, Health> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}
