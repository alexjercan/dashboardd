//! Dashboard HTTP resources, SSE stream, and OpenAPI documentation.

use std::{collections::BTreeMap, convert::Infallible, time::Duration};

use axum::{
    Json, Router,
    extract::{FromRequest, Path as AxumPath, Request, State},
    http::{
        StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Redirect, Response, Sse, sse::Event, sse::KeepAlive},
    routing::{get, post},
};
use dashboard_protocol::{InstanceId, WidgetId};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio_stream::{Stream, StreamExt, wrappers::BroadcastStream};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

use crate::{
    AppState,
    configuration::Theme,
    event::{self, DashboardError, DashboardEvent},
    health::InstanceHealth,
    instance::{DashboardLayout, Instance, InstanceError, InstanceLayout, NewInstanceLink},
    state::DashboardLink,
    widget::{WidgetDescriptor, WidgetLinkPort, WidgetVariant},
};

const WEB_DIST: &str = "web/dist";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetList {
    pub widgets: Vec<WidgetDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InstanceList {
    pub instances: Vec<Instance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InstanceHealthList {
    pub instances: Vec<InstanceHealth>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct Position {
    pub column: u32,
    pub row: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CreateInstance {
    pub widget_id: WidgetId,
    pub variant_id: String,
    pub position: Position,
    #[serde(default)]
    pub options: BTreeMap<String, Value>,
    #[serde(default)]
    pub links: Vec<NewInstanceLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct LinkList {
    pub links: Vec<DashboardLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SetLink {
    pub source_instance_id: InstanceId,
    pub source_port: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct UpdateInstance {
    pub position: Position,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SwapInstances {
    pub source_instance_id: InstanceId,
    pub target_instance_id: InstanceId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SwapResult {
    pub instances: Vec<Instance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ErrorResponse {
    pub error: DashboardError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetStateResource {
    pub widget_id: WidgetId,
    pub revision: u64,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct SetWidgetState {
    pub revision: u64,
    pub value: Value,
}

#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        get_layout,
        get_theme,
        list_widgets,
        get_widget,
        list_instances,
        list_instance_health,
        get_instance_health,
        restart_instance,
        list_links,
        set_link,
        delete_link,
        get_instance,
        create_instance,
        update_instance,
        swap_instances,
        delete_instance,
        send_widget_message,
        get_widget_state,
        set_widget_state,
        dashboard_events,
    ),
    components(schemas(
        CreateInstance,
        DashboardError,
        DashboardEvent,
        DashboardLayout,
        ErrorResponse,
        Theme,
        Instance,
        InstanceLayout,
        InstanceList,
        InstanceHealth,
        InstanceHealthList,
        LinkList,
        NewInstanceLink,
        DashboardLink,
        SetLink,
        Position,
        SwapInstances,
        SwapResult,
        UpdateInstance,
        WidgetDescriptor,
        WidgetLinkPort,
        WidgetStateResource,
        SetWidgetState,
        WidgetList,
        WidgetVariant,
    )),
    tags(
        (name = "widgets", description = "Read-only installed widget definitions"),
        (name = "instances", description = "Dashboardd-owned widget instance CRUD"),
        (name = "events", description = "Server-sent dashboard events")
    )
)]
struct ApiDoc;

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/layout", get(get_layout))
        .route("/api/v1/theme", get(get_theme))
        .route("/api/v1/layout/swap", post(swap_instances))
        .route("/api/v1/widgets", get(list_widgets))
        .route("/api/v1/widgets/{widget_id}", get(get_widget))
        .route(
            "/api/v1/widget-state/{widget_id}",
            get(get_widget_state).put(set_widget_state),
        )
        .route(
            "/api/v1/instances",
            get(list_instances).post(create_instance),
        )
        .route("/api/v1/instance-health", get(list_instance_health))
        .route("/api/v1/links", get(list_links))
        .route(
            "/api/v1/links/{target_instance_id}/{target_port}",
            axum::routing::put(set_link).delete(delete_link),
        )
        .route(
            "/api/v1/instances/{instance_id}",
            get(get_instance)
                .patch(update_instance)
                .delete(delete_instance),
        )
        .route(
            "/api/v1/instances/{instance_id}/health",
            get(get_instance_health),
        )
        .route(
            "/api/v1/instances/{instance_id}/restart",
            post(restart_instance),
        )
        .route(
            "/api/v1/instances/{instance_id}/messages",
            post(send_widget_message),
        )
        .route("/api/v1/events", get(dashboard_events))
        .route_service("/edit", ServeFile::new(format!("{WEB_DIST}/index.html")))
        .route("/edit/", get(redirect_edit))
        .route_service(
            "/focus/{instance_id}",
            ServeFile::new(format!("{WEB_DIST}/index.html")),
        )
        .route(
            "/widgets/{widget_id}/variants/{variant_id}/frontend.js",
            get(widget_frontend),
        )
        .merge(SwaggerUi::new("/docs").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .fallback_service(ServeDir::new(WEB_DIST).append_index_html_on_directories(true))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[utoipa::path(
    get,
    path = "/health",
    responses((status = 200, description = "Dashboardd is running"))
)]
async fn health() -> StatusCode {
    StatusCode::OK
}

async fn redirect_edit() -> Redirect {
    Redirect::permanent("/edit")
}

#[utoipa::path(
    get,
    path = "/api/v1/layout",
    responses((status = 200, description = "Canonical dashboard layout constraints", body = DashboardLayout))
)]
async fn get_layout(State(state): State<AppState>) -> Json<DashboardLayout> {
    Json(state.instances.layout())
}

#[utoipa::path(
    get,
    path = "/api/v1/theme",
    responses((status = 200, description = "Effective public dashboard theme", body = Theme))
)]
async fn get_theme(State(state): State<AppState>) -> Json<Theme> {
    Json(state.themes.current())
}

#[utoipa::path(
    get,
    path = "/api/v1/widgets",
    tag = "widgets",
    responses((status = 200, description = "Installed widgets", body = WidgetList))
)]
async fn list_widgets(State(state): State<AppState>) -> Json<WidgetList> {
    Json(WidgetList {
        widgets: state.widgets.list(),
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/widgets/{widget_id}",
    tag = "widgets",
    params(("widget_id" = String, Path, description = "Widget definition ID")),
    responses(
        (status = 200, description = "Widget definition", body = WidgetDescriptor),
        (status = 404, description = "Widget was not found", body = ErrorResponse)
    )
)]
async fn get_widget(
    AxumPath(widget_id): AxumPath<WidgetId>,
    State(state): State<AppState>,
) -> Result<Json<WidgetDescriptor>, ApiError> {
    state
        .widgets
        .get(&widget_id)
        .map(|config| Json(config.descriptor.clone()))
        .ok_or_else(ApiError::unknown_widget)
}

#[utoipa::path(
    get,
    path = "/api/v1/widget-state/{widget_id}",
    tag = "widgets",
    params(("widget_id" = String, Path, description = "Widget package ID")),
    responses(
        (status = 200, description = "Shared durable widget state", body = WidgetStateResource),
        (status = 404, description = "Widget was not found", body = ErrorResponse)
    )
)]
async fn get_widget_state(
    AxumPath(widget_id): AxumPath<WidgetId>,
    State(state): State<AppState>,
) -> Result<Json<WidgetStateResource>, ApiError> {
    if state.widgets.get(&widget_id).is_none() {
        return Err(ApiError::unknown_widget());
    }
    let (revision, value) = state.instances.get_widget_state(&widget_id);
    Ok(Json(WidgetStateResource {
        widget_id,
        revision,
        value,
    }))
}

#[utoipa::path(
    put,
    path = "/api/v1/widget-state/{widget_id}",
    tag = "widgets",
    params(("widget_id" = String, Path, description = "Widget package ID")),
    request_body = SetWidgetState,
    responses(
        (status = 200, description = "Updated shared durable widget state", body = WidgetStateResource),
        (status = 400, description = "Widget state exceeds its bound", body = ErrorResponse),
        (status = 404, description = "Widget was not found", body = ErrorResponse),
        (status = 409, description = "Widget state revision is stale", body = ErrorResponse)
    )
)]
async fn set_widget_state(
    AxumPath(widget_id): AxumPath<WidgetId>,
    State(state): State<AppState>,
    ApiJson(request): ApiJson<SetWidgetState>,
) -> Result<Json<WidgetStateResource>, ApiError> {
    if state.widgets.get(&widget_id).is_none() {
        return Err(ApiError::unknown_widget());
    }
    let (revision, value) = state
        .instances
        .set_widget_state(&widget_id, request.revision, request.value)
        .await?;
    Ok(Json(WidgetStateResource {
        widget_id,
        revision,
        value,
    }))
}

#[utoipa::path(
    get,
    path = "/api/v1/instances",
    tag = "instances",
    responses((status = 200, description = "Running instances", body = InstanceList))
)]
async fn list_instances(State(state): State<AppState>) -> Json<InstanceList> {
    Json(InstanceList {
        instances: state.instances.list().await,
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/instance-health",
    tag = "instances",
    responses((status = 200, description = "Runtime health for all widget instances", body = InstanceHealthList))
)]
async fn list_instance_health(State(state): State<AppState>) -> Json<InstanceHealthList> {
    Json(InstanceHealthList {
        instances: state.instances.list_health().await,
    })
}

#[utoipa::path(
    get,
    path = "/api/v1/instances/{instance_id}/health",
    tag = "instances",
    params(("instance_id" = String, Path, description = "Running instance ID")),
    responses(
        (status = 200, description = "Runtime health for one widget instance", body = InstanceHealth),
        (status = 404, description = "Instance was not found", body = ErrorResponse)
    )
)]
async fn get_instance_health(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
) -> Result<Json<InstanceHealth>, ApiError> {
    Ok(Json(state.instances.health(&instance_id).await?))
}

#[utoipa::path(
    post,
    path = "/api/v1/instances/{instance_id}/restart",
    tag = "instances",
    params(("instance_id" = String, Path, description = "Running instance ID")),
    responses(
        (status = 200, description = "Backend restarted", body = InstanceHealth),
        (status = 404, description = "Instance was not found", body = ErrorResponse)
    )
)]
async fn restart_instance(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
) -> Result<Json<InstanceHealth>, ApiError> {
    Ok(Json(state.instances.restart(&instance_id).await?))
}

#[utoipa::path(
    get,
    path = "/api/v1/links",
    tag = "instances",
    responses((status = 200, description = "Dashboard widget links", body = LinkList))
)]
async fn list_links(State(state): State<AppState>) -> Json<LinkList> {
    Json(LinkList {
        links: state.instances.list_links(),
    })
}

#[utoipa::path(
    put,
    path = "/api/v1/links/{target_instance_id}/{target_port}",
    tag = "instances",
    params(
        ("target_instance_id" = String, Path, description = "Target instance ID"),
        ("target_port" = String, Path, description = "Target input port")
    ),
    request_body = SetLink,
    responses(
        (status = 200, description = "Created or replaced link", body = DashboardLink),
        (status = 400, description = "Link is incompatible", body = ErrorResponse),
        (status = 404, description = "An instance or port was not found", body = ErrorResponse)
    )
)]
async fn set_link(
    AxumPath((target_instance_id, target_port)): AxumPath<(InstanceId, String)>,
    State(state): State<AppState>,
    ApiJson(request): ApiJson<SetLink>,
) -> Result<Json<DashboardLink>, ApiError> {
    Ok(Json(
        state
            .instances
            .set_link(DashboardLink {
                source_instance_id: request.source_instance_id,
                source_port: request.source_port,
                target_instance_id,
                target_port,
            })
            .await?,
    ))
}

#[utoipa::path(
    delete,
    path = "/api/v1/links/{target_instance_id}/{target_port}",
    tag = "instances",
    params(
        ("target_instance_id" = String, Path, description = "Target instance ID"),
        ("target_port" = String, Path, description = "Target input port")
    ),
    responses(
        (status = 204, description = "Link deleted"),
        (status = 404, description = "Link was not found", body = ErrorResponse)
    )
)]
async fn delete_link(
    AxumPath((target_instance_id, target_port)): AxumPath<(InstanceId, String)>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    state
        .instances
        .delete_link(&target_instance_id, &target_port)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/v1/instances/{instance_id}",
    tag = "instances",
    params(("instance_id" = String, Path, description = "Running instance ID")),
    responses(
        (status = 200, description = "Running instance", body = Instance),
        (status = 404, description = "Instance was not found", body = ErrorResponse)
    )
)]
async fn get_instance(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
) -> Result<Json<Instance>, ApiError> {
    Ok(Json(state.instances.get(&instance_id).await?))
}

#[utoipa::path(
    post,
    path = "/api/v1/instances",
    tag = "instances",
    request_body = CreateInstance,
    responses(
        (status = 201, description = "Instance created", body = Instance),
        (status = 400, description = "Request JSON is invalid", body = ErrorResponse),
        (status = 404, description = "Widget was not found", body = ErrorResponse),
        (status = 409, description = "Layout overlaps another instance", body = ErrorResponse),
        (status = 500, description = "Backend executable was not found", body = ErrorResponse)
    )
)]
async fn create_instance(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CreateInstance>,
) -> Result<Response, ApiError> {
    let config = state
        .widgets
        .get(&request.widget_id)
        .ok_or_else(ApiError::unknown_widget)?;
    let instance = state
        .instances
        .create(
            config,
            request.variant_id,
            request.position.column,
            request.position.row,
            request.options,
            request.links,
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        [(
            axum::http::header::LOCATION,
            format!("/api/v1/instances/{}", instance.id),
        )],
        Json(instance),
    )
        .into_response())
}

#[utoipa::path(
    patch,
    path = "/api/v1/instances/{instance_id}",
    tag = "instances",
    params(("instance_id" = String, Path, description = "Running instance ID")),
    request_body = UpdateInstance,
    responses(
        (status = 200, description = "Updated instance", body = Instance),
        (status = 400, description = "Layout or request JSON is invalid", body = ErrorResponse),
        (status = 404, description = "Instance was not found", body = ErrorResponse)
    )
)]
async fn update_instance(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
    ApiJson(request): ApiJson<UpdateInstance>,
) -> Result<Json<Instance>, ApiError> {
    Ok(Json(
        state
            .instances
            .update(&instance_id, request.position.column, request.position.row)
            .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/v1/layout/swap",
    tag = "instances",
    request_body = SwapInstances,
    responses(
        (status = 200, description = "Instances swapped", body = SwapResult),
        (status = 400, description = "Request JSON is invalid", body = ErrorResponse),
        (status = 404, description = "An instance was not found", body = ErrorResponse),
        (status = 409, description = "Resulting layout is invalid", body = ErrorResponse)
    )
)]
async fn swap_instances(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<SwapInstances>,
) -> Result<Json<SwapResult>, ApiError> {
    Ok(Json(SwapResult {
        instances: state
            .instances
            .swap(&request.source_instance_id, &request.target_instance_id)
            .await?,
    }))
}

#[utoipa::path(
    delete,
    path = "/api/v1/instances/{instance_id}",
    tag = "instances",
    params(("instance_id" = String, Path, description = "Running instance ID")),
    responses(
        (status = 204, description = "Instance destroyed"),
        (status = 404, description = "Instance was not found", body = ErrorResponse)
    )
)]
async fn delete_instance(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    state.instances.destroy(&instance_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/v1/instances/{instance_id}/messages",
    tag = "instances",
    params(("instance_id" = String, Path, description = "Running instance ID")),
    request_body(content = Value, description = "Widget-owned command payload"),
    responses(
        (status = 202, description = "Message accepted"),
        (status = 400, description = "Request JSON is invalid", body = ErrorResponse),
        (status = 404, description = "Instance was not found", body = ErrorResponse),
        (status = 503, description = "Backend is unavailable", body = ErrorResponse)
    )
)]
async fn send_widget_message(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
    ApiJson(payload): ApiJson<Value>,
) -> Result<StatusCode, ApiError> {
    state.instances.send(&instance_id, payload).await?;
    Ok(StatusCode::ACCEPTED)
}

#[utoipa::path(
    get,
    path = "/api/v1/events",
    tag = "events",
    responses(
        (status = 200, description = "Versioned dashboard events. Use `curl -N /api/v1/events` to inspect the stream.", content_type = "text/event-stream", body = String)
    )
)]
async fn dashboard_events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    tracing::info!("dashboard event stream connected");
    let mut shutdown = state.shutdown.subscribe();
    let updates = BroadcastStream::new(state.instances.subscribe()).filter_map(|result| {
        result.ok().and_then(|event| {
            event::serialize(event)
                .ok()
                .map(|data| Ok(Event::default().data(data)))
        })
    });
    // Flush the response now. Browsers do not open EventSource until body data arrives.
    let initial = tokio_stream::once(Ok::<_, Infallible>(Event::default().comment("connected")));
    let stream = initial.chain(updates);
    let stream = futures_util::StreamExt::take_until(stream, async move {
        let _ = shutdown.recv().await;
        tracing::debug!("closing dashboard event stream for shutdown");
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

async fn widget_frontend(
    AxumPath((widget_id, variant_id)): AxumPath<(WidgetId, String)>,
    State(state): State<AppState>,
) -> Response {
    let Some(config) = state.widgets.get(&widget_id) else {
        tracing::debug!(widget_id, "widget frontend was not found");
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(frontend) = config.frontend(&variant_id) else {
        tracing::debug!(
            widget_id,
            variant_id,
            "widget variant frontend was not found"
        );
        return StatusCode::NOT_FOUND.into_response();
    };

    tracing::debug!(widget_id, variant_id, path = %frontend.display(), "serving widget frontend");
    match tokio::fs::read_to_string(frontend).await {
        Ok(source) => (
            [
                (CONTENT_TYPE, "text/javascript; charset=utf-8"),
                (CACHE_CONTROL, "no-cache"),
            ],
            source,
        )
            .into_response(),
        Err(error) => {
            tracing::error!(%error, widget_id, "failed to read widget frontend");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

struct ApiJson<T>(T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| ApiError {
                status: StatusCode::BAD_REQUEST,
                code: "invalid_json",
                message: error.body_text(),
            })
    }
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn unknown_widget() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "unknown_widget",
            message: "widget was not found".into(),
        }
    }
}

impl From<InstanceError> for ApiError {
    fn from(error: InstanceError) -> Self {
        let (status, code) = match error {
            InstanceError::UnknownInstance => (StatusCode::NOT_FOUND, "unknown_instance"),
            InstanceError::UnknownVariant => (StatusCode::NOT_FOUND, "unknown_variant"),
            InstanceError::InvalidOptions(_) => (StatusCode::BAD_REQUEST, "invalid_options"),
            InstanceError::InvalidLink(_) => (StatusCode::BAD_REQUEST, "invalid_link"),
            InstanceError::UnknownLink => (StatusCode::NOT_FOUND, "unknown_link"),
            InstanceError::BackendNotFound => {
                (StatusCode::INTERNAL_SERVER_ERROR, "backend_not_found")
            }
            InstanceError::BackendUnavailable => {
                (StatusCode::SERVICE_UNAVAILABLE, "backend_unavailable")
            }
            InstanceError::InvalidLayout => (StatusCode::BAD_REQUEST, "invalid_layout"),
            InstanceError::LayoutOccupied => (StatusCode::CONFLICT, "layout_occupied"),
            InstanceError::PersistenceFailed => {
                (StatusCode::INTERNAL_SERVER_ERROR, "persistence_failed")
            }
            InstanceError::WidgetStateTooLarge => {
                (StatusCode::BAD_REQUEST, "widget_state_too_large")
            }
            InstanceError::WidgetStateConflict => (StatusCode::CONFLICT, "widget_state_conflict"),
            InstanceError::InvalidState(_) => (StatusCode::INTERNAL_SERVER_ERROR, "invalid_state"),
        };

        Self {
            status,
            code,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: DashboardError {
                    code: self.code.into(),
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use super::*;
    use crate::{
        configuration::{Theme, ThemeManager},
        instance::InstanceManager,
        widget::WidgetsManager,
    };

    fn test_app() -> Router {
        build_router(AppState {
            widgets: WidgetsManager::default(),
            instances: InstanceManager::default(),
            themes: ThemeManager::new(Theme::default()),
            shutdown: broadcast::channel(1).0,
        })
    }

    fn test_app_with_projects() -> (Router, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "scufris-api-widget-state-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let widget = root.join("projects");
        std::fs::create_dir_all(&widget).unwrap();
        std::fs::write(
            widget.join("widget.json"),
            r#"{"schema_version":2,"id":"projects","name":"Projects","description":"Projects","backend":"backend","variants":[{"id":"pinned","name":"Pinned","width":3,"height":1,"frontend":"pinned.js"}],"options":[]}"#,
        )
        .unwrap();
        std::fs::write(widget.join("backend"), "backend").unwrap();
        std::fs::write(widget.join("pinned.js"), "frontend").unwrap();
        let widgets = WidgetsManager::discover(&root).unwrap();
        (
            build_router(AppState {
                widgets,
                instances: InstanceManager::default(),
                themes: ThemeManager::new(Theme::default()),
                shutdown: broadcast::channel(1).0,
            }),
            root,
        )
    }

    #[tokio::test]
    async fn reads_updates_and_conflict_checks_widget_state() {
        let (app, root) = test_app_with_projects();
        let response = app
            .clone()
            .oneshot(
                Request::get("/api/v1/widget-state/projects")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            serde_json::json!({"widget_id": "projects", "revision": 0, "value": {}})
        );

        let update = |revision, value: Value| {
            Request::put("/api/v1/widget-state/projects")
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "revision": revision,
                        "value": value
                    }))
                    .unwrap(),
                ))
                .unwrap()
        };
        let response = app
            .clone()
            .oneshot(update(0, serde_json::json!({"pins": []})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = app
            .clone()
            .oneshot(update(0, serde_json::json!({})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let response = app
            .clone()
            .oneshot(update(1, Value::String("x".repeat(64 * 1024 + 1))))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = app
            .oneshot(
                Request::get("/api/v1/widget-state/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn returns_canonical_layout_constraints() {
        let response = test_app()
            .oneshot(Request::get("/api/v1/layout").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), br#"{"columns":9}"#);
    }

    #[tokio::test]
    async fn redirects_the_trailing_edit_route() {
        let response = test_app()
            .oneshot(Request::get("/edit/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(response.headers()[axum::http::header::LOCATION], "/edit");
    }

    #[tokio::test]
    async fn lists_widgets_as_an_http_resource() {
        let response = test_app()
            .oneshot(Request::get("/api/v1/widgets").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), br#"{"widgets":[]}"#);
    }

    #[tokio::test]
    async fn exposes_runtime_instance_health_resources() {
        let response = test_app()
            .oneshot(
                Request::get("/api/v1/instance-health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), br#"{"instances":[]}"#);

        for request in [
            Request::get("/api/v1/instances/missing/health")
                .body(Body::empty())
                .unwrap(),
            Request::post("/api/v1/instances/missing/restart")
                .body(Body::empty())
                .unwrap(),
        ] {
            let response = test_app().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
    }

    #[tokio::test]
    async fn returns_consistent_not_found_errors() {
        let response = test_app()
            .oneshot(
                Request::get("/api/v1/instances/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            body.as_ref(),
            br#"{"error":{"code":"unknown_instance","message":"instance was not found"}}"#
        );
    }

    #[tokio::test]
    async fn returns_json_for_invalid_request_bodies() {
        let response = test_app()
            .oneshot(
                Request::post("/api/v1/instances")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let error: ErrorResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(error.error.code, "invalid_json");
    }

    #[tokio::test]
    async fn serves_the_openapi_document() {
        let response = test_app()
            .oneshot(
                Request::get("/api-docs/openapi.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let document: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            document["components"]["schemas"]["DashboardLayout"]["type"],
            "object"
        );
        assert!(document["paths"]["/api/v1/layout"].is_object());
        assert!(document["paths"]["/api/v1/instances"].is_object());
        assert!(document["paths"]["/api/v1/widget-state/{widget_id}"].is_object());
        assert!(document["paths"]["/api/v1/events"].is_object());
    }
}
