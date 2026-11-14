//! Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing.

use crate::engine::{Engine, ReceiveResult};
use crate::errors::{Result, UserError};
use crate::ids::key;
use crate::model::{thread_key, Read, Ticket, TicketInput, Trigger, TriggerDisposition};
use crate::ports::{DomainEvent, ScopeResult};
use crate::reasons::Reason;
use crate::time::iso_time;

impl Engine {
    pub(crate) fn intake_receive(&self, received: Trigger) -> Result<ReceiveResult> {
        let trigger = Trigger { at: iso_time(&received.at), ..received };
        if trigger.threads.is_empty() {
            return Err(UserError::invalid("A trigger must belong to at least one thread"));
        }
        if self.repo().trigger(&trigger.id).is_some() {
            return Ok(ReceiveResult::Duplicate);
        }
        let at = self.now();
        let fan = match self.o.scope.scope(&trigger.source, &trigger.meta) {
            ScopeResult::Ignored { reason } => {
                self.repo().save_trigger(&trigger);
                let disposition = TriggerDisposition { filtered: Some(Reason::code(&reason)), ..TriggerDisposition::at(&at) };
                self.repo().save_disposition(&trigger.id, &disposition);
                return Ok(ReceiveResult::Filtered);
            }
            ScopeResult::Listened { fanout, .. } => fanout,
        };
        self.repo().save_trigger(&trigger);
        let keys: Vec<String> = trigger.threads.iter().map(thread_key).collect();
        // The tickets reached, and whether only on Threads they follow for context (a ticket's own Thread makes it false).
        let mut reached: Vec<(Ticket, bool)> = Vec::new();
        for reference in &trigger.threads {
            let mut thread = self.thread_of(reference);
            if thread.last_at.as_deref().is_none_or(|last| trigger.at.as_str() > last) {
                thread.last_at = Some(trigger.at.clone());
            }
            for other in keys.iter().filter(|other| **other != thread.key) {
                if !thread.correlated.contains(other) {
                    thread.correlated.push(other.clone());
                }
            }
            for ticket_id in thread.subscriptions.iter().filter(|_| fan) {
                let Some(ticket) = self.repo().ticket(ticket_id) else {
                    continue;
                };
                // Only a person's message on a non-context thread resumes an ended ticket; bots do not, and a
                // human-stopped ticket receives nothing because its Mandate was withdrawn.
                let followed = thread.context.contains(ticket_id);
                let resumes = trigger.human && !ticket.stopped_by_person() && !followed;
                if !ticket.live() && !resumes {
                    continue;
                }
                match reached.iter_mut().find(|(known, _)| known.id == *ticket_id) {
                    Some(entry) => *entry = (ticket, followed && entry.1),
                    None => reached.push((ticket, followed)),
                }
            }
            self.repo().save_thread(&thread);
        }
        for (ticket, followed) in &mut reached {
            let input = TicketInput::Trigger {
                id: key(&["input", &ticket.id, "trigger", &trigger.id]),
                trigger_id: trigger.id.clone(),
                at: at.clone(),
                note: None,
                human: trigger.human,
                context: *followed,
                read_at: Read::Undelivered,
                delivered_to: None,
            };
            self.tickets_add_input(ticket, input);
        }
        let fanout: Vec<String> = reached.iter().map(|(ticket, _)| ticket.id.clone()).collect();
        let context: Vec<String> = reached.iter().filter(|(_, followed)| *followed).map(|(ticket, _)| ticket.id.clone()).collect();
        self.repo().save_disposition(&trigger.id, &TriggerDisposition { fanout: fanout.clone(), context, ..TriggerDisposition::at(&at) });
        // A person's message that no ticket decides, such as one that reached only tickets a person stopped or that
        // follow the Thread for context, and every bot's, goes to Eval.
        if self.owners(&trigger).is_empty() {
            self.queue_for_eval(&trigger);
        }
        for ticket_id in &fanout {
            self.tickets_wake(ticket_id);
        }
        self.emit(DomainEvent::TriggerReceived { trigger_id: trigger.id.clone(), threads: keys });
        Ok(ReceiveResult::Stored)
    }
}
