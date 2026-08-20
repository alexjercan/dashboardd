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
    Command, DirectInput, PROTOCOL_VERSION, Presentation, Request, Response, read_message,
    socket_path, write_message,
};
use dashboardd_runtime::{
    CreateInstanceSpec, HealthStatus, Instance, InstanceError, InstanceHealth, RuntimeEvent,
    RuntimeHandle, Theme, TypedInput,
};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, http,
    ipc::Channel,
};
use thiserror::Error;

use crate::audit::AuditLog;

const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const UI_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const WINDOW_UNIT: f64 = 240.0;
const MAX_WINDOW_WIDTH: f64 = 1200.0;
const MAX_WINDOW_HEIGHT: f64 = 960.0;

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
    surfaces: Mutex<BTreeMap<String, SurfaceInfo>>,
    socket_path: PathBuf,
    runtime: RuntimeHandle,
}

#[derive(Clone)]
struct SurfaceInfo {
    surface_id: String,
    instance_id: String,
    widget_id: String,
    widget_name: String,
    variant_id: String,
    title: String,
    presentation: Presentation,
    frontend_path: PathBuf,
    event_channel: Option<Channel<Value>>,
}

struct CommandResult {
    response: Response,
    surface_id: Option<String>,
    quit: bool,
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

#[derive(Serialize)]
pub struct SurfaceSnapshot {
    instance: Instance,
    widget_name: String,
    frontend_url: String,
    presentation: Presentation,
    theme: Theme,
    health: InstanceHealth,
    state: WidgetStateSnapshot,
}

#[derive(Serialize)]
pub struct WidgetStateSnapshot {
    revision: u64,
    value: Value,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum StateMutation {
    Updated { state: WidgetStateSnapshot },
    Conflict { state: WidgetStateSnapshot },
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
    pub fn new(prepared: &PreparedService, runtime: RuntimeHandle) -> Self {
        Self {
            inner: Arc::new(ServiceState {
                shutdown: AtomicBool::new(false),
                next_surface_id: AtomicU64::new(1),
                next_request_id: AtomicU64::new(1),
                surfaces: Mutex::new(BTreeMap::new()),
                socket_path: prepared.socket_path.clone(),
                runtime,
            }),
        }
    }

    pub fn start(&self, prepared: PreparedService, app: AppHandle) -> Result<(), StartError> {
        let state = Arc::clone(&self.inner);
        thread::Builder::new()
            .name("dashboardd-desktop-control".into())
            .spawn(move || {
                serve(
                    prepared.listener,
                    prepared.socket_guard,
                    prepared.audit,
                    app,
                    state,
                );
            })
            .map_err(StartError::Socket)?;
        Ok(())
    }

    pub fn forward_runtime_events(&self) {
        let mut events = self.inner.runtime.subscribe();
        let state = Arc::clone(&self.inner);
        tauri::async_runtime::spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                if state.shutdown.load(Ordering::Acquire) {
                    break;
                }
                emit_runtime_event(&state, event);
            }
        });
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

    pub fn widget_protocol(
        &self,
        webview_label: &str,
        request: http::Request<Vec<u8>>,
    ) -> http::Response<Vec<u8>> {
        if request.method() != http::Method::GET {
            return protocol_response(
                http::StatusCode::METHOD_NOT_ALLOWED,
                b"method not allowed".to_vec(),
            );
        }
        let requested = request
            .uri()
            .path()
            .strip_prefix('/')
            .and_then(|path| path.strip_suffix(".js"));
        let Some(surface_id) = requested else {
            return protocol_response(http::StatusCode::NOT_FOUND, b"not found".to_vec());
        };
        if surface_id != webview_label {
            return protocol_response(http::StatusCode::FORBIDDEN, b"forbidden".to_vec());
        }
        let path = self
            .inner
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(surface_id)
            .map(|surface| surface.frontend_path.clone());
        let Some(path) = path else {
            return protocol_response(http::StatusCode::NOT_FOUND, b"not found".to_vec());
        };
        match fs::read(path) {
            Ok(body) => http::Response::builder()
                .status(http::StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")
                .header("access-control-allow-origin", "*")
                .header("cache-control", "no-store")
                .header("x-content-type-options", "nosniff")
                .body(body)
                .expect("static protocol response is valid"),
            Err(_) => protocol_response(http::StatusCode::NOT_FOUND, b"not found".to_vec()),
        }
    }
}

#[tauri::command]
pub fn surface_subscribe(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let mut surfaces = service
        .inner
        .surfaces
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let surface = surfaces
        .get_mut(window.label())
        .ok_or_else(|| "surface was not found".to_owned())?;
    surface.event_channel = Some(on_event);
    Ok(())
}

#[tauri::command]
pub async fn surface_initialize(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
) -> Result<SurfaceSnapshot, String> {
    let surface = service.surface(&window)?;
    let instance = service
        .inner
        .runtime
        .instance(&surface.instance_id)
        .await
        .map_err(instance_message)?;
    let health = service
        .inner
        .runtime
        .health(&surface.instance_id)
        .await
        .map_err(instance_message)?;
    let (revision, value) = service
        .inner
        .runtime
        .widget_state(&surface.widget_id)
        .map_err(instance_message)?;
    Ok(SurfaceSnapshot {
        instance,
        widget_name: surface.widget_name,
        frontend_url: format!("dashboardd-widget://localhost/{}.js", surface.surface_id),
        presentation: surface.presentation,
        theme: service.inner.runtime.theme(),
        health,
        state: WidgetStateSnapshot { revision, value },
    })
}

#[tauri::command]
pub async fn surface_send(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
    payload: Value,
) -> Result<(), String> {
    let surface = service.surface(&window)?;
    service
        .inner
        .runtime
        .send_message(&surface.instance_id, payload)
        .await
        .map_err(instance_message)
}

#[tauri::command]
pub async fn surface_restart(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
) -> Result<InstanceHealth, String> {
    let surface = service.surface(&window)?;
    service
        .inner
        .runtime
        .restart_instance(&surface.instance_id)
        .await
        .map_err(instance_message)
}

#[tauri::command]
pub async fn surface_mutate_state(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
    revision: u64,
    value: Value,
) -> Result<StateMutation, String> {
    let surface = service.surface(&window)?;
    match service
        .inner
        .runtime
        .set_widget_state(&surface.widget_id, revision, value)
        .await
    {
        Ok((revision, value)) => Ok(StateMutation::Updated {
            state: WidgetStateSnapshot { revision, value },
        }),
        Err(InstanceError::WidgetStateConflict) => {
            let (revision, value) = service
                .inner
                .runtime
                .widget_state(&surface.widget_id)
                .map_err(instance_message)?;
            Ok(StateMutation::Conflict {
                state: WidgetStateSnapshot { revision, value },
            })
        }
        Err(error) => Err(instance_message(error)),
    }
}

impl DesktopService {
    fn surface(&self, window: &WebviewWindow) -> Result<SurfaceInfo, String> {
        self.inner
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(window.label())
            .cloned()
            .ok_or_else(|| "surface was not found".into())
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
            (command_name, execute_command(app, state, request.command))
        }
        Ok(request) => (
            request.command.name(),
            failed(
                "unsupported_version",
                format!("protocol version {} is not supported", request.version),
            ),
        ),
        Err(error) => ("invalid", failed("invalid_request", error.to_string())),
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
    if result.quit {
        DesktopService {
            inner: Arc::clone(state),
        }
        .shutdown(app);
        app.exit(0);
    }
}

fn execute_command(app: &AppHandle, state: &Arc<ServiceState>, command: Command) -> CommandResult {
    match command {
        Command::Discover => discover(state),
        Command::Open {
            widget_id,
            variant_id,
            options,
            inputs,
            presentation,
        } => open_surface(
            app,
            state,
            widget_id,
            variant_id,
            options,
            inputs,
            presentation,
        ),
        Command::Update {
            surface_id,
            inputs,
            presentation,
        } => update_surface(app, state, surface_id, inputs, presentation),
        Command::List => list_surfaces(state),
        Command::Focus { surface_id } => focus_surface(app, state, &surface_id),
        Command::Close { surface_id } => close_surface(app, state, &surface_id),
        Command::Quit => CommandResult {
            response: Response::ok(json!({})),
            surface_id: None,
            quit: true,
        },
    }
}

fn discover(state: &Arc<ServiceState>) -> CommandResult {
    let widgets = state
        .runtime
        .widgets()
        .into_iter()
        .map(|widget| {
            let variants = widget
                .variants
                .into_iter()
                .map(|variant| {
                    json!({
                        "id": variant.id,
                        "name": variant.name,
                        "width": variant.width,
                        "height": variant.height,
                        "focus": variant.focus,
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "id": widget.id,
                "name": widget.name,
                "description": widget.description,
                "variants": variants,
                "options": widget.options,
                "inputs": widget.inputs,
            })
        })
        .collect::<Vec<_>>();
    ok(json!({ "widgets": widgets }), None)
}

fn open_surface(
    app: &AppHandle,
    state: &Arc<ServiceState>,
    widget_id: String,
    variant_id: String,
    options: BTreeMap<String, Value>,
    inputs: BTreeMap<String, DirectInput>,
    presentation: Presentation,
) -> CommandResult {
    let Some(widget) = state.runtime.widget(&widget_id) else {
        return failed("widget_not_found", "widget was not found".into());
    };
    let Some(variant) = widget
        .variants
        .iter()
        .find(|variant| variant.id == variant_id)
        .cloned()
    else {
        return failed("variant_not_found", "widget variant was not found".into());
    };
    if let Err(result) = validate_required_inputs(&widget, &variant_id, &inputs) {
        return result;
    }
    let runtime_inputs = inputs
        .into_iter()
        .map(|(id, input)| {
            (
                id,
                TypedInput {
                    input_type: input.input_type,
                    value: input.value,
                },
            )
        })
        .collect();
    let instance = match tauri::async_runtime::block_on(state.runtime.create_instance(
        &widget_id,
        CreateInstanceSpec {
            variant_id: variant_id.clone(),
            options,
            inputs: runtime_inputs,
        },
    )) {
        Ok(instance) => instance,
        Err(error) => return instance_failed(error),
    };
    let frontend_path = match state.runtime.widget_frontend(&widget_id, &variant_id) {
        Ok(path) => path,
        Err(error) => {
            let _ = tauri::async_runtime::block_on(state.runtime.delete_instance(&instance.id));
            return instance_failed(error);
        }
    };
    let surface_id = format!(
        "surface-{}",
        state.next_surface_id.fetch_add(1, Ordering::Relaxed)
    );
    let title = format!("{} - dashboardd", widget.name);
    let surface = SurfaceInfo {
        surface_id: surface_id.clone(),
        instance_id: instance.id.clone(),
        widget_id,
        widget_name: widget.name,
        variant_id,
        title: title.clone(),
        presentation,
        frontend_path,
        event_channel: None,
    };
    state
        .surfaces
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(surface_id.clone(), surface);

    let dimensions = window_dimensions(variant.width, variant.height);
    let build_result = run_on_main(app, {
        let app = app.clone();
        let state = Arc::clone(state);
        let closed_surface_id = surface_id.clone();
        move || {
            let window = WebviewWindowBuilder::new(
                &app,
                &closed_surface_id,
                WebviewUrl::App("index.html".into()),
            )
            .title(&title)
            .inner_size(dimensions.0, dimensions.1)
            .resizable(true)
            .decorations(true)
            .build()
            .map_err(|error| error.to_string())?;
            let callback_state = Arc::clone(&state);
            let callback_surface_id = closed_surface_id.clone();
            window.on_window_event(move |event| {
                if !matches!(event, WindowEvent::Destroyed) {
                    return;
                }
                let removed = callback_state
                    .surfaces
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&callback_surface_id);
                if let Some(surface) = removed {
                    let runtime = callback_state.runtime.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = runtime.delete_instance(&surface.instance_id).await;
                    });
                }
            });
            Ok(())
        }
    });
    if let Err(error) = build_result.and_then(|result| result) {
        state
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&surface_id);
        let _ = tauri::async_runtime::block_on(state.runtime.delete_instance(&instance.id));
        return failed("window_create_failed", error);
    }
    ok(
        json!({
            "surface_id": surface_id,
            "instance_id": instance.id,
            "width": dimensions.0,
            "height": dimensions.1,
        }),
        Some(surface_id),
    )
}

fn update_surface(
    app: &AppHandle,
    state: &Arc<ServiceState>,
    surface_id: String,
    inputs: Option<BTreeMap<String, DirectInput>>,
    presentation: Option<Presentation>,
) -> CommandResult {
    if inputs.is_none() && presentation.is_none() {
        return failed(
            "empty_update",
            "update requires inputs or presentation".into(),
        );
    }
    let Some(surface) = get_surface(state, &surface_id) else {
        return surface_not_found(&surface_id);
    };
    if let Some(inputs) = inputs {
        let Some(widget) = state.runtime.widget(&surface.widget_id) else {
            return failed("widget_not_found", "widget was not found".into());
        };
        if let Err(result) = validate_required_inputs(&widget, &surface.variant_id, &inputs) {
            return result;
        }
        let runtime_inputs = inputs
            .into_iter()
            .map(|(id, input)| {
                (
                    id,
                    TypedInput {
                        input_type: input.input_type,
                        value: input.value,
                    },
                )
            })
            .collect();
        if let Err(error) = tauri::async_runtime::block_on(
            state
                .runtime
                .set_instance_inputs(&surface.instance_id, runtime_inputs),
        ) {
            return instance_failed(error);
        }
    }
    if let Some(presentation) = presentation {
        if app.get_webview_window(&surface_id).is_none() {
            return surface_not_found(&surface_id);
        }
        let channel = state
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(&surface_id)
            .and_then(|stored| {
                stored.presentation = presentation;
                stored.event_channel.clone()
            });
        if let Some(channel) = channel {
            let _ = channel.send(json!({
                "kind": "presentation_updated",
                "data": { "presentation": presentation },
            }));
        }
    }
    ok(json!({ "surface_id": surface_id }), Some(surface_id))
}

fn list_surfaces(state: &Arc<ServiceState>) -> CommandResult {
    let surfaces = state
        .surfaces
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let health = tauri::async_runtime::block_on(state.runtime.instance_health())
        .into_iter()
        .map(|health| (health.instance_id.clone(), health.status))
        .collect::<BTreeMap<_, _>>();
    let surfaces = surfaces
        .into_iter()
        .map(|surface| {
            json!({
                "surface_id": surface.surface_id,
                "instance_id": surface.instance_id,
                "widget_id": surface.widget_id,
                "variant_id": surface.variant_id,
                "title": surface.title,
                "presentation": surface.presentation,
                "health": health.get(&surface.instance_id).copied().unwrap_or(HealthStatus::Failed),
            })
        })
        .collect::<Vec<_>>();
    ok(json!({ "surfaces": surfaces }), None)
}

fn focus_surface(app: &AppHandle, state: &Arc<ServiceState>, surface_id: &str) -> CommandResult {
    if get_surface(state, surface_id).is_none() {
        return surface_not_found(surface_id);
    }
    let surface_id_owned = surface_id.to_owned();
    let result = run_on_main(app, {
        let app = app.clone();
        move || {
            let window = app
                .get_webview_window(&surface_id_owned)
                .ok_or_else(|| "window was not found".to_owned())?;
            window
                .unminimize()
                .and_then(|()| window.show())
                .and_then(|()| window.set_focus())
                .map_err(|error| error.to_string())
        }
    });
    match result.and_then(|result| result) {
        Ok(()) => ok(json!({ "surface_id": surface_id }), Some(surface_id.into())),
        Err(error) => failed("window_focus_failed", error),
    }
}

fn close_surface(app: &AppHandle, state: &Arc<ServiceState>, surface_id: &str) -> CommandResult {
    let surface = state
        .surfaces
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(surface_id);
    let Some(surface) = surface else {
        return surface_not_found(surface_id);
    };
    let surface_id_owned = surface_id.to_owned();
    let result = run_on_main(app, {
        let app = app.clone();
        move || {
            app.get_webview_window(&surface_id_owned)
                .ok_or_else(|| "window was not found".to_owned())?
                .destroy()
                .map_err(|error| error.to_string())
        }
    });
    if let Err(error) = result.and_then(|result| result) {
        state
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(surface_id.into(), surface);
        return failed("window_close_failed", error);
    }
    if let Err(error) =
        tauri::async_runtime::block_on(state.runtime.delete_instance(&surface.instance_id))
    {
        return instance_failed(error);
    }
    ok(json!({ "surface_id": surface_id }), Some(surface_id.into()))
}

fn emit_runtime_event(state: &Arc<ServiceState>, event: RuntimeEvent) {
    let targets = {
        let surfaces = state
            .surfaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let matching = |predicate: &dyn Fn(&SurfaceInfo) -> bool| {
            surfaces
                .values()
                .filter(|surface| predicate(surface))
                .filter_map(|surface| surface.event_channel.clone())
                .collect::<Vec<_>>()
        };
        match &event {
            RuntimeEvent::InstanceCreated { .. } => Vec::new(),
            RuntimeEvent::InstanceDestroyed { instance_id }
            | RuntimeEvent::InstanceInputsUpdated { instance_id, .. }
            | RuntimeEvent::InstanceHealthUpdated {
                health: InstanceHealth { instance_id, .. },
            }
            | RuntimeEvent::WidgetUpdate { instance_id, .. } => {
                matching(&|surface| surface.instance_id == *instance_id)
            }
            RuntimeEvent::InstanceError {
                instance_id: Some(instance_id),
                ..
            } => matching(&|surface| surface.instance_id == *instance_id),
            RuntimeEvent::WidgetStateUpdated { widget_id, .. } => {
                matching(&|surface| surface.widget_id == *widget_id)
            }
            RuntimeEvent::InstanceError {
                instance_id: None, ..
            }
            | RuntimeEvent::ThemeUpdated { .. }
            | RuntimeEvent::ConfigurationError { .. } => matching(&|_| true),
        }
    };
    let Ok(payload) = serde_json::to_value(event) else {
        return;
    };
    for channel in targets {
        let _ = channel.send(payload.clone());
    }
}

fn validate_required_inputs(
    widget: &dashboardd_runtime::WidgetDescriptor,
    variant_id: &str,
    inputs: &BTreeMap<String, DirectInput>,
) -> Result<(), CommandResult> {
    let missing = widget
        .inputs
        .iter()
        .filter(|input| {
            input.required
                && (input.variants.is_empty()
                    || input.variants.iter().any(|variant| variant == variant_id))
                && !inputs.contains_key(&input.id)
        })
        .map(|input| input.id.clone())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(failed(
            "required_inputs_missing",
            format!("required widget inputs are missing: {}", missing.join(", ")),
        ))
    }
}

fn get_surface(state: &Arc<ServiceState>, surface_id: &str) -> Option<SurfaceInfo> {
    state
        .surfaces
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(surface_id)
        .cloned()
}

fn window_dimensions(width: u32, height: u32) -> (f64, f64) {
    let width = f64::from(width) * WINDOW_UNIT;
    let height = f64::from(height) * WINDOW_UNIT;
    let scale = 1.0_f64
        .min(MAX_WINDOW_WIDTH / width)
        .min(MAX_WINDOW_HEIGHT / height);
    ((width * scale).round(), (height * scale).round())
}

fn run_on_main<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(operation());
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(UI_OPERATION_TIMEOUT)
        .map_err(|error| format!("desktop operation did not complete: {error}"))
}

fn protocol_response(status: http::StatusCode, body: Vec<u8>) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(body)
        .expect("static protocol response is valid")
}

fn surface_not_found(surface_id: &str) -> CommandResult {
    failed(
        "surface_not_found",
        format!("surface {surface_id:?} does not exist"),
    )
}

fn instance_failed(error: InstanceError) -> CommandResult {
    let code = match error {
        InstanceError::UnknownWidget => "widget_not_found",
        InstanceError::UnknownVariant => "variant_not_found",
        InstanceError::UnknownInstance => "instance_not_found",
        InstanceError::InvalidOptions(_) => "invalid_options",
        InstanceError::InvalidInputs(_) => "invalid_inputs",
        InstanceError::BackendNotFound => "backend_not_found",
        InstanceError::BackendUnavailable => "backend_unavailable",
        InstanceError::PersistenceFailed => "persistence_failed",
        InstanceError::WidgetStateTooLarge => "state_too_large",
        InstanceError::WidgetStateConflict => "state_conflict",
        InstanceError::InvalidState(_) => "invalid_state",
    };
    failed(code, error.to_string())
}

fn instance_message(error: InstanceError) -> String {
    error.to_string()
}

fn ok(result: Value, surface_id: Option<String>) -> CommandResult {
    CommandResult {
        response: Response::ok(result),
        surface_id,
        quit: false,
    }
}

fn failed(code: &str, message: String) -> CommandResult {
    CommandResult {
        response: Response::failed(code, message),
        surface_id: None,
        quit: false,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_sizes_preserve_manifest_aspect_ratio() {
        assert_eq!(window_dimensions(3, 3), (720.0, 720.0));
        assert_eq!(window_dimensions(3, 2), (720.0, 480.0));
        assert_eq!(window_dimensions(3, 1), (720.0, 240.0));
        assert_eq!(window_dimensions(10, 10), (960.0, 960.0));
    }
}
