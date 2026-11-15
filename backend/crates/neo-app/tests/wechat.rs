//! The WeChat bridge against a stand-in for WeChat's API on a loopback port: binding by QR code and verification
//! code, messages and encrypted media in both directions, the binding across a restart, and its end.

mod common;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::*;
use neo_app::kernels::SessionRole;
use neo_app::settings::CHAT_SOURCE;
use neo_app::wechat_protocol::{decrypt, encrypt, Protocol};
use neo_core::ports::Repositories;
use neo_testkit::http::{serve, Request, Response, Server};
use neo_testkit::TempDir;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const IMAGE_KEY: [u8; 16] = [7; 16];
const FILE_KEY: [u8; 16] = [9; 16];
const PIXEL: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What the stand-in saw and how it should behave.
#[derive(Default)]
struct Seen {
    base: String,
    qr_count: usize,
    /// What the status of a login is, until the verification code arrives.
    login: String,
    confirmed: bool,
    /// How many of the next questions about a login fail.
    status_failures: usize,
    delivered: bool,
    /// What a poll answers instead of messages, such as an expired login.
    poll: Option<Value>,
    /// Messages for the next polls, a batch each, after the first.
    batches: std::collections::VecDeque<Value>,
    cursors: Vec<String>,
    sent: Vec<Value>,
    upload_key: Vec<u8>,
    uploads: Vec<Vec<u8>>,
    tokens: Vec<String>,
    /// The typing statuses sent, in order: 1 to show it, 2 to take it away.
    typing: Vec<i64>,
}

struct WeChat {
    server: Server,
    seen: Arc<Mutex<Seen>>,
}

fn answer(seen: &Mutex<Seen>, request: Request) -> Response {
    let mut seen = seen.lock().unwrap();
    let (path, query) = request.path.split_once('?').unwrap_or((request.path.as_str(), ""));
    let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
    if let Some(token) = request.headers.get("authorization") {
        seen.tokens.push(token.clone());
    }
    let base = seen.base.clone();
    match (request.method.as_str(), path) {
        ("POST", "/ilink/bot/get_bot_qrcode") => {
            seen.qr_count += 1;
            assert_eq!(body["base_info"]["channel_version"], "2.4.10");
            Response::json(200, &json!({"qrcode": "qr id", "qrcode_img_content": "weixin://fixture-bind"}))
        }
        ("GET", "/ilink/bot/get_qrcode_status") => {
            assert!(query.contains("qrcode=qr%20id"), "{query}");
            if query.contains("verify_code=1234") {
                seen.confirmed = true;
            }
            if seen.status_failures > 0 {
                seen.status_failures -= 1;
                return Response::bytes(500, Vec::new());
            }
            if seen.login == "slow" {
                // Held open longer than the client waits, as when nothing happens on the phone.
                drop(seen);
                std::thread::sleep(Duration::from_millis(400));
                return Response::json(200, &json!({"status": "wait"}));
            }
            if seen.confirmed {
                Response::json(
                    200,
                    &json!({"status": "confirmed", "bot_token": "secret-token", "ilink_bot_id": "fixture-bot", "ilink_user_id": "bound-user", "baseurl": base}),
                )
            } else {
                Response::json(200, &json!({"status": seen.login}))
            }
        }
        ("POST", "/ilink/bot/getupdates") => {
            seen.cursors.push(body["get_updates_buf"].as_str().unwrap_or("").to_string());
            if let Some(poll) = &seen.poll {
                return Response::json(200, poll);
            }
            if seen.delivered {
                if let Some(batch) = seen.batches.pop_front() {
                    let cursor = format!("cursor-batch-{}", seen.cursors.len());
                    return Response::json(200, &json!({"ret": 0, "msgs": batch, "get_updates_buf": cursor, "longpolling_timeout_ms": 100}));
                }
            }
            let text = json!({"message_id": 9007199254740993u64, "from_user_id": "bound-user", "message_type": 1, "context_token": "context-1", "create_time_ms": 1_750_000_000_000i64,
                "item_list": [{"type": 1, "text_item": {"text": "微信文本"}}]});
            let media = json!({"message_id": "media-1", "from_user_id": "bound-user", "message_type": 1, "context_token": "context-1", "item_list": [
                {"type": 1, "text_item": {"text": "微信附件"}},
                {"type": 3, "voice_item": {"text": "语音内容"}},
                {"type": 2, "image_item": {"aeskey": hex(&IMAGE_KEY), "media": {"full_url": format!("{base}/cdn/image")}}},
                {"type": 4, "file_item": {"file_name": "../notes.txt", "media": {"full_url": format!("{base}/cdn/file"), "aes_key": STANDARD.encode(hex(&FILE_KEY))}}},
                {"type": 4, "file_item": {"file_name": "lost.bin", "media": {"full_url": format!("{base}/cdn/missing")}}},
            ]});
            let stranger =
                json!({"message_id": "ignored", "from_user_id": "stranger", "message_type": 1, "item_list": [{"type": 1, "text_item": {"text": "不得投递"}}]});
            let group = json!({"message_id": "grouped", "from_user_id": "bound-user", "group_id": "g1", "message_type": 1, "item_list": [{"type": 1, "text_item": {"text": "群里的话"}}]});
            let messages = if seen.delivered { json!([]) } else { json!([text, text, stranger, group, media]) };
            seen.delivered = true;
            // An empty poll leaves the cursor where it was.
            let asked = body["get_updates_buf"].as_str().filter(|cursor| !cursor.is_empty() && messages.as_array().is_some_and(Vec::is_empty));
            let cursor = asked.unwrap_or("cursor-1").to_string();
            Response::json(200, &json!({"ret": 0, "msgs": messages, "get_updates_buf": cursor, "longpolling_timeout_ms": 100}))
        }
        ("POST", "/ilink/bot/getconfig") => {
            assert_eq!(body["ilink_user_id"], "bound-user");
            Response::json(200, &json!({"ret": 0, "typing_ticket": "typing-ticket"}))
        }
        ("POST", "/ilink/bot/sendtyping") => {
            assert_eq!((body["ilink_user_id"].as_str(), body["typing_ticket"].as_str()), (Some("bound-user"), Some("typing-ticket")));
            seen.typing.push(body["status"].as_i64().unwrap_or(0));
            Response::json(200, &json!({"ret": 0}))
        }
        ("POST", "/ilink/bot/sendmessage") => {
            seen.sent.push(body["msg"].clone());
            Response::json(200, &json!({"ret": 0, "message_id": 9007199254740995u64}))
        }
        ("POST", "/ilink/bot/getuploadurl") => {
            seen.upload_key = (0..16).map(|i| u8::from_str_radix(&body["aeskey"].as_str().unwrap()[2 * i..2 * i + 2], 16).unwrap()).collect();
            assert_eq!(body["filesize"].as_u64().unwrap(), (body["rawsize"].as_u64().unwrap() / 16 + 1) * 16);
            assert_eq!(body["rawfilemd5"].as_str().map(str::len), Some(32));
            Response::json(200, &json!({"upload_full_url": format!("{base}/cdn/upload")}))
        }
        ("POST", "/cdn/upload") => {
            let key: [u8; 16] = seen.upload_key.clone().try_into().unwrap();
            seen.uploads.push(decrypt(&request.body, &key).expect("the upload decrypts with the announced key"));
            let param = format!("download-{}", seen.uploads.len());
            Response::bytes(200, Vec::new()).header("x-encrypted-param", &param)
        }
        ("GET", "/cdn/image") => Response::bytes(200, encrypt(&STANDARD.decode(PIXEL).unwrap(), &IMAGE_KEY)),
        ("GET", "/cdn/report") => Response::bytes(200, encrypt(b"quarterly numbers", &FILE_KEY)),
        ("GET", "/cdn/file") => Response::bytes(200, encrypt(b"wechat file payload", &FILE_KEY)),
        _ => Response::bytes(404, Vec::new()),
    }
}

async fn wechat(login: &str) -> WeChat {
    let seen = Arc::new(Mutex::new(Seen { login: login.into(), ..Seen::default() }));
    let handling = seen.clone();
    let server = serve(move |request| answer(&handling, request)).await;
    seen.lock().unwrap().base = server.url();
    WeChat { server, seen }
}

/// The application over the stand-in, with an orchestrator that answers every message in the same turn; each
/// message with words is taken at once.
async fn bound_to(wechat: &WeChat) -> Fixture {
    bound_with(wechat, Duration::ZERO, Duration::from_secs(15)).await
}

/// The same, holding bursts for `quiet` after words and files alone for `file_wait`.
async fn bound_with(wechat: &WeChat, quiet: Duration, file_wait: Duration) -> Fixture {
    let kernels = Arc::new(Scripted::default());
    *kernels.wechat.lock().unwrap() = Protocol {
        pace: Duration::from_millis(20),
        status_wait: Duration::from_millis(150),
        quiet,
        burst_cap: Duration::from_secs(2),
        file_wait,
        typing_check: Duration::from_millis(20),
        typing_keepalive: Duration::from_millis(100),
        ..Protocol::at(&wechat.server.url(), &format!("{}/cdn", wechat.server.url()))
    };
    *kernels.model.lock().unwrap() = Some(model(|turn| {
        Box::pin(async move {
            if let Some(card) = turn.card("kind").filter(|card| card["kind"] == "candidate") {
                turn.call(
                    "orchestrator_route",
                    json!({"decisions": [{"kind": "ignore", "trigger_id": card["trigger_id"], "reason": "Conversation", "answer": "orchestrator 微信回复"}]}),
                )
                .await?;
            }
            Ok("Done.".into())
        })
    }));
    let f = open_in(Arc::new(TempDir::new("wechat")), kernels).await;
    f.app.start().await.expect("the application starts");
    f
}

fn state(f: &Fixture) -> &'static str {
    f.app.wechat_status().state
}

#[tokio::test(flavor = "multi_thread")]
async fn binds_by_qr_code_and_exchanges_text_images_and_files() {
    let wechat = wechat("need_verifycode").await;
    let f = bound_to(&wechat).await;
    assert_eq!(serde_json::to_value(f.app.wechat_status()).unwrap(), json!({"state": "disconnected", "message": "尚未连接微信。"}));
    assert_eq!(f.app.wechat_verify("1234").unwrap_err(), "当前不需要微信验证码");
    assert_eq!(f.app.wechat_send_file("/tmp/x", None).await.unwrap_err(), "请先在应用中连接微信");

    // Two requests at once start one login; the code to draw is what WeChat said the QR encodes.
    let (first, second) = tokio::join!(f.app.wechat_connect(), f.app.wechat_connect());
    assert_eq!(wechat.seen.lock().unwrap().qr_count, 1);
    for status in [&first, &second] {
        assert!(matches!(status.state, "waiting" | "verify"), "{status:?}");
        assert_eq!(status.qr_content.as_deref(), Some("weixin://fixture-bind"));
    }
    f.until("the code is asked for", || state(&f) == "verify").await;
    assert_eq!(f.app.wechat_status().message, "输入手机微信显示的验证码。");
    assert_eq!(f.app.wechat_verify("12a4").unwrap_err(), "验证码必须为数字");
    let verified = f.app.wechat_verify(" 1234 ").unwrap();
    assert_eq!((verified.state, verified.qr_content.as_deref()), ("waiting", Some("weixin://fixture-bind")));
    f.until("the account is bound", || state(&f) == "connected").await;
    let status = serde_json::to_value(f.app.wechat_status()).unwrap();
    assert_eq!(status["senderId"], "wechat:bound-user");
    assert!(status.get("qrContent").is_none() && !status.to_string().contains("secret-token"), "{status}");
    // The bound user may now write to the application, as the app's own user may.
    assert!(f.app.settings().allowed_sender(CHAT_SOURCE, "wechat:bound-user").is_some());

    // Its messages arrive once each; a stranger's and a group's do not.
    f.until("both messages were answered", || {
        wechat.seen.lock().unwrap().sent.iter().any(|message| message["item_list"][0]["text_item"]["text"] == "orchestrator 微信回复")
    })
    .await;
    f.settle().await;
    let chat = f.chat();
    let from_wechat: Vec<&str> = chat.iter().filter(|(source, _)| source == "wechat").map(|(_, text)| text.as_str()).collect();
    assert_eq!(from_wechat.len(), 2, "{chat:#?}");
    assert_eq!(from_wechat[0], "微信文本");
    let state_dir = f.dir.join("state");
    let image = state_dir.join("attachments/chat-wechat-media-1/1-wechat-media-1.jpg");
    assert!(from_wechat[1].starts_with("微信附件\n[语音转写] 语音内容\n[微信附件下载失败：微信 CDN HTTP 404]\n\n"), "{}", from_wechat[1]);
    assert!(from_wechat[1].contains(&format!("<attachment name=\"wechat-media-1.jpg\" mediaType=\"image/png\" path=\"{}\">", image.display())));
    assert!(from_wechat[1].contains("<attachment name=\".._notes.txt\">\nwechat file payload\n</attachment>"));
    assert_eq!(std::fs::read(&image).unwrap(), STANDARD.decode(PIXEL).unwrap());
    assert!(!chat.iter().any(|(_, text)| text.contains("不得投递") || text.contains("群里的话")));
    let transcript = serde_json::to_string(&f.app.chat_transcript()).unwrap();
    assert_eq!(transcript.matches("\"requestId\":\"chat:wechat:9007199254740993\"").count(), 1, "a 64-bit id is kept exact and taken once");
    // The message carries the time WeChat gave it, and the person's conversation as its channel.
    let trigger = f.app.store.trigger(&neo_core::ids::key(&["trigger", CHAT_SOURCE, "wechat:9007199254740993"])).expect("the trigger");
    assert_eq!((trigger.at.as_str(), trigger.actor.id.as_str()), ("2025-06-15T15:06:40.000Z", "wechat:bound-user"));
    assert_eq!(trigger.channel.as_ref().map(|channel| channel.thread.as_str()), Some("wechat:bound-user"));
    // The model saw the image.
    assert!(f.ran(SessionRole::Orchestrator).iter().any(|ran| ran.text.contains("Images attached to chat message chat:wechat:media-1:")));
    // Replies went to the transcript and to WeChat, under the reply's own id and the conversation's token.
    {
        let seen = wechat.seen.lock().unwrap();
        let replies: Vec<&Value> = seen.sent.iter().filter(|message| message["item_list"][0]["text_item"]["text"] == "orchestrator 微信回复").collect();
        assert!(!replies.is_empty());
        for reply in replies {
            assert_eq!(
                (reply["to_user_id"].as_str(), reply["context_token"].as_str(), reply["message_type"].as_i64()),
                (Some("bound-user"), Some("context-1"), Some(2))
            );
            assert!(reply["client_id"].as_str().unwrap().starts_with("neo-agent:") && reply["client_id"].as_str().unwrap().len() > 20);
        }
        assert!(seen.tokens.iter().all(|token| token == "Bearer secret-token"));
        assert!(seen.cursors.first().is_some_and(String::is_empty) && seen.cursors.last().is_some_and(|cursor| cursor == "cursor-1"));
    }
    assert!(chat.iter().any(|(source, text)| source == "chat-reply" && text == "orchestrator 微信回复"));
    assert_eq!(f.app.store.get::<String>("wechat-cursor").as_deref(), Some("cursor-1"));

    // Files go out encrypted: any file as a file after its caption, an image as an image.
    let out = state_dir.join("out.bin");
    std::fs::write(&out, [0u8, 255, 1, 2, 3]).unwrap();
    assert_eq!(f.app.wechat_send_file(out.to_str().unwrap(), Some("文件说明")).await.unwrap(), json!({"sent": true, "name": "out.bin"}));
    let picture = state_dir.join("pixel.png");
    std::fs::write(&picture, STANDARD.decode(PIXEL).unwrap()).unwrap();
    f.app.wechat_send_file(picture.to_str().unwrap(), None).await.unwrap();
    assert!(f.app.wechat_send_file(state_dir.to_str().unwrap(), None).await.unwrap_err().contains("必须是文件"));
    assert!(f.app.wechat_send_file("/nonexistent/file.bin", None).await.unwrap_err().starts_with("无法读取微信附件"));
    {
        let seen = wechat.seen.lock().unwrap();
        assert_eq!(seen.uploads, vec![vec![0u8, 255, 1, 2, 3], STANDARD.decode(PIXEL).unwrap()]);
        let tail: Vec<&Value> = seen.sent.iter().rev().take(3).collect();
        assert_eq!((tail[2]["item_list"][0]["type"].as_i64(), tail[2]["item_list"][0]["text_item"]["text"].as_str()), (Some(1), Some("文件说明")));
        let file = &tail[1]["item_list"][0];
        assert_eq!((file["type"].as_i64(), file["file_item"]["file_name"].as_str(), file["file_item"]["len"].as_str()), (Some(4), Some("out.bin"), Some("5")));
        assert_eq!(
            (file["file_item"]["media"]["encrypt_query_param"].as_str(), file["file_item"]["media"]["encrypt_type"].as_i64()),
            (Some("download-1"), Some(1))
        );
        let image = &tail[0]["item_list"][0];
        assert_eq!((image["type"].as_i64(), image["image_item"]["media"]["encrypt_query_param"].as_str()), (Some(2), Some("download-2")));
        assert_eq!(STANDARD.decode(image["image_item"]["media"]["aes_key"].as_str().unwrap()).unwrap(), hex(&seen.upload_key).into_bytes());
    }
    // The main Session has the tool for it.
    assert!(neo_app::tools::main_specs().iter().any(|spec| spec.name == "wechat_send_file"));

    // After a restart the binding is taken up where it stopped, without a new login.
    let polls = wechat.seen.lock().unwrap().cursors.len();
    let f = f.restart().await;
    assert_eq!(state(&f), "connected");
    f.until("polling goes on", || wechat.seen.lock().unwrap().cursors.len() > polls).await;
    assert_eq!(wechat.seen.lock().unwrap().cursors.last().map(String::as_str), Some("cursor-1"));
    assert_eq!(wechat.seen.lock().unwrap().qr_count, 1);
    assert_eq!(f.app.wechat_connect().await.message, "微信已连接，可直接与 orchestrator 对话。");
    assert_eq!(f.chat().len(), chat.len(), "nothing arrived twice");

    // Unbinding forgets the account and the sender, and keeps the conversation.
    let status = f.app.wechat_disconnect().await;
    assert_eq!(serde_json::to_value(&status).unwrap(), json!({"state": "disconnected", "message": "微信已断开，orchestrator 对话记录保留。"}));
    assert!(f.app.store.get::<Value>("wechat-account").is_none() && f.app.store.get::<String>("wechat-cursor").is_none());
    assert!(f.app.settings().allowed_sender(CHAT_SOURCE, "wechat:bound-user").is_none());
    assert_eq!(f.chat().len(), chat.len());
    let polls = wechat.seen.lock().unwrap().cursors.len();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(wechat.seen.lock().unwrap().cursors.len() <= polls + 1, "polling stopped");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn says_why_a_login_ended_and_starts_a_new_one_on_request() {
    let wechat = wechat("expired").await;
    let f = bound_to(&wechat).await;
    f.app.wechat_connect().await;
    f.until("the login ended", || state(&f) == "error").await;
    assert_eq!(serde_json::to_value(f.app.wechat_status()).unwrap(), json!({"state": "error", "message": "二维码已过期，请重新连接。"}));
    // Scanned: waits for the phone; a second request replaces the login with a new code.
    wechat.seen.lock().unwrap().login = "scaned".into();
    f.app.wechat_connect().await;
    f.until("it was scanned", || state(&f) == "scaned").await;
    assert_eq!(f.app.wechat_status().qr_content.as_deref(), Some("weixin://fixture-bind"));
    assert_eq!(f.app.wechat_connect().await.state, "waiting");
    assert_eq!(wechat.seen.lock().unwrap().qr_count, 3);
    wechat.seen.lock().unwrap().login = "verify_code_blocked".into();
    f.until("the code was refused for good", || state(&f) == "error").await;
    assert_eq!(f.app.wechat_status().message, "验证码错误次数过多，请重新扫码。");
    // A confirmation without credentials binds nothing.
    wechat.seen.lock().unwrap().login = "confirmed".into();
    f.app.wechat_connect().await;
    f.until("the login failed", || state(&f) == "error").await;
    assert_eq!(f.app.wechat_status().message, "微信连接失败：扫码确认响应缺少账号凭据或绑定用户");
    assert!(f.app.store.get::<Value>("wechat-account").is_none());
    // Stopping in the middle of a login leaves nothing running.
    wechat.seen.lock().unwrap().login = "wait".into();
    f.app.wechat_connect().await;
    assert_eq!(state(&f), "waiting");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_listening_when_wechat_ends_the_login_and_retries_other_failures() {
    let wechat = wechat("need_verifycode").await;
    let f = bound_to(&wechat).await;
    f.app.wechat_connect().await;
    f.until("the code is asked for", || state(&f) == "verify").await;
    f.app.wechat_verify("1234").unwrap();
    f.until("the account is bound", || state(&f) == "connected").await;
    f.until("the first poll was answered", || f.app.store.get::<String>("wechat-cursor").is_some()).await;
    // A failure that may pass is retried, and said.
    wechat.seen.lock().unwrap().poll = Some(json!({"ret": 500, "errmsg": "busy"}));
    f.until("the failure shows", || f.app.wechat_status().message == "微信接收暂时失败，正在重试：busy").await;
    assert_eq!(state(&f), "connected");
    wechat.seen.lock().unwrap().poll = None;
    f.until("it recovered", || f.app.wechat_status().message == "微信已连接。").await;
    // An ended login is not.
    wechat.seen.lock().unwrap().poll = Some(json!({"errcode": -14}));
    f.until("the login is known to be over", || state(&f) == "error").await;
    assert_eq!(f.app.wechat_status().message, "微信登录已失效，请断开后重新扫码。");
    let polls = wechat.seen.lock().unwrap().cursors.len();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(wechat.seen.lock().unwrap().cursors.len(), polls, "polling stopped");
    // A reply to that user can still be tried while the binding is kept, and a reply to another user never is.
    assert_eq!(f.app.wechat_disconnect().await.state, "disconnected");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_a_login_alive_through_slow_and_failed_questions() {
    let wechat = wechat("slow").await;
    let f = bound_to(&wechat).await;
    f.app.wechat_connect().await;
    // WeChat answers later than the client waits, several times over: the login still waits for the scan.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!((state(&f), f.app.wechat_status().qr_content.as_deref()), ("waiting", Some("weixin://fixture-bind")));
    // A few failed questions in a row are ridden out, and the scan is then seen.
    {
        let mut seen = wechat.seen.lock().unwrap();
        seen.status_failures = 3;
        seen.login = "scaned".into();
    }
    f.until("it was scanned", || state(&f) == "scaned").await;
    assert_eq!(wechat.seen.lock().unwrap().status_failures, 0);
    // More than that in a row ends the login, with the reason.
    wechat.seen.lock().unwrap().status_failures = 50;
    f.until("the login failed", || state(&f) == "error").await;
    assert_eq!(f.app.wechat_status().message, "微信连接失败：微信接口 HTTP 500");
    assert_eq!(wechat.seen.lock().unwrap().qr_count, 1);
    f.app.stop().await;
}

/// A file the bound user sends, as WeChat's CDN holds it.
fn report(name: &str, base: &str) -> Value {
    json!({"type": 4, "file_item": {"file_name": name, "media": {"full_url": format!("{base}/cdn/report"), "aes_key": STANDARD.encode(hex(&FILE_KEY))}}})
}

fn from_bound(id: &str, items: Value) -> Value {
    json!({"message_id": id, "from_user_id": "bound-user", "message_type": 1, "context_token": "context-1", "item_list": items})
}

/// Bound, with the first poll's messages already taken, so only the batches given later arrive.
async fn quietly_bound(quiet: Duration, file_wait: Duration) -> (WeChat, Fixture) {
    let wechat = wechat("need_verifycode").await;
    wechat.seen.lock().unwrap().delivered = true;
    let f = bound_with(&wechat, quiet, file_wait).await;
    f.app.wechat_connect().await;
    f.until("the code is asked for", || state(&f) == "verify").await;
    f.app.wechat_verify("1234").unwrap();
    f.until("the account is bound", || state(&f) == "connected").await;
    (wechat, f)
}

fn wechat_chat(f: &Fixture) -> Vec<String> {
    f.chat().into_iter().filter(|(source, _)| source == "wechat").map(|(_, text)| text).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn takes_a_file_and_the_words_after_it_as_one_message() {
    let (wechat, f) = quietly_bound(Duration::from_millis(150), Duration::from_secs(10)).await;
    let base = wechat.server.url();
    wechat.seen.lock().unwrap().batches.push_back(json!([from_bound("burst-1", json!([report("report.txt", &base)]))]));
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The file alone waits for its words, and its cursor is not saved while it waits.
    assert!(wechat_chat(&f).is_empty());
    assert!(!f.app.store.get::<String>("wechat-cursor").is_some_and(|cursor| cursor.starts_with("cursor-batch")));
    wechat.seen.lock().unwrap().batches.push_back(json!([from_bound("burst-2", json!([{"type": 1, "text_item": {"text": "总结这个文件"}}]))]));
    f.until("the burst arrived", || !wechat_chat(&f).is_empty()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let chat = wechat_chat(&f);
    assert_eq!(chat.len(), 1, "{chat:#?}");
    assert!(chat[0].starts_with("总结这个文件\n"), "{}", chat[0]);
    assert!(chat[0].contains("<attachment name=\"report.txt\">\nquarterly numbers\n</attachment>"), "{}", chat[0]);
    assert!(f.app.store.trigger(&neo_core::ids::key(&["trigger", CHAT_SOURCE, "wechat:burst-1"])).is_some());
    f.until("the cursor is saved", || f.app.store.get::<String>("wechat-cursor").is_some_and(|cursor| cursor.starts_with("cursor-batch"))).await;
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn takes_files_alone_once_no_words_come_and_says_so() {
    let (wechat, f) = quietly_bound(Duration::from_millis(150), Duration::from_millis(300)).await;
    let base = wechat.server.url();
    wechat
        .seen
        .lock()
        .unwrap()
        .batches
        .push_back(json!([from_bound("alone-1", json!([report("a.txt", &base)])), from_bound("alone-2", json!([report("b.txt", &base)]))]));
    f.until("the files arrived", || !wechat_chat(&f).is_empty()).await;
    let chat = wechat_chat(&f);
    assert_eq!(chat.len(), 1, "{chat:#?}");
    assert!(chat[0].starts_with("[用户只发送了文件，没有说明要做什么"), "{}", chat[0]);
    assert!(chat[0].contains("<attachment name=\"a.txt\">") && chat[0].contains("<attachment name=\"b.txt\">"), "{}", chat[0]);
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn takes_what_a_message_quotes() {
    let (wechat, f) = quietly_bound(Duration::ZERO, Duration::from_secs(10)).await;
    let base = wechat.server.url();
    wechat.seen.lock().unwrap().batches.push_back(json!([
        from_bound(
            "quote-1",
            json!([{"type": 1, "text_item": {"text": "按这个文件处理"}, "ref_msg": {"title": "plan.txt", "message_item": report("plan.txt", &base)}}])
        ),
        from_bound("quote-2", json!([{"type": 1, "text_item": {"text": "好的"}, "ref_msg": {"message_item": {"type": 1, "text_item": {"text": "明天开会"}}}}])),
    ]));
    f.until("both arrived", || wechat_chat(&f).len() == 2).await;
    let chat = wechat_chat(&f);
    assert!(chat[0].starts_with("[引用的文件：plan.txt]\n按这个文件处理\n"), "{}", chat[0]);
    assert!(chat[0].contains("<attachment name=\"plan.txt\">\nquarterly numbers\n</attachment>"), "{}", chat[0]);
    assert_eq!(chat[1], "[引用] 明天开会\n好的");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn finds_a_file_quoted_by_its_name_alone_among_those_lately_received() {
    let (wechat, f) = quietly_bound(Duration::ZERO, Duration::from_millis(200)).await;
    let base = wechat.server.url();
    wechat.seen.lock().unwrap().batches.push_back(json!([from_bound("named-1", json!([report("plan.md", &base)]))]));
    f.until("the file arrived", || wechat_chat(&f).len() == 1).await;
    wechat.seen.lock().unwrap().batches.push_back(json!([
        from_bound("named-2", json!([{"type": 1, "text_item": {"text": "复现这个文档"}, "ref_msg": {"message_item": {"type": 4, "file_item": {"file_name": "plan.md"}}}}])),
        from_bound("named-3", json!([{"type": 1, "text_item": {"text": "还有这个"}, "ref_msg": {"title": "gone.pdf", "message_item": {"type": 4, "file_item": {"file_name": "gone.pdf"}}}}])),
    ]));
    f.until("the quotes arrived", || wechat_chat(&f).len() == 3).await;
    let chat = wechat_chat(&f);
    assert!(chat[1].starts_with("[引用的文件：plan.md]\n复现这个文档\n"), "{}", chat[1]);
    assert!(chat[1].contains("<attachment name=\"plan.md\">\nquarterly numbers\n</attachment>"), "{}", chat[1]);
    // A file never received is still named, so the window shows what was quoted.
    assert_eq!(chat[2], "[引用的文件：gone.pdf（未能取回文件内容）]\n还有这个");
    f.app.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shows_typing_while_the_orchestrator_works_and_takes_it_away_after() {
    let (wechat, f) = quietly_bound(Duration::ZERO, Duration::from_secs(10)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Nothing at work: nothing is shown.
    assert!(wechat.seen.lock().unwrap().typing.is_empty());
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let held = gate.clone();
    f.script(model(move |_turn| {
        let held = held.clone();
        Box::pin(async move {
            while held.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok("Done.".into())
        })
    }));
    wechat.seen.lock().unwrap().batches.push_back(json!([from_bound("think-1", json!([{"type": 1, "text_item": {"text": "想一想"}}]))]));
    // While the turn runs, "typing" is said and said again before it lapses.
    f.until("typing is kept up", || wechat.seen.lock().unwrap().typing.iter().filter(|status| **status == 1).count() >= 3).await;
    assert!(!wechat.seen.lock().unwrap().typing.contains(&2));
    gate.store(false, std::sync::atomic::Ordering::SeqCst);
    f.until("typing is taken away", || wechat.seen.lock().unwrap().typing.last() == Some(&2)).await;
    let count = wechat.seen.lock().unwrap().typing.len();
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(wechat.seen.lock().unwrap().typing.len(), count, "nothing more once idle");
    f.app.stop().await;
}
