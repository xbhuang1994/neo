//! Ticket stage classification and retry eligibility.

use crate::model::{AssignmentState, ReportState, Ticket};

/// What a person is waited on for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersonAction {
    /// Delivering an Input to the worker failed.
    Delivery,
    /// The worker asked a question.
    Answer,
    /// A result is ready to review.
    Review,
    /// The worker reported blocked.
    Blocked,
    /// The worker reported failed.
    Failed,
}

impl PersonAction {
    /// The action's name in views.
    pub fn as_str(self) -> &'static str {
        match self {
            PersonAction::Delivery => "delivery",
            PersonAction::Answer => "answer",
            PersonAction::Review => "review",
            PersonAction::Blocked => "blocked",
            PersonAction::Failed => "failed",
        }
    }
}

/// High-level execution stage of a ticket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketStage {
    /// Waiting on a person.
    Person(PersonAction),
    /// Actively working, or `queued` for launch.
    Working {
        /// Its Assignment has not started.
        queued: bool,
    },
    /// Idle between turns.
    Idle,
    /// Over.
    Ended,
}

/// Classifies a ticket's stage; the first matching rule wins.
pub fn ticket_stage(ticket: &Ticket) -> TicketStage {
    if ticket.ended.is_some() {
        return TicketStage::Ended;
    }
    if ticket.delivery.is_some() {
        return TicketStage::Person(PersonAction::Delivery);
    }
    if ticket.attention.is_some() {
        return TicketStage::Person(PersonAction::Answer);
    }
    let assignment = ticket.latest();
    let report = assignment.and_then(|a| a.report.as_ref()).map(|r| r.state);
    if report == Some(ReportState::Ready) {
        return TicketStage::Person(PersonAction::Review);
    }
    // A human follow-up after a blocked or failed report returns the ticket to the executor.
    if ticket.waits_for_person() {
        return TicketStage::Person(if report == Some(ReportState::Blocked) { PersonAction::Blocked } else { PersonAction::Failed });
    }
    match assignment {
        None => TicketStage::Working { queued: true },
        Some(a) if a.state == AssignmentState::Pending => TicketStage::Working { queued: true },
        Some(a) if report == Some(ReportState::Waiting) || a.state == AssignmentState::Ended => TicketStage::Idle,
        Some(_) => TicketStage::Working { queued: false },
    }
}

/// True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery.
pub fn can_retry(ticket: &Ticket) -> bool {
    ticket.ended.is_none() && (ticket.waits_for_person() || ticket.delivery.is_some())
}
