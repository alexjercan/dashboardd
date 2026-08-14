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
    instance::{DashboardLayout, Instance, InstanceError, InstanceLayout},
    widget::{WidgetDescriptor, WidgetVariant},
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

#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        get_layout,
        get_theme,
        list_widgets,
        get_widget,
        list_instances,
        get_instance,
        create_instance,
        update_instance,
        swap_instances,
        delete_instance,
        send_widget_message,
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
        Position,
        SwapInstances,
        SwapResult,
        UpdateInstance,
        WidgetDescriptor,
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
            "/api/v1/instances",
            get(list_instances).post(create_instance),
        )
        .route(
            "/api/v1/instances/{instance_id}",
            get(get_instance)
                .patch(update_instance)
                .delete(delete_instance),
        )
        .route(
            "/api/v1/instances/{instance_id}/messages",
            post(send_widget_message),
        )
        .route("/api/v1/events", get(dashboard_events))
        .route_service("/edit", ServeFile::new(format!("{WEB_DIST}/index.html")))
        .route("/edit/", get(redirect_edit))
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
        assert!(document["paths"]["/api/v1/events"].is_object());
    }
}
