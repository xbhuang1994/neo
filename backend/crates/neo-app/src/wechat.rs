//! The WeChat bridge: one WeChat user, bound by scanning a QR code, talks to the main Session as in the app. It owns
//! the login, the long poll for that user's messages, replies in order, and the binding kept across restarts.

use crate::app::App;
use crate::outbox::Sent;
use crate::sessions::ChatAttachment;
use crate::wechat_protocol::{id_text, mime_of, safe_name, Account, Protocol, MAX_MEDIA_BYTES};
use neo_core::time::{format_iso, now_ms};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

const ACCOUNT: &str = "wechat-account";
const CURSOR: &str = "wechat-cursor";
const LOGIN_MINUTES: i64 = 5;
/// How many questions about a login may fail in a row before the login is given up.
const MAX_STATUS_FAILURES: u32 = 3;
/// How many ids of messages lately taken into a burst are remembered, so one delivered twice is taken once.
const SEEN_IDS: usize = 64;
/// How many files lately received are kept, so a quote of one WeChat sends without its contents finds it.
const RECENT_FILES: usize = 16;
/// The most bytes those files may hold together.
const RECENT_BYTES: usize = 64 * 1024 * 1024;
/// What a burst of files alone says, once nothing more came.
const FILES_ALONE: &str = "[用户只发送了文件，没有说明要做什么；请先确认需求再处理]";

/// The bridge as the app shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeChatStatus {
    /// `disconnected`, `waiting`, `scaned`, `verify`, `connected` or `error`.
    pub state: &'static str,
    /// In words.
    pub message: String,
    /// What the login QR code encodes, for the app to draw, while a login waits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_content: Option<String>,
    /// The bound user as a chat sender.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_id: Option<String>,
}

struct Running {
    id: u64,
    cancel: watch::Sender<bool>,
}

struct Inner {
    state: &'static str,
    message: String,
    qr: Option<String>,
    login: Option<Running>,
    verify_code: Option<String>,
    login_task: Option<JoinHandle<()>>,
    monitor: Option<Running>,
    monitor_task: Option<JoinHandle<()>>,
    seq: u64,
}

impl Inner {
    fn set(&mut self, state: &'static str, message: impl Into<String>) {
        self.state = state;
        self.message = message.into();
        if !matches!(state, "waiting" | "scaned" | "verify") {
            self.qr = None;
        }
    }
    fn next(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }
    fn login_is(&self, id: u64) -> bool {
        self.login.as_ref().is_some_and(|login| login.id == id)
    }
}

/// Messages held back so that a burst, such as a file and then the words about it, reaches the main Session as one.
#[derive(Default)]
struct Burst {
    held: Option<Held>,
    /// Bursts taken out and still on their way to the main Session.
    delivering: usize,
    /// The poll's cursor past held messages, saved once nothing is held or on its way.
    cursor: Option<String>,
    /// Ids lately taken into a burst.
    seen: VecDeque<String>,
    timer: Option<JoinHandle<()>>,
    seq: u64,
}

/// A burst so far: one message to the main Session, under the id of its first.
struct Held {
    user_id: String,
    id: String,
    text: Vec<String>,
    attachments: Vec<ChatAttachment>,
    at: Option<String>,
    /// When its first words came.
    worded: Option<Instant>,
    /// When its last message came.
    last: Instant,
}

impl Held {
    /// When the burst is over, unless more comes: soon after words, later after files alone.
    fn due(&self, protocol: &Protocol) -> Instant {
        match self.worded {
            Some(worded) => (self.last + protocol.quiet).min(worded + protocol.burst_cap),
            None => self.last + protocol.file_wait,
        }
    }
}

/// The bridge's state within the application.
pub struct WeChatState {
    pub(crate) protocol: Protocol,
    inner: Mutex<Inner>,
    burst: Mutex<Burst>,
    /// Files lately received, newest last.
    recent: Mutex<VecDeque<ChatAttachment>>,
    /// Held while a login is being started, so two requests start one.
    connecting: tokio::sync::Mutex<()>,
}

impl WeChatState {
    pub(crate) fn new(protocol: Protocol) -> WeChatState {
        let inner = Inner {
            state: "disconnected",
            message: "尚未连接微信。".into(),
            qr: None,
            login: None,
            verify_code: None,
            login_task: None,
            monitor: None,
            monitor_task: None,
            seq: 0,
        };
        WeChatState { protocol, inner: Mutex::new(inner), burst: Mutex::default(), recent: Mutex::default(), connecting: tokio::sync::Mutex::new(()) }
    }
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn burst(&self) -> MutexGuard<'_, Burst> {
        self.burst.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// What one answer about a login's status leads to.
enum Step {
    /// Ask again.
    Wait,
    /// The login is over, or no longer the current one.
    Over,
    /// An account is bound, newly or as before: listen to it.
    Bound(Account),
}

/// `work`, unless `cancel` turns true first.
async fn unless<T>(cancel: &mut watch::Receiver<bool>, work: impl Future<Output = T>) -> Option<T> {
    tokio::select! {
        biased;
        _ = cancel.wait_for(|cancelled| *cancelled) => None,
        value = work => Some(value),
    }
}

/// A message's structure without what it says: each string by its length, so the log shows what WeChat sent.
fn shape(value: &Value) -> String {
    fn walk(value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(format!("<{}字>", text.chars().count())),
            Value::Array(items) => Value::Array(items.iter().map(walk).collect()),
            Value::Object(fields) => Value::Object(fields.iter().map(|(name, value)| (name.clone(), walk(value))).collect()),
            other => other.clone(),
        }
    }
    let shown = walk(value).to_string();
    shown.chars().take(2000).collect()
}

/// A message id that can name a chat message: the id itself when it is made of plain characters, else its digest.
fn message_id(message: &Value) -> String {
    let id = id_text(&message["message_id"]).or_else(|| id_text(&message["client_id"])).unwrap_or_default();
    if (1..=180).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')) {
        return id;
    }
    Sha256::digest(if id.is_empty() { message.to_string() } else { id }.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

impl App {
    pub(crate) fn wechat_account(&self) -> Option<Account> {
        self.store.get::<Account>(ACCOUNT)
    }

    /// Where the bridge stands.
    pub fn wechat_status(&self) -> WeChatStatus {
        let sender_id = self.wechat_account().map(|account| format!("wechat:{}", account.user_id));
        let inner = self.wechat.inner();
        WeChatStatus { state: inner.state, message: inner.message.clone(), qr_content: inner.qr.clone(), sender_id }
    }

    /// Take up a saved binding again.
    pub(crate) fn wechat_start(self: &Arc<Self>) {
        if let Some(account) = self.wechat_account() {
            self.wechat.inner().set("connected", "微信绑定已恢复。");
            self.wechat_monitor(account);
        }
    }

    /// Stop the login and the long poll; the binding stays.
    pub(crate) async fn wechat_stop(&self) {
        let tasks: Vec<JoinHandle<()>> = {
            let mut inner = self.wechat.inner();
            for running in [inner.login.take(), inner.monitor.take()].into_iter().flatten() {
                running.cancel.send_replace(true);
            }
            [inner.login_task.take(), inner.monitor_task.take()].into_iter().flatten().collect()
        };
        for task in tasks {
            let _ = task.await;
        }
        // A held burst is let go with its cursor unsaved: the next poll after a start brings its messages again.
        let mut burst = self.wechat.burst();
        if let Some(timer) = burst.timer.take() {
            timer.abort();
        }
        burst.held = None;
        burst.cursor = None;
        burst.seq += 1;
    }

    /// Connect: with a binding, listen; without one, start a login and show its QR code.
    pub async fn wechat_connect(self: &Arc<Self>) -> WeChatStatus {
        if let Some(account) = self.wechat_account() {
            self.wechat_monitor(account);
            self.wechat.inner().set("connected", "微信已连接，可直接与 orchestrator 对话。");
            return self.wechat_status();
        }
        let Ok(_starting) = self.wechat.connecting.try_lock() else {
            // Another request is starting the login: wait for it and show the same code.
            let _ = self.wechat.connecting.lock().await;
            return self.wechat_status();
        };
        let (id, mut cancelled) = {
            let mut inner = self.wechat.inner();
            if let Some(previous) = inner.login.take() {
                previous.cancel.send_replace(true);
            }
            let id = inner.next();
            let (cancel, cancelled) = watch::channel(false);
            inner.login = Some(Running { id, cancel });
            inner.verify_code = None;
            (id, cancelled)
        };
        let qr = unless(&mut cancelled, self.wechat.protocol.create_qr()).await;
        let mut inner = self.wechat.inner();
        if !inner.login_is(id) {
            drop(inner);
            return self.wechat_status();
        }
        match qr {
            Some(Ok(qr)) => {
                inner.set("waiting", "使用微信扫码并确认授权。");
                inner.qr = Some(qr.url.clone());
                let app = self.clone();
                inner.login_task = Some(self.rt.spawn(async move { app.wechat_login(id, qr.id, cancelled).await }));
            }
            Some(Err(error)) => {
                inner.login = None;
                inner.set("error", format!("获取微信二维码失败：{error}"));
            }
            None => inner.login = None,
        }
        drop(inner);
        self.wechat_status()
    }

    /// Follow a login until it is confirmed, fails, or five minutes have passed.
    async fn wechat_login(self: Arc<Self>, id: u64, qr_id: String, mut cancelled: watch::Receiver<bool>) {
        let protocol = &self.wechat.protocol;
        let deadline = now_ms() + LOGIN_MINUTES * 60_000;
        let mut base = protocol.api_base.clone();
        let mut failures = 0u32;
        let outcome: Result<(), String> = async {
            while now_ms() < deadline && self.wechat.inner().login_is(id) {
                let code = self.wechat.inner().verify_code.clone();
                let Some(result) = unless(&mut cancelled, protocol.qr_status(&qr_id, &base, code.as_deref())).await else { return Ok(()) };
                // One failed question is not a failed login: the network may hiccup while the person reaches for the phone.
                let result = match result {
                    Ok(result) => {
                        failures = 0;
                        result
                    }
                    Err(error) => {
                        failures += 1;
                        if failures > MAX_STATUS_FAILURES {
                            return Err(error.to_string());
                        }
                        if unless(&mut cancelled, tokio::time::sleep(protocol.pace)).await.is_none() {
                            return Ok(());
                        }
                        continue;
                    }
                };
                match self.wechat_login_step(id, &result, code.is_some(), &mut base)? {
                    Step::Wait => {}
                    Step::Over => return Ok(()),
                    Step::Bound(account) => {
                        self.wechat_monitor(account);
                        return Ok(());
                    }
                }
                if unless(&mut cancelled, tokio::time::sleep(protocol.pace)).await.is_none() {
                    return Ok(());
                }
            }
            let mut inner = self.wechat.inner();
            if inner.login_is(id) {
                inner.login = None;
                inner.set("error", "连接超时，请重新获取二维码。");
            }
            Ok(())
        }
        .await;
        if let Err(error) = outcome {
            let mut inner = self.wechat.inner();
            if inner.login_is(id) {
                inner.login = None;
                inner.set("error", format!("微信连接失败：{error}"));
            }
        }
    }

    /// Apply one answer about a login's status.
    fn wechat_login_step(&self, id: u64, result: &Value, code_given: bool, base: &mut String) -> Result<Step, String> {
        let mut inner = self.wechat.inner();
        if !inner.login_is(id) {
            return Ok(Step::Over);
        }
        match result["status"].as_str().unwrap_or("") {
            "scaned" => {
                inner.verify_code = None;
                inner.set("scaned", "已扫码，请在手机微信确认。");
            }
            "need_verifycode" => inner.set("verify", if code_given { "验证码不正确，请重新输入。" } else { "输入手机微信显示的验证码。" }),
            "scaned_but_redirect" => {
                if let Some(host) = result["redirect_host"].as_str().filter(|host| !host.is_empty()) {
                    *base = format!("https://{host}");
                }
            }
            "confirmed" => {
                let part = |name: &str| result[name].as_str().filter(|value| !value.is_empty()).map(str::to_string);
                let (Some(token), Some(account_id), Some(user_id)) = (part("bot_token"), part("ilink_bot_id"), part("ilink_user_id")) else {
                    return Err("扫码确认响应缺少账号凭据或绑定用户".into());
                };
                let account = Account {
                    token,
                    account_id,
                    user_id,
                    base_url: part("baseurl").unwrap_or_else(|| self.wechat.protocol.api_base.clone()),
                    context_token: None,
                };
                // The binding is whole before it shows as connected: the account, and its user as a chat sender.
                drop(inner);
                self.store.set(ACCOUNT, &account);
                self.store.delete(CURSOR);
                self.wechat_allow(&account.user_id, true);
                let mut inner = self.wechat.inner();
                inner.login = None;
                inner.set("connected", "微信连接成功。");
                return Ok(Step::Bound(account));
            }
            "binded_redirect" => {
                let account = self.wechat_account().ok_or("微信已绑定其他实例；请先解除原绑定")?;
                inner.login = None;
                inner.set("connected", "微信已连接。");
                return Ok(Step::Bound(account));
            }
            "expired" => {
                inner.login = None;
                inner.set("error", "二维码已过期，请重新连接。");
                return Ok(Step::Over);
            }
            "verify_code_blocked" => {
                inner.login = None;
                inner.set("error", "验证码错误次数过多，请重新扫码。");
                return Ok(Step::Over);
            }
            _ => {}
        }
        Ok(Step::Wait)
    }

    /// Give the code WeChat showed on the phone.
    pub fn wechat_verify(&self, code: &str) -> Result<WeChatStatus, String> {
        let code = code.trim();
        {
            let mut inner = self.wechat.inner();
            if inner.login.is_none() || inner.state != "verify" {
                return Err("当前不需要微信验证码".into());
            }
            if !(1..=16).contains(&code.len()) || !code.bytes().all(|b| b.is_ascii_digit()) {
                return Err("验证码必须为数字".into());
            }
            inner.verify_code = Some(code.to_string());
            inner.set("waiting", "验证码已提交，等待微信确认。");
        }
        Ok(self.wechat_status())
    }

    /// Unbind: stop listening and forget the account; the conversation stays.
    pub async fn wechat_disconnect(self: &Arc<Self>) -> WeChatStatus {
        self.wechat_stop().await;
        if let Some(account) = self.wechat_account() {
            self.wechat_allow(&account.user_id, false);
        }
        self.store.delete(ACCOUNT);
        self.store.delete(CURSOR);
        self.wechat.inner().set("disconnected", "微信已断开，orchestrator 对话记录保留。");
        self.wechat_status()
    }

    /// Put the bound user on the chat Source's list of senders, or take it off.
    fn wechat_allow(&self, user_id: &str, allow: bool) {
        let mut settings = (*self.settings()).clone();
        let sender = format!("wechat:{user_id}");
        let changed = if allow { settings.allow_chat_sender(&sender) } else { settings.disallow_chat_sender(&sender) };
        if changed {
            let _ = self.save_settings(settings, "internal", "policy");
        }
    }

    fn wechat_monitor(self: &Arc<Self>, account: Account) {
        let mut inner = self.wechat.inner();
        if inner.monitor.is_some() || self.closing() {
            return;
        }
        let id = inner.next();
        let (cancel, cancelled) = watch::channel(false);
        inner.monitor = Some(Running { id, cancel });
        let app = self.clone();
        inner.monitor_task = Some(self.rt.spawn(async move {
            // The typing indicator lives as long as the poll, whether it is cancelled or the login ends.
            let (done, until_done) = watch::channel(false);
            let poll = async {
                app.wechat_poll(account, cancelled).await;
                done.send_replace(true);
            };
            tokio::join!(poll, app.wechat_typing(until_done));
            let mut inner = app.wechat.inner();
            if inner.monitor.as_ref().is_some_and(|monitor| monitor.id == id) {
                inner.monitor = None;
            }
        }));
    }

    /// Long-poll for the bound user's messages until cancelled or the login is no longer valid.
    async fn wechat_poll(self: &Arc<Self>, mut account: Account, mut cancelled: watch::Receiver<bool>) {
        let protocol = &self.wechat.protocol;
        let mut cursor = self.store.get::<String>(CURSOR).unwrap_or_default();
        let mut timeout = Duration::from_secs(35);
        let mut failures = 0u32;
        loop {
            let Some(update) = unless(&mut cancelled, protocol.updates(&account, &cursor, timeout)).await else { return };
            let handled: Result<bool, String> = async {
                let update = update.map_err(|error| error.to_string())?;
                let code = |name: &str| update[name].as_i64().unwrap_or(0);
                if code("ret") == -14 || code("errcode") == -14 {
                    return Ok(false);
                }
                if code("ret") != 0 || code("errcode") != 0 {
                    return Err(update["errmsg"]
                        .as_str()
                        .filter(|text| !text.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("微信长轮询 ret={}", if code("ret") != 0 { code("ret") } else { code("errcode") })));
                }
                if let Some(wait) = update["longpolling_timeout_ms"].as_u64().filter(|wait| *wait > 0) {
                    timeout = Duration::from_millis(wait);
                }
                for message in update["msgs"].as_array().into_iter().flatten() {
                    self.wechat_receive(&mut account, message).await?;
                }
                if let Some(next) = update["get_updates_buf"].as_str().filter(|next| !next.is_empty()) {
                    cursor = next.to_string();
                    self.wechat_keep_cursor(&cursor);
                }
                Ok(true)
            }
            .await;
            if *cancelled.borrow() {
                return;
            }
            match handled {
                Ok(true) => {
                    failures = 0;
                    let mut inner = self.wechat.inner();
                    if inner.login.is_none() && (inner.state != "connected" || inner.message.starts_with("微信接收暂时失败")) {
                        inner.set("connected", "微信已连接。");
                    }
                }
                Ok(false) => {
                    self.wechat.inner().set("error", "微信登录已失效，请断开后重新扫码。");
                    return;
                }
                Err(error) => {
                    failures += 1;
                    self.wechat.inner().set("connected", format!("微信接收暂时失败，正在重试：{error}"));
                    let wait = (protocol.pace * 2u32.pow(failures.min(5))).min(Duration::from_secs(30));
                    if unless(&mut cancelled, tokio::time::sleep(wait)).await.is_none() {
                        return;
                    }
                }
            }
        }
    }

    /// Take in one message of the long poll: only a direct message of the bound user, with its text, voice
    /// transcripts and attachments.
    async fn wechat_receive(self: &Arc<Self>, account: &mut Account, message: &Value) -> Result<(), String> {
        let from_group = message["group_id"].as_str().is_some_and(|group| !group.is_empty());
        if message["message_type"].as_i64() != Some(1) || from_group || message["from_user_id"].as_str() != Some(account.user_id.as_str()) {
            return Ok(());
        }
        let id = message_id(message);
        if let Some(token) = message["context_token"].as_str().filter(|token| !token.is_empty() && account.context_token.as_deref() != Some(token)) {
            account.context_token = Some(token.to_string());
            self.store.set(ACCOUNT, account);
        }
        eprintln!("[neo-agent] 微信消息 {id}：{}", shape(&message["item_list"]));
        let (mut quoted, mut text, mut attachments) = (Vec::new(), Vec::new(), Vec::new());
        if message["ref_msg"].is_object() {
            self.wechat_quote(&message["ref_msg"], &format!("{id}-ref"), &mut quoted, &mut attachments).await;
        }
        for item in message["item_list"].as_array().into_iter().flatten() {
            match (item["type"].as_i64(), item["text_item"]["text"].as_str(), item["voice_item"]["text"].as_str()) {
                (Some(1), Some(said), _) if !said.is_empty() => text.push(said.to_string()),
                (Some(3), _, Some(said)) if !said.is_empty() => text.push(format!("[语音转写] {said}")),
                _ => {}
            }
            self.wechat_fetch(item, &id, &mut text, &mut attachments).await;
            if item["ref_msg"].is_object() {
                self.wechat_quote(&item["ref_msg"], &format!("{id}-ref"), &mut quoted, &mut attachments).await;
            }
        }
        quoted.extend(text);
        if quoted.is_empty() && attachments.is_empty() {
            return Ok(());
        }
        let at = message["create_time_ms"].as_i64().map(format_iso);
        self.wechat_hold(&account.user_id, format!("wechat:{id}"), quoted, attachments, at).await
    }

    /// The image, file or video an item carries, among the attachments; a file that cannot be fetched is said in
    /// words, and holds back neither its message nor those after it.
    async fn wechat_fetch(&self, item: &Value, id: &str, text: &mut Vec<String>, attachments: &mut Vec<ChatAttachment>) {
        match self.wechat.protocol.download_attachment(item, id).await {
            Ok(Some(attachment)) => {
                self.wechat_remember(&attachment);
                attachments.push(attachment);
            }
            Ok(None) => {}
            Err(error) => text.push(format!("[{error}]")),
        }
    }

    /// Keep a received file among the recent ones.
    fn wechat_remember(&self, attachment: &ChatAttachment) {
        if attachment.data.len() > RECENT_BYTES {
            return;
        }
        let mut recent = self.wechat.recent.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        recent.retain(|kept| kept.name != attachment.name);
        recent.push_back(attachment.clone());
        while recent.len() > RECENT_FILES || recent.iter().map(|kept| kept.data.len()).sum::<usize>() > RECENT_BYTES {
            recent.pop_front();
        }
    }

    /// The file of that name lately received, newest first.
    fn wechat_recalled(&self, name: &str) -> Option<ChatAttachment> {
        let recent = self.wechat.recent.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        recent.iter().rev().find(|kept| kept.name == name).cloned()
    }

    /// What a message quotes: its words as a quote line, its file among the attachments.
    async fn wechat_quote(&self, quote: &Value, id: &str, lines: &mut Vec<String>, attachments: &mut Vec<ChatAttachment>) {
        let item = &quote["message_item"];
        let title = quote["title"].as_str().map(str::trim).filter(|title| !title.is_empty());
        let said = item["text_item"]["text"].as_str().or(item["voice_item"]["text"].as_str()).map(str::trim).filter(|said| !said.is_empty());
        let named = item["file_item"]["file_name"].as_str().filter(|name| !name.trim().is_empty()).map(|name| safe_name(Some(name), "file.bin"));
        let before = attachments.len();
        let mut failed = Vec::new();
        self.wechat_fetch(item, id, &mut failed, attachments).await;
        // WeChat may quote a file by its name alone: then it is the one of that name lately received.
        if attachments.len() == before {
            if let Some(file) = [named.as_deref(), title].into_iter().flatten().find_map(|name| self.wechat_recalled(name)) {
                attachments.push(file);
                failed.clear();
            }
        }
        match (attachments.get(before), named, said.or(title)) {
            (Some(file), _, _) => lines.push(format!("[引用的文件：{}]", file.name)),
            (None, Some(name), _) => lines.push(format!("[引用的文件：{name}（未能取回文件内容）]")),
            (None, None, Some(said)) => lines.push(format!("[引用] {said}")),
            (None, None, None) => {}
        }
        lines.extend(failed);
    }

    /// Take a message into the burst it belongs to; the burst goes to the main Session when it is over.
    async fn wechat_hold(
        self: &Arc<Self>,
        user_id: &str,
        id: String,
        text: Vec<String>,
        attachments: Vec<ChatAttachment>,
        at: Option<String>,
    ) -> Result<(), String> {
        let protocol = &self.wechat.protocol;
        let now = Instant::now();
        let due = {
            let mut burst = self.wechat.burst();
            if burst.seen.contains(&id) {
                return Ok(());
            }
            burst.seen.push_back(id.clone());
            if burst.seen.len() > SEEN_IDS {
                burst.seen.pop_front();
            }
            // Only the bound user's messages come here, and unbinding lets a held burst go: a burst is one person's.
            let worded = (!text.is_empty()).then_some(now);
            let held = burst.held.get_or_insert_with(|| Held {
                user_id: user_id.to_string(),
                id,
                text: Vec::new(),
                attachments: Vec::new(),
                at,
                worded: None,
                last: now,
            });
            held.text.extend(text);
            held.attachments.extend(attachments);
            held.worded = held.worded.or(worded);
            held.last = now;
            let due = held.due(protocol);
            burst.seq += 1;
            if let Some(timer) = burst.timer.take() {
                timer.abort();
            }
            if due > now {
                let (app, seq) = (self.clone(), burst.seq);
                burst.timer = Some(self.rt.spawn(async move {
                    tokio::time::sleep_until(due).await;
                    if let Err(error) = app.wechat_flush(Some(seq)).await {
                        app.wechat.inner().set("connected", format!("微信接收暂时失败，正在重试：{error}"));
                    }
                }));
            }
            due
        };
        if due <= now {
            self.wechat_flush(None).await?;
        }
        Ok(())
    }

    /// Send the held burst to the main Session: any burst, or only the one `seq` names, when nothing came since.
    async fn wechat_flush(self: &Arc<Self>, seq: Option<u64>) -> Result<(), String> {
        let held = {
            let mut burst = self.wechat.burst();
            if seq.is_some_and(|seq| seq != burst.seq) {
                return Ok(());
            }
            let Some(held) = burst.held.take() else { return Ok(()) };
            if seq.is_none() {
                if let Some(timer) = burst.timer.take() {
                    timer.abort();
                }
            } else {
                burst.timer = None;
            }
            burst.delivering += 1;
            held
        };
        let text = if held.text.is_empty() { FILES_ALONE.to_string() } else { held.text.join("\n") };
        let received = self.receive_wechat(&held.user_id, &held.id, &text, held.attachments, held.at).await;
        let mut burst = self.wechat.burst();
        burst.delivering -= 1;
        if received.is_ok() && burst.held.is_none() && burst.delivering == 0 {
            if let Some(cursor) = burst.cursor.take() {
                self.store.set(CURSOR, &cursor);
            }
        }
        received.map(|_| ())
    }

    /// Save the poll's cursor, unless messages before it are still held or on their way: then once they are delivered.
    fn wechat_keep_cursor(&self, cursor: &str) {
        let mut burst = self.wechat.burst();
        if burst.held.is_some() || burst.delivering > 0 {
            burst.cursor = Some(cursor.to_string());
        } else {
            burst.cursor = None;
            self.store.set(CURSOR, &cursor.to_string());
        }
    }

    /// Send a reply to the user it was written for, when that user is still the bound one; the id makes a retry the
    /// same message.
    pub(crate) async fn wechat_deliver(&self, id: &str, text: &str, user_id: &str) -> Result<Sent, String> {
        let Some(account) = self.wechat_account().filter(|account| account.user_id == user_id) else { return Ok(Sent::Gone) };
        self.wechat.protocol.send_text(&account, text, Some(id)).await.map_err(|error| error.to_string())?;
        Ok(Sent::Sent)
    }

    /// The ticket whose directory holds `file`, choosing the deepest match when directories nest.
    fn ticket_for_path(&self, file: &Path) -> Option<neo_core::model::Ticket> {
        use neo_core::ports::Repositories;
        self.store
            .tickets()
            .into_iter()
            .filter_map(|ticket| {
                let dir = Path::new(&ticket.execution.as_ref()?.directory);
                if dir.as_os_str().is_empty() {
                    return None;
                }
                let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
                file.starts_with(&dir).then(|| (dir.as_os_str().len(), ticket))
            })
            .max_by_key(|(depth, _)| *depth)
            .map(|(_, ticket)| ticket)
    }

    /// Send a local file to the bound user, after its caption.
    pub async fn wechat_send_file(&self, path: &str, caption: Option<&str>) -> Result<Value, String> {
        self.wechat_send_ticket_file(path, caption, None).await
    }

    /// Send a local file to the bound user, recording a reply receipt when it delivers a ticket's report so Watchdog
    /// does not re-relay that report and a duplicate call does not send the file twice.
    pub async fn wechat_send_ticket_file(&self, path: &str, caption: Option<&str>, ticket_id: Option<&str>) -> Result<Value, String> {
        let account = self.wechat_account().ok_or("请先在应用中连接微信")?;
        let explicit = match ticket_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => Some(self.store_ticket(id).ok_or_else(|| format!("Unknown ticket: {id}"))?),
            None => None,
        };
        let file = Path::new(path).to_path_buf();
        let canonical = tokio::task::spawn_blocking(move || {
            let info = std::fs::metadata(&file).map_err(|error| format!("无法读取微信附件：{error}"))?;
            if !info.is_file() {
                return Err("微信附件路径必须是文件".to_string());
            }
            if info.len() as usize > MAX_MEDIA_BYTES {
                return Err("微信附件不能超过 100 MiB".to_string());
            }
            Ok::<_, String>(std::fs::canonicalize(&file).unwrap_or(file))
        })
        .await
        .map_err(|error| error.to_string())??;
        let name = Path::new(path).file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "file.bin".into());
        let ticket = explicit.or_else(|| self.ticket_for_path(&canonical)).or_else(|| self.ticket_for_path(Path::new(path)));
        let receipt = ticket.and_then(|ticket| {
            let report = ticket.latest_report()?;
            let id = neo_core::ids::key(&["wechat-file", &ticket.id, &report.at, &canonical.to_string_lossy()]);
            Some((ticket.id.clone(), report.at.clone(), id))
        });
        if let Some((_, _, id)) = &receipt {
            if self.store.reply_status(id) == Some(neo_core::ports::ReplyStatus::Sent) {
                return Ok(json!({"sent": true, "reused": true, "name": name}));
            }
        }
        let read_path = canonical.clone();
        let data = tokio::task::spawn_blocking(move || {
            let data = std::fs::read(&read_path).map_err(|error| format!("无法读取微信附件：{error}"))?;
            if data.len() > MAX_MEDIA_BYTES {
                return Err("微信附件不能超过 100 MiB".to_string());
            }
            Ok::<_, String>(data)
        })
        .await
        .map_err(|error| error.to_string())??;
        let message_id = receipt.as_ref().map(|(_, _, id)| id.as_str());
        self.wechat.protocol.send_media(&account, &data, &name, mime_of(&name), caption.unwrap_or(""), message_id).await.map_err(|error| error.to_string())?;
        if let Some((ticket_id, report_at, id)) = receipt {
            let party = format!("wechat:{}", account.user_id);
            let address = [("surface", "wechat"), ("conversation", party.as_str()), ("sender", party.as_str())]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            let text = caption.map(str::trim).filter(|text| !text.is_empty()).map(str::to_string).unwrap_or_else(|| name.clone());
            self.store.record_sent_receipt(
                &neo_core::ports::OutboundMessage {
                    id,
                    channel: neo_core::model::ChannelRef { source: crate::settings::CHAT_SOURCE.into(), thread: party, address },
                    text,
                    kind: neo_core::ports::MessageKind::Reply,
                    ticket_id: Some(ticket_id),
                },
                &report_at,
            );
        }
        Ok(json!({"sent": true, "name": name}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_message_by_its_id_or_by_a_digest_when_the_id_is_not_plain() {
        assert_eq!(message_id(&json!({"message_id": 9007199254740993u64})), "9007199254740993");
        assert_eq!(message_id(&json!({"message_id": "media-1"})), "media-1");
        assert_eq!(message_id(&json!({"client_id": "c_1.x"})), "c_1.x");
        let odd = message_id(&json!({"message_id": "a/b c"}));
        assert!(odd.len() == 64 && odd.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(odd, message_id(&json!({"message_id": "a/b c", "other": 1})), "the same id is the same message");
        let none = message_id(&json!({"item_list": [{"type": 1}]}));
        assert_eq!(none.len(), 64);
        assert_ne!(none, message_id(&json!({"item_list": [{"type": 2}]})));
    }
}
