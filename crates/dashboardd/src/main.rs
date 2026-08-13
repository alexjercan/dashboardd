//! The dashboard daemon entry point.
//!
//! This binary serves the dashboard and bridges browser sessions to widget backends.

mod widget;

use std::{
    env,
    error::Error,
    io,
    net::{IpAddr, SocketAddr, TcpListener},
    path::Path,
    sync::Arc,
};

use axum::{
    Router,
    extract::{
        Path as AxumPath, State,
        ws::{Message as WebSocketMessage, WebSocket, WebSocketUpgrade},
    },
    http::{StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::get,
};
use dashboard_protocol::{
    DashboardToServer, ErrorData, InstanceId, ProtocolError, RequestId, ServerToDashboard,
    ServerToWidget, WidgetDescriptor, WidgetId,
};
use rand::seq::SliceRandom;
use serde_json::Value;
use tokio::{net::TcpListener as TokioTcpListener, sync::mpsc};
use tower_http::services::ServeDir;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::widget::WidgetManifest;

const DEFAULT_HOST: &str = "127.0.0.1";
const PORT_RANGE: std::ops::Range<u16> = 7000..8000;
const WEB_DIST: &str = "web/dist";
const WIDGETS_DIR: &str = "widgets";

#[derive(Clone)]
struct AppState {
    widgets: Arc<Vec<WidgetManifest>>,
}

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
    let widgets = widget::discover_widgets(Path::new(WIDGETS_DIR))?;
    info!(count = widgets.len(), "discovered widgets");

    let listener = bind_listener(&config)?;
    let address = listener.local_addr()?;
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(websocket))
        .route("/widgets/{widget_id}/frontend.js", get(widget_frontend))
        .fallback_service(ServeDir::new(WEB_DIST).append_index_html_on_directories(true))
        .with_state(AppState {
            widgets: Arc::new(widgets),
        });

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

async fn websocket(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn widget_frontend(
    AxumPath(widget_id): AxumPath<WidgetId>,
    State(state): State<AppState>,
) -> Response {
    let Some(manifest) = state
        .widgets
        .iter()
        .find(|widget| widget.descriptor.id == widget_id)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };

    match tokio::fs::read_to_string(&manifest.frontend).await {
        Ok(source) => ([(CONTENT_TYPE, "text/javascript; charset=utf-8")], source).into_response(),
        Err(error) => {
            tracing::error!(%error, widget_id, "failed to read widget frontend");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
enum SessionState {
    #[default]
    AwaitingHello,
    Ready,
}

#[derive(Debug, PartialEq, Eq)]
enum SessionAction {
    Reply(ServerToDashboard),
    StartWidget {
        request_id: RequestId,
        widget_id: WidgetId,
    },
    SendWidget {
        instance_id: InstanceId,
        payload: Value,
    },
}

async fn handle_socket(mut socket: WebSocket, app: AppState) {
    let mut state = SessionState::default();
    let (updates_tx, mut updates_rx) = mpsc::unbounded_channel();
    let mut backend: Option<widget::WidgetBackend> = None;

    loop {
        tokio::select! {
            browser_message = socket.recv() => {
                let Some(Ok(WebSocketMessage::Text(text))) = browser_message else {
                    break;
                };

                let action = match dashboard_protocol::parse::<DashboardToServer>(text.as_str()) {
                    Ok(request) => {
                        let descriptors = app.widgets.iter().map(|widget| widget.descriptor.clone()).collect();
                        let (next_state, action) = process_message(state, request, descriptors);
                        state = next_state;
                        action
                    }
                    Err(error) => SessionAction::Reply(protocol_error(
                        None,
                        protocol_error_code(&error),
                        error.to_string(),
                    )),
                };

                let response = match action {
                    SessionAction::Reply(response) => response,
                    SessionAction::StartWidget { request_id, widget_id } => {
                        if backend.is_some() {
                            protocol_error(
                                Some(request_id),
                                "instance_exists",
                                "this dashboard session already has a widget instance",
                            )
                        } else if let Some(manifest) = app.widgets.iter().find(|widget| widget.descriptor.id == widget_id) {
                            let instance_id = format!("{widget_id}-1");
                            backend = Some(widget::start_backend(
                                Arc::new(manifest.clone()),
                                instance_id.clone(),
                                updates_tx.clone(),
                            ));
                            ServerToDashboard::InstanceCreated {
                                request_id,
                                instance_id,
                                widget_id,
                            }
                        } else {
                            protocol_error(Some(request_id), "unknown_widget", "widget was not found")
                        }
                    }
                    SessionAction::SendWidget { instance_id, payload } => {
                        match &backend {
                            Some(backend) if backend.send(ServerToWidget::Message { instance_id, payload }).is_ok() => {
                                continue;
                            }
                            Some(_) => protocol_error(None, "backend_failed", "widget backend is unavailable"),
                            None => protocol_error(None, "unknown_instance", "widget instance was not found"),
                        }
                    }
                };

                if send_dashboard_message(&mut socket, response).await.is_err() {
                    break;
                }
            }
            Some(update) = updates_rx.recv(), if backend.is_some() => {
                if send_dashboard_message(&mut socket, update).await.is_err() {
                    break;
                }
            }
        }
    }

    drop(backend);
}

async fn send_dashboard_message(
    socket: &mut WebSocket,
    message: ServerToDashboard,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let encoded = dashboard_protocol::serialize(message)?;
    socket.send(WebSocketMessage::Text(encoded.into())).await?;
    Ok(())
}

fn process_message(
    state: SessionState,
    request: DashboardToServer,
    widgets: Vec<WidgetDescriptor>,
) -> (SessionState, SessionAction) {
    match request {
        DashboardToServer::Hello {} => (
            SessionState::Ready,
            SessionAction::Reply(ServerToDashboard::Ready {}),
        ),
        _ if state == SessionState::AwaitingHello => (
            state,
            SessionAction::Reply(protocol_error(
                None,
                "handshake_required",
                "send hello before other dashboard messages",
            )),
        ),
        DashboardToServer::ListWidgets { request_id } => (
            state,
            SessionAction::Reply(ServerToDashboard::Widgets {
                request_id,
                widgets,
            }),
        ),
        DashboardToServer::CreateInstance {
            request_id,
            widget_id,
        } => (
            state,
            SessionAction::StartWidget {
                request_id,
                widget_id,
            },
        ),
        DashboardToServer::WidgetMessage {
            instance_id,
            payload,
        } => (
            state,
            SessionAction::SendWidget {
                instance_id,
                payload,
            },
        ),
        _ => (
            state,
            SessionAction::Reply(protocol_error(
                None,
                "not_implemented",
                "dashboard message is not implemented yet",
            )),
        ),
    }
}

fn protocol_error_code(error: &ProtocolError) -> &'static str {
    match error {
        ProtocolError::InvalidMessage(_) => "invalid_message",
        ProtocolError::UnsupportedVersion(_) => "unsupported_version",
    }
}

fn protocol_error(
    request_id: Option<RequestId>,
    code: impl Into<String>,
    message: impl Into<String>,
) -> ServerToDashboard {
    ServerToDashboard::Error {
        request_id,
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
        let (state, action) =
            process_message(SessionState::default(), DashboardToServer::Hello {}, vec![]);

        assert_eq!(state, SessionState::Ready);
        assert_eq!(action, SessionAction::Reply(ServerToDashboard::Ready {}));
    }

    #[test]
    fn ready_session_lists_widgets() {
        let descriptor = WidgetDescriptor {
            id: "cpu".into(),
            name: "CPU".into(),
            frontend_url: "/widgets/cpu/frontend.js".into(),
        };
        let (state, action) = process_message(
            SessionState::Ready,
            DashboardToServer::ListWidgets {
                request_id: "widgets-1".into(),
            },
            vec![descriptor.clone()],
        );

        assert_eq!(state, SessionState::Ready);
        assert_eq!(
            action,
            SessionAction::Reply(ServerToDashboard::Widgets {
                request_id: "widgets-1".into(),
                widgets: vec![descriptor],
            })
        );
    }

    #[test]
    fn ready_session_routes_widget_messages() {
        let payload = serde_json::json!({"mode": "performance"});
        let (state, action) = process_message(
            SessionState::Ready,
            DashboardToServer::WidgetMessage {
                instance_id: "cpu-1".into(),
                payload: payload.clone(),
            },
            vec![],
        );

        assert_eq!(state, SessionState::Ready);
        assert_eq!(
            action,
            SessionAction::SendWidget {
                instance_id: "cpu-1".into(),
                payload,
            }
        );
    }

    #[test]
    fn messages_before_hello_return_an_error() {
        let (state, action) = process_message(
            SessionState::default(),
            DashboardToServer::ListWidgets {
                request_id: "request-1".into(),
            },
            vec![],
        );

        assert_eq!(state, SessionState::AwaitingHello);
        assert_eq!(
            action,
            SessionAction::Reply(protocol_error(
                None,
                "handshake_required",
                "send hello before other dashboard messages"
            ))
        );
    }
}
