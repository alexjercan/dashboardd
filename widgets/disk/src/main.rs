//! Root filesystem capacity and I/O telemetry.

use std::{
    error::Error,
    path::{Path, PathBuf},
    time::Duration as StdDuration,
};

use dashboard_protocol::{ServerToWidget, WidgetToServer};
use serde::Serialize;
use sysinfo::{Disk, Disks};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{Duration, Instant, interval_at};

const WIDGET_ID: &str = "disk";
const UPDATE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Serialize)]
struct DiskSnapshot {
    usage_percent: f64,
    used_bytes: u64,
    available_bytes: u64,
    total_bytes: u64,
    read_bytes_per_second: u64,
    written_bytes_per_second: u64,
    file_system: String,
    read_only: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut stdout = tokio::io::stdout();
    let mut disks = Disks::new_with_refreshed_list();
    let root = system_root();
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
                Some(line) => match dashboard_protocol::parse::<ServerToWidget>(&line) {
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
                disks.refresh(true);
                match disk_snapshot(&disks, &root, elapsed) {
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
                            "disk_unavailable",
                            "Root filesystem telemetry is unavailable",
                        ).await?;
                    }
                    None => {}
                }
            }
        }
    }
    Ok(())
}

fn disk_snapshot(disks: &Disks, root: &Path, elapsed: StdDuration) -> Option<DiskSnapshot> {
    let disk = root_disk(disks, root)?;
    let total_bytes = disk.total_space();
    let available_bytes = disk.available_space().min(total_bytes);
    let used_bytes = total_bytes.saturating_sub(available_bytes);
    let usage = disk.usage();
    Some(DiskSnapshot {
        usage_percent: percentage(used_bytes, total_bytes),
        used_bytes,
        available_bytes,
        total_bytes,
        read_bytes_per_second: bytes_per_second(usage.read_bytes, elapsed),
        written_bytes_per_second: bytes_per_second(usage.written_bytes, elapsed),
        file_system: sanitize_file_system(disk.file_system().to_string_lossy().as_ref()),
        read_only: disk.is_read_only(),
    })
}

fn root_disk<'a>(disks: &'a Disks, root: &Path) -> Option<&'a Disk> {
    select_mount(root, disks.list().iter().map(Disk::mount_point))
        .and_then(|index| disks.list().get(index))
}

fn select_mount<'a>(target: &Path, mounts: impl Iterator<Item = &'a Path>) -> Option<usize> {
    mounts
        .enumerate()
        .filter(|(_, mount)| target.starts_with(mount))
        .max_by_key(|(_, mount)| mount.components().count())
        .map(|(index, _)| index)
}

#[cfg(unix)]
fn system_root() -> PathBuf {
    PathBuf::from("/")
}

#[cfg(windows)]
fn system_root() -> PathBuf {
    let drive = std::env::var_os("SystemDrive").unwrap_or_else(|| "C:".into());
    PathBuf::from(drive).join("\\")
}

#[cfg(not(any(unix, windows)))]
fn system_root() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn percentage(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (used as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
    }
}

fn bytes_per_second(bytes: u64, elapsed: StdDuration) -> u64 {
    let nanos = elapsed.as_nanos();
    if nanos == 0 {
        return 0;
    }
    (u128::from(bytes).saturating_mul(1_000_000_000) / nanos).min(u128::from(u64::MAX)) as u64
}

fn sanitize_file_system(value: &str) -> String {
    let value = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        .take(24)
        .collect::<String>();
    if value.is_empty() {
        "Unknown".into()
    } else {
        value
    }
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
    fn selects_the_longest_mount_containing_the_target() {
        let mounts = [Path::new("/"), Path::new("/home"), Path::new("/home/alex")];
        assert_eq!(
            select_mount(Path::new("/home/alex/file"), mounts.into_iter()),
            Some(2)
        );
        assert_eq!(select_mount(Path::new("/"), mounts.into_iter()), Some(0));
    }

    #[test]
    fn calculates_bounded_capacity_and_rates() {
        assert_eq!(percentage(50, 100), 50.0);
        assert_eq!(percentage(1, 0), 0.0);
        assert_eq!(bytes_per_second(512, StdDuration::from_millis(500)), 1024);
    }

    #[test]
    fn sanitizes_filesystem_labels_and_snapshot_fields_are_private() {
        assert_eq!(sanitize_file_system("ext4 /private"), "ext4private");
        let snapshot = DiskSnapshot {
            usage_percent: 50.0,
            used_bytes: 1,
            available_bytes: 1,
            total_bytes: 2,
            read_bytes_per_second: 3,
            written_bytes_per_second: 4,
            file_system: "ext4".into(),
            read_only: false,
        };
        let payload = serde_json::to_value(snapshot).unwrap();
        assert!(payload.get("mount_point").is_none());
        assert!(payload.get("device_name").is_none());
    }
}
