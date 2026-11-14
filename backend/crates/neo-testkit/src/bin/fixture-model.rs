//! A fake model endpoint as a program, for trying the product by hand or from a browser test: it plays an
//! orchestrator that accepts each request and a worker that writes a file and reports.
//!
//! Usage: `fixture-model anthropic|openai`. It prints its base URL on one line and runs until it is ended.

use neo_testkit::models::{anthropic, openai, ticket_flow};

#[tokio::main]
async fn main() {
    let kind = std::env::args().nth(1).unwrap_or_default();
    let model = match kind.as_str() {
        "anthropic" => {
            anthropic(|request, number| {
                // With FIXTURE_DUMP set, each request is kept there for a look at what the runtime really sent.
                if let Ok(dir) = std::env::var("FIXTURE_DUMP") {
                    let _ = std::fs::write(format!("{dir}/request-{number}.json"), request.to_string());
                }
                ticket_flow(request, |name| format!("mcp__neo__{name}"), "Bash")
            })
            .await
        }
        "openai" => openai(|request, _| ticket_flow(request, |name| name.to_string(), "bash")).await,
        _ => {
            eprintln!("usage: fixture-model anthropic|openai");
            std::process::exit(2);
        }
    };
    println!("{}", model.url());
    std::future::pending::<()>().await;
}
