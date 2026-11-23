//! Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs.

use crate::engine::Engine;
use crate::errors::{Result, UserError};
use crate::ids::key;
use crate::model::{
    settled, thread_key, Assignment, AssignmentState, DecisionKind, Ended, Evaluation, Mandate, Origin, PolicyEffect, Read, ThreadRef, Ticket, TicketEndBy,
    TicketInput, TicketOutcome, Trigger,
};
use crate::ports::{Accept, DomainEvent};
use crate::stage::can_retry;
use std::collections::HashMap;

const STATUS_REQUEST: &str =
    "Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.";

/// Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the
/// message into a step before then. One that never reached a Session counts by when it reached the ticket.
fn read_before(input: &TicketInput, until: &str) -> bool {
    match input {
        TicketInput::Trigger { read_at: Read::Undelivered, at, .. } => at.as_str() <= until,
        TicketInput::Trigger { read_at: Read::At(read), .. } => read.as_str() < until,
        _ => false,
    }
}

impl Engine {
    /// Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its
    /// first Assignment, and the acknowledgement the accept carries, and queue its launch.
    pub(crate) fn tickets_create(&self, id: &str, decision_id: &str, mandate: Mandate, evaluation: &Evaluation, accept: &Accept, at: &str) -> Result<()> {
        let trigger_ids = evaluation.trigger_ids.clone();
        let primary = self.repo().trigger(evaluation.primary.as_deref().unwrap_or_else(|| trigger_ids.last().map(String::as_str).unwrap_or("")));
        let origin = Origin { trigger_id: primary.as_ref().map(|t| t.id.clone()).unwrap_or_else(|| trigger_ids[0].clone()), trigger_ids: trigger_ids.clone() };
        let mut ticket = Ticket {
            id: id.to_string(),
            title: accept.title.clone(),
            decision_id: decision_id.to_string(),
            mandate: mandate.clone(),
            channels: Vec::new(),
            ended: None,
            attention: None,
            assignments: Vec::new(),
            inputs: Vec::new(),
            undelivered: Vec::new(),
            answers: Vec::new(),
            digest: None,
            created_at: at.to_string(),
            updated_at: at.to_string(),
            origin,
            execution: None,
            delivery: None,
            result_sent: None,
        };
        let triggers: Vec<Trigger> = trigger_ids.iter().filter_map(|trigger_id| self.repo().trigger(trigger_id)).collect();
        for channel in triggers.iter().filter_map(|trigger| trigger.channel.as_ref()) {
            if !ticket.channels.contains(channel) {
                ticket.channels.push(channel.clone());
            }
        }
        if let Some(prepare) = &self.o.prepare_ticket {
            ticket = prepare(ticket, accept)?;
        }
        let assignment = self.new_assignment(&mut ticket);
        self.repo().save_ticket(&ticket);
        for reference in triggers.iter().flat_map(|trigger| trigger.threads.iter()) {
            self.subscribe(id, reference);
        }
        if let (Some(text), Some(primary)) = (&accept.acknowledgement, &primary) {
            self.replies_acknowledge_accepted(id, primary, text);
        }
        self.o.executor.start(&self.require(id)?, &assignment);
        self.emit(DomainEvent::TicketCreated { ticket_id: id.to_string(), decision_id: decision_id.to_string(), strength: mandate.strength });
        Ok(())
    }

    /// The Trigger to attach to a ticket, once the ticket may take it.
    pub(crate) fn tickets_attachable(&self, ticket_id: &str, trigger_id: &str) -> Result<Trigger> {
        let trigger = self.repo().trigger(trigger_id).ok_or_else(|| UserError::new("unknownTrigger"))?;
        // A follow-up that reached a ticket goes elsewhere only once the workers that decide it hand it back.
        self.left_to_workers(&trigger)?;
        let current = self.require(ticket_id)?;
        if current.stopped_by_person() {
            return Err(UserError::new("ticketStopped"));
        }
        if !current.live() && !self.policy().revalidate(&current.mandate) {
            return Err(UserError::new("mandateRevoked"));
        }
        Ok(trigger)
    }

    /// Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's
    /// worker then decides it, as it decides a message that reached the ticket on its own Thread.
    pub(crate) fn tickets_attach(&self, ticket_id: &str, trigger: &Trigger, note: Option<&str>) -> Result<()> {
        for reference in &trigger.threads {
            self.subscribe(ticket_id, reference);
        }
        // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
        let current = self.disposition_or_new(&trigger.id);
        let mut disposition = current.clone();
        disposition.requeued = false;
        disposition.context.retain(|id| id != ticket_id);
        if !disposition.fanout.iter().any(|id| id == ticket_id) {
            disposition.fanout.push(ticket_id.to_string());
        }
        self.repo().save_disposition(&trigger.id, &disposition);
        let mut ticket = self.require(ticket_id)?;
        let id = key(&["input", ticket_id, "trigger", &trigger.id]);
        let at = self.now();
        let input = |input_id: String| TicketInput::Trigger {
            id: input_id,
            trigger_id: trigger.id.clone(),
            at: at.clone(),
            note: note.map(str::to_string),
            human: trigger.human,
            context: false,
            read_at: Read::Undelivered,
            delivered_to: None,
        };
        let existing = ticket.inputs.iter().position(|item| item.id() == id && item.trigger_id().is_some());
        match existing {
            None => self.tickets_add_input(&mut ticket, input(id)),
            Some(index) if note.is_some() && ticket.undelivered.contains(&id) => {
                if let TicketInput::Trigger { note: stored, .. } = &mut ticket.inputs[index] {
                    *stored = note.map(str::to_string);
                }
                ticket.updated_at = at.clone();
                self.repo().save_ticket(&ticket);
            }
            // A person sent it to Eval, or the ticket let it go before its worker took it up, read it for context
            // only, or ended after its worker had it, so the worker gets it again.
            Some(_)
                if current.requeued || !current.fanout.iter().any(|t| t == ticket_id) || current.context.iter().any(|t| t == ticket_id) || !ticket.live() =>
            {
                self.tickets_add_input(&mut ticket, input(key(&["input", ticket_id, "trigger", &trigger.id, "attached", &at])));
            }
            // The worker has the message already, so the note comes with it again.
            Some(_) => {
                if let Some(note) = note {
                    self.tickets_add_input(&mut ticket, input(key(&["input", ticket_id, "trigger", &trigger.id, "note", note])));
                }
            }
        }
        Ok(())
    }

    /// Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
    pub(crate) fn tickets_request_status(&self, ticket_id: &str) -> Result<bool> {
        let mut ticket = self.require(ticket_id)?;
        let waiting = ticket.running().and_then(|a| a.report.as_ref()).is_some_and(|r| r.state == crate::model::ReportState::Waiting);
        if !ticket.live() || !waiting {
            return Ok(false);
        }
        let input = TicketInput::Text { id: format!("status:{ticket_id}:{}", ticket.updated_at), text: STATUS_REQUEST.to_string(), at: self.now() };
        self.tickets_add_input(&mut ticket, input);
        Ok(true)
    }

    /// Wake an open ticket's running Assignment with a Watchdog prompt so the worker can finish, recover or report.
    pub(crate) fn tickets_wake_worker(&self, ticket_id: &str, text: &str) -> Result<bool> {
        let mut ticket = self.require(ticket_id)?;
        if !ticket.live() || ticket.running().is_none() {
            return Ok(false);
        }
        let at = self.now();
        let input = TicketInput::Text { id: key(&["input", ticket_id, "watchdog", &at, text]), text: format!("[Watchdog] {text}"), at };
        self.tickets_add_input(&mut ticket, input);
        Ok(true)
    }

    /// Ends the stalled assignment of a retryable open ticket and starts a new one.
    pub(crate) fn tickets_retry(&self, ticket_id: &str) -> Result<Ticket> {
        let mut ticket = self.require(ticket_id)?;
        let Some(latest) = ticket.latest().cloned().filter(|_| can_retry(&ticket)) else {
            return Err(UserError::new("notRetryable"));
        };
        let latest = self.end_assignment(&mut ticket, &latest.id, "retried");
        self.requeue_untaken(&mut ticket, &latest.id);
        let assignment = self.new_assignment(&mut ticket);
        ticket.updated_at = self.now();
        self.repo().save_ticket(&ticket);
        self.o.executor.stop(&ticket, &latest, "retried");
        self.o.executor.start(&ticket, &assignment);
        Ok(ticket)
    }

    /// Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the
    /// person's messages there that the ticket decides.
    pub(crate) fn tickets_mark_unrelated(&self, ticket_id: &str, thread: &str, reason: &str) -> Result<()> {
        let ticket = self.require(ticket_id)?;
        if self.source(&ticket).is_some_and(|trigger| trigger.threads.iter().any(|r| thread_key(r) == thread)) {
            return Err(UserError::new("sourceThread"));
        }
        if !self.repo().thread(thread).is_some_and(|current| current.subscriptions.iter().any(|id| id == ticket_id)) {
            return Err(UserError::new("notFollowing"));
        }
        self.tickets_drop_subscriptions(thread, false, Some(ticket_id), Some(reason));
        for trigger in self.triggers_of(&ticket, None) {
            if trigger.threads.iter().any(|r| thread_key(r) == thread) && self.owners(&trigger).iter().any(|id| id == ticket_id) {
                self.hand_back(ticket_id, &trigger, reason);
            }
        }
        Ok(())
    }

    /// Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order
    /// they were accepted; the others are left alone.
    pub(crate) fn tickets_policy_changed(&self, from: &str, to: &str, effects: &HashMap<String, PolicyEffect>) {
        let at = self.now();
        let mut open = self.repo().open_tickets();
        open.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        for mut ticket in open {
            // `at` is part of the id so repeated transitions between the same versions still record a new Input.
            if let Some(effect) = effects.get(&ticket.id) {
                let input = TicketInput::PolicyChanged {
                    id: key(&["input", &ticket.id, "policy", from, to, &at]),
                    from: from.to_string(),
                    to: to.to_string(),
                    at: at.clone(),
                    effect: effect.clone(),
                };
                self.tickets_add_input(&mut ticket, input);
            }
        }
    }

    /// Drop a Thread's Subscriptions, every ticket's or only `ticket_id`'s, and say so; false when none dropped. Each
    /// ticket keeps deciding the messages it received from the Thread.
    pub(crate) fn tickets_drop_subscriptions(&self, thread: &str, by_person: bool, ticket_id: Option<&str>, reason: Option<&str>) -> bool {
        let Some(mut current) = self.repo().thread(thread) else {
            return false;
        };
        let dropped: Vec<String> = current.subscriptions.iter().filter(|id| ticket_id.is_none_or(|only| only == id.as_str())).cloned().collect();
        if dropped.is_empty() {
            return false;
        }
        current.subscriptions.retain(|id| !dropped.contains(id));
        self.repo().save_thread(&current);
        for id in dropped {
            self.emit(DomainEvent::ThreadUnsubscribed { thread_key: current.key.clone(), ticket_id: id, by_person, reason: reason.map(str::to_string) });
        }
        true
    }

    /// Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment
    /// whose launch failed once no person is waited for: a Policy change alone does not launch it again.
    pub(crate) fn tickets_add_input(&self, ticket: &mut Ticket, input: TicketInput) {
        if ticket.input(input.id()).is_some() {
            return;
        }
        let id = input.id().to_string();
        let automatic = input.automatic();
        ticket.inputs.push(input);
        ticket.updated_at = self.now();
        // Hold back automated inputs while the worker is waiting on a person.
        let held = ticket.live() && automatic && ticket.waits_for_person();
        if !held {
            ticket.undelivered.push(id);
        }
        self.repo().save_ticket(ticket);
        if !ticket.live() || held {
            return;
        }
        if let Some(running) = ticket.running() {
            self.o.executor.deliver(ticket, running);
        } else if let Some(latest) = ticket.latest().filter(|a| a.state == AssignmentState::Pending) {
            if !ticket.waits_for_person() {
                self.o.executor.start(ticket, latest);
            }
        }
    }

    /// Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it:
    /// no Eval and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds
    /// stays ended and takes nothing. While processing is paused the message waits. Idempotent.
    pub(crate) fn tickets_wake(&self, ticket_id: &str) {
        let Some(mut ticket) = self.repo().ticket(ticket_id) else {
            return;
        };
        if ticket.live() || ticket.stopped_by_person() || ticket.undelivered.is_empty() {
            return;
        }
        let policy = self.policy();
        if policy.paused() {
            return;
        }
        if !policy.revalidate(&ticket.mandate) {
            self.refuse(ticket);
            return;
        }
        // Only a human's message resumes an ended ticket; bot triggers wait alongside inputs from before the ticket ended.
        let first = ticket.undelivered.iter().find_map(|id| match ticket.input(id) {
            Some(TicketInput::Trigger { human: true, trigger_id, .. }) => Some(trigger_id.clone()),
            _ => None,
        });
        let Some(trigger_id) = first else { return };
        let at = self.now();
        ticket.ended = None;
        ticket.updated_at = at.clone();
        let assignment = self.new_assignment(&mut ticket);
        // The resumed marker is delivered ahead of the waiting messages.
        let resumed = TicketInput::Resumed { id: key(&["input", &ticket.id, "resumed", &trigger_id]), trigger_id: trigger_id.clone(), at };
        ticket.undelivered.insert(0, resumed.id().to_string());
        ticket.inputs.push(resumed);
        self.repo().save_ticket(&ticket);
        self.o.executor.start(&ticket, &assignment);
        self.emit(DomainEvent::TicketResumed { ticket_id: ticket_id.to_string(), trigger_id });
    }

    /// The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`.
    fn triggers_of(&self, ticket: &Ticket, ids: Option<&[String]>) -> Vec<Trigger> {
        ticket
            .inputs
            .iter()
            .filter(|input| ids.is_none_or(|ids| ids.iter().any(|id| id == input.id())))
            .filter_map(|input| input.trigger_id().and_then(|id| self.repo().trigger(id)))
            .collect()
    }

    /// Whether a ticket's worker took a person's message up, by acknowledging or answering it.
    fn taken_up(&self, ticket: &Ticket, trigger: &Trigger) -> bool {
        self.repo().disposition(&trigger.id).is_some_and(|d| d.acked.contains(&ticket.id))
    }

    /// The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up.
    fn untaken(&self, ticket: &Ticket, ids: &[String]) -> Vec<Trigger> {
        self.triggers_of(ticket, Some(ids)).into_iter().filter(|trigger| self.owners(trigger).contains(&ticket.id) && !self.taken_up(ticket, trigger)).collect()
    }

    /// A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the
    /// person's messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and
    /// each of `left` that no other ticket decides goes to Eval, unless a ticket took it up, a Decision settled it, or
    /// it is the message a stop ended this ticket on.
    fn let_go(&self, ticket_id: &str, waiting: &[Trigger], left: &[Trigger]) {
        for trigger in waiting.iter().chain(left) {
            if let Some(mut disposition) = self.repo().disposition(&trigger.id) {
                if disposition.fanout.iter().any(|id| id == ticket_id) {
                    disposition.fanout.retain(|id| id != ticket_id);
                    self.repo().save_disposition(&trigger.id, &disposition);
                }
            }
        }
        for trigger in left {
            let disposition = self.repo().disposition(&trigger.id);
            let decision = disposition.as_ref().and_then(|d| d.decision_id.as_deref()).and_then(|id| self.repo().decision(id));
            let handbacks = disposition.as_ref().is_some_and(|d| !d.handbacks.is_empty());
            let acked = disposition.as_ref().is_some_and(|d| !d.acked.is_empty());
            // The main Session that stopped this ticket on the message decides the rest of it itself, unless a ticket handed it back.
            let decided = decision.as_ref().is_some_and(|decision| {
                settled(decision) || (decision.kind == DecisionKind::Stop && decision.ticket_id.as_deref() == Some(ticket_id) && !handbacks)
            });
            if self.owners(trigger).is_empty() && !acked && !decided {
                self.queue_for_eval(trigger);
            }
        }
    }

    /// An ended ticket that cannot resume takes none of the messages that waited for it.
    fn refuse(&self, mut ticket: Ticket) {
        let waiting = self.triggers_of(&ticket, Some(&ticket.undelivered));
        let left = self.untaken(&ticket, &ticket.undelivered);
        ticket.undelivered.clear();
        self.repo().save_ticket(&ticket);
        self.let_go(&ticket.id, &waiting, &left);
    }

    /// Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch.
    pub(crate) fn tickets_restart(&self, ticket: &mut Ticket, running_id: &str, reason: &str, note: &str) {
        self.end_assignment(ticket, running_id, reason);
        self.requeue_untaken(ticket, running_id);
        let assignment = self.new_assignment(ticket);
        let at = self.now();
        let input = TicketInput::Text { id: key(&["input", &ticket.id, "restart", &assignment.id]), text: note.to_string(), at: at.clone() };
        ticket.undelivered.push(input.id().to_string());
        ticket.inputs.push(input);
        ticket.updated_at = at;
        self.repo().save_ticket(ticket);
        self.o.executor.start(ticket, &assignment);
    }

    /// Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a
    /// cancel may have dropped them, or a step that claimed them was cut off.
    fn requeue_untaken(&self, ticket: &mut Ticket, replaced: &str) {
        let untaken: Vec<String> = ticket
            .inputs
            .iter()
            .filter(|input| matches!(input, TicketInput::Trigger { read_at: Read::Waiting, delivered_to: Some(to), .. } if to == replaced))
            .map(|input| input.id().to_string())
            .filter(|id| !ticket.undelivered.contains(id))
            .collect();
        ticket.undelivered.splice(0..0, untaken);
    }

    /// End a ticket with its outcome; `reason` says why in words, by default the outcome. The ticket lets go of the
    /// messages its worker never received, and of the person's messages it decides that its worker did not read before
    /// its latest report or turn end and neither acknowledged, answered nor handed back.
    pub(crate) fn tickets_end(&self, ticket_id: &str, by: TicketEndBy, outcome: TicketOutcome, at: Option<&str>, reason: Option<&str>) -> Result<()> {
        let mut ticket = self.require(ticket_id)?;
        if !ticket.live() {
            return Ok(());
        }
        let at = at.map(str::to_string).unwrap_or_else(|| self.now());
        let why = reason.filter(|reason| *reason != outcome.as_str()).map(str::to_string);
        let until = ticket.read_until(true);
        let waiting = self.triggers_of(&ticket, Some(&ticket.undelivered));
        let unread: Vec<String> = ticket
            .inputs
            .iter()
            .filter(|input| input.trigger_id().is_some() && (!read_before(input, &until) || ticket.undelivered.iter().any(|id| id == input.id())))
            .map(|input| input.id().to_string())
            .collect();
        let left = self.untaken(&ticket, &unread);
        ticket.ended = Some(Ended { at: at.clone(), by, outcome, reason: why.clone() });
        ticket.undelivered.clear();
        if outcome != TicketOutcome::Completed {
            ticket.answers.clear();
        }
        ticket.updated_at = self.now();
        ticket.attention = None;
        ticket.delivery = None;
        // The Assignments the end stops end with it; the ticket's end says why.
        let mut stopping = Vec::new();
        for assignment in ticket.assignments.iter_mut().filter(|a| a.state != AssignmentState::Ended) {
            assignment.state = AssignmentState::Ended;
            assignment.ended_at = Some(at.clone());
            stopping.push(assignment.clone());
        }
        self.repo().save_ticket(&ticket);
        self.let_go(ticket_id, &waiting, &left);
        self.emit(DomainEvent::TicketEnded { ticket_id: ticket_id.to_string(), by, outcome, reason: why });
        for assignment in &stopping {
            self.o.executor.stop(&ticket, assignment, reason.unwrap_or(outcome.as_str()));
        }
        Ok(())
    }

    /// Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket.
    fn new_assignment(&self, ticket: &mut Ticket) -> Assignment {
        let assignment = Assignment {
            id: key(&["assignment", &ticket.id, &ticket.assignments.len().to_string()]),
            state: AssignmentState::Pending,
            created_at: self.now(),
            started_at: None,
            ended_at: None,
            ended_reason: None,
            report: None,
            delivered_at: None,
            idle_at: None,
        };
        ticket.assignments.push(assignment.clone());
        ticket.delivery = None;
        assignment
    }

    fn end_assignment(&self, ticket: &mut Ticket, assignment_id: &str, reason: &str) -> Assignment {
        let now = self.now();
        let assignment = ticket.assignments.iter_mut().find(|a| a.id == assignment_id).expect("assignment belongs to its ticket");
        assignment.state = AssignmentState::Ended;
        assignment.ended_at = Some(now);
        assignment.ended_reason = Some(reason.to_string());
        let ended = assignment.clone();
        self.emit(DomainEvent::AssignmentEnded { ticket_id: ticket.id.clone(), assignment_id: assignment_id.to_string(), reason: reason.to_string() });
        ended
    }

    /// Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing.
    pub(crate) fn tickets_note(&self, ticket_id: &str, text: &str) -> Result<Ticket> {
        let mut ticket = self.require(ticket_id)?;
        if !ticket.live() {
            return Err(UserError::new("ticketEnded"));
        }
        let at = self.now();
        let input = TicketInput::Note { id: key(&["input", ticket_id, "note", &at, text]), text: text.to_string(), at };
        self.tickets_add_input(&mut ticket, input);
        self.require(ticket_id)
    }

    /// Subscribe an open ticket to a Thread its Executor found related, for context.
    pub(crate) fn tickets_follow_for_context(&self, ticket_id: &str, reference: &ThreadRef) -> Result<bool> {
        if !self.require(ticket_id)?.live() {
            return Err(UserError::new("ticketEnded"));
        }
        if self.thread_of(reference).subscriptions.iter().any(|id| id == ticket_id) {
            return Ok(false);
        }
        self.subscribe(ticket_id, reference);
        let mut thread = self.thread_of(reference);
        thread.context.push(ticket_id.to_string());
        self.repo().save_thread(&thread);
        Ok(true)
    }

    /// Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context.
    fn subscribe(&self, ticket_id: &str, reference: &ThreadRef) {
        let mut thread = self.thread_of(reference);
        if !thread.subscriptions.iter().any(|id| id == ticket_id) {
            thread.subscriptions.push(ticket_id.to_string());
            self.emit(DomainEvent::ThreadSubscribed { thread_key: thread.key.clone(), ticket_id: ticket_id.to_string() });
        }
        thread.context.retain(|id| id != ticket_id);
        self.repo().save_thread(&thread);
    }
}
