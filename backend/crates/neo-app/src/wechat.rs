//! The WeChat bridge: one WeChat user, bound by scanning a QR code, talks to the main Session as in the app. It owns
//! the login, the long poll for that user's messages, replies in order, and the binding kept across restarts.

use crate::app::App;
use crate::outbox::Sent;
use crate::wechat_protocol::{id_text, mime_of, Account, Protocol, MAX_MEDIA_BYTES};
use neo_core::time::{format_iso, now_ms};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

const ACCOUNT: &str = "wechat-account";
const CURSOR: &str = "wechat-cursor";
const LOGIN_MINUTES: i64 = 5;

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

/// The bridge's state within the application.
pub struct WeChatState {
    protocol: Protocol,
    inner: Mutex<Inner>,
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
        WeChatState { protocol, inner: Mutex::new(inner), connecting: tokio::sync::Mutex::new(()) }
    }
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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

/// A message id that can name a chat message: the id itself when it is made of plain characters, else its digest.
fn message_id(message: &Value) -> String {
    let id = id_text(&message["message_id"]).or_else(|| id_text(&message["client_id"])).unwrap_or_default();
    if (1..=180).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-')) {
        return id;
    }
    Sha256::digest(if id.is_empty() { message.to_string() } else { id }.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

impl App {
    fn wechat_account(&self) -> Option<Account> {
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
        let outcome: Result<(), String> = async {
            while now_ms() < deadline && self.wechat.inner().login_is(id) {
                let code = self.wechat.inner().verify_code.clone();
                let Some(result) = unless(&mut cancelled, protocol.qr_status(&qr_id, &base, code.as_deref())).await else { return Ok(()) };
                let result = result.map_err(|error| error.to_string())?;
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
            app.wechat_poll(account, cancelled).await;
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
                    self.store.set(CURSOR, &cursor);
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
        let mut text: Vec<String> = Vec::new();
        let mut attachments = Vec::new();
        for item in message["item_list"].as_array().into_iter().flatten() {
            match (item["type"].as_i64(), item["text_item"]["text"].as_str(), item["voice_item"]["text"].as_str()) {
                (Some(1), Some(said), _) if !said.is_empty() => text.push(said.to_string()),
                (Some(3), _, Some(said)) if !said.is_empty() => text.push(format!("[语音转写] {said}")),
                _ => {}
            }
            match self.wechat.protocol.download_attachment(item, &id).await {
                Ok(Some(attachment)) => attachments.push(attachment),
                Ok(None) => {}
                // A file that cannot be fetched must not hold back the message, nor those after it.
                Err(error) => text.push(format!("[{error}]")),
            }
        }
        if text.is_empty() && attachments.is_empty() {
            return Ok(());
        }
        let at = message["create_time_ms"].as_i64().map(format_iso);
        self.receive_wechat(&account.user_id, &format!("wechat:{id}"), &text.join("\n"), attachments, at).await?;
        Ok(())
    }

    /// Send a reply to the user it was written for, when that user is still the bound one; the id makes a retry the
    /// same message.
    pub(crate) async fn wechat_deliver(&self, id: &str, text: &str, user_id: &str) -> Result<Sent, String> {
        let Some(account) = self.wechat_account().filter(|account| account.user_id == user_id) else { return Ok(Sent::Gone) };
        self.wechat.protocol.send_text(&account, text, Some(id)).await.map_err(|error| error.to_string())?;
        Ok(Sent::Sent)
    }

    /// Send a local file to the bound user, after its caption.
    pub async fn wechat_send_file(&self, path: &str, caption: Option<&str>) -> Result<Value, String> {
        let account = self.wechat_account().ok_or("请先在应用中连接微信")?;
        let file = Path::new(path).to_path_buf();
        let read = tokio::task::spawn_blocking(move || {
            let info = std::fs::metadata(&file).map_err(|error| format!("无法读取微信附件：{error}"))?;
            if !info.is_file() {
                return Err("微信附件路径必须是文件".to_string());
            }
            if info.len() as usize > MAX_MEDIA_BYTES {
                return Err("微信附件不能超过 100 MiB".to_string());
            }
            std::fs::read(&file).map_err(|error| format!("无法读取微信附件：{error}"))
        });
        let data = read.await.map_err(|error| error.to_string())??;
        let name = Path::new(path).file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "file.bin".into());
        self.wechat.protocol.send_media(&account, &data, &name, mime_of(&name), caption.unwrap_or("")).await.map_err(|error| error.to_string())?;
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
