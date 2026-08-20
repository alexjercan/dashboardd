//! Global runtime HTTP resources, SSE stream, and OpenAPI documentation.

use std::{collections::BTreeMap, convert::Infallible, path::PathBuf, time::Duration};

use axum::{
    Json, Router,
    extract::{FromRequest, Path as AxumPath, Request, State},
    http::{
        StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response, Sse, sse::Event, sse::KeepAlive},
    routing::{get, post, put},
};
use dashboardd_runtime::{
    CreateInstanceSpec, Instance, InstanceError, InstanceHealth, RuntimeEvent, RuntimeHandle,
    ShutdownHandle, Theme, TypedInput, WidgetDescriptor,
};
use dashboardd_widget_protocol::{InstanceId, WidgetId};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio_stream::{Stream, StreamExt, wrappers::BroadcastStream};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

const EVENT_VERSION: u16 = 3;

#[derive(Serialize)]
struct EventEnvelope<T> {
    version: u16,
    #[serde(flatten)]
    event: T,
}

fn serialize_event(event: RuntimeEvent) -> Result<String, serde_json::Error> {
    serde_json::to_string(&EventEnvelope {
        version: EVENT_VERSION,
        event,
    })
}

#[derive(Clone)]
pub struct AppState {
    runtime: RuntimeHandle,
    shutdown: ShutdownHandle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WidgetList {
    pub widgets: Vec<WidgetDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceList {
    pub instances: Vec<Instance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceHealthList {
    pub instances: Vec<InstanceHealth>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateInstance {
    pub widget_id: WidgetId,
    pub variant_id: String,
    #[serde(default)]
    pub options: BTreeMap<String, Value>,
    #[serde(default)]
    pub inputs: BTreeMap<String, InputValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct InputValue {
    #[serde(rename = "type")]
    pub input_type: String,
    pub value: Value,
}

impl From<InputValue> for TypedInput {
    fn from(input: InputValue) -> Self {
        Self {
            input_type: input.input_type,
            value: input.value,
        }
    }
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct ThemeFontsSchema {
    pub sans: String,
    pub mono: String,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct ThemeSchema {
    pub fonts: ThemeFontsSchema,
    pub canvas: String,
    pub surface: String,
    pub selection: String,
    pub text: String,
    pub text_bright: String,
    pub text_muted: String,
    pub text_dim: String,
    pub accent: String,
    pub border: String,
    pub success: String,
    pub danger: String,
    pub secondary: String,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct WidgetVariantSchema {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frontend_url: String,
    pub focus: bool,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct WidgetPortSchema {
    pub id: String,
    pub name: String,
    #[schema(rename = "type")]
    pub port_type: String,
    pub variants: Vec<String>,
    pub required: bool,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct WidgetDescriptorSchema {
    pub id: String,
    pub name: String,
    pub description: String,
    pub variants: Vec<WidgetVariantSchema>,
    pub options: Vec<Value>,
    pub inputs: Vec<WidgetPortSchema>,
    pub outputs: Vec<WidgetPortSchema>,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct WidgetListSchema {
    pub widgets: Vec<WidgetDescriptorSchema>,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct InstanceSchema {
    pub id: String,
    pub widget_id: String,
    pub variant_id: String,
    pub options: BTreeMap<String, Value>,
    pub inputs: BTreeMap<String, InputValue>,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct InstanceListSchema {
    pub instances: Vec<InstanceSchema>,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct HealthErrorSchema {
    pub code: String,
    pub message: String,
    pub at: String,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct InstanceHealthSchema {
    pub instance_id: String,
    pub status: String,
    pub started_at: String,
    pub last_update_at: Option<String>,
    pub last_error: Option<HealthErrorSchema>,
    pub restart_count: u64,
}

#[allow(dead_code)]
#[derive(ToSchema)]
pub struct InstanceHealthListSchema {
    pub instances: Vec<InstanceHealthSchema>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SetInstanceInputs {
    pub inputs: BTreeMap<String, InputValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ErrorResponse {
    pub error: ErrorData,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ErrorData {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct WidgetStateResource {
    pub widget_id: WidgetId,
    pub revision: u64,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SetWidgetState {
    pub revision: u64,
    pub value: Value,
}

#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        get_theme,
        list_widgets,
        get_widget,
        list_instances,
        list_instance_health,
        get_instance_health,
        restart_instance,
        get_instance,
        create_instance,
        delete_instance,
        set_instance_inputs,
        send_widget_message,
        get_widget_state,
        set_widget_state,
        runtime_events,
    ),
    components(schemas(
        CreateInstance,
        InputValue,
        ErrorResponse,
        ErrorData,
        WidgetStateResource,
        SetWidgetState,
        SetInstanceInputs,
        ThemeFontsSchema,
        ThemeSchema,
        WidgetVariantSchema,
        WidgetPortSchema,
        WidgetDescriptorSchema,
        WidgetListSchema,
        InstanceSchema,
        InstanceListSchema,
        HealthErrorSchema,
        InstanceHealthSchema,
        InstanceHealthListSchema,
    )),
    tags(
        (name = "widgets", description = "Read-only installed widget definitions"),
        (name = "instances", description = "Global memory-only widget instance CRUD"),
        (name = "events", description = "Versioned runtime events")
    )
)]
struct ApiDoc;

pub fn build_router(runtime: RuntimeHandle, web_dir: PathBuf, shutdown: ShutdownHandle) -> Router {
    let index = web_dir.join("index.html");
    let state = AppState { runtime, shutdown };
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/theme", get(get_theme))
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
        .route(
            "/api/v1/instances/{instance_id}",
            get(get_instance).delete(delete_instance),
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
            "/api/v1/instances/{instance_id}/inputs",
            put(set_instance_inputs),
        )
        .route(
            "/api/v1/instances/{instance_id}/messages",
            post(send_widget_message),
        )
        .route("/api/v1/events", get(runtime_events))
        .route_service("/d/{dashboard_id}", ServeFile::new(index.clone()))
        .route_service("/d/{dashboard_id}/edit", ServeFile::new(index.clone()))
        .route_service(
            "/d/{dashboard_id}/focus/{instance_id}",
            ServeFile::new(index),
        )
        .route(
            "/widgets/{widget_id}/variants/{variant_id}/frontend.js",
            get(widget_frontend),
        )
        .merge(SwaggerUi::new("/docs").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .fallback_service(ServeDir::new(web_dir).append_index_html_on_directories(true))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[utoipa::path(get, path = "/health", responses((status = 200, description = "Dashboardd is running")))]
async fn health() -> StatusCode {
    StatusCode::OK
}

#[utoipa::path(get, path = "/api/v1/theme", responses((status = 200, body = ThemeSchema)))]
async fn get_theme(State(state): State<AppState>) -> Json<Theme> {
    Json(state.runtime.theme())
}

#[utoipa::path(get, path = "/api/v1/widgets", tag = "widgets", responses((status = 200, body = WidgetListSchema)))]
async fn list_widgets(State(state): State<AppState>) -> Json<WidgetList> {
    Json(WidgetList {
        widgets: state.runtime.widgets(),
    })
}

#[utoipa::path(get, path = "/api/v1/widgets/{widget_id}", tag = "widgets", responses((status = 200, body = WidgetDescriptorSchema), (status = 404, body = ErrorResponse)))]
async fn get_widget(
    AxumPath(widget_id): AxumPath<WidgetId>,
    State(state): State<AppState>,
) -> Result<Json<WidgetDescriptor>, ApiError> {
    state
        .runtime
        .widget(&widget_id)
        .map(Json)
        .ok_or_else(ApiError::unknown_widget)
}

#[utoipa::path(get, path = "/api/v1/instances", tag = "instances", responses((status = 200, body = InstanceListSchema)))]
async fn list_instances(State(state): State<AppState>) -> Json<InstanceList> {
    Json(InstanceList {
        instances: state.runtime.instances().await,
    })
}

#[utoipa::path(post, path = "/api/v1/instances", tag = "instances", request_body = CreateInstance, responses((status = 201, body = InstanceSchema), (status = 400, body = ErrorResponse), (status = 404, body = ErrorResponse), (status = 500, body = ErrorResponse)))]
async fn create_instance(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CreateInstance>,
) -> Result<Response, ApiError> {
    let instance = state
        .runtime
        .create_instance(
            &request.widget_id,
            CreateInstanceSpec {
                variant_id: request.variant_id,
                options: request.options,
                inputs: request
                    .inputs
                    .into_iter()
                    .map(|(id, input)| (id, input.into()))
                    .collect(),
            },
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

#[utoipa::path(get, path = "/api/v1/instances/{instance_id}", tag = "instances", responses((status = 200, body = InstanceSchema), (status = 404, body = ErrorResponse)))]
async fn get_instance(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
) -> Result<Json<Instance>, ApiError> {
    Ok(Json(state.runtime.instance(&instance_id).await?))
}

#[utoipa::path(delete, path = "/api/v1/instances/{instance_id}", tag = "instances", responses((status = 204), (status = 404, body = ErrorResponse)))]
async fn delete_instance(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    state.runtime.delete_instance(&instance_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/api/v1/instance-health", tag = "instances", responses((status = 200, body = InstanceHealthListSchema)))]
async fn list_instance_health(State(state): State<AppState>) -> Json<InstanceHealthList> {
    Json(InstanceHealthList {
        instances: state.runtime.instance_health().await,
    })
}

#[utoipa::path(get, path = "/api/v1/instances/{instance_id}/health", tag = "instances", responses((status = 200, body = InstanceHealthSchema), (status = 404, body = ErrorResponse)))]
async fn get_instance_health(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
) -> Result<Json<InstanceHealth>, ApiError> {
    Ok(Json(state.runtime.health(&instance_id).await?))
}

#[utoipa::path(post, path = "/api/v1/instances/{instance_id}/restart", tag = "instances", responses((status = 200, body = InstanceHealthSchema), (status = 404, body = ErrorResponse)))]
async fn restart_instance(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
) -> Result<Json<InstanceHealth>, ApiError> {
    Ok(Json(state.runtime.restart_instance(&instance_id).await?))
}

#[utoipa::path(put, path = "/api/v1/instances/{instance_id}/inputs", tag = "instances", request_body = SetInstanceInputs, responses((status = 200, body = InstanceSchema), (status = 400, body = ErrorResponse), (status = 404, body = ErrorResponse)))]
async fn set_instance_inputs(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
    ApiJson(request): ApiJson<SetInstanceInputs>,
) -> Result<Json<Instance>, ApiError> {
    Ok(Json(
        state
            .runtime
            .set_instance_inputs(
                &instance_id,
                request
                    .inputs
                    .into_iter()
                    .map(|(id, input)| (id, input.into()))
                    .collect(),
            )
            .await?,
    ))
}

#[utoipa::path(post, path = "/api/v1/instances/{instance_id}/messages", tag = "instances", request_body(content = Value), responses((status = 202), (status = 404, body = ErrorResponse), (status = 503, body = ErrorResponse)))]
async fn send_widget_message(
    AxumPath(instance_id): AxumPath<InstanceId>,
    State(state): State<AppState>,
    ApiJson(payload): ApiJson<Value>,
) -> Result<StatusCode, ApiError> {
    state.runtime.send_message(&instance_id, payload).await?;
    Ok(StatusCode::ACCEPTED)
}

#[utoipa::path(get, path = "/api/v1/widget-state/{widget_id}", tag = "widgets", responses((status = 200, body = WidgetStateResource), (status = 404, body = ErrorResponse)))]
async fn get_widget_state(
    AxumPath(widget_id): AxumPath<WidgetId>,
    State(state): State<AppState>,
) -> Result<Json<WidgetStateResource>, ApiError> {
    let (revision, value) = state.runtime.widget_state(&widget_id)?;
    Ok(Json(WidgetStateResource {
        widget_id,
        revision,
        value,
    }))
}

#[utoipa::path(put, path = "/api/v1/widget-state/{widget_id}", tag = "widgets", request_body = SetWidgetState, responses((status = 200, body = WidgetStateResource), (status = 400, body = ErrorResponse), (status = 404, body = ErrorResponse), (status = 409, body = ErrorResponse)))]
async fn set_widget_state(
    AxumPath(widget_id): AxumPath<WidgetId>,
    State(state): State<AppState>,
    ApiJson(request): ApiJson<SetWidgetState>,
) -> Result<Json<WidgetStateResource>, ApiError> {
    let (revision, value) = state
        .runtime
        .set_widget_state(&widget_id, request.revision, request.value)
        .await?;
    Ok(Json(WidgetStateResource {
        widget_id,
        revision,
        value,
    }))
}

#[utoipa::path(get, path = "/api/v1/events", tag = "events", responses((status = 200, content_type = "text/event-stream", body = String)))]
async fn runtime_events(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    tracing::info!("runtime event stream connected");
    let mut shutdown = state.shutdown.subscribe();
    let updates = BroadcastStream::new(state.runtime.subscribe()).filter_map(|result| {
        result.ok().and_then(|event| {
            serialize_event(event)
                .ok()
                .map(|data| Ok(Event::default().data(data)))
        })
    });
    let initial = tokio_stream::once(Ok::<_, Infallible>(Event::default().comment("connected")));
    let stream = initial.chain(updates);
    let stream = futures_util::StreamExt::take_until(stream, async move {
        let _ = shutdown.recv().await;
        tracing::debug!("closing runtime event stream for shutdown");
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
    let frontend = match state.runtime.widget_frontend(&widget_id, &variant_id) {
        Ok(frontend) => frontend,
        Err(InstanceError::UnknownWidget | InstanceError::UnknownVariant) => {
            return StatusCode::NOT_FOUND.into_response();
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
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
            InstanceError::UnknownWidget => (StatusCode::NOT_FOUND, "unknown_widget"),
            InstanceError::UnknownInstance => (StatusCode::NOT_FOUND, "unknown_instance"),
            InstanceError::UnknownVariant => (StatusCode::NOT_FOUND, "unknown_variant"),
            InstanceError::InvalidOptions(_) => (StatusCode::BAD_REQUEST, "invalid_options"),
            InstanceError::InvalidInputs(_) => (StatusCode::BAD_REQUEST, "invalid_inputs"),
            InstanceError::BackendNotFound => {
                (StatusCode::INTERNAL_SERVER_ERROR, "backend_not_found")
            }
            InstanceError::BackendUnavailable => {
                (StatusCode::SERVICE_UNAVAILABLE, "backend_unavailable")
            }
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
                error: ErrorData {
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
    use std::{fs, process};

    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use dashboardd_runtime::{Runtime, RuntimeConfig};
    use tower::ServiceExt;

    use super::*;

    async fn request(request: Request<Body>) -> Response {
        let root = std::env::temp_dir().join(format!(
            "dashboardd-server-api-{}-{}",
            process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.html"), "server test").unwrap();
        let runtime = Runtime::start(RuntimeConfig {
            widget_roots: Vec::new(),
            state_file: root.join("runtime.json"),
            config_file: root.join("config.toml"),
        })
        .await
        .unwrap();
        let router = build_router(runtime.handle(), root.clone(), runtime.shutdown_handle());
        let response = router.oneshot(request).await.unwrap();
        runtime.shutdown().await;
        fs::remove_dir_all(root).unwrap();
        response
    }

    #[tokio::test]
    async fn global_instance_collection_starts_empty() {
        let response = request(
            Request::get("/api/v1/instances")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), br#"{"instances":[]}"#);
    }

    #[tokio::test]
    async fn old_dashboard_and_surface_routes_are_not_resources() {
        for path in ["/api/v1/dashboards", "/surface/instance-test"] {
            let response = request(Request::get(path).body(Body::empty()).unwrap()).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn rejects_dashboard_composition_fields_on_global_creation() {
        let response = request(
            Request::post("/api/v1/instances")
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"widget_id":"cpu","variant_id":"compact","position":{"column":0,"row":0}}"#,
                ))
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let error: ErrorResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(error.error.code, "invalid_json");
    }

    #[tokio::test]
    async fn missing_instances_return_consistent_errors() {
        let response = request(
            Request::get("/api/v1/instances/missing")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            body.as_ref(),
            br#"{"error":{"code":"unknown_instance","message":"instance was not found"}}"#
        );
    }

    #[tokio::test]
    async fn openapi_exposes_global_instances_only() {
        let response = request(
            Request::get("/api-docs/openapi.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let document: Value = serde_json::from_slice(&body).unwrap();
        assert!(document["paths"]["/api/v1/instances"].is_object());
        assert!(document["paths"]["/api/v1/instances/{instance_id}/inputs"].is_object());
        assert!(document["paths"]["/api/v1/dashboards"].is_null());
        assert!(document["paths"]["/api/v1/events"].is_object());
        assert!(document["components"]["schemas"]["InstanceSchema"].is_object());
        assert!(document["components"]["schemas"]["WidgetDescriptorSchema"].is_object());
    }

    #[test]
    fn server_owns_versioned_event_serialization() {
        let encoded = serialize_event(RuntimeEvent::InstanceDestroyed {
            instance_id: "instance-1".into(),
        })
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&encoded).unwrap(),
            serde_json::json!({
                "version": 3,
                "kind": "instance_destroyed",
                "data": {"instance_id": "instance-1"}
            })
        );
    }
}
