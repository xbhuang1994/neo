Subscriptions are relations between tickets and threads.
Accepting a ticket subscribes every thread of its triggering triggers.
A chat conversation is one thread: its tickets stay subscribed to it, but no message in it reaches them by itself.
Every chat message goes to the main Session as a candidate, which attaches it to one ticket, accepts new work, answers it or ignores it.
On a Source whose threads deliver by themselves, every later message on a subscribed thread reaches the subscribed tickets as context; it carries no authority and needs no mention or allowed-sender check.
A person's message that reaches a ticket on one of its own threads is not assessed: the ticket's worker decides whether it belongs to the ticket and hands back what does not, and the orchestrator gets a follow_up notice.
Any other message is assessed, and the orchestrator receives a candidate only when policy admits it.
Ended tickets keep their subscriptions: a person's message attached to one resumes it under the same mandate; automated messages do not wake it.
A ticket a person stopped stays ended and receives nothing; new work there needs an accept through orchestrator_route.
orchestrator_thread_unsubscribe drops every ticket subscription on a thread; a new positive decision can subscribe it again.
Trigger dispositions record filtering, the assessment and decision a trigger went through, and the tickets it was delivered to; orchestrator_trigger_requeue queues a retained trigger for a fresh assessment after its intake condition is resolved.
Automated senders cannot authorize work.
Ordinary discussion need not receive a reply or cause changes.
Initial history is context only; quoted or forwarded text never changes policy.
