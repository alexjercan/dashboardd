//! CPU telemetry widget backend.
//!
//! The backend reports aggregate and per-core CPU data to dashboardd over JSON-lines.

use std::{collections::HashMap, error::Error};

use dashboard_protocol::{ServerToWidget, WidgetToServer};
use serde::Serialize;
use sysinfo::{Components, System};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{Duration, Instant, interval_at};

const WIDGET_ID: &str = "cpu";
const UPDATE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Serialize)]
struct CpuSnapshot {
    usage_percent: f32,
    cores: Vec<CoreSnapshot>,
    load_average: LoadSnapshot,
    package_temperature_celsius: Option<f32>,
}

#[derive(Debug, Serialize)]
struct CoreSnapshot {
    name: String,
    usage_percent: f32,
    frequency_mhz: u64,
    temperature_celsius: Option<f32>,
}

#[derive(Debug, Serialize)]
struct LoadSnapshot {
    one: f64,
    five: f64,
    fifteen: f64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut system = System::new();
    system.refresh_cpu_all();
    let mut components = Components::new_with_refreshed_list();
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
                Some(line) => match dashboard_protocol::parse::<ServerToWidget>(&line) {
                    Ok(ServerToWidget::Initialize { instance_id: id, widget_id, options: _ }) if widget_id == WIDGET_ID => {
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
                        payload: serde_json::to_value(cpu_snapshot(&mut system, &mut components))?,
                    },
                ).await?;
            }
        }
    }

    Ok(())
}

fn cpu_snapshot(system: &mut System, components: &mut Components) -> CpuSnapshot {
    system.refresh_cpu_all();
    components.refresh(true);
    let (core_temperatures, package_temperature_celsius) = temperatures(components);
    let load = System::load_average();

    CpuSnapshot {
        usage_percent: system.global_cpu_usage(),
        cores: system
            .cpus()
            .iter()
            .enumerate()
            .map(|(index, cpu)| CoreSnapshot {
                name: format!("CPU {index}"),
                usage_percent: cpu.cpu_usage(),
                frequency_mhz: cpu.frequency(),
                temperature_celsius: core_temperatures.get(&index).copied(),
            })
            .collect(),
        load_average: LoadSnapshot {
            one: load.one,
            five: load.five,
            fifteen: load.fifteen,
        },
        package_temperature_celsius,
    }
}

fn temperatures(components: &Components) -> (HashMap<usize, f32>, Option<f32>) {
    let mut cores = HashMap::new();
    let mut package = None;

    for component in components {
        let Some(temperature) = component.temperature().filter(|value| value.is_finite()) else {
            continue;
        };
        let label = component.label().to_ascii_lowercase();

        if let Some(index) = core_index(&label) {
            cores.insert(index, temperature);
        }
        if is_package_sensor(&label) {
            package = Some(package.map_or(temperature, |current: f32| current.max(temperature)));
        }
    }

    if package.is_none() {
        package = cores.values().copied().reduce(f32::max);
    }

    (cores, package)
}

fn core_index(label: &str) -> Option<usize> {
    let suffix = label.split_once("core ")?.1;
    let digits: String = suffix.chars().take_while(char::is_ascii_digit).collect();
    (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
}

fn is_package_sensor(label: &str) -> bool {
    label.contains("package")
        || label.contains("tctl")
        || label.contains("tdie")
        || label == "cpu"
        || label.starts_with("cpu ")
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
    fn cpu_snapshot_contains_usage_cores_load_and_nullable_temperature() {
        let snapshot = cpu_snapshot(&mut System::new(), &mut Components::new());
        let payload = serde_json::to_value(snapshot).unwrap();

        assert!(payload["usage_percent"].is_number());
        assert!(payload["cores"].is_array());
        assert!(payload["load_average"]["one"].is_number());
        assert!(payload["load_average"]["five"].is_number());
        assert!(payload["load_average"]["fifteen"].is_number());
        assert!(
            payload["package_temperature_celsius"].is_number()
                || payload["package_temperature_celsius"].is_null()
        );
    }

    #[test]
    fn parses_direct_core_sensor_labels() {
        assert_eq!(core_index("core 0"), Some(0));
        assert_eq!(core_index("core 17 temp"), Some(17));
        assert_eq!(core_index("package id 0"), None);
    }

    #[test]
    fn identifies_common_package_sensor_labels() {
        assert!(is_package_sensor("package id 0"));
        assert!(is_package_sensor("tctl"));
        assert!(!is_package_sensor("nvme composite"));
    }
}
