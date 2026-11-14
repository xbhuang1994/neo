//! Test harness: an Engine over the repository the test crate's root provides (`crate::test_repo`), with recording
//! ports and a manual clock. The same tests run against the SQLite store from `neo-store`.
#![allow(dead_code)]

use neo_core::assignments::WorkerReport;
use neo_core::engine::{Engine, EngineOptions};
use neo_core::model::*;
use neo_core::ports::*;
use neo_core::time::format_iso;
use neo_core::Result;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub const BASE_MS: i64 = 1_790_121_600_000; // 2026-09-23T00:00:00.000Z

pub fn member() -> ActorRef {
    ActorRef { source: "chat".into(), id: "alice".into() }
}
pub fn guest() -> ActorRef {
    ActorRef { source: "chat".into(), id: "guest".into() }
}
pub fn thread(id: &str) -> ThreadRef {
    ThreadRef { source: "chat".into(), id: id.into() }
}
pub fn channel(id: &str) -> ChannelRef {
    ChannelRef { source: "chat".into(), thread: "t1".into(), address: [("message".to_string(), id.to_string())].into() }
}
/// A person's message `id` from the member on thread `t1`.
pub fn trigger(id: &str) -> Trigger {
    Trigger {
        id: id.into(),
        source: "chat".into(),
        threads: vec![thread("t1")],
        actor: member(),
        human: true,
        addressed: None,
        at: format!("2026-09-23T00:00:{:0>2}Z", id),
        text: format!("message {id}"),
        channel: Some(channel(id)),
        url: None,
        meta: Json::new(),
    }
}
pub fn on(mut trigger: Trigger, thread_id: &str) -> Trigger {
    trigger.threads = vec![thread(thread_id)];
    trigger
}
pub fn by(mut trigger: Trigger, actor: ActorRef) -> Trigger {
    trigger.actor = actor;
    trigger
}
pub fn bot(mut trigger: Trigger) -> Trigger {
    trigger.human = false;
    trigger
}
pub fn meta(mut trigger: Trigger, flag: &str) -> Trigger {
    trigger.meta.insert(flag.into(), true.into());
    trigger
}

#[derive(Default)]
pub struct Recorder {
    pub outbox: Mutex<Vec<OutboundMessage>>,
    pub withdrawn: Mutex<Vec<String>>,
    pub requests: Mutex<Vec<Candidate>>,
    pub released: Mutex<Vec<String>>,
    pub launches: Mutex<VecDeque<(Ticket, Assignment)>>,
    pub deliveries: Mutex<Vec<String>>,
    pub delivered: Mutex<Vec<(String, String)>>,
    pub starts: AtomicUsize,
    pub delivers: AtomicUsize,
    pub stops: AtomicUsize,
    pub events: Mutex<Vec<DomainEvent>>,
    pub version: Mutex<String>,
    pub paused: AtomicBool,
    pub clock: AtomicI64,
}

impl Assessor for Recorder {
    fn request(&self, candidate: Candidate) {
        self.requests.lock().unwrap().push(candidate);
    }
    fn release(&self, eval_id: &str) {
        self.released.lock().unwrap().push(eval_id.to_string());
    }
}
impl Executor for Recorder {
    fn start(&self, ticket: &Ticket, assignment: &Assignment) {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.launches.lock().unwrap().push_back((ticket.clone(), assignment.clone()));
    }
    fn deliver(&self, ticket: &Ticket, _assignment: &Assignment) {
        self.delivers.fetch_add(1, Ordering::SeqCst);
        let mut deliveries = self.deliveries.lock().unwrap();
        if !deliveries.contains(&ticket.id) {
            deliveries.push(ticket.id.clone());
        }
    }
    fn stop(&self, _ticket: &Ticket, _assignment: &Assignment, _reason: &str) {
        self.stops.fetch_add(1, Ordering::SeqCst);
    }
}
impl Outbox for Recorder {
    fn send(&self, message: OutboundMessage) {
        let mut outbox = self.outbox.lock().unwrap();
        if !outbox.iter().any(|item| item.id == message.id) {
            outbox.push(message);
        }
    }
    fn status(&self, id: &str) -> Option<ReplyStatus> {
        self.outbox.lock().unwrap().iter().any(|item| item.id == id).then_some(ReplyStatus::Pending)
    }
    fn withdraw(&self, id: &str) {
        self.withdrawn.lock().unwrap().push(id.to_string());
    }
}
impl SourceScope for Recorder {
    fn scope(&self, _source: &str, meta: &Json) -> ScopeResult {
        if meta.contains_key("blocked") {
            ScopeResult::Ignored { reason: "chat not allowed".into() }
        } else {
            ScopeResult::Listened { observed: false, row: None, fanout: !meta.contains_key("routed") }
        }
    }
}

pub fn explicit() -> GateResult {
    GateResult::Admissible { strength: Strength::Explicit, basis: MandateBasis::via(BasisVia::Addressed { addressed: Addressed::Direct }) }
}
pub fn inferred() -> GateResult {
    GateResult::Admissible { strength: Strength::Inferred, basis: MandateBasis::via(BasisVia::Followup) }
}

pub type Gate = dyn Fn(&Trigger, &Thread) -> GateResult + Send + Sync;

pub struct TestPolicy {
    recorder: Arc<Recorder>,
    gate: Option<Arc<Gate>>,
}
impl Policy for TestPolicy {
    fn version(&self) -> String {
        self.recorder.version.lock().unwrap().clone()
    }
    fn paused(&self) -> bool {
        self.recorder.paused.load(Ordering::SeqCst)
    }
    fn gate(&self, trigger: &Trigger, thread: &Thread, _tickets: &[Ticket]) -> GateResult {
        if let Some(gate) = &self.gate {
            return gate(trigger, thread);
        }
        if !trigger.human {
            GateResult::Inadmissible { reason: "not human".into() }
        } else if trigger.actor.id == "alice" {
            explicit()
        } else if !thread.subscriptions.is_empty() {
            inferred()
        } else {
            GateResult::Inadmissible { reason: "not a member".into() }
        }
    }
    fn revalidate(&self, _mandate: &Mandate) -> bool {
        self.version() != "revoked"
    }
    fn admits_inferred(&self, rules: &[String]) -> bool {
        !rules.is_empty()
    }
    fn eval_timeout_ms(&self) -> i64 {
        60_000
    }
}

pub struct Harness {
    pub repo: Arc<dyn Repositories>,
    pub engine: Engine,
    pub r: Arc<Recorder>,
}

#[derive(Default)]
pub struct Hooks {
    pub gate: Option<Arc<Gate>>,
    pub prepare: Option<neo_core::engine::PrepareTicket>,
}

pub fn harness() -> Harness {
    harness_with(Hooks::default())
}

pub fn harness_with(hooks: Hooks) -> Harness {
    let repo: Arc<dyn Repositories> = crate::test_repo();
    let r = Arc::new(Recorder::default());
    *r.version.lock().unwrap() = "v1".into();
    let policy: Arc<dyn Policy> = Arc::new(TestPolicy { recorder: r.clone(), gate: hooks.gate });
    let (clock, events) = (r.clone(), r.clone());
    let engine = Engine::new(EngineOptions {
        repo: repo.clone(),
        policy: Box::new(move || policy.clone()),
        scope: r.clone(),
        assessor: r.clone(),
        executor: r.clone(),
        outbox: r.clone(),
        prepare_ticket: hooks.prepare,
        now: Some(Box::new(move || format_iso(BASE_MS + clock.clock.load(Ordering::SeqCst) * 1000))),
        emit: Some(Box::new(move |event, _at| events.events.lock().unwrap().push(event))),
    });
    Harness { repo, engine, r }
}

pub fn accept_outcome() -> Outcome {
    Outcome::new(
        OutcomeKind::Accept(Accept { title: "Fix".into(), scope: "small".into(), acknowledgement: Some("ok".into()), ..Default::default() }),
        "requested",
    )
}
pub fn accept_plain(title: &str) -> Outcome {
    Outcome::new(OutcomeKind::Accept(Accept { title: title.into(), scope: "small".into(), ..Default::default() }), "requested")
}
pub fn ignore(reason: &str) -> Outcome {
    Outcome::new(OutcomeKind::Ignore, reason)
}
pub fn stop(ticket_id: &str, reason: &str) -> Outcome {
    Outcome::new(OutcomeKind::Stop { ticket_id: ticket_id.into() }, reason)
}
pub fn report(state: ReportState, summary: &str) -> WorkerReport {
    WorkerReport::new(state, summary)
}

impl Harness {
    pub fn receive(&self, trigger: Trigger) -> neo_core::ReceiveResult {
        self.engine.receive(trigger).unwrap()
    }
    /// Simulate the executor starting queued assignments (unless `launch` is false) and delivering pending inputs.
    pub fn settle_with(&self, launch: bool) {
        loop {
            let next = if launch { self.r.launches.lock().unwrap().pop_front() } else { None };
            if let Some((ticket, assignment)) = next {
                self.engine.assignment_started(&ticket.id, &assignment.id).unwrap();
                continue;
            }
            let ticket_id = {
                let mut deliveries = self.r.deliveries.lock().unwrap();
                if deliveries.is_empty() {
                    return;
                }
                deliveries.remove(0)
            };
            let ticket = self.ticket(&ticket_id);
            let Some(assignment) = ticket.running().cloned().filter(|_| ticket.live()) else {
                continue;
            };
            for input_id in &ticket.undelivered {
                self.r.delivered.lock().unwrap().push((ticket_id.clone(), input_id.clone()));
                self.engine.inputs_delivered(&ticket_id, &assignment.id, std::slice::from_ref(input_id)).unwrap();
            }
        }
    }
    pub fn settle(&self) {
        self.settle_with(true)
    }
    pub fn pump(&self) {
        self.engine.evaluate_due();
        self.settle();
    }
    /// Simulate the worker's Session taking the delivered Trigger Inputs it has not yet read into a step.
    pub fn read(&self, ticket_id: &str) {
        let waiting: Vec<String> = self
            .ticket(ticket_id)
            .inputs
            .iter()
            .filter(|input| matches!(input, TicketInput::Trigger { read_at: Read::Waiting, .. }))
            .map(|input| input.id().to_string())
            .collect();
        self.engine.inputs_read(ticket_id, &waiting).unwrap();
    }
    /// Decide the candidate's Eval through its first trigger.
    pub fn decide(&self, candidate: &Candidate, mut outcome: Outcome) -> Result<Decision> {
        outcome.eval_id = Some(candidate.eval_id.clone());
        self.engine.decide(&candidate.triggers[0].id, outcome)
    }
    pub fn request(&self, index: usize) -> Candidate {
        self.r.requests.lock().unwrap()[index].clone()
    }
    pub fn last_request(&self) -> Candidate {
        self.r.requests.lock().unwrap().last().cloned().expect("a candidate was requested")
    }
    pub fn requests(&self) -> usize {
        self.r.requests.lock().unwrap().len()
    }
    pub fn request_ids(&self, candidate: &Candidate) -> Vec<String> {
        candidate.triggers.iter().map(|trigger| trigger.id.clone()).collect()
    }
    pub fn last_ids(&self) -> Vec<String> {
        self.request_ids(&self.last_request())
    }
    /// Receive message `id` on `thread_id`, assess it and accept it with an acknowledgement; returns the ticket id.
    pub fn accepted_on(&self, id: &str, thread_id: &str) -> String {
        self.receive(on(trigger(id), thread_id));
        self.pump();
        let decision = self.decide(&self.last_request(), accept_outcome()).unwrap();
        self.settle();
        decision.ticket_id.unwrap()
    }
    pub fn accepted(&self) -> String {
        self.accepted_on("1", "t1")
    }
    pub fn ticket(&self, id: &str) -> Ticket {
        self.repo.ticket(id).expect("the ticket is stored")
    }
    pub fn thread(&self, key: &str) -> Thread {
        self.repo.thread(key).expect("the thread is stored")
    }
    pub fn disposition(&self, id: &str) -> TriggerDisposition {
        self.repo.disposition(id).expect("the disposition is stored")
    }
    pub fn decisions(&self, key: &str) -> Vec<Decision> {
        self.repo.decisions_by_thread(key)
    }
    pub fn set_version(&self, version: &str) {
        *self.r.version.lock().unwrap() = version.to_string();
    }
    pub fn set_paused(&self, paused: bool) {
        self.r.paused.store(paused, Ordering::SeqCst);
    }
    pub fn tick(&self, seconds: i64) {
        self.r.clock.fetch_add(seconds, Ordering::SeqCst);
    }
    pub fn starts(&self) -> usize {
        self.r.starts.load(Ordering::SeqCst)
    }
    pub fn delivers(&self) -> usize {
        self.r.delivers.load(Ordering::SeqCst)
    }
    pub fn stops(&self) -> usize {
        self.r.stops.load(Ordering::SeqCst)
    }
    pub fn outbox(&self) -> Vec<OutboundMessage> {
        self.r.outbox.lock().unwrap().clone()
    }
    pub fn delivered(&self) -> Vec<(String, String)> {
        self.r.delivered.lock().unwrap().clone()
    }
    pub fn report(&self, ticket_id: &str, state: ReportState, summary: &str) -> Ticket {
        self.engine.report(ticket_id, report(state, summary)).unwrap()
    }
    pub fn code<T: std::fmt::Debug>(result: Result<T>) -> &'static str {
        result.expect_err("the request is refused").code
    }
}
