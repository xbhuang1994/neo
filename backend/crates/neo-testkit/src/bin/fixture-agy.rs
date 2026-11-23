//! A stand-in Antigravity CLI (`agy`) for browser tests without network or login: lists fixture models and drives
//! Neo's orchestrator and worker MCP tools over the bridge folder Neo creates.

use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};

fn emit(value: &Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

fn mcp_call(url: &str, auth: &str, id: u64, name: &str, arguments: Value) -> Result<Value, String> {
    let rest = url.strip_prefix("http://").ok_or("MCP URL is not http")?;
    let (address, path) = rest.split_once('/').map(|(a, p)| (a, format!("/{p}"))).unwrap_or((rest, "/".into()));
    let body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments}
    }))
    .map_err(|error| error.to_string())?;
    let mut stream = TcpStream::connect(address).map_err(|error| error.to_string())?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(&body)).map_err(|error| error.to_string())?;
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).map_err(|error| error.to_string())?;
    let split = reply.windows(4).position(|window| window == b"\r\n\r\n").ok_or("malformed HTTP response")?;
    serde_json::from_slice(&reply[split + 4..]).map_err(|error| error.to_string())
}

fn load_bridge(bridge: &Path) -> (bool, String, String) {
    let agent = std::fs::read_to_string(bridge.join(".agents/agents/neo-session.md")).unwrap_or_default();
    let is_worker = agent.contains("You are a worker.");
    let config: Value =
        std::fs::read_to_string(bridge.join(".agents/plugins/neo/mcp_config.json")).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let url = config["mcpServers"]["neo"]["url"].as_str().unwrap_or("").to_string();
    let auth = config["mcpServers"]["neo"]["headers"]["Authorization"].as_str().unwrap_or("").to_string();
    (is_worker, url, auth)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        println!("agy 1.0.0-fixture");
        return;
    }
    if args.first().map(String::as_str) == Some("models") {
        println!("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)");
        println!("gemini-3.8-pro-high\tGemini 3.8 Pro (High)");
        return;
    }
    let mut bridge = PathBuf::new();
    let mut conversation = format!("conv-fixture-{}", std::process::id());
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--add-dir" if i + 1 < args.len() => {
                bridge = PathBuf::from(&args[i + 1]);
                i += 2;
            }
            "--conversation" if i + 1 < args.len() => {
                conversation = args[i + 1].clone();
                i += 2;
            }
            _ => i += 1,
        }
    }
    let (is_worker, url, auth) = load_bridge(&bridge);
    emit(&json!({"event": "init", "conversation_id": conversation}));

    let mut step_index = 1i64;
    let mut call_id = 1u64;
    let mut asked_chinese = false;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        if value["event"] != "user" {
            continue;
        }
        let content = value["message"]["content"].as_str().unwrap_or("");
        let cards: Vec<Value> = content.split("\n\n").filter_map(|part| serde_json::from_str::<Value>(part).ok()).collect();
        emit(&json!({
            "event": "step_update",
            "step_update": {"step_index": step_index, "state": "DONE", "step_type": "user_input"}
        }));
        step_index += 1;
        let reply = if is_worker {
            let _ = std::fs::write("result.txt", "done by the worker\n");
            emit(&json!({
                "event": "step_update",
                "step_update": {
                    "step_index": step_index,
                    "state": "DONE",
                    "step_type": "tool",
                    "tool_name": "run_command",
                    "tool_info": {
                        "name": "run_command",
                        "parameters": {"CommandLine": "printf 'done by the worker\\n' > result.txt"},
                        "output": "wrote result.txt"
                    }
                }
            }));
            step_index += 1;
            if let Err(error) =
                mcp_call(&url, &auth, call_id, "orchestrator_report", json!({"state": "ready", "summary": "Wrote result.txt.", "topic": "Write result.txt"}))
            {
                eprintln!("[fixture-agy] orchestrator_report error: {error}");
            }
            call_id += 1;
            "Wrote result.txt."
        } else if let Some(card) = cards.iter().find(|card| card["kind"] == "candidate") {
            let text = card["text"].as_str().unwrap_or("");
            asked_chinese = text.chars().any(|c| matches!(c as u32, 0x3400..=0x9FFF));
            let ack = if asked_chinese { "收到：正在把结果写进文件。" } else { "On it." };
            if let Err(error) = mcp_call(
                &url,
                &auth,
                call_id,
                "orchestrator_route",
                json!({"decisions": [{"kind": "accept", "trigger_id": card["trigger_id"], "title": "Write the result file", "worktree_name": "write-result", "acknowledgement": ack}]}),
            ) {
                eprintln!("[fixture-agy] orchestrator_route error: {error}");
            }
            call_id += 1;
            "Accepted."
        } else if let Some(report) = cards.iter().find(|card| card["kind"] == "worker_report" && card["state"] == "ready") {
            let answer = if asked_chinese { "结果已写入文件。" } else { "The file is written." };
            if let Err(error) =
                mcp_call(&url, &auth, call_id, "orchestrator_reply", json!({"ticket_id": report["ticket"]["ticket_id"], "purpose": "result", "text": answer}))
            {
                eprintln!("[fixture-agy] orchestrator_reply error: {error}");
            }
            call_id += 1;
            "Delivered."
        } else {
            "Done."
        };
        emit(&json!({
            "event": "step_update",
            "step_update": {
                "step_index": step_index,
                "state": "DONE",
                "step_type": "agent_response",
                "text_delta": reply
            }
        }));
        step_index += 1;
        emit(&json!({"event": "result", "result": {"status": "SUCCESS"}}));
    }
}
