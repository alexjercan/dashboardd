//! Codex subscription usage widget backend.

use std::{error::Error, process::Stdio, time::SystemTime};

use dashboard_protocol::{ServerToWidget, WidgetToServer};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::{Duration, Instant, interval_at, timeout},
};

const WIDGET_ID: &str = "codex-usage";
const UPDATE_INTERVAL: Duration = Duration::from_secs(300);

#[derive(Clone, Serialize)]
struct UsageSnapshot {
    status: &'static str,
    subscription_type: Option<String>,
    updated_at: u64,
    stale: bool,
    important: LimitSnapshot,
}

#[derive(Clone, Serialize)]
struct LimitSnapshot {
    label: &'static str,
    remaining_percent: u8,
    resets_at: Option<u64>,
}

#[derive(Serialize)]
struct UnavailableSnapshot {
    status: &'static str,
    reason: &'static str,
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum UsageCommand {
    Refresh { force: bool },
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
                                    refresh = Some(tokio::spawn(fetch_usage()));
                                }
                            }
                            Err(error) => write_error(&mut stdout, instance_id.clone(), "invalid_command", &error.to_string()).await?,
                        }
                    }
                    Ok(ServerToWidget::Shutdown {}) => break,
                    Ok(_) => {}
                    Err(error) => write_error(&mut stdout, instance_id.clone(), "invalid_message", &error.to_string()).await?,
                },
                None => break,
            },
            _ = updates.tick(), if instance_id.is_some() && refresh.is_none() => {
                refresh = Some(tokio::spawn(fetch_usage()));
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
                        eprintln!("codex usage refresh failed: {}", error.category());
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
    Process,
    Protocol,
    Unavailable,
}
impl FetchError {
    fn category(&self) -> &'static str {
        match self {
            Self::SignedOut => "signed_out",
            Self::Process => "process",
            Self::Protocol => "protocol",
            Self::Unavailable => "unavailable",
        }
    }
}

async fn fetch_usage() -> Result<UsageSnapshot, FetchError> {
    let mut child = Command::new("codex")
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| FetchError::Process)?;
    let mut input = child.stdin.take().ok_or(FetchError::Process)?;
    let mut output = BufReader::new(child.stdout.take().ok_or(FetchError::Process)?).lines();
    send(&mut input, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"scufris","version":"0.1"},"capabilities":{}}})).await?;
    response(&mut output, 1).await?;
    send(
        &mut input,
        json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
    )
    .await?;
    send(
        &mut input,
        json!({"jsonrpc":"2.0","id":2,"method":"account/read","params":{"refreshToken":true}}),
    )
    .await?;
    let account = response(&mut output, 2).await?;
    if account.pointer("/result/account").is_none() {
        return Err(FetchError::SignedOut);
    }
    send(
        &mut input,
        json!({"jsonrpc":"2.0","id":3,"method":"account/rateLimits/read","params":{}}),
    )
    .await?;
    let rates = response(&mut output, 3).await?;
    let _ = child.start_kill();
    normalize_usage(&account, &rates).ok_or(FetchError::Unavailable)
}

async fn send(input: &mut tokio::process::ChildStdin, value: Value) -> Result<(), FetchError> {
    input
        .write_all(value.to_string().as_bytes())
        .await
        .map_err(|_| FetchError::Process)?;
    input
        .write_all(b"\n")
        .await
        .map_err(|_| FetchError::Process)?;
    input.flush().await.map_err(|_| FetchError::Process)
}

async fn response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
) -> Result<Value, FetchError> {
    timeout(Duration::from_secs(20), async {
        while let Some(line) = lines.next_line().await.map_err(|_| FetchError::Protocol)? {
            let value: Value = serde_json::from_str(&line).map_err(|_| FetchError::Protocol)?;
            if value["id"] == id {
                return if value.get("result").is_some() {
                    Ok(value)
                } else {
                    Err(FetchError::Protocol)
                };
            }
        }
        Err(FetchError::Protocol)
    })
    .await
    .map_err(|_| FetchError::Protocol)?
}

fn normalize_usage(account: &Value, rates: &Value) -> Option<UsageSnapshot> {
    let snapshot = rates.pointer("/result/rateLimits")?;
    let window = [snapshot.get("primary"), snapshot.get("secondary")]
        .into_iter()
        .flatten()
        .filter(|value| {
            value
                .get("windowDurationMins")
                .and_then(Value::as_u64)
                .is_some()
        })
        .max_by_key(|value| value["windowDurationMins"].as_u64().unwrap_or_default())?;
    let used = window["usedPercent"].as_u64()?.min(100);
    Some(UsageSnapshot {
        status: "ok",
        subscription_type: account
            .pointer("/result/account/planType")
            .and_then(Value::as_str)
            .or_else(|| snapshot["planType"].as_str())
            .map(str::to_owned),
        updated_at: now_seconds(),
        stale: false,
        important: LimitSnapshot {
            label: "Weekly",
            remaining_percent: (100 - used) as u8,
            resets_at: window["resetsAt"].as_u64(),
        },
    })
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
            serde_json::from_value(json!({"command":"refresh","force":true})).unwrap();
        assert!(matches!(command, UsageCommand::Refresh { force: true }));
    }

    #[test]
    fn longest_window_is_normalized_to_remaining() {
        let account = json!({"result":{"account":{"planType":"plus"}}});
        let rates = json!({"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":1},"secondary":{"usedPercent":22,"windowDurationMins":10080,"resetsAt":2},"planType":"prolite"}}});
        let result = normalize_usage(&account, &rates).unwrap();
        assert_eq!(result.important.remaining_percent, 78);
        assert_eq!(result.important.resets_at, Some(2));
        assert_eq!(result.subscription_type.as_deref(), Some("plus"));
    }
}
