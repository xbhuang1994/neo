//! What the Executor and its workers report about the Assignments that run tickets.

use crate::engine::Engine;
use crate::errors::{Result, UserError};
use crate::ids::key;
use crate::model::{AssignmentState, Attention, DeliveryFailure, Read, Report, ReportState, Ticket, TicketEndBy, TicketInput, TicketOutcome};
use crate::ports::DomainEvent;

/// The open question a report carries.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Question {
    /// Keep the current one.
    #[default]
    Keep,
    /// Clear an open one.
    Clear,
    /// Ask this.
    Ask(String),
}

/// What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerReport {
    /// What it reports.
    pub state: ReportState,
    /// In words.
    pub summary: String,
    /// Open question for a person.
    pub question: Question,
    /// The person's message whose request raised the question; routes the question to where it was written.
    pub asked_by: Option<String>,
    /// The person's question this report answers, which the worker thereby takes up; authorizes an answer reply.
    pub answers: Option<String>,
    /// What the ticket is about now, in a sentence or two; replaces the ticket's digest.
    pub topic: Option<String>,
}

impl WorkerReport {
    /// A report with a state and summary only.
    pub fn new(state: ReportState, summary: &str) -> Self {
        WorkerReport { state, summary: summary.to_string(), question: Question::Keep, asked_by: None, answers: None, topic: None }
    }
}

const RECOVERY_NOTE: &str = "The host restarted during this ticket. Inspect the current working directory and its history before continuing. Do not repeat an already completed external operation. Background jobs and subagents of the previous run stopped with it; rerun what you still need. Finish the original assignment and report its status.";

impl Engine {
    /// Marks a non-ended assignment running and queues delivery of waiting Inputs on an open ticket.
    pub(crate) fn assignments_started(&self, ticket_id: &str, assignment_id: &str) -> Result<()> {
        let mut ticket = self.require(ticket_id)?;
        let now = self.now();
        let Some(assignment) = ticket.assignments.iter_mut().find(|a| a.id == assignment_id && a.state != AssignmentState::Ended) else {
            return Ok(());
        };
        assignment.state = AssignmentState::Running;
        assignment.started_at.get_or_insert_with(|| now.clone());
        let assignment = assignment.clone();
        ticket.updated_at = now;
        self.repo().save_ticket(&ticket);
        if ticket.live() && !ticket.undelivered.is_empty() {
            self.o.executor.deliver(&ticket, &assignment);
        }
        self.emit(DomainEvent::AssignmentStarted { ticket_id: ticket_id.to_string(), assignment_id: assignment_id.to_string() });
        Ok(())
    }

    /// Marks `input_ids` delivered on the ticket's running assignment and clears any prior delivery failure; ignored if
    /// that assignment no longer runs.
    pub(crate) fn assignments_delivered(&self, ticket_id: &str, assignment_id: &str, input_ids: &[String]) -> Result<()> {
        let Some(mut ticket) = self.running_ticket(ticket_id, assignment_id)? else {
            return Ok(());
        };
        let now = self.now();
        ticket.undelivered.retain(|id| !input_ids.contains(id));
        ticket.updated_at = now.clone();
        if let Some(running) = ticket.running_mut() {
            running.delivered_at = Some(now);
        }
        for input in &mut ticket.inputs {
            if let TicketInput::Trigger { id, read_at, delivered_to, .. } = input {
                if input_ids.contains(id) {
                    if *read_at == Read::Undelivered {
                        *read_at = Read::Waiting;
                    }
                    *delivered_to = Some(assignment_id.to_string());
                }
            }
        }
        ticket.delivery = None;
        self.repo().save_ticket(&ticket);
        Ok(())
    }

    /// Records when the worker's Session of an open ticket took `input_ids` into a step, from which its model reads them.
    pub(crate) fn assignments_read(&self, ticket_id: &str, input_ids: &[String]) -> Result<()> {
        let mut ticket = self.require(ticket_id)?;
        if !ticket.live() {
            return Ok(());
        }
        let now = self.now();
        for input in &mut ticket.inputs {
            if let TicketInput::Trigger { id, read_at, .. } = input {
                if input_ids.contains(id) && !matches!(read_at, Read::At(_)) {
                    *read_at = Read::At(now.clone());
                }
            }
        }
        self.repo().save_ticket(&ticket);
        Ok(())
    }

    pub(crate) fn assignments_turn_ended(&self, ticket_id: &str, assignment_id: &str) -> Result<()> {
        let Some(mut ticket) = self.running_ticket(ticket_id, assignment_id)? else {
            return Ok(());
        };
        let now = self.now();
        if let Some(running) = ticket.running_mut() {
            running.idle_at = Some(now);
        }
        self.repo().save_ticket(&ticket);
        Ok(())
    }

    pub(crate) fn assignments_delivery_failed(&self, ticket_id: &str, assignment_id: &str, error: &str) -> Result<()> {
        let Some(mut ticket) = self.running_ticket(ticket_id, assignment_id)? else {
            return Ok(());
        };
        ticket.delivery = Some(DeliveryFailure { error: error.chars().take(300).collect(), at: self.now() });
        self.repo().save_ticket(&ticket);
        Ok(())
    }

    /// Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest
    /// report is `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case
    /// it keeps its session and flushes any waiting inputs.
    pub(crate) fn assignments_interrupted(&self, ticket_id: &str, assignment_id: &str) -> Result<()> {
        let Some(mut ticket) = self.running_ticket(ticket_id, assignment_id)? else {
            return Ok(());
        };
        let Some(running) = ticket.running().cloned() else {
            return Ok(());
        };
        let busy = matches!((&running.delivered_at, &running.report), (Some(delivered), Some(report)) if delivered >= &report.at);
        let settled =
            running.report.as_ref().is_some_and(|r| matches!(r.state, ReportState::Waiting | ReportState::Ready | ReportState::Blocked | ReportState::Failed))
                && !busy;
        if !settled {
            self.tickets_restart(&mut ticket, &running.id, "hostRestarted", RECOVERY_NOTE);
        } else if !ticket.undelivered.is_empty() {
            self.o.executor.deliver(&ticket, &running);
        }
        Ok(())
    }

    /// Records a worker status report on an open ticket's current assignment, updating its question, answers and held
    /// automated inputs, and ending the ticket when `dropped` or `ready`.
    pub(crate) fn assignments_report(&self, ticket_id: &str, report: WorkerReport) -> Result<Ticket> {
        let mut ticket = self.require(ticket_id)?;
        if !ticket.live() {
            return Err(UserError::new("ticketEnded"));
        }
        let asks = matches!(report.question, Question::Ask(_));
        if asks && (report.state == ReportState::Ready || report.answers.is_some()) {
            return Err(UserError::new("questionWithResult"));
        }
        if report.asked_by.is_some() && !asks {
            return Err(UserError::new("askerWithoutQuestion"));
        }
        let person = |id: &str, channel: bool| {
            self.repo().trigger(id).is_some_and(|trigger| trigger.human && (!channel || trigger.channel.is_some()) && self.reaches(&ticket, &trigger, false))
        };
        if report.asked_by.as_deref().is_some_and(|id| !person(id, true)) {
            return Err(UserError::new("notAsker"));
        }
        if report.answers.as_deref().is_some_and(|id| !person(id, false)) {
            return Err(UserError::new("notAnswerable"));
        }
        let index = ticket
            .assignments
            .iter()
            .position(|a| a.state == AssignmentState::Running)
            .or_else(|| ticket.assignments.len().checked_sub(1))
            .ok_or_else(|| UserError::new("unknownAssignment"))?;
        if ticket.assignments[index].state == AssignmentState::Ended {
            return Err(UserError::new("assignmentEnded"));
        }
        let at = self.now();
        let previous = ticket.attention.clone();
        let asked = match &report.question {
            Question::Ask(question) if previous.as_ref().map(|p| p.question.as_str()) != Some(question.as_str()) => {
                Some(Attention { id: key(&["attention", ticket_id, question, &at]), question: question.clone(), trigger_id: report.asked_by.clone() })
            }
            _ => previous.clone(),
        };
        let attention = if report.question == Question::Clear || report.state == ReportState::Ready { None } else { asked };
        // A replaced or cleared question withdraws any pending unsent reply for the previous one from the outbox.
        if let Some(previous) = &previous {
            if attention.as_ref().map(|a| a.id.as_str()) != Some(previous.id.as_str()) {
                self.replies_withdraw_attention(&previous.id);
            }
        }
        ticket.attention = attention;
        ticket.assignments[index].report = Some(Report { state: report.state, summary: report.summary.clone(), at: at.clone() });
        // A drop only hands a message back or says nothing is left; it never says what the ticket is about now.
        if let Some(topic) = report.topic.as_ref().filter(|topic| !topic.is_empty() && report.state != ReportState::Dropped) {
            ticket.digest = Some(topic.clone());
        }
        ticket.updated_at = at.clone();
        if let Some(answered) = &report.answers {
            if !ticket.answers.contains(answered) {
                ticket.answers.push(answered.clone());
            }
            self.take_up(ticket_id, answered);
        }
        if matches!(report.state, ReportState::Blocked | ReportState::Failed) {
            let automatic: Vec<String> = ticket.undelivered.iter().filter(|id| ticket.input(id).is_none_or(TicketInput::automatic)).cloned().collect();
            ticket.undelivered.retain(|id| !automatic.contains(id));
        }
        self.repo().save_ticket(&ticket);
        let outcome = match report.state {
            ReportState::Dropped => Some(TicketOutcome::Dropped),
            ReportState::Ready => Some(TicketOutcome::Completed),
            _ => None,
        };
        if let Some(outcome) = outcome {
            self.tickets_end(ticket_id, TicketEndBy::Executor, outcome, Some(&at), None)?;
        }
        self.require(ticket_id)
    }

    /// The ticket, while it is open and `assignment_id` runs it.
    fn running_ticket(&self, ticket_id: &str, assignment_id: &str) -> Result<Option<Ticket>> {
        let ticket = self.require(ticket_id)?;
        Ok((ticket.live() && ticket.running().is_some_and(|a| a.id == assignment_id)).then_some(ticket))
    }
}
