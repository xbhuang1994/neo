//! A small blocking HTTP client run off the async runtime, for the few outbound calls the application makes itself.

use std::time::Duration;

/// A response's status, headers of interest and body.
#[derive(Clone, Debug)]
pub struct Response {
    /// The status code.
    pub status: u16,
    /// The body.
    pub body: Vec<u8>,
    /// The headers asked for in the request, in that order; empty when absent.
    pub headers: Vec<String>,
}

/// A request to make.
#[derive(Clone, Debug, Default)]
pub struct Request {
    /// `GET` or `POST`.
    pub method: &'static str,
    /// The URL.
    pub url: String,
    /// Request headers.
    pub headers: Vec<(String, String)>,
    /// The body of a `POST`.
    pub body: Option<Vec<u8>>,
    /// How long the whole exchange may take.
    pub timeout: Duration,
    /// Response headers to return.
    pub want: Vec<&'static str>,
}

/// Why a request got no response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Nothing came back in time.
    Timeout,
    /// The connection failed.
    Transport(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Timeout => f.write_str("The request timed out"),
            Failure::Transport(error) => f.write_str(error),
        }
    }
}

fn blocking(request: Request) -> Result<Response, Failure> {
    let agent = ureq::AgentBuilder::new().timeout(request.timeout).build();
    let mut call = agent.request(request.method, &request.url);
    for (name, value) in &request.headers {
        call = call.set(name, value);
    }
    let result = match &request.body {
        Some(body) => call.send_bytes(body),
        None => call.call(),
    };
    let response = match result {
        Ok(response) => response,
        // A status the server chose is a response, not a failure.
        Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(error)) => {
            let text = error.to_string();
            let timed_out = text.contains("timed out") || text.contains("Timeout") || text.contains("timeout");
            return Err(if timed_out { Failure::Timeout } else { Failure::Transport(text) });
        }
    };
    let status = response.status();
    let headers = request.want.iter().map(|name| response.header(name).unwrap_or("").to_string()).collect();
    let mut body = Vec::new();
    use std::io::Read;
    match response.into_reader().take(128 << 20).read_to_end(&mut body) {
        Ok(_) => Ok(Response { status, body, headers }),
        Err(error) if error.kind() == std::io::ErrorKind::TimedOut || error.kind() == std::io::ErrorKind::WouldBlock => Err(Failure::Timeout),
        Err(error) => Err(Failure::Transport(error.to_string())),
    }
}

/// Make a request without blocking the async runtime.
pub async fn send(request: Request) -> Result<Response, Failure> {
    tokio::task::spawn_blocking(move || blocking(request)).await.unwrap_or_else(|error| Err(Failure::Transport(error.to_string())))
}
