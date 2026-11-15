//! The iLink Bot protocol WeChat offers: login by QR code, long-polled messages, and media through an encrypted CDN.

use crate::http::{self, Failure, Request};
use crate::sessions::ChatAttachment;
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

/// The API's address.
pub const API_URL: &str = "https://ilinkai.weixin.qq.com";
/// The media CDN's address.
pub const CDN_URL: &str = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION: &str = "2.4.10";
const CLIENT_VERSION: u32 = (2 << 16) | (4 << 8) | 10;
/// The largest media file sent or received.
pub const MAX_MEDIA_BYTES: usize = 100 * 1024 * 1024;

/// The bound bot account and the one user it talks to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// The bot's credential.
    pub token: String,
    /// The bot's id.
    pub account_id: String,
    /// The person who bound it; the only one it listens to.
    pub user_id: String,
    /// The API address this account uses.
    pub base_url: String,
    /// The conversation token of the person's latest message, which replies carry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_token: Option<String>,
}

/// A login QR code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Qr {
    /// Its id, for asking about its status.
    pub id: String,
    /// What the code encodes: the address WeChat opens when it is scanned.
    pub url: String,
}

/// Why a call failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// Nothing came back in time.
    Timeout,
    /// Anything else, in words.
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Timeout => f.write_str("请求超时"),
            Error::Other(text) => f.write_str(text),
        }
    }
}

impl From<String> for Error {
    fn from(text: String) -> Self {
        Error::Other(text)
    }
}

fn failed(failure: Failure) -> Error {
    match failure {
        Failure::Timeout => Error::Timeout,
        Failure::Transport(text) => Error::Other(text),
    }
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).expect("the system provides random bytes");
    bytes
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() & 1 == 1 || !text.is_ascii() {
        return None;
    }
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok()).collect()
}

/// Percent-encode a query value.
fn query(value: &str) -> String {
    value
        .bytes()
        .map(|byte| if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') { (byte as char).to_string() } else { format!("%{byte:02X}") })
        .collect()
}

/// The MD5 digest the upload API asks for, in hex.
pub fn md5_hex(data: &[u8]) -> String {
    const SHIFTS: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4,
        11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let constants: Vec<u32> = (0..64).map(|i| (((i + 1) as f64).sin().abs() * 4_294_967_296.0) as u32).collect();
    let mut state: [u32; 4] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64).wrapping_mul(8)).to_le_bytes());
    for block in message.chunks_exact(64) {
        let words: Vec<u32> = block.chunks_exact(4).map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]])).collect();
        let [mut a, mut b, mut c, mut d] = state;
        for i in 0..64 {
            let (mixed, index) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let rotated = a.wrapping_add(mixed).wrapping_add(constants[i]).wrapping_add(words[index]).rotate_left(SHIFTS[i]);
            (a, d, c, b) = (d, c, b, b.wrapping_add(rotated));
        }
        state = [state[0].wrapping_add(a), state[1].wrapping_add(b), state[2].wrapping_add(c), state[3].wrapping_add(d)];
    }
    hex(&state.iter().flat_map(|word| word.to_le_bytes()).collect::<Vec<u8>>())
}

/// AES-128-ECB with PKCS#7 padding, as the CDN stores media.
pub fn encrypt(plain: &[u8], key: &[u8; 16]) -> Vec<u8> {
    let cipher = aes::Aes128::new(GenericArray::from_slice(key));
    let pad = 16 - plain.len() % 16;
    let mut data = plain.to_vec();
    data.resize(plain.len() + pad, pad as u8);
    for block in data.chunks_exact_mut(16) {
        cipher.encrypt_block(GenericArray::from_mut_slice(block));
    }
    data
}

/// The reverse of [`encrypt`]; fails on data that is not whole blocks or whose padding is wrong.
pub fn decrypt(encrypted: &[u8], key: &[u8; 16]) -> Result<Vec<u8>, String> {
    if encrypted.is_empty() || encrypted.len() & 15 != 0 {
        return Err("微信媒体密文长度无效".into());
    }
    let cipher = aes::Aes128::new(GenericArray::from_slice(key));
    let mut data = encrypted.to_vec();
    for block in data.chunks_exact_mut(16) {
        cipher.decrypt_block(GenericArray::from_mut_slice(block));
    }
    let pad = *data.last().unwrap_or(&0) as usize;
    if pad == 0 || pad > 16 || data[data.len() - pad..].iter().any(|byte| *byte as usize != pad) {
        return Err("微信媒体解密失败".into());
    }
    data.truncate(data.len() - pad);
    Ok(data)
}

/// A media key as messages carry it: base64 of the 16 bytes, or of their 32 hex digits.
fn media_key(encoded: &str) -> Result<[u8; 16], String> {
    let decoded = STANDARD.decode(encoded.trim()).map_err(|_| "微信媒体 AES 密钥格式无效".to_string())?;
    let bytes = match decoded.len() {
        16 => Some(decoded),
        32 => std::str::from_utf8(&decoded).ok().and_then(unhex),
        _ => None,
    };
    bytes.and_then(|bytes| bytes.try_into().ok()).ok_or_else(|| "微信媒体 AES 密钥格式无效".to_string())
}

const MIME: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("mp4", "video/mp4"),
    ("mov", "video/quicktime"),
    ("webm", "video/webm"),
    ("pdf", "application/pdf"),
    ("txt", "text/plain"),
    ("md", "text/markdown"),
    ("csv", "text/csv"),
    ("zip", "application/zip"),
    ("doc", "application/msword"),
    ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ("xls", "application/vnd.ms-excel"),
    ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
];

/// The media type a file name's extension stands for.
pub fn mime_of(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default();
    MIME.iter().find(|(known, _)| *known == extension).map(|(_, mime)| *mime).unwrap_or("application/octet-stream")
}

/// A file name without separators and control characters, 200 characters at most.
pub(crate) fn safe_name(name: Option<&str>, fallback: &str) -> String {
    let cleaned: String = name.unwrap_or("").chars().map(|c| if matches!(c, '/' | '\\') || c.is_control() { '_' } else { c }).collect();
    let cleaned: String = cleaned.trim().chars().take(200).collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// What kind of image the bytes are, by how they begin.
fn image_mime(data: &[u8]) -> &'static str {
    if data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        "image/png"
    } else if data.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        "image/gif"
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

/// An id that the API sends as a string or as a 64-bit number.
pub fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The client.
#[derive(Clone, Debug)]
pub struct Protocol {
    /// The API's address.
    pub api_base: String,
    /// The CDN's address.
    pub cdn_base: String,
    /// Between two questions about a login, and the first wait after a failed poll.
    pub pace: Duration,
    /// How long one question about a login may wait for its answer; WeChat holds each for about half a minute.
    pub status_wait: Duration,
    /// How long the bridge waits after a message with words for more of the same burst; zero takes each at once.
    pub quiet: Duration,
    /// The longest a burst with words is held after its first words.
    pub burst_cap: Duration,
    /// How long files sent without words wait for the words that say what to do with them.
    pub file_wait: Duration,
    /// How often the typing indicator looks whether the main Session or a worker is at work.
    pub typing_check: Duration,
    /// While work goes on, "typing" blinks: shown this long, then taken away for `typing_off`, so the person sees the
    /// work is alive and not stuck.
    pub typing_on: Duration,
    /// How long "typing" stays away between two blinks.
    pub typing_off: Duration,
}

impl Default for Protocol {
    fn default() -> Self {
        Protocol {
            api_base: API_URL.into(),
            cdn_base: CDN_URL.into(),
            pace: Duration::from_secs(1),
            status_wait: Duration::from_secs(45),
            quiet: Duration::from_secs(3),
            burst_cap: Duration::from_secs(6),
            file_wait: Duration::from_secs(15),
            typing_check: Duration::from_millis(250),
            typing_on: Duration::from_secs(2),
            typing_off: Duration::from_secs(1),
        }
    }
}

/// The most one call about the typing indicator waits, so that stopping never waits long on it.
const TYPING_WAIT: Duration = Duration::from_secs(5);

struct Call<'a> {
    method: &'static str,
    token: Option<&'a str>,
    body: Option<Value>,
    timeout: Duration,
}

impl Default for Call<'_> {
    fn default() -> Self {
        Call { method: "POST", token: None, body: None, timeout: Duration::from_secs(15) }
    }
}

impl Protocol {
    /// A client for other addresses than WeChat's own, as tests use.
    pub fn at(api_base: &str, cdn_base: &str) -> Protocol {
        Protocol { api_base: api_base.trim_end_matches('/').to_string(), cdn_base: cdn_base.trim_end_matches('/').to_string(), ..Protocol::default() }
    }

    async fn call(&self, base: &str, path: &str, call: Call<'_>) -> Result<Value, Error> {
        let uin = STANDARD.encode(u32::from_be_bytes(random::<4>()).to_string());
        let mut headers: Vec<(String, String)> =
            [("content-type", "application/json"), ("authorizationType", "ilink_bot_token"), ("x-wechat-uin", uin.as_str()), ("iLink-App-Id", "bot")]
                .into_iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect();
        headers.push(("iLink-App-ClientVersion".into(), CLIENT_VERSION.to_string()));
        if let Some(token) = call.token {
            headers.push(("authorization".into(), format!("Bearer {token}")));
        }
        let body = call.body.map(|mut body| {
            body["base_info"] = json!({"channel_version": CHANNEL_VERSION, "bot_agent": concat!("neo-agent/", env!("CARGO_PKG_VERSION"))});
            body.to_string().into_bytes()
        });
        let request =
            Request { method: call.method, url: format!("{}/{path}", base.trim_end_matches('/')), headers, body, timeout: call.timeout, want: Vec::new() };
        let response = http::send(request).await.map_err(failed)?;
        if !(200..300).contains(&response.status) {
            return Err(Error::Other(format!("微信接口 HTTP {}", response.status)));
        }
        serde_json::from_slice(&response.body).map_err(|_| Error::Other("微信接口返回了无法解析的内容".into()))
    }

    /// Ask for a login QR code.
    pub async fn create_qr(&self) -> Result<Qr, Error> {
        let result =
            self.call(&self.api_base, "ilink/bot/get_bot_qrcode?bot_type=3", Call { body: Some(json!({"local_token_list": []})), ..Call::default() }).await?;
        match (result["qrcode"].as_str(), result["qrcode_img_content"].as_str()) {
            (Some(id), Some(url)) if !id.is_empty() && !url.is_empty() => Ok(Qr { id: id.into(), url: url.into() }),
            _ => Err(Error::Other("微信未返回有效二维码".into())),
        }
    }

    /// Where a login stands; the call waits up to 35 seconds for a change.
    pub async fn qr_status(&self, id: &str, base: &str, verify_code: Option<&str>) -> Result<Value, Error> {
        let code = verify_code.map(|code| format!("&verify_code={}", query(code))).unwrap_or_default();
        let asked = self
            .call(
                base,
                &format!("ilink/bot/get_qrcode_status?qrcode={}{code}", query(id)),
                Call { method: "GET", timeout: self.status_wait, ..Call::default() },
            )
            .await;
        // WeChat holds the question open until something changes: no answer in time means nothing changed yet.
        match asked {
            Err(Error::Timeout) => Ok(json!({"status": "wait"})),
            other => other,
        }
    }

    /// Long-poll for messages after `cursor`; a poll that times out is an empty one.
    pub async fn updates(&self, account: &Account, cursor: &str, timeout: Duration) -> Result<Value, Error> {
        match self
            .call(
                &account.base_url,
                "ilink/bot/getupdates",
                Call { token: Some(&account.token), body: Some(json!({"get_updates_buf": cursor})), timeout, ..Call::default() },
            )
            .await
        {
            Err(Error::Timeout) => Ok(json!({"ret": 0, "msgs": [], "get_updates_buf": cursor})),
            other => other,
        }
    }

    /// The ticket that lets the bot show the bound user that it is typing.
    pub async fn typing_ticket(&self, account: &Account) -> Result<String, Error> {
        let body = json!({"ilink_user_id": account.user_id, "context_token": account.context_token});
        let response = self
            .call(&account.base_url, "ilink/bot/getconfig", Call { token: Some(&account.token), body: Some(body), timeout: TYPING_WAIT, ..Call::default() })
            .await?;
        match (response["ret"].as_i64(), response["typing_ticket"].as_str()) {
            (None | Some(0), Some(ticket)) if !ticket.is_empty() => Ok(ticket.to_string()),
            _ => Err(Error::Other(format!("微信未返回输入状态凭证：{}", response["errmsg"].as_str().unwrap_or("无说明")))),
        }
    }

    /// Show the bound user "typing", or take it away.
    pub async fn send_typing(&self, account: &Account, ticket: &str, typing: bool) -> Result<(), Error> {
        let body = json!({"ilink_user_id": account.user_id, "typing_ticket": ticket, "status": if typing { 1 } else { 2 }});
        let response = self
            .call(&account.base_url, "ilink/bot/sendtyping", Call { token: Some(&account.token), body: Some(body), timeout: TYPING_WAIT, ..Call::default() })
            .await?;
        match response["ret"].as_i64() {
            None | Some(0) => Ok(()),
            Some(ret) => {
                Err(Error::Other(format!("微信输入状态失败：{}", response["errmsg"].as_str().map(str::to_string).unwrap_or_else(|| format!("ret={ret}")))))
            }
        }
    }

    async fn send_item(&self, account: &Account, item: Value, client_id: Option<&str>) -> Result<(), Error> {
        let client_id = client_id.map(|id| format!("neo-agent:{id}")).unwrap_or_else(|| format!("neo-agent:{}", neo_kernel::types::uuid()));
        let message = json!({"msg": {"from_user_id": "", "to_user_id": account.user_id, "client_id": client_id, "message_type": 2, "message_state": 2, "context_token": account.context_token, "item_list": [item]}});
        let response =
            self.call(&account.base_url, "ilink/bot/sendmessage", Call { token: Some(&account.token), body: Some(message), ..Call::default() }).await?;
        match response["ret"].as_i64() {
            None | Some(0) => Ok(()),
            Some(ret) => {
                Err(Error::Other(format!("微信发送失败：{}", response["errmsg"].as_str().map(str::to_string).unwrap_or_else(|| format!("ret={ret}")))))
            }
        }
    }

    /// Send a text to the bound user; the same `message_id` is the same message to WeChat.
    pub async fn send_text(&self, account: &Account, text: &str, message_id: Option<&str>) -> Result<(), Error> {
        if text.is_empty() {
            return Ok(());
        }
        self.send_item(account, json!({"type": 1, "text_item": {"text": text}}), message_id).await
    }

    /// Upload a file encrypted and send it as an image, a video or a file, after its caption.
    pub async fn send_media(&self, account: &Account, plain: &[u8], name: &str, media_type: &str, caption: &str) -> Result<(), Error> {
        if plain.len() > MAX_MEDIA_BYTES {
            return Err(Error::Other("微信媒体不能超过 100 MiB".into()));
        }
        let (file_key, key) = (hex(&random::<16>()), random::<16>());
        let cipher_size = (plain.len() / 16 + 1) * 16;
        let kind = if media_type.starts_with("image/") {
            1
        } else if media_type.starts_with("video/") {
            2
        } else {
            3
        };
        let ask = json!({"filekey": file_key, "media_type": kind, "to_user_id": account.user_id, "rawsize": plain.len(), "rawfilemd5": md5_hex(plain), "filesize": cipher_size, "no_need_thumb": true, "aeskey": hex(&key)});
        let upload = self.call(&account.base_url, "ilink/bot/getuploadurl", Call { token: Some(&account.token), body: Some(ask), ..Call::default() }).await?;
        let url = match (upload["upload_full_url"].as_str().filter(|url| !url.is_empty()), upload["upload_param"].as_str().filter(|param| !param.is_empty())) {
            (Some(url), _) => url.to_string(),
            (None, Some(param)) => format!("{}/upload?encrypted_query_param={}&filekey={}", self.cdn_base, query(param), query(&file_key)),
            (None, None) => return Err(Error::Other("微信未返回媒体上传地址".into())),
        };
        let encrypted = encrypt(plain, &key);
        let mut download = String::new();
        for attempt in 0..3u64 {
            let request = Request {
                method: "POST",
                url: url.clone(),
                headers: vec![("content-type".into(), "application/octet-stream".into())],
                body: Some(encrypted.clone()),
                timeout: Duration::from_secs(30),
                want: vec!["x-encrypted-param"],
            };
            let result = match http::send(request).await {
                Ok(response) if !(200..300).contains(&response.status) => Err(Error::Other(format!("微信 CDN HTTP {}", response.status))),
                Ok(response) => {
                    response.headers.into_iter().next().filter(|param| !param.is_empty()).ok_or_else(|| Error::Other("微信 CDN 未返回下载参数".into()))
                }
                Err(failure) => Err(failed(failure)),
            };
            match result {
                Ok(param) => {
                    download = param;
                    break;
                }
                Err(error) if attempt == 2 => return Err(error),
                Err(_) => tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await,
            }
        }
        if !caption.is_empty() {
            self.send_text(account, caption, None).await?;
        }
        let media = json!({"encrypt_query_param": download, "aes_key": STANDARD.encode(hex(&key)), "encrypt_type": 1});
        let item = match kind {
            1 => json!({"type": 2, "image_item": {"media": media, "mid_size": cipher_size}}),
            2 => json!({"type": 5, "video_item": {"media": media, "video_size": cipher_size}}),
            _ => json!({"type": 4, "file_item": {"media": media, "file_name": safe_name(Some(name), "file.bin"), "len": plain.len().to_string()}}),
        };
        self.send_item(account, item, None).await
    }

    async fn download(&self, media: &Value, hex_key: Option<&str>) -> Result<Vec<u8>, String> {
        let url = match media["full_url"].as_str().filter(|url| !url.is_empty()) {
            Some(url) => url.to_string(),
            None => format!("{}/download?encrypted_query_param={}", self.cdn_base, query(media["encrypt_query_param"].as_str().unwrap_or(""))),
        };
        let response =
            http::send(Request { method: "GET", url, timeout: Duration::from_secs(30), ..Request::default() }).await.map_err(|failure| failure.to_string())?;
        if !(200..300).contains(&response.status) {
            return Err(format!("微信 CDN HTTP {}", response.status));
        }
        if response.body.len() > MAX_MEDIA_BYTES + 16 {
            return Err("微信媒体不能超过 100 MiB".into());
        }
        let key = match hex_key.filter(|key| !key.is_empty()) {
            Some(key) => Some(unhex(key).and_then(|bytes| <[u8; 16]>::try_from(bytes).ok()).ok_or("微信媒体 AES 密钥格式无效")?),
            None => media["aes_key"].as_str().filter(|key| !key.is_empty()).map(media_key).transpose()?,
        };
        match key {
            Some(key) => decrypt(&response.body, &key),
            None => Ok(response.body),
        }
    }

    /// The image, file or video a message item carries, downloaded and decrypted; nothing for other items.
    pub async fn download_attachment(&self, item: &Value, message_id: &str) -> Result<Option<ChatAttachment>, String> {
        let fetched = match item["type"].as_i64() {
            Some(2) if item["image_item"]["media"].is_object() => {
                let data = self.download(&item["image_item"]["media"], item["image_item"]["aeskey"].as_str()).await;
                data.map(|data| Some(ChatAttachment { name: format!("wechat-{message_id}.jpg"), media_type: image_mime(&data).into(), data }))
            }
            Some(4) if item["file_item"]["media"].is_object() => {
                let name = safe_name(item["file_item"]["file_name"].as_str(), "file.bin");
                self.download(&item["file_item"]["media"], None).await.map(|data| Some(ChatAttachment { media_type: mime_of(&name).into(), name, data }))
            }
            Some(5) if item["video_item"]["media"].is_object() => self
                .download(&item["video_item"]["media"], None)
                .await
                .map(|data| Some(ChatAttachment { name: format!("wechat-{message_id}.mp4"), media_type: "video/mp4".into(), data })),
            _ => Ok(None),
        };
        fetched.map_err(|error| format!("微信附件下载失败：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_with_md5_as_the_reference_vectors_say() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(md5_hex(b"The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
        assert_eq!(md5_hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890".as_bytes()), "57edf4a22be3c955ac49da2e2107b67a");
        // Lengths around the padding boundary.
        assert_eq!(md5_hex(&[b'a'; 55]), "ef1772b6dff9a122358552954ad0df65");
        assert_eq!(md5_hex(&[b'a'; 56]), "3b0c8ac703f828b04c6c197006d17218");
        assert_eq!(md5_hex(&[b'a'; 64]), "014842d480b571495a4a0363793f7367");
    }

    #[test]
    fn encrypts_as_aes_128_ecb_with_padding_and_back() {
        // FIPS-197 appendix C.1: one block, then a whole block of padding.
        let key: [u8; 16] = unhex("000102030405060708090a0b0c0d0e0f").unwrap().try_into().unwrap();
        let plain = unhex("00112233445566778899aabbccddeeff").unwrap();
        let encrypted = encrypt(&plain, &key);
        assert_eq!(hex(&encrypted[..16]), "69c4e0d86a7b0430d8cdb78070b4c55a");
        assert_eq!(encrypted.len(), 32);
        assert_eq!(decrypt(&encrypted, &key).unwrap(), plain);
        for length in [0usize, 1, 15, 16, 17, 1000] {
            let data: Vec<u8> = (0..length).map(|i| (i * 7) as u8).collect();
            let encrypted = encrypt(&data, &key);
            assert_eq!(encrypted.len(), (length / 16 + 1) * 16);
            assert_eq!(decrypt(&encrypted, &key).unwrap(), data);
        }
        assert!(decrypt(&encrypted[..20], &key).is_err());
        assert!(decrypt(&[0u8; 16], &key).is_err(), "wrong padding");
        assert!(decrypt(&[], &key).is_err());
    }

    #[test]
    fn reads_a_media_key_in_either_encoding() {
        let key = [9u8; 16];
        assert_eq!(media_key(&STANDARD.encode(key)).unwrap(), key);
        assert_eq!(media_key(&STANDARD.encode(hex(&key))).unwrap(), key);
        assert!(media_key(&STANDARD.encode([1u8; 8])).is_err());
        assert!(media_key(&STANDARD.encode("z".repeat(32))).is_err());
        assert!(media_key("not base64!").is_err());
    }

    #[test]
    fn names_files_safely_and_knows_their_types() {
        assert_eq!(safe_name(Some("../notes.txt"), "file.bin"), ".._notes.txt");
        assert_eq!(safe_name(Some(" a\\b\u{7}c "), "file.bin"), "a_b_c");
        assert_eq!(safe_name(Some("   "), "file.bin"), "file.bin");
        assert_eq!(safe_name(None, "file.bin"), "file.bin");
        assert_eq!(safe_name(Some(&"长".repeat(300)), "x").chars().count(), 200);
        assert_eq!(
            (mime_of("A.PNG"), mime_of("notes.md"), mime_of("archive"), mime_of("x.unknown")),
            ("image/png", "text/markdown", "application/octet-stream", "application/octet-stream")
        );
        assert_eq!(image_mime(&[0xff, 0xd8, 0xff, 0xe0]), "image/jpeg");
        assert_eq!(image_mime(b"GIF89a..."), "image/gif");
        assert_eq!(image_mime(b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
        assert_eq!(image_mime(b"plain"), "application/octet-stream");
    }

    #[test]
    fn keeps_64_bit_ids_exact_and_encodes_query_values() {
        let parsed: Value = serde_json::from_str(r#"{"message_id":9007199254740993,"other":"abc","none":null,"empty":""}"#).unwrap();
        assert_eq!(id_text(&parsed["message_id"]).as_deref(), Some("9007199254740993"));
        assert_eq!(id_text(&parsed["other"]).as_deref(), Some("abc"));
        assert_eq!((id_text(&parsed["none"]), id_text(&parsed["empty"])), (None, None));
        assert_eq!(query("a b&c=d/é~"), "a%20b%26c%3Dd%2F%C3%A9~");
    }
}
