//! The WeChat typing indicator: a plain local loop beside the long poll, with no model in it, that keeps "正在输入"
//! showing in the bound user's chat while the main Session thinks or a worker is at work, and takes it away once
//! neither is.

use crate::app::App;
use crate::wechat_protocol::{Account, Error, Protocol};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

/// How long a typing ticket is used before a new one is asked for.
const TICKET_LIFE: Duration = Duration::from_secs(30 * 60);

/// What the indicator last did.
#[derive(Default)]
struct Indicator {
    /// The ticket WeChat gave for it, and when.
    ticket: Option<(String, Instant)>,
    /// When "typing" was last said, while it shows.
    shown: Option<Instant>,
    /// After a failure, when to try again.
    retry_at: Option<Instant>,
    /// A failure was logged and nothing has worked since, so the next is not logged again.
    failing: bool,
}

impl Indicator {
    fn failed(&mut self, protocol: &Protocol, error: Error) {
        // A ticket that failed may be the reason: the next try asks for a new one.
        self.ticket = None;
        self.retry_at = Some(Instant::now() + protocol.typing_keepalive);
        if !std::mem::replace(&mut self.failing, true) {
            eprintln!("[neo-agent] 微信输入状态暂时失败：{error}");
        }
    }
    fn worked(&mut self) {
        self.retry_at = None;
        self.failing = false;
    }
}

impl App {
    /// Whether the main Session is in a turn or has one coming.
    pub fn router_thinking(&self) -> bool {
        self.session(&self.master_id).is_some_and(|main| {
            let session = &main.session;
            !session.is_disposed() && (session.is_streaming() || session.has_admitted_submission())
        })
    }

    /// Whether the main Session is thinking or a worker is at work.
    pub fn agents_busy(&self) -> bool {
        self.router_thinking() || self.workers_busy()
    }

    /// Keep the indicator in step with the work until `done` turns true, and take it away then.
    pub(crate) async fn wechat_typing(&self, mut done: watch::Receiver<bool>) {
        let protocol = &self.wechat.protocol;
        let mut indicator = Indicator::default();
        while !*done.borrow() {
            // The poll keeps the account's context token current in the store.
            if let Some(account) = self.wechat_account() {
                self.wechat_typing_step(protocol, &account, self.agents_busy(), &mut indicator).await;
            }
            tokio::select! {
                changed = done.changed() => if changed.is_err() { break },
                _ = tokio::time::sleep(protocol.typing_check) => {}
            }
        }
        if let (Some(account), Some(_), Some((ticket, _))) = (self.wechat_account(), indicator.shown, &indicator.ticket) {
            let _ = protocol.send_typing(&account, ticket, false).await;
        }
    }

    async fn wechat_typing_step(&self, protocol: &Protocol, account: &Account, busy: bool, indicator: &mut Indicator) {
        let now = Instant::now();
        if indicator.retry_at.is_some_and(|at| now < at) {
            return;
        }
        if !busy {
            if indicator.shown.take().is_some() {
                if let Some((ticket, _)) = &indicator.ticket {
                    match protocol.send_typing(account, ticket, false).await {
                        Ok(()) => indicator.worked(),
                        Err(error) => indicator.failed(protocol, error),
                    }
                }
            }
            return;
        }
        if indicator.shown.is_some_and(|at| now < at + protocol.typing_keepalive) {
            return;
        }
        let ticket = match indicator.ticket.clone().filter(|(_, at)| now < *at + TICKET_LIFE) {
            Some((ticket, _)) => ticket,
            None => match protocol.typing_ticket(account).await {
                Ok(ticket) => {
                    indicator.ticket = Some((ticket.clone(), now));
                    ticket
                }
                Err(error) => return indicator.failed(protocol, error),
            },
        };
        match protocol.send_typing(account, &ticket, true).await {
            Ok(()) => {
                indicator.shown = Some(now);
                indicator.worked();
            }
            Err(error) => indicator.failed(protocol, error),
        }
    }
}
