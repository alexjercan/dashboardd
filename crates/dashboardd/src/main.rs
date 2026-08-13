//! The dashboard daemon entry point.
//!
//! This binary serves the built dashboard and exposes its health endpoint.

use std::{
    env,
    error::Error,
    io,
    net::{IpAddr, SocketAddr, TcpListener},
    path::Path,
};

use axum::{
    Router,
    extract::ws::{Message as WebSocketMessage, WebSocket, WebSocketUpgrade},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
};
use dashboard_protocol::{DashboardToServer, ErrorData, ProtocolError, ServerToDashboard};
use rand::seq::SliceRandom;
use tokio::net::TcpListener as TokioTcpListener;
use tower_http::services::ServeDir;
use tracing::info;
use tracing_subscriber::EnvFilter;

const DEFAULT_HOST: &str = "127.0.0.1";
const PORT_RANGE: std::ops::Range<u16> = 7000..8000;
const WEB_DIST: &str = "web/dist";

#[derive(Debug)]
struct Config {
    host: IpAddr,
    port: Option<u16>,
}

impl Config {
    fn from_environment() -> Result<Self, Box<dyn Error>> {
        let host = env::var("DASHBOARDD_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_owned());
        let host = host.parse()?;
        let port = env::var("DASHBOARDD_PORT")
            .ok()
            .map(|value| value.parse())
            .transpose()?;

        if port == Some(0) {
            return Err("DASHBOARDD_PORT must be between 1 and 65535".into());
        }

        Ok(Self { host, port })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let config = Config::from_environment()?;
    ensure_web_dist_exists()?;

    let listener = bind_listener(&config)?;
    let address = listener.local_addr()?;
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(websocket))
        .fallback_service(ServeDir::new(WEB_DIST).append_index_html_on_directories(true));

    info!(%address, "dashboardd listening");
    axum::serve(TokioTcpListener::from_std(listener)?, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("dashboardd stopped");
    Ok(())
}

fn ensure_web_dist_exists() -> io::Result<()> {
    if Path::new(WEB_DIST).is_dir() {
        return Ok(());
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("web frontend not found at {WEB_DIST}; run `cd web && npm run build` first"),
    ))
}

fn bind_listener(config: &Config) -> io::Result<TcpListener> {
    match config.port {
        Some(port) => bind_socket(config.host, port),
        None => {
            let mut ports: Vec<_> = PORT_RANGE.collect();
            ports.shuffle(&mut rand::rng());
            ports
                .into_iter()
                .find_map(|port| bind_socket(config.host, port).ok())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "no free port found in the range 7000-7999",
                    )
                })
        }
    }
}

fn bind_socket(host: IpAddr, port: u16) -> io::Result<TcpListener> {
    let listener = TcpListener::bind(SocketAddr::new(host, port))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

async fn health() -> StatusCode {
    StatusCode::OK
}

async fn websocket(upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade.on_upgrade(handle_socket)
}

#[derive(Debug, Default, PartialEq, Eq)]
enum SessionState {
    #[default]
    AwaitingHello,
    Ready,
}

async fn handle_socket(mut socket: WebSocket) {
    let mut state = SessionState::default();

    while let Some(Ok(websocket_message)) = socket.recv().await {
        let WebSocketMessage::Text(text) = websocket_message else {
            continue;
        };

        let response = match dashboard_protocol::parse::<DashboardToServer>(text.as_str()) {
            Ok(request) => {
                let (next_state, response) = process_message(state, request);
                state = next_state;
                response
            }
            Err(error) => protocol_error(protocol_error_code(&error), error.to_string()),
        };
        let Ok(encoded) = dashboard_protocol::serialize(response) else {
            tracing::error!("failed to serialize WebSocket response");
            break;
        };

        if socket
            .send(WebSocketMessage::Text(encoded.into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

fn process_message(
    state: SessionState,
    request: DashboardToServer,
) -> (SessionState, ServerToDashboard) {
    match request {
        DashboardToServer::Hello {} => (SessionState::Ready, ServerToDashboard::Ready {}),
        _ if state == SessionState::AwaitingHello => (
            state,
            protocol_error(
                "handshake_required",
                "send hello before other dashboard messages",
            ),
        ),
        _ => (
            state,
            protocol_error(
                "not_implemented",
                "dashboard message is not implemented yet",
            ),
        ),
    }
}

fn protocol_error_code(error: &ProtocolError) -> &'static str {
    match error {
        ProtocolError::InvalidMessage(_) => "invalid_message",
        ProtocolError::UnsupportedVersion(_) => "unsupported_version",
    }
}

fn protocol_error(code: impl Into<String>, message: impl Into<String>) -> ServerToDashboard {
    ServerToDashboard::Error {
        request_id: None,
        error: ErrorData {
            code: code.into(),
            message: message.into(),
        },
    }
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to listen for Ctrl-C");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_returns_ready_and_completes_the_handshake() {
        let (state, response) =
            process_message(SessionState::default(), DashboardToServer::Hello {});

        assert_eq!(state, SessionState::Ready);
        assert_eq!(response, ServerToDashboard::Ready {});
    }

    #[test]
    fn messages_before_hello_return_an_error() {
        let (state, response) = process_message(
            SessionState::default(),
            DashboardToServer::ListWidgets {
                request_id: "request-1".into(),
            },
        );

        assert_eq!(state, SessionState::AwaitingHello);
        assert_eq!(
            response,
            protocol_error(
                "handshake_required",
                "send hello before other dashboard messages"
            )
        );
    }
}
