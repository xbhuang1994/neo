//! Fake model providers: an Anthropic Messages endpoint and an OpenAI chat-completions endpoint whose every answer a
//! test scripts, as text or tool calls.

use crate::http::{serve, Request, Response, Server};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// What the fake model answers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reply {
    /// Text to say.
    pub text: Option<String>,
    /// Tools to call, as name and arguments.
    pub tool_calls: Vec<(String, Value)>,
}

impl Reply {
    /// Say `text` and end the turn.
    pub fn text(text: &str) -> Reply {
        Reply { text: Some(text.to_string()), tool_calls: Vec::new() }
    }
    /// Call one tool.
    pub fn call(name: &str, arguments: Value) -> Reply {
        Reply { text: None, tool_calls: vec![(name.to_string(), arguments)] }
    }
}

/// A fake provider and the requests it received.
pub struct FakeModel {
    /// The server.
    pub server: Server,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl FakeModel {
    /// The model requests received so far, oldest first.
    pub fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
    /// The base URL to give the runtime.
    pub fn url(&self) -> String {
        self.server.url()
    }
}

/// The names of the tools a request offers the model.
pub fn tool_names(request: &Value) -> Vec<String> {
    request["tools"]
        .as_array()
        .map(|tools| tools.iter().filter_map(|tool| tool["name"].as_str().or(tool["function"]["name"].as_str()).map(str::to_string)).collect())
        .unwrap_or_default()
}

/// How many tool results a request's conversation carries.
pub fn tool_results(request: &Value) -> usize {
    request["messages"]
        .as_array()
        .map(|messages| {
            messages
                .iter()
                .map(|message| {
                    if message["role"] == "tool" {
                        return 1;
                    }
                    message["content"].as_array().map(|blocks| blocks.iter().filter(|block| block["type"] == "tool_result").count()).unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0)
}

/// Everything a request's conversation says, as one string to search.
pub fn conversation(request: &Value) -> String {
    format!("{}\n{}", request["system"], request["messages"])
}

fn anthropic_events(reply: &Reply, number: usize) -> String {
    let mut events =
        vec![json!({"type": "message_start", "message": {"id": format!("msg_fixture_{number}"), "type": "message", "role": "assistant", "model": "fixture",
        "content": [], "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 10, "output_tokens": 1}}})];
    let mut index = 0;
    if let Some(text) = &reply.text {
        events.push(json!({"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}));
        events.push(json!({"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text}}));
        events.push(json!({"type": "content_block_stop", "index": index}));
        index += 1;
    }
    for (call, (name, arguments)) in reply.tool_calls.iter().enumerate() {
        events.push(json!({"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": format!("toolu_{number}_{call}"), "name": name, "input": {}}}));
        events.push(json!({"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": arguments.to_string()}}));
        events.push(json!({"type": "content_block_stop", "index": index}));
        index += 1;
    }
    let stop = if reply.tool_calls.is_empty() { "end_turn" } else { "tool_use" };
    events.push(json!({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": null}, "usage": {"output_tokens": 5}}));
    events.push(json!({"type": "message_stop"}));
    events.iter().map(|event| format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap_or(""))).collect()
}

/// An Anthropic Messages endpoint. `script` answers each request that offers tools (the agent's own turns), given the
/// request and how many such requests came before; the runtime's side requests get a plain "ok".
pub async fn anthropic(script: impl Fn(&Value, usize) -> Reply + Send + Sync + 'static) -> FakeModel {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let server = serve(move |request: Request| {
        if request.method == "GET" {
            return Response::json(200, &json!({"data": [{"id": "fixture", "display_name": "Fixture", "type": "model"}], "has_more": false}));
        }
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        if request.path.contains("count_tokens") {
            return Response::json(200, &json!({"input_tokens": 10}));
        }
        let reply = if tool_names(&body).is_empty() {
            Reply::text("ok")
        } else {
            let number = {
                let mut seen = seen.lock().unwrap();
                seen.push(body.clone());
                seen.len() - 1
            };
            script(&body, number)
        };
        if body["stream"] == true {
            return Response::events(anthropic_events(&reply, seen.lock().unwrap().len()));
        }
        let mut content: Vec<Value> = reply.text.iter().map(|text| json!({"type": "text", "text": text})).collect();
        content.extend(reply.tool_calls.iter().enumerate().map(|(call, (name, arguments))| json!({"type": "tool_use", "id": format!("toolu_plain_{call}"), "name": name, "input": arguments})));
        Response::json(200, &json!({"id": "msg_fixture", "type": "message", "role": "assistant", "model": "fixture", "content": content,
            "stop_reason": if reply.tool_calls.is_empty() { "end_turn" } else { "tool_use" }, "stop_sequence": null, "usage": {"input_tokens": 10, "output_tokens": 5}}))
    })
    .await;
    FakeModel { server, requests }
}

/// An OpenAI chat-completions endpoint at `/v1/chat/completions`. `script` answers each request, given the request
/// and how many came before.
pub async fn openai(script: impl Fn(&Value, usize) -> Reply + Send + Sync + 'static) -> FakeModel {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let server = serve(move |request: Request| {
        if request.method != "POST" || !request.path.ends_with("/chat/completions") {
            return Response::json(404, &json!({"error": "not found"}));
        }
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let number = {
            let mut seen = seen.lock().unwrap();
            seen.push(body.clone());
            seen.len() - 1
        };
        let reply = script(&body, number);
        let delta = if reply.tool_calls.is_empty() {
            json!({"role": "assistant", "content": reply.text.clone().unwrap_or_default()})
        } else {
            let calls: Vec<Value> = reply
                .tool_calls
                .iter()
                .enumerate()
                .map(|(index, (name, arguments))| json!({"index": index, "id": format!("fixture-call-{number}-{index}"), "type": "function", "function": {"name": name, "arguments": arguments.to_string()}}))
                .collect();
            json!({"role": "assistant", "content": reply.text, "tool_calls": calls})
        };
        let chunk = json!({"id": format!("chatcmpl-fixture-{number}"), "object": "chat.completion.chunk", "created": 0, "model": "fixture",
            "choices": [{"index": 0, "delta": delta, "finish_reason": if reply.tool_calls.is_empty() { "stop" } else { "tool_calls" }}]});
        Response::events(format!("data: {chunk}\n\ndata: [DONE]\n\n"))
    })
    .await;
    FakeModel { server, requests }
}

/// The text between `"name":"` and the next quote, where the conversation quotes JSON once or twice.
fn field(text: &str, name: &str) -> Option<String> {
    for quote in ["\\\\\\\"", "\\\"", "\""] {
        let start = format!("{quote}{name}{quote}:{quote}");
        if let Some(at) = text.rfind(&start) {
            let rest = &text[at + start.len()..];
            return rest.find(quote).map(|end| rest[..end].to_string());
        }
    }
    None
}

/// The model both kernels talk to: the orchestrator accepts the request and later sends the result; the worker writes
/// a file with its shell and reports ready. `tool` maps an application tool's name to what the kernel calls it.
pub fn ticket_flow(request: &Value, tool: fn(&str) -> String, shell: &str) -> Reply {
    let all = conversation(request);
    // What the turn answers is the last thing a person or a tool said; a runtime may add notes of its own after it.
    let messages: Vec<Value> = request["messages"].as_array().into_iter().flatten().filter(|message| message["role"] != "system").cloned().collect();
    let last = messages.last().map(Value::to_string).unwrap_or_default();
    let after_tool = messages.last().is_some_and(|message| {
        message["role"] == "tool" || message["content"].as_array().is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"))
    });
    if all.contains("You are a worker.") {
        if !after_tool {
            return Reply::call(shell, json!({"command": "printf 'done by the worker\\n' > result.txt"}));
        }
        if last.contains("reported") || last.contains("notification") {
            return Reply::text("Finished.");
        }
        return Reply::call(&tool("orchestrator_report"), json!({"state": "ready", "summary": "Wrote result.txt.", "topic": "Writing result.txt"}));
    }
    if after_tool {
        return Reply::text("Done.");
    }
    if last.contains("worker_report") {
        let ticket = field(&last, "ticket_id").unwrap_or_default();
        return Reply::call(&tool("orchestrator_reply"), json!({"ticket_id": ticket, "purpose": "result", "text": "The file is written."}));
    }
    if last.contains("candidate") {
        let trigger = field(&last, "trigger_id").unwrap_or_default();
        return Reply::call(
            &tool("orchestrator_route"),
            json!({"decisions": [{"kind": "accept", "trigger_id": trigger, "title": "Write the result file", "worktree_name": "write-result", "acknowledgement": "On it."}]}),
        );
    }
    Reply::text("Noted.")
}
