use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use serde::Deserialize;
use serde_json::json;

use crate::db::memory::{
    MemoryStore, SaveObservationParams, SearchOptions, UpdateObservationParams,
};

#[derive(Clone)]
pub struct MemoryApiState {
    pub memory_store: Arc<MemoryStore>,
}

#[derive(Deserialize)]
struct StartSessionRequestBody {
    id: String,
    project: String,
    directory: Option<String>,
}

#[derive(Deserialize)]
struct EndSessionRequestBody {
    summary: Option<String>,
}

#[derive(Deserialize)]
struct SaveObservationRequestBody {
    session_id: String,
    #[serde(rename = "type")]
    observation_type: String,
    title: String,
    content: String,
    project: Option<String>,
    scope: Option<String>,
    topic_key: Option<String>,
    embedding: Option<Vec<f32>>,
}

#[derive(Deserialize)]
struct UpdateObservationRequestBody {
    #[serde(rename = "type")]
    observation_type: Option<String>,
    title: Option<String>,
    content: Option<String>,
    project: Option<String>,
    scope: Option<String>,
    topic_key: Option<String>,
}

#[derive(Deserialize)]
struct SearchQueryParameters {
    #[serde(rename = "q")]
    query: Option<String>,
    #[serde(rename = "type")]
    observation_type: Option<String>,
    project: Option<String>,
    scope: Option<String>,
    limit: Option<i64>,
    embedding: Option<String>,
}

#[derive(Deserialize)]
struct ContextQueryParameters {
    project: Option<String>,
    session_limit: Option<i64>,
    observation_limit: Option<i64>,
}

#[derive(Deserialize)]
struct TimelineQueryParameters {
    observation_id: i64,
    before: Option<i64>,
    after: Option<i64>,
}

#[derive(Deserialize)]
struct DeleteQueryParameters {
    hard: Option<bool>,
}

pub fn memory_routes() -> Router<MemoryApiState> {
    Router::new()
        .route("/api/memory/sessions", post(handle_start_session))
        .route("/api/memory/sessions/{session_id}", get(handle_get_session))
        .route(
            "/api/memory/sessions/{session_id}/end",
            post(handle_end_session),
        )
        .route("/api/memory/observations", post(handle_save_observation))
        .route(
            "/api/memory/observations/{observation_id}",
            get(handle_get_observation),
        )
        .route(
            "/api/memory/observations/{observation_id}",
            patch(handle_update_observation),
        )
        .route(
            "/api/memory/observations/{observation_id}",
            delete(handle_delete_observation),
        )
        .route("/api/memory/search", get(handle_search))
        .route("/api/memory/context", get(handle_context))
        .route("/api/memory/timeline", get(handle_timeline))
        .route("/api/memory/stats", get(handle_stats))
        .route("/api/memory/prune", post(handle_prune))
}

async fn handle_start_session(
    State(state): State<MemoryApiState>,
    axum::Json(body): axum::Json<StartSessionRequestBody>,
) -> impl IntoResponse {
    let directory = body.directory.as_deref().unwrap_or("");

    match state
        .memory_store
        .start_session(&body.id, &body.project, directory)
        .await
    {
        Ok(session) => (StatusCode::CREATED, axum::Json(json!(session))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_get_session(
    State(state): State<MemoryApiState>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    match state.memory_store.get_session(&session_id).await {
        Ok(session) => (StatusCode::OK, axum::Json(json!(session))).into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": "session not found" })),
        )
            .into_response(),
    }
}

async fn handle_end_session(
    State(state): State<MemoryApiState>,
    Path(session_id): Path<String>,
    axum::Json(body): axum::Json<EndSessionRequestBody>,
) -> impl IntoResponse {
    match state
        .memory_store
        .end_session(&session_id, body.summary.as_deref())
        .await
    {
        Ok(()) => (StatusCode::OK, axum::Json(json!({ "status": "completed" }))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_save_observation(
    State(state): State<MemoryApiState>,
    axum::Json(body): axum::Json<SaveObservationRequestBody>,
) -> impl IntoResponse {
    let params = SaveObservationParams {
        session_id: body.session_id,
        observation_type: body.observation_type,
        title: body.title,
        content: body.content,
        project: body.project,
        scope: body.scope,
        topic_key: body.topic_key,
        embedding: body.embedding,
    };

    match state.memory_store.save_observation(params).await {
        Ok(observation) => (StatusCode::CREATED, axum::Json(json!(observation))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_get_observation(
    State(state): State<MemoryApiState>,
    Path(observation_id): Path<i64>,
) -> impl IntoResponse {
    match state.memory_store.get_observation(observation_id).await {
        Ok(observation) => (StatusCode::OK, axum::Json(json!(observation))).into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": "observation not found" })),
        )
            .into_response(),
    }
}

async fn handle_update_observation(
    State(state): State<MemoryApiState>,
    Path(observation_id): Path<i64>,
    axum::Json(body): axum::Json<UpdateObservationRequestBody>,
) -> impl IntoResponse {
    let params = UpdateObservationParams {
        observation_type: body.observation_type,
        title: body.title,
        content: body.content,
        project: body.project,
        scope: body.scope,
        topic_key: body.topic_key,
    };

    match state
        .memory_store
        .update_observation(observation_id, params)
        .await
    {
        Ok(observation) => (StatusCode::OK, axum::Json(json!(observation))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_delete_observation(
    State(state): State<MemoryApiState>,
    Path(observation_id): Path<i64>,
    Query(query_params): Query<DeleteQueryParameters>,
) -> impl IntoResponse {
    let hard_delete = query_params.hard.unwrap_or(false);

    match state
        .memory_store
        .delete_observation(observation_id, hard_delete)
        .await
    {
        Ok(()) => (StatusCode::OK, axum::Json(json!({ "status": "deleted" }))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_search(
    State(state): State<MemoryApiState>,
    Query(query_params): Query<SearchQueryParameters>,
) -> impl IntoResponse {
    let query_text = match query_params.query {
        Some(ref text) if !text.trim().is_empty() => text.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({ "error": "query parameter 'q' is required" })),
            )
                .into_response();
        }
    };

    let decoded_embedding = query_params.embedding.and_then(|base64_string| {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_string)
            .ok()?;
        let floats: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();
        if floats.is_empty() {
            None
        } else {
            Some(floats)
        }
    });

    let options = SearchOptions {
        query: query_text,
        observation_type: query_params.observation_type,
        project: query_params.project,
        scope: query_params.scope,
        limit: query_params.limit,
        embedding: decoded_embedding,
    };

    match state.memory_store.hybrid_search(options).await {
        Ok(results) => (StatusCode::OK, axum::Json(json!(results))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_context(
    State(state): State<MemoryApiState>,
    Query(query_params): Query<ContextQueryParameters>,
) -> impl IntoResponse {
    match state
        .memory_store
        .get_context(
            query_params.project.as_deref(),
            query_params.session_limit,
            query_params.observation_limit,
        )
        .await
    {
        Ok(context) => (StatusCode::OK, axum::Json(json!(context))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_timeline(
    State(state): State<MemoryApiState>,
    Query(query_params): Query<TimelineQueryParameters>,
) -> impl IntoResponse {
    match state
        .memory_store
        .get_timeline(
            query_params.observation_id,
            query_params.before,
            query_params.after,
        )
        .await
    {
        Ok(timeline) => (StatusCode::OK, axum::Json(json!(timeline))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_stats(State(state): State<MemoryApiState>) -> impl IntoResponse {
    match state.memory_store.get_stats().await {
        Ok(stats) => (StatusCode::OK, axum::Json(json!(stats))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

async fn handle_prune(State(state): State<MemoryApiState>) -> impl IntoResponse {
    match state.memory_store.prune().await {
        Ok(result) => (StatusCode::OK, axum::Json(json!(result))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}
