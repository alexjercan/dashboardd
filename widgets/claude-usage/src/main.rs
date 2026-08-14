//! Claude subscription usage widget backend.

use std::{
    env,
    error::Error,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    time::SystemTime,
};

use dashboard_protocol::{ServerToWidget, WidgetToServer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    time::{Duration, Instant, interval_at},
};

const WIDGET_ID: &str = "claude-usage";
const UPDATE_INTERVAL: Duration = Duration::from_secs(300);
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

#[derive(Deserialize)]
struct CredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    oauth: OAuthCredentials,
}

#[derive(Deserialize)]
struct OAuthCredentials {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "subscriptionType")]
    subscription_type: Option<String>,
}

#[derive(Deserialize)]
struct UsageResponse {
    limits: Vec<UsageLimit>,
}

#[derive(Deserialize)]
struct UsageLimit {
    group: String,
    kind: String,
    percent: f64,
    resets_at: Option<String>,
    is_active: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct LimitSnapshot {
    label: String,
    remaining_percent: u8,
    resets_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct UsageSnapshot {
    status: String,
    subscription_type: Option<String>,
    updated_at: u64,
    stale: bool,
    important: LimitSnapshot,
    all_models: Option<LimitSnapshot>,
}

#[derive(Serialize)]
struct UnavailableSnapshot {
    status: &'static str,
    reason: &'static str,
}

#[derive(Default, Serialize, Deserialize)]
struct CacheFile {
    snapshot: Option<UsageSnapshot>,
    retry_after: Option<u64>,
}

struct CacheLock(PathBuf);

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum UsageCommand {
    Refresh { force: bool },
}

impl Drop for CacheLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut updates = interval_at(Instant::now(), UPDATE_INTERVAL);
    let mut instance_id = None;
    let mut last_success: Option<UsageSnapshot> = None;
    let mut refresh: Option<tokio::task::JoinHandle<Result<UsageSnapshot, FetchError>>> = None;

    write_message(
        &mut stdout,
        WidgetToServer::Ready {
            widget_id: WIDGET_ID.into(),
        },
    )
    .await?;
    loop {
        tokio::select! {
            line = lines.next_line() => match line? {
                Some(line) => match dashboard_protocol::parse::<ServerToWidget>(&line) {
                    Ok(ServerToWidget::Initialize { instance_id: id, widget_id, variant_id: _, options: _ }) if widget_id == WIDGET_ID => instance_id = Some(id),
                    Ok(ServerToWidget::Message { instance_id: target, payload }) if instance_id.as_deref() == Some(&target) => {
                        match serde_json::from_value::<UsageCommand>(payload) {
                            Ok(UsageCommand::Refresh { force }) => {
                                if !force && let Some(snapshot) = last_success.clone() {
                                    publish(&mut stdout, &target, serde_json::to_value(snapshot)?).await?;
                                }
                                let current_is_fresh = last_success.as_ref().is_some_and(|snapshot| now_seconds().saturating_sub(snapshot.updated_at) < 300);
                                if refresh.is_none() && (force || !current_is_fresh) {
                                    refresh = Some(tokio::spawn(fetch_usage(force)));
                                }
                            }
                            Err(error) => write_error(&mut stdout, instance_id.clone(), "invalid_command", &error.to_string()).await?,
                        }
                    }
                    Ok(ServerToWidget::Ping { nonce }) => write_message(
                        &mut stdout,
                        WidgetToServer::Pong { nonce },
                    ).await?,
                    Ok(ServerToWidget::Shutdown {}) => break,
                    Ok(_) => {}
                    Err(error) => write_error(&mut stdout, instance_id.clone(), "invalid_message", &error.to_string()).await?,
                },
                None => break,
            },
            _ = updates.tick(), if instance_id.is_some() && refresh.is_none() => {
                refresh = Some(tokio::spawn(fetch_usage(false)));
            }
            result = async { refresh.as_mut().expect("refresh task is checked").await }, if refresh.is_some() => {
                refresh = None;
                let payload = match result {
                    Ok(Ok(snapshot)) => {
                        last_success = Some(snapshot.clone());
                        serde_json::to_value(snapshot)?
                    }
                    Ok(Err(FetchError::SignedOut)) => serde_json::to_value(UnavailableSnapshot { status: "unavailable", reason: "sign_in" })?,
                    Ok(Err(error)) => {
                        eprintln!("claude usage refresh failed: {}", error.category());
                        stale_or_unavailable(last_success.clone())?
                    }
                    Err(_) => stale_or_unavailable(last_success.clone())?,
                };
                publish(&mut stdout, instance_id.as_deref().expect("instance id is checked"), payload).await?;
            }
        }
    }
    Ok(())
}

#[derive(Debug)]
enum FetchError {
    SignedOut,
    Credentials,
    Request,
    Response,
    RateLimited(u64),
}
impl FetchError {
    fn category(&self) -> &'static str {
        match self {
            Self::SignedOut => "signed_out",
            Self::Credentials => "credentials",
            Self::Request => "request",
            Self::Response => "response",
            Self::RateLimited(_) => "rate_limited",
        }
    }
}

async fn fetch_usage(force: bool) -> Result<UsageSnapshot, FetchError> {
    let cache_path = cache_path().ok_or(FetchError::Credentials)?;
    if !force && let Some(snapshot) = fresh_snapshot(&read_cache(&cache_path), now_seconds()) {
        return Ok(snapshot);
    }
    let lock_path = cache_path.with_extension("lock");
    let mut waited = false;
    for _ in 0..100 {
        match acquire_lock(&lock_path) {
            Ok(_lock) => {
                let mut cache = read_cache(&cache_path);
                let now = now_seconds();
                if (!force || waited)
                    && let Some(snapshot) = fresh_snapshot(&cache, now)
                {
                    return Ok(snapshot);
                }
                if cache
                    .retry_after
                    .is_some_and(|retry_after| retry_after > now)
                {
                    return cached_or_error(
                        cache.snapshot,
                        FetchError::RateLimited(cache.retry_after.unwrap()),
                    );
                }
                match fetch_remote().await {
                    Ok(snapshot) => {
                        cache = CacheFile {
                            snapshot: Some(snapshot.clone()),
                            retry_after: None,
                        };
                        write_cache(&cache_path, &cache)?;
                        return Ok(snapshot);
                    }
                    Err(FetchError::RateLimited(retry_after)) => {
                        cache.retry_after = Some(retry_after);
                        write_cache(&cache_path, &cache)?;
                        return cached_or_error(
                            cache.snapshot,
                            FetchError::RateLimited(retry_after),
                        );
                    }
                    Err(error) => return cached_or_error(cache.snapshot, error),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                waited = true;
                tokio::time::sleep(Duration::from_millis(100)).await;
                if let Some(snapshot) = fresh_snapshot(&read_cache(&cache_path), now_seconds()) {
                    return Ok(snapshot);
                }
            }
            Err(_) => return Err(FetchError::Credentials),
        }
    }
    cached_or_error(read_cache(&cache_path).snapshot, FetchError::Request)
}

async fn fetch_remote() -> Result<UsageSnapshot, FetchError> {
    let source = tokio::fs::read_to_string(credentials_path().ok_or(FetchError::SignedOut)?)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                FetchError::SignedOut
            } else {
                FetchError::Credentials
            }
        })?;
    let credentials: CredentialsFile =
        serde_json::from_str(&source).map_err(|_| FetchError::Credentials)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| FetchError::Request)?
        .get(USAGE_URL)
        .bearer_auth(&credentials.oauth.access_token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|_| FetchError::Request)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(FetchError::SignedOut);
    }
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let delay = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(300);
        return Err(FetchError::RateLimited(now_seconds().saturating_add(delay)));
    }
    let usage: UsageResponse = response
        .error_for_status()
        .map_err(|_| FetchError::Response)?
        .json()
        .await
        .map_err(|_| FetchError::Response)?;
    normalize_usage(usage, credentials.oauth.subscription_type).ok_or(FetchError::Response)
}

fn normalize_usage(
    usage: UsageResponse,
    subscription_type: Option<String>,
) -> Option<UsageSnapshot> {
    let weekly = usage
        .limits
        .iter()
        .find(|limit| limit.kind == "weekly_all")?;
    let scoped = usage
        .limits
        .iter()
        .find(|limit| limit.kind == "weekly_scoped" && limit.is_active)
        .or_else(|| {
            usage
                .limits
                .iter()
                .find(|limit| limit.group == "weekly" && limit.kind == "weekly_scoped")
        });
    let important = scoped.unwrap_or(weekly);
    Some(UsageSnapshot {
        status: "ok".into(),
        subscription_type,
        updated_at: now_seconds(),
        stale: false,
        important: to_snapshot(
            if scoped.is_some() {
                "Fable"
            } else {
                "All models"
            },
            important,
        ),
        all_models: scoped.map(|_| to_snapshot("All models", weekly)),
    })
}

fn to_snapshot(label: &str, limit: &UsageLimit) -> LimitSnapshot {
    LimitSnapshot {
        label: label.into(),
        remaining_percent: (100.0 - limit.percent).round().clamp(0.0, 100.0) as u8,
        resets_at: limit.resets_at.clone(),
    }
}

fn stale_or_unavailable(snapshot: Option<UsageSnapshot>) -> Result<Value, serde_json::Error> {
    match snapshot {
        Some(mut snapshot) => {
            snapshot.stale = now_seconds().saturating_sub(snapshot.updated_at) >= 900;
            serde_json::to_value(snapshot)
        }
        None => serde_json::to_value(UnavailableSnapshot {
            status: "unavailable",
            reason: "service",
        }),
    }
}

async fn publish(
    stdout: &mut tokio::io::Stdout,
    instance_id: &str,
    payload: Value,
) -> Result<(), Box<dyn Error>> {
    write_message(
        stdout,
        WidgetToServer::Update {
            instance_id: instance_id.into(),
            payload,
        },
    )
    .await
}

fn cached_or_error(
    snapshot: Option<UsageSnapshot>,
    error: FetchError,
) -> Result<UsageSnapshot, FetchError> {
    snapshot
        .map(|mut snapshot| {
            snapshot.stale = now_seconds().saturating_sub(snapshot.updated_at) >= 900;
            snapshot
        })
        .ok_or(error)
}

fn fresh_snapshot(cache: &CacheFile, now: u64) -> Option<UsageSnapshot> {
    cache
        .snapshot
        .clone()
        .filter(|snapshot| now.saturating_sub(snapshot.updated_at) < 300)
}

fn read_cache(path: &Path) -> CacheFile {
    fs::read_to_string(path)
        .ok()
        .and_then(|source| serde_json::from_str(&source).ok())
        .unwrap_or_default()
}

fn write_cache(path: &Path, cache: &CacheFile) -> Result<(), FetchError> {
    let parent = path.parent().ok_or(FetchError::Credentials)?;
    fs::create_dir_all(parent).map_err(|_| FetchError::Credentials)?;
    let temporary = parent.join(format!(".claude-usage-{}.tmp", std::process::id()));
    fs::write(
        &temporary,
        serde_json::to_vec(cache).map_err(|_| FetchError::Credentials)?,
    )
    .map_err(|_| FetchError::Credentials)?;
    fs::rename(&temporary, path).map_err(|_| FetchError::Credentials)
}

fn acquire_lock(path: &Path) -> std::io::Result<CacheLock> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if lock_is_stale(path) {
        let _ = fs::remove_file(path);
    }
    OpenOptions::new().write(true).create_new(true).open(path)?;
    Ok(CacheLock(path.to_owned()))
}

fn lock_is_stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
        .is_ok_and(|age| age >= Duration::from_secs(30))
}

fn cache_path() -> Option<PathBuf> {
    env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .map(|directory| directory.join("scufris/claude-usage.json"))
}

fn credentials_path() -> Option<PathBuf> {
    env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .map(|directory| directory.join(".credentials.json"))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn write_error(
    stdout: &mut tokio::io::Stdout,
    instance_id: Option<String>,
    code: &str,
    message: &str,
) -> Result<(), Box<dyn Error>> {
    write_message(
        stdout,
        WidgetToServer::Error {
            instance_id,
            error: dashboard_protocol::ErrorData {
                code: code.into(),
                message: message.into(),
            },
        },
    )
    .await
}

async fn write_message(
    stdout: &mut tokio::io::Stdout,
    message: WidgetToServer,
) -> Result<(), Box<dyn Error>> {
    stdout
        .write_all(dashboard_protocol::serialize(message)?.as_bytes())
        .await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refresh_command_parses_force_flag() {
        let command: UsageCommand =
            serde_json::from_value(serde_json::json!({"command":"refresh","force":true})).unwrap();
        assert!(matches!(command, UsageCommand::Refresh { force: true }));
    }

    #[test]
    fn scoped_weekly_limit_is_primary_and_converted_to_remaining() {
        let result = normalize_usage(
            UsageResponse {
                limits: vec![
                    UsageLimit {
                        group: "weekly".into(),
                        kind: "weekly_all".into(),
                        percent: 48.0,
                        resets_at: Some("all".into()),
                        is_active: false,
                    },
                    UsageLimit {
                        group: "weekly".into(),
                        kind: "weekly_scoped".into(),
                        percent: 84.0,
                        resets_at: Some("fable".into()),
                        is_active: true,
                    },
                ],
            },
            Some("max".into()),
        )
        .unwrap();
        assert_eq!(result.important.label, "Fable");
        assert_eq!(result.important.remaining_percent, 16);
        assert_eq!(result.all_models.unwrap().remaining_percent, 52);
    }
}
