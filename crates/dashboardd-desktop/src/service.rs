use std::{
    collections::BTreeMap,
    fs, io,
    io::{BufReader, BufWriter},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use dashboardd_desktop_control::{
    Command, MAX_TITLE_BYTES, PROTOCOL_VERSION, Request, Response, read_message, socket_path,
    write_message,
};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use thiserror::Error;

use crate::audit::AuditLog;

const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const UI_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_TITLE: &str = "dashboardd desktop demo";

pub struct PreparedService {
    listener: UnixListener,
    socket_guard: SocketGuard,
    audit: AuditLog,
    socket_path: PathBuf,
}

#[derive(Clone)]
pub struct DesktopService {
    inner: Arc<ServiceState>,
}

struct ServiceState {
    shutdown: AtomicBool,
    next_surface_id: AtomicU64,
    next_request_id: AtomicU64,
    surfaces: Arc<Mutex<BTreeMap<String, SurfaceInfo>>>,
    socket_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
struct SurfaceInfo {
    surface_id: String,
    title: String,
}

struct CommandResult {
    response: Response,
    surface_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum StartError {
    #[error("cannot resolve control socket: {0}")]
    SocketPath(#[from] dashboardd_desktop_control::ControlPathError),
    #[error("cannot prepare control socket: {0}")]
    Socket(#[source] io::Error),
    #[error("cannot open control audit log: {0}")]
    Audit(#[source] io::Error),
    #[error("dashboardd desktop is already running")]
    AlreadyRunning,
}

impl PreparedService {
    pub fn prepare() -> Result<Self, StartError> {
        let socket_path = socket_path()?;
        let listener = bind_socket(&socket_path)?;
        let socket_guard = SocketGuard::new(socket_path.clone()).map_err(StartError::Socket)?;
        let audit = AuditLog::open().map_err(StartError::Audit)?;
        Ok(Self {
            listener,
            socket_guard,
            audit,
            socket_path,
        })
    }
}

impl DesktopService {
    pub fn start(prepared: PreparedService, app: AppHandle) -> Result<Self, StartError> {
        let state = Arc::new(ServiceState {
            shutdown: AtomicBool::new(false),
            next_surface_id: AtomicU64::new(1),
            next_request_id: AtomicU64::new(1),
            surfaces: Arc::new(Mutex::new(BTreeMap::new())),
            socket_path: prepared.socket_path.clone(),
        });
        let thread_state = Arc::clone(&state);
        thread::Builder::new()
            .name("dashboardd-desktop-control".into())
            .spawn(move || {
                serve(
                    prepared.listener,
                    prepared.socket_guard,
                    prepared.audit,
                    app,
                    thread_state,
                );
            })
            .map_err(StartError::Socket)?;
        Ok(Self { inner: state })
    }

    pub fn shutdown(&self, app: &AppHandle) {
        if self.inner.shutdown.swap(true, Ordering::AcqRel) {
            return;
        }
        let surface_ids = self
            .inner
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for surface_id in surface_ids {
            if let Some(window) = app.get_webview_window(&surface_id) {
                let _ = window.destroy();
            }
        }
        self.inner
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        remove_socket_if_owned(&self.inner.socket_path);
    }
}

fn serve(
    listener: UnixListener,
    _socket_guard: SocketGuard,
    audit: AuditLog,
    app: AppHandle,
    state: Arc<ServiceState>,
) {
    while !state.shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => handle_connection(stream, &audit, &app, &state),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(error) => {
                eprintln!("dashboardd-desktop: control socket failed: {error}");
                break;
            }
        }
    }
}

fn handle_connection(
    stream: UnixStream,
    audit: &AuditLog,
    app: &AppHandle,
    state: &Arc<ServiceState>,
) {
    let request_id = state.next_request_id.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    let _ = stream.set_read_timeout(Some(UI_OPERATION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(UI_OPERATION_TIMEOUT));
    let request = read_message::<Request>(&mut BufReader::new(&stream));
    let (command_name, result) = match request {
        Ok(request) if request.version == PROTOCOL_VERSION => {
            let command_name = request.command.name();
            (command_name, dispatch(app, state, request.command))
        }
        Ok(request) => (
            request.command.name(),
            CommandResult {
                response: Response::failed(
                    "unsupported_version",
                    format!("protocol version {} is not supported", request.version),
                ),
                surface_id: None,
            },
        ),
        Err(error) => (
            "invalid",
            CommandResult {
                response: Response::failed("invalid_request", error.to_string()),
                surface_id: None,
            },
        ),
    };

    let duration_ms = started.elapsed().as_millis();
    if let Err(error) = audit.write(
        request_id,
        command_name,
        result.response.status(),
        duration_ms,
        result.surface_id.as_deref(),
        result.response.error_code(),
    ) {
        eprintln!("dashboardd-desktop: cannot write control audit log: {error}");
    }
    if let Err(error) = write_message(&mut BufWriter::new(&stream), &result.response) {
        eprintln!("dashboardd-desktop: cannot return control response: {error}");
    }
}

fn dispatch(app: &AppHandle, state: &Arc<ServiceState>, command: Command) -> CommandResult {
    let (sender, receiver) = mpsc::sync_channel(1);
    let app_for_command = app.clone();
    let state_for_command = Arc::clone(state);
    if let Err(error) = app.run_on_main_thread(move || {
        let _ = sender.send(execute_command(
            &app_for_command,
            &state_for_command,
            command,
        ));
    }) {
        return failed("ui_unavailable", error.to_string());
    }
    receiver
        .recv_timeout(UI_OPERATION_TIMEOUT)
        .unwrap_or_else(|error| {
            failed(
                "ui_timeout",
                format!("desktop operation did not complete: {error}"),
            )
        })
}

fn execute_command(app: &AppHandle, state: &Arc<ServiceState>, command: Command) -> CommandResult {
    match command {
        Command::OpenDemo { title } => open_demo(app, state, title),
        Command::List => list_surfaces(state),
        Command::Focus { surface_id } => focus_surface(app, state, &surface_id),
        Command::Close { surface_id } => close_surface(app, state, &surface_id),
    }
}

fn open_demo(app: &AppHandle, state: &Arc<ServiceState>, title: Option<String>) -> CommandResult {
    let title = title.unwrap_or_else(|| DEFAULT_TITLE.into());
    if title.is_empty() || title.len() > MAX_TITLE_BYTES || title.chars().any(char::is_control) {
        return failed(
            "invalid_title",
            format!("title must contain 1 to {MAX_TITLE_BYTES} UTF-8 bytes without controls"),
        );
    }
    let surface_id = format!(
        "surface-{}",
        state.next_surface_id.fetch_add(1, Ordering::Relaxed)
    );
    let surfaces = Arc::clone(&state.surfaces);
    let closed_surface_id = surface_id.clone();
    let window = WebviewWindowBuilder::new(app, &surface_id, WebviewUrl::App("demo.html".into()))
        .title(&title)
        .inner_size(720.0, 480.0)
        .resizable(true)
        .decorations(true)
        .build();
    let window = match window {
        Ok(window) => window,
        Err(error) => return failed("window_create_failed", error.to_string()),
    };
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            surfaces
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&closed_surface_id);
        }
    });
    state
        .surfaces
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(
            surface_id.clone(),
            SurfaceInfo {
                surface_id: surface_id.clone(),
                title,
            },
        );
    CommandResult {
        response: Response::ok(json!({ "surface_id": surface_id })),
        surface_id: Some(surface_id),
    }
}

fn list_surfaces(state: &Arc<ServiceState>) -> CommandResult {
    let surfaces = state
        .surfaces
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .values()
        .cloned()
        .collect::<Vec<_>>();
    CommandResult {
        response: Response::ok(json!({ "surfaces": surfaces })),
        surface_id: None,
    }
}

fn focus_surface(app: &AppHandle, state: &Arc<ServiceState>, surface_id: &str) -> CommandResult {
    if !contains_surface(state, surface_id) {
        return surface_not_found(surface_id);
    }
    let Some(window) = app.get_webview_window(surface_id) else {
        state
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(surface_id);
        return surface_not_found(surface_id);
    };
    if let Err(error) = window
        .unminimize()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus())
    {
        return failed("window_focus_failed", error.to_string());
    }
    CommandResult {
        response: Response::ok(json!({ "surface_id": surface_id })),
        surface_id: Some(surface_id.into()),
    }
}

fn close_surface(app: &AppHandle, state: &Arc<ServiceState>, surface_id: &str) -> CommandResult {
    if !contains_surface(state, surface_id) {
        return surface_not_found(surface_id);
    }
    let Some(window) = app.get_webview_window(surface_id) else {
        state
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(surface_id);
        return surface_not_found(surface_id);
    };
    if let Err(error) = window.destroy() {
        return failed("window_close_failed", error.to_string());
    }
    state
        .surfaces
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(surface_id);
    CommandResult {
        response: Response::ok(json!({ "surface_id": surface_id })),
        surface_id: Some(surface_id.into()),
    }
}

fn contains_surface(state: &Arc<ServiceState>, surface_id: &str) -> bool {
    state
        .surfaces
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains_key(surface_id)
}

fn surface_not_found(surface_id: &str) -> CommandResult {
    failed(
        "surface_not_found",
        format!("surface {surface_id:?} does not exist"),
    )
}

fn failed(code: &str, message: String) -> CommandResult {
    CommandResult {
        response: Response::failed(code, message),
        surface_id: None,
    }
}

fn bind_socket(path: &Path) -> Result<UnixListener, StartError> {
    validate_runtime_directory(path).map_err(StartError::Socket)?;
    if path.exists() {
        if UnixStream::connect(path).is_ok() {
            return Err(StartError::AlreadyRunning);
        }
        validate_stale_socket(path).map_err(StartError::Socket)?;
        fs::remove_file(path).map_err(StartError::Socket)?;
    }
    let listener = UnixListener::bind(path).map_err(StartError::Socket)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(StartError::Socket)?;
    listener.set_nonblocking(true).map_err(StartError::Socket)?;
    Ok(listener)
}

fn validate_runtime_directory(socket: &Path) -> io::Result<()> {
    let directory = socket.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "control socket has no parent")
    })?;
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.file_type().is_dir() || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "XDG_RUNTIME_DIR must be a private directory",
        ));
    }
    Ok(())
}

fn validate_stale_socket(path: &Path) -> io::Result<()> {
    let socket_metadata = fs::symlink_metadata(path)?;
    let directory_metadata = fs::symlink_metadata(path.parent().expect("socket parent validated"))?;
    if !socket_metadata.file_type().is_socket() || socket_metadata.uid() != directory_metadata.uid()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to replace an unowned or non-socket control path",
        ));
    }
    Ok(())
}

struct SocketGuard {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl SocketGuard {
    fn new(path: PathBuf) -> io::Result<Self> {
        let metadata = fs::symlink_metadata(&path)?;
        Ok(Self {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let matches = fs::symlink_metadata(&self.path).is_ok_and(|metadata| {
            metadata.file_type().is_socket()
                && metadata.dev() == self.device
                && metadata.ino() == self.inode
        });
        if matches {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn remove_socket_if_owned(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket()) {
        let _ = fs::remove_file(path);
    }
}
