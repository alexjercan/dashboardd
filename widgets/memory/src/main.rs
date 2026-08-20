//! Memory telemetry widget backend.
//!
//! The backend reports RAM and swap usage to dashboardd over JSON-lines.

use std::error::Error;

use dashboardd_widget_protocol::{ServerToWidget, WidgetToServer};
use serde::Serialize;
use sysinfo::System;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{Duration, Instant, interval_at};

const WIDGET_ID: &str = "memory";
const UPDATE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Serialize)]
struct MemorySnapshot {
    usage_percent: f64,
    used_bytes: u64,
    total_bytes: u64,
    available_bytes: u64,
    swap: SwapSnapshot,
}

#[derive(Debug, Serialize)]
struct SwapSnapshot {
    usage_percent: f64,
    used_bytes: u64,
    total_bytes: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut system = System::new();
    system.refresh_memory();
    let mut updates = interval_at(Instant::now() + UPDATE_INTERVAL, UPDATE_INTERVAL);
    let mut instance_id = None;

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
                Some(line) => match dashboardd_widget_protocol::parse::<ServerToWidget>(&line) {
                    Ok(ServerToWidget::Initialize { instance_id: id, widget_id, variant_id: _, options: _ }) if widget_id == WIDGET_ID => {
                        instance_id = Some(id);
                    }
                    Ok(ServerToWidget::Ping { nonce }) => write_message(
                        &mut stdout,
                        WidgetToServer::Pong { nonce },
                    ).await?,
                    Ok(ServerToWidget::Shutdown {}) => break,
                    Ok(_) => {}
                    Err(error) => write_message(
                        &mut stdout,
                        WidgetToServer::Error {
                            instance_id: instance_id.clone(),
                            error: dashboardd_widget_protocol::ErrorData {
                                code: "invalid_message".into(),
                                message: error.to_string(),
                            },
                        },
                    ).await?,
                },
                None => break,
            },
            _ = updates.tick(), if instance_id.is_some() => {
                write_message(
                    &mut stdout,
                    WidgetToServer::Update {
                        instance_id: instance_id.clone().expect("instance_id is checked"),
                        payload: serde_json::to_value(memory_snapshot(&mut system))?,
                    },
                ).await?;
            }
        }
    }

    Ok(())
}

fn memory_snapshot(system: &mut System) -> MemorySnapshot {
    system.refresh_memory();
    let total_bytes = system.total_memory();
    let used_bytes = system.used_memory().min(total_bytes);
    let total_swap_bytes = system.total_swap();
    let used_swap_bytes = system.used_swap().min(total_swap_bytes);

    MemorySnapshot {
        usage_percent: percentage(used_bytes, total_bytes),
        used_bytes,
        total_bytes,
        available_bytes: system.available_memory().min(total_bytes),
        swap: SwapSnapshot {
            usage_percent: percentage(used_swap_bytes, total_swap_bytes),
            used_bytes: used_swap_bytes,
            total_bytes: total_swap_bytes,
        },
    }
}

fn percentage(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (used as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
    }
}

async fn write_message(
    stdout: &mut tokio::io::Stdout,
    message: WidgetToServer,
) -> Result<(), Box<dyn Error>> {
    stdout
        .write_all(dashboardd_widget_protocol::serialize(message)?.as_bytes())
        .await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_ram_and_swap_values() {
        let payload = serde_json::to_value(memory_snapshot(&mut System::new())).unwrap();

        assert!(payload["usage_percent"].is_number());
        assert!(payload["used_bytes"].is_number());
        assert!(payload["total_bytes"].is_number());
        assert!(payload["available_bytes"].is_number());
        assert!(payload["swap"]["usage_percent"].is_number());
        assert!(payload["swap"]["used_bytes"].is_number());
        assert!(payload["swap"]["total_bytes"].is_number());
    }

    #[test]
    fn percentage_handles_empty_and_overcommitted_values() {
        assert_eq!(percentage(1, 0), 0.0);
        assert_eq!(percentage(1, 4), 25.0);
        assert_eq!(percentage(5, 4), 100.0);
    }
}
