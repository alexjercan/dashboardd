//! Aggregate non-loopback network throughput telemetry.

use std::{error::Error, net::IpAddr, time::Duration as StdDuration};

use dashboardd_widget_protocol::{ServerToWidget, WidgetToServer};
use serde::Serialize;
use sysinfo::{InterfaceOperationalState, NetworkData, Networks};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{Duration, Instant, interval_at};

const WIDGET_ID: &str = "network";
const UPDATE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Serialize)]
struct NetworkSnapshot {
    received_bytes_per_second: u64,
    transmitted_bytes_per_second: u64,
    total_received_bytes: u64,
    total_transmitted_bytes: u64,
    receive_errors: u64,
    transmit_errors: u64,
    active_interfaces: u64,
}

#[derive(Clone, Copy)]
struct InterfaceCounters {
    received: u64,
    transmitted: u64,
    total_received: u64,
    total_transmitted: u64,
    receive_errors: u64,
    transmit_errors: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut networks = Networks::new_with_refreshed_list();
    let mut updates = interval_at(Instant::now() + UPDATE_INTERVAL, UPDATE_INTERVAL);
    let mut last_refresh = Instant::now();
    let mut instance_id = None;
    let mut unavailable = false;

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
                    Ok(ServerToWidget::Initialize { instance_id: id, widget_id, variant_id: _, options: _ }) if widget_id == WIDGET_ID => instance_id = Some(id),
                    Ok(ServerToWidget::Ping { nonce }) => write_message(&mut stdout, WidgetToServer::Pong { nonce }).await?,
                    Ok(ServerToWidget::Shutdown {}) => break,
                    Ok(_) => {}
                    Err(error) => write_error(&mut stdout, instance_id.clone(), "invalid_message", &error.to_string()).await?,
                },
                None => break,
            },
            _ = updates.tick(), if instance_id.is_some() => {
                let now = Instant::now();
                let elapsed = now.duration_since(last_refresh);
                last_refresh = now;
                networks.refresh(true);
                match network_snapshot(&networks, elapsed) {
                    Some(snapshot) => {
                        unavailable = false;
                        write_message(
                            &mut stdout,
                            WidgetToServer::Update {
                                instance_id: instance_id.clone().expect("instance id is checked"),
                                payload: serde_json::to_value(snapshot)?,
                            },
                        ).await?;
                    }
                    None if !unavailable => {
                        unavailable = true;
                        write_error(
                            &mut stdout,
                            instance_id.clone(),
                            "network_unavailable",
                            "Network telemetry is unavailable",
                        ).await?;
                    }
                    None => {}
                }
            }
        }
    }
    Ok(())
}

fn network_snapshot(networks: &Networks, elapsed: StdDuration) -> Option<NetworkSnapshot> {
    let counters = networks
        .iter()
        .filter(|(name, data)| interface_eligible(name, data))
        .map(|(_, data)| InterfaceCounters {
            received: data.received(),
            transmitted: data.transmitted(),
            total_received: data.total_received(),
            total_transmitted: data.total_transmitted(),
            receive_errors: data.errors_on_received(),
            transmit_errors: data.errors_on_transmitted(),
        });
    aggregate(counters, elapsed)
}

fn interface_eligible(name: &str, data: &NetworkData) -> bool {
    interface_identity_eligible(
        name,
        data.ip_networks().iter().map(|network| network.addr),
        data.operational_state(),
    )
}

fn interface_identity_eligible(
    name: &str,
    addresses: impl Iterator<Item = IpAddr>,
    state: InterfaceOperationalState,
) -> bool {
    if matches!(
        state,
        InterfaceOperationalState::Down
            | InterfaceOperationalState::NotPresent
            | InterfaceOperationalState::LowerLayerDown
    ) {
        return false;
    }
    let addresses = addresses.collect::<Vec<_>>();
    if !addresses.is_empty() {
        return addresses.iter().any(|address| !address.is_loopback());
    }
    let normalized = name.to_ascii_lowercase();
    !matches!(normalized.as_str(), "lo" | "lo0" | "loopback")
        && !normalized.starts_with("loopback ")
        && state == InterfaceOperationalState::Up
}

fn aggregate(
    counters: impl Iterator<Item = InterfaceCounters>,
    elapsed: StdDuration,
) -> Option<NetworkSnapshot> {
    let counters = counters.collect::<Vec<_>>();
    if counters.is_empty() {
        return None;
    }
    let sum = |field: fn(&InterfaceCounters) -> u64| {
        counters
            .iter()
            .fold(0_u64, |total, item| total.saturating_add(field(item)))
    };
    Some(NetworkSnapshot {
        received_bytes_per_second: bytes_per_second(sum(|item| item.received), elapsed),
        transmitted_bytes_per_second: bytes_per_second(sum(|item| item.transmitted), elapsed),
        total_received_bytes: sum(|item| item.total_received),
        total_transmitted_bytes: sum(|item| item.total_transmitted),
        receive_errors: sum(|item| item.receive_errors),
        transmit_errors: sum(|item| item.transmit_errors),
        active_interfaces: counters.len() as u64,
    })
}

fn bytes_per_second(bytes: u64, elapsed: StdDuration) -> u64 {
    let nanos = elapsed.as_nanos();
    if nanos == 0 {
        return 0;
    }
    (u128::from(bytes).saturating_mul(1_000_000_000) / nanos).min(u128::from(u64::MAX)) as u64
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
            error: dashboardd_widget_protocol::ErrorData {
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
        .write_all(dashboardd_widget_protocol::serialize(message)?.as_bytes())
        .await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::*;

    #[test]
    fn excludes_loopback_and_down_interfaces() {
        assert!(!interface_identity_eligible(
            "lo",
            [IpAddr::V4(Ipv4Addr::LOCALHOST)].into_iter(),
            InterfaceOperationalState::Unknown,
        ));
        assert!(!interface_identity_eligible(
            "eth0",
            [IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1))].into_iter(),
            InterfaceOperationalState::Down,
        ));
        assert!(interface_identity_eligible(
            "en0",
            [
                IpAddr::V6(Ipv6Addr::LOCALHOST),
                IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1))
            ]
            .into_iter(),
            InterfaceOperationalState::Up,
        ));
    }

    #[test]
    fn aggregates_rates_totals_errors_and_interface_count() {
        let snapshot = aggregate(
            [
                InterfaceCounters {
                    received: 100,
                    transmitted: 50,
                    total_received: 1_000,
                    total_transmitted: 500,
                    receive_errors: 1,
                    transmit_errors: 0,
                },
                InterfaceCounters {
                    received: 300,
                    transmitted: 150,
                    total_received: 3_000,
                    total_transmitted: 1_500,
                    receive_errors: 0,
                    transmit_errors: 2,
                },
            ]
            .into_iter(),
            StdDuration::from_millis(500),
        )
        .unwrap();
        assert_eq!(snapshot.received_bytes_per_second, 800);
        assert_eq!(snapshot.transmitted_bytes_per_second, 400);
        assert_eq!(snapshot.total_received_bytes, 4_000);
        assert_eq!(snapshot.total_transmitted_bytes, 2_000);
        assert_eq!(snapshot.receive_errors, 1);
        assert_eq!(snapshot.transmit_errors, 2);
        assert_eq!(snapshot.active_interfaces, 2);
        assert!(aggregate([].into_iter(), StdDuration::from_secs(1)).is_none());
    }

    #[test]
    fn serialized_snapshot_does_not_expose_interface_identity() {
        let snapshot = NetworkSnapshot {
            received_bytes_per_second: 1,
            transmitted_bytes_per_second: 2,
            total_received_bytes: 3,
            total_transmitted_bytes: 4,
            receive_errors: 0,
            transmit_errors: 0,
            active_interfaces: 1,
        };
        let payload = serde_json::to_value(snapshot).unwrap();
        assert!(payload.get("interfaces").is_none());
        assert!(payload.get("addresses").is_none());
        assert!(payload.get("mac_address").is_none());
    }
}
