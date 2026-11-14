//! Neo Agent's HTTP interface: the JSON API the app calls, access control, and the web build's static files.
#![deny(missing_docs)]

pub mod api;
pub mod server;

pub use api::Access;
use neo_app::app::App;
use server::{Handler, Server};
use std::sync::Arc;

/// Whether a host name or address is this machine's loopback, where the API may be offered without a token.
pub fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok_and(|address| address.is_loopback())
}

/// Offer the application's API, and the web build when `access` names its folder, on `host:port`.
///
/// Anywhere but on loopback a token is required: an API without one is refused here rather than exposed.
pub async fn serve(app: Arc<App>, host: &str, port: u16, access: Access) -> Result<Server, String> {
    if access.token.as_deref().is_some_and(|token| token.len() < 16) {
        return Err("The access token must have at least 16 characters".into());
    }
    if access.token.is_none() && !is_loopback(host) {
        return Err(format!("Listening on {host} needs an access token: set one, or listen on 127.0.0.1"));
    }
    let access = Arc::new(access);
    let handler: Handler = Arc::new(move |request, peer| {
        let (app, access) = (app.clone(), access.clone());
        Box::pin(async move { api::handle(app, access, request, peer).await })
    });
    Server::bind(host, port, handler).await
}

#[cfg(test)]
mod tests {
    use super::is_loopback;

    #[test]
    fn tells_loopback_hosts_from_others() {
        for host in ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", "127.8.9.1"] {
            assert!(is_loopback(host), "{host}");
        }
        for host in ["0.0.0.0", "::", "192.168.1.2", "example.com", ""] {
            assert!(!is_loopback(host), "{host}");
        }
    }
}
