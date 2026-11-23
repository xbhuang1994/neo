//! The Engine's messages to Channels, each by the rule that allows it.

use crate::engine::Engine;
use crate::errors::{Result, UserError};
use crate::ids::key;
use crate::model::{ChannelRef, ReportState, Ticket, TicketOutcome, Trigger};
use crate::ports::{MessageKind, OutboundMessage, ReplyStatus};

/// What a reply is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// An Executor's acknowledgement of a person's request it works on.
    Acknowledgement,
    /// The answer to a person's question once the worker reported it.
    Answer,
    /// The result of a ticket that is ready, completed, or dropped.
    Result,
    /// The ticket's current question for a person.
    Attention,
}

/// A message for a Channel, by purpose. When `ticket_id` is omitted, the ticket that `trigger_id` reached is used.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplyRequest {
    /// What it is for.
    pub purpose: Purpose,
    /// The ticket it is for.
    pub ticket_id: Option<String>,
    /// The person's message it replies to.
    pub trigger_id: Option<String>,
    /// For `Attention`: the ticket's current question.
    pub question: Option<String>,
    /// What it says.
    pub text: String,
}

/// A queued message: its id, whether it went out, and whether an earlier request had queued it already.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    /// The message's id in the outbox.
    pub id: String,
    /// What became of it.
    pub status: ReplyStatus,
    /// An earlier request queued it already.
    pub reused: bool,
}

impl Engine {
    /// Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's
    /// message was written, attention where the message that raised the question was (or to the ticket's starting
    /// conversation), and a result to the conversation where the ticket started. Each is queued at most once.
    pub(crate) fn replies_reply(&self, request: ReplyRequest) -> Result<Reply> {
        if request.purpose == Purpose::Acknowledgement {
            self.acknowledge(request)
        } else {
            self.answer(request)
        }
    }

    /// Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a
    /// Channel and a person wrote it.
    pub(crate) fn replies_acknowledge_accepted(&self, ticket_id: &str, trigger: &Trigger, text: &str) {
        if let Some(channel) = trigger.channel.clone().filter(|_| trigger.human) {
            self.o.outbox.send(OutboundMessage {
                id: key(&["ack", &trigger.id]),
                channel,
                text: text.to_string(),
                kind: MessageKind::Acknowledgement,
                ticket_id: Some(ticket_id.to_string()),
            });
        }
    }

    /// Withdraw a ticket's question for a person from the outbox, unless it went out already.
    pub(crate) fn replies_withdraw_attention(&self, attention_id: &str) {
        self.o.outbox.withdraw(&key(&["attention-reply", attention_id]));
    }

    fn acknowledge(&self, request: ReplyRequest) -> Result<Reply> {
        let ticket = self.require(request.ticket_id.as_deref().unwrap_or(""))?;
        if !ticket.live() {
            return Err(UserError::new("ackEnded"));
        }
        let trigger = request.trigger_id.as_deref().and_then(|id| self.repo().trigger(id)).ok_or_else(|| UserError::new("unknownTrigger"))?;
        // Context-only threads are read-only and cannot receive acknowledgements.
        if !self.reaches(&ticket, &trigger, false) {
            return Err(UserError::new("notReached"));
        }
        let Some(channel) = trigger.channel.clone() else {
            return Err(UserError::new("ackNoChannel"));
        };
        let id = key(&["ack", &trigger.id]);
        let existing = self.o.outbox.status(&id);
        if existing.is_none() && !trigger.human {
            return Err(UserError::new("ackNotPerson"));
        }
        // The automatic or first queued acknowledgement stays.
        if existing.is_none() {
            self.o.outbox.send(OutboundMessage {
                id: id.clone(),
                channel,
                text: request.text,
                kind: MessageKind::Acknowledgement,
                ticket_id: Some(ticket.id.clone()),
            });
        }
        self.take_up(&ticket.id, &trigger.id);
        Ok(Reply { status: self.o.outbox.status(&id).unwrap_or(ReplyStatus::Pending), id, reused: existing.is_some() })
    }

    fn answer(&self, request: ReplyRequest) -> Result<Reply> {
        let trigger = match &request.trigger_id {
            Some(id) => Some(self.repo().trigger(id).ok_or_else(|| UserError::new("unknownTrigger"))?),
            None => None,
        };
        // A hand-back returns the message to the orchestrator; it no longer waits for that ticket's worker to answer it.
        let disposition = trigger.as_ref().and_then(|t| self.repo().disposition(&t.id));
        let returned = |ticket_id: &str| disposition.as_ref().is_some_and(|d| d.handed_back_by(ticket_id));
        // The ticket a message went to, as its origin or an Input.
        let mut ticket = match (&request.ticket_id, &trigger) {
            (Some(id), _) => Some(self.require(id)?),
            (None, Some(trigger)) => self
                .repo()
                .tickets()
                .into_iter()
                .find(|item| !returned(&item.id) && (item.origin.trigger_ids.contains(&trigger.id) || item.has_trigger_input(&trigger.id))),
            (None, None) => None,
        };
        if request.purpose == Purpose::Result {
            let ready = ticket.as_ref().is_some_and(|ticket| match &ticket.ended {
                Some(ended) => matches!(ended.outcome, TicketOutcome::Completed | TicketOutcome::Dropped),
                None => ticket.latest().and_then(|a| a.report.as_ref()).is_some_and(|r| r.state == ReportState::Ready),
            });
            if !ready {
                return Err(UserError::new("notReady"));
            }
        }
        let attention = if request.purpose == Purpose::Attention { ticket.as_ref().and_then(|t| t.attention.clone()) } else { None };
        // Attention replies must match the ticket's currently open question text.
        if request.purpose == Purpose::Attention && attention.as_ref().map(|a| a.question.as_str()) != request.question.as_deref() {
            return Err(UserError::new("notAttention"));
        }
        if request.purpose == Purpose::Attention && attention.is_none() {
            return Err(UserError::new("notAttention"));
        }
        if request.purpose == Purpose::Answer && !trigger.as_ref().is_some_and(|t| t.human) {
            return Err(UserError::new("notQuestion"));
        }
        let id = match &attention {
            Some(attention) => key(&["attention-reply", &attention.id]),
            None => key(&["reply", trigger.as_ref().map(|t| t.id.as_str()).or(ticket.as_ref().map(|t| t.id.as_str())).unwrap_or(""), &request.text]),
        };
        let existing = self.o.outbox.status(&id);
        // A result goes out once per report: the same words again reuse the message, and other words are refused, so
        // that a worker's direct reply is not followed by the orchestrator's paraphrase of it.
        let reported = ticket.as_ref().and_then(|ticket| ticket.latest_report().map(|report| report.at.clone()));
        if request.purpose == Purpose::Result
            && existing.is_none()
            && reported.is_some()
            && ticket.as_ref().and_then(|ticket| ticket.result_sent.clone()) == reported
        {
            return Err(UserError::new("resultSent"));
        }
        let answered = match (&ticket, &trigger) {
            (Some(ticket), Some(trigger)) => ticket.answers.contains(&trigger.id),
            _ => true,
        };
        if request.purpose == Purpose::Answer && !answered && existing.is_none() {
            return Err(UserError::new("noAnswer"));
        }
        let asker = attention.as_ref().and_then(|a| a.trigger_id.as_deref()).and_then(|id| self.repo().trigger(id));
        let channel = if request.purpose == Purpose::Answer {
            trigger.as_ref().and_then(|t| t.channel.clone())
        } else {
            asker.and_then(|t| t.channel).or_else(|| ticket.as_ref().and_then(|t| self.source_channel(t)))
        };
        let Some(channel) = channel else {
            return Err(UserError::new("noChannel"));
        };
        self.o.outbox.send(OutboundMessage {
            id: id.clone(),
            channel,
            text: request.text,
            kind: MessageKind::Reply,
            ticket_id: ticket.as_ref().map(|t| t.id.clone()),
        });
        if request.purpose == Purpose::Result {
            if let Some(ticket) = ticket.as_mut().filter(|ticket| ticket.result_sent != reported || !ticket.answers.is_empty()) {
                ticket.result_sent = reported;
                ticket.answers.clear();
                self.repo().save_ticket(ticket);
            }
        }
        if request.purpose == Purpose::Answer {
            if let (Some(ticket), Some(trigger)) = (ticket.as_mut(), &trigger) {
                if ticket.answers.contains(&trigger.id) {
                    ticket.answers.retain(|item| *item != trigger.id);
                    self.repo().save_ticket(ticket);
                }
            }
        }
        Ok(Reply { status: self.o.outbox.status(&id).unwrap_or(ReplyStatus::Pending), id, reused: existing.is_some() })
    }

    /// The conversation a ticket started in: its origin Trigger's Channel, else its first Channel.
    fn source_channel(&self, ticket: &Ticket) -> Option<ChannelRef> {
        self.source(ticket).and_then(|trigger| trigger.channel).or_else(|| ticket.channels.first().cloned())
    }
}
