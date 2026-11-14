//! In-memory repository for tests and ephemeral engines; it matches the ordering of the SQLite store.

use crate::model::{AssignmentState, Decision, Thread, Ticket, Trigger, TriggerDisposition};
use crate::ports::Repositories;
use std::sync::Mutex;

/// Rows in insertion order; saving an existing key keeps its position.
#[derive(Clone)]
struct Rows<T>(Vec<(String, T)>);

impl<T> Default for Rows<T> {
    fn default() -> Self {
        Rows(Vec::new())
    }
}

impl<T: Clone> Rows<T> {
    fn get(&self, key: &str) -> Option<T> {
        self.0.iter().find(|(id, _)| id == key).map(|(_, value)| value.clone())
    }
    fn set(&mut self, key: &str, value: &T) {
        match self.0.iter_mut().find(|(id, _)| id == key) {
            Some(row) => row.1 = value.clone(),
            None => self.0.push((key.to_string(), value.clone())),
        }
    }
    fn values(&self) -> Vec<T> {
        self.0.iter().map(|(_, value)| value.clone()).collect()
    }
}

#[derive(Clone, Default)]
struct State {
    triggers: Rows<Trigger>,
    dispositions: Rows<TriggerDisposition>,
    threads: Rows<Thread>,
    tickets: Rows<Ticket>,
    decisions: Rows<Decision>,
}

/// In-memory [`Repositories`] with snapshot rollback.
#[derive(Default)]
pub struct MemoryRepositories {
    state: Mutex<State>,
    snapshots: Mutex<Vec<State>>,
}

impl MemoryRepositories {
    /// An empty repository.
    pub fn new() -> Self {
        Self::default()
    }
    fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.state.lock().unwrap())
    }
    fn write(&self, f: impl FnOnce(&mut State)) {
        f(&mut self.state.lock().unwrap())
    }
}

impl Repositories for MemoryRepositories {
    fn begin(&self) {
        let snapshot = self.state.lock().unwrap().clone();
        self.snapshots.lock().unwrap().push(snapshot);
    }
    fn commit(&self) {
        self.snapshots.lock().unwrap().pop();
    }
    fn rollback(&self) {
        if let Some(snapshot) = self.snapshots.lock().unwrap().pop() {
            *self.state.lock().unwrap() = snapshot;
        }
    }

    fn trigger(&self, id: &str) -> Option<Trigger> {
        self.read(|s| s.triggers.get(id))
    }
    fn save_trigger(&self, trigger: &Trigger) {
        self.write(|s| s.triggers.set(&trigger.id, trigger))
    }
    fn disposition(&self, id: &str) -> Option<TriggerDisposition> {
        self.read(|s| s.dispositions.get(id))
    }
    fn save_disposition(&self, id: &str, value: &TriggerDisposition) {
        self.write(|s| s.dispositions.set(id, value))
    }

    fn thread(&self, key: &str) -> Option<Thread> {
        self.read(|s| s.threads.get(key))
    }
    fn save_thread(&self, thread: &Thread) {
        self.write(|s| s.threads.set(&thread.key, thread))
    }
    fn threads(&self) -> Vec<Thread> {
        self.read(|s| s.threads.values())
    }
    fn active_threads(&self) -> Vec<Thread> {
        self.threads().into_iter().filter(|thread| !thread.pending.is_empty() || thread.evaluating.is_some()).collect()
    }

    fn ticket(&self, id: &str) -> Option<Ticket> {
        self.read(|s| s.tickets.get(id))
    }
    fn save_ticket(&self, ticket: &Ticket) {
        self.write(|s| s.tickets.set(&ticket.id, ticket))
    }
    fn tickets(&self) -> Vec<Ticket> {
        let mut all = self.read(|s| s.tickets.values());
        all.reverse();
        all
    }
    fn open_tickets(&self) -> Vec<Ticket> {
        self.tickets().into_iter().filter(Ticket::live).collect()
    }
    fn active_tickets(&self) -> Vec<Ticket> {
        self.tickets()
            .into_iter()
            .filter(|ticket| {
                !ticket.undelivered.is_empty() || ticket.latest().is_some_and(|a| matches!(a.state, AssignmentState::Pending | AssignmentState::Running))
            })
            .collect()
    }

    fn decision(&self, id: &str) -> Option<Decision> {
        self.read(|s| s.decisions.get(id))
    }
    fn save_decision(&self, decision: &Decision) {
        self.write(|s| s.decisions.set(&decision.id, decision))
    }
    fn decisions_by_thread(&self, key: &str) -> Vec<Decision> {
        self.read(|s| s.decisions.values()).into_iter().filter(|decision| decision.thread_key == key).collect()
    }
}
