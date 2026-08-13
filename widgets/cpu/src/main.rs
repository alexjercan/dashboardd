//! CPU usage widget backend.
//!
//! The backend reports total CPU usage to dashboardd over JSON-lines.

use std::error::Error;

use dashboard_protocol::{ServerToWidget, WidgetToServer};
use serde_json::json;
use sysinfo::System;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{Duration, interval};

const WIDGET_ID: &str = "cpu";

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut system = System::new();
    let mut updates = interval(Duration::from_secs(1));
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
                Some(line) => match dashboard_protocol::parse::<ServerToWidget>(&line) {
                    Ok(ServerToWidget::Initialize { instance_id: id, widget_id }) if widget_id == WIDGET_ID => {
                        instance_id = Some(id);
                    }
                    Ok(ServerToWidget::Shutdown {}) => break,
                    Ok(_) => {}
                    Err(error) => write_message(
                        &mut stdout,
                        WidgetToServer::Error {
                            instance_id: instance_id.clone(),
                            error: dashboard_protocol::ErrorData {
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
                        payload: cpu_payload(&mut system),
                    },
                ).await?;
            }
        }
    }

    Ok(())
}

fn cpu_payload(system: &mut System) -> serde_json::Value {
    system.refresh_cpu_usage();
    json!({ "usage_percent": system.global_cpu_usage() })
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
    fn cpu_payload_contains_a_percentage() {
        let payload = cpu_payload(&mut System::new());

        assert!(payload["usage_percent"].is_number());
    }
}
