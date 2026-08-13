//! Widget manifest discovery and backend process lifecycle.
//!
//! Backends are isolated child processes that exchange versioned JSON-lines with dashboardd.

use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use dashboard_protocol::{
    ErrorData, InstanceId, ServerToDashboard, ServerToWidget, WidgetDescriptor, WidgetToServer,
};
use serde::Deserialize;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
    task::JoinHandle,
};

#[derive(Clone, Debug)]
pub struct WidgetManifest {
    pub descriptor: WidgetDescriptor,
    pub backend: PathBuf,
}

#[derive(Debug, Deserialize)]
struct ManifestFile {
    id: String,
    name: String,
    backend: PathBuf,
}

pub fn discover_widgets(root: &Path) -> io::Result<Vec<WidgetManifest>> {
    let mut directories = fs::read_dir(root)?.collect::<Result<Vec<_>, _>>()?;
    directories.sort_by_key(fs::DirEntry::file_name);

    directories
        .into_iter()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| read_manifest(&entry.path()))
        .collect()
}

fn read_manifest(widget_directory: &Path) -> io::Result<WidgetManifest> {
    let manifest_path = widget_directory.join("widget.json");
    let source = fs::read_to_string(&manifest_path)?;
    let manifest: ManifestFile = serde_json::from_str(&source).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "invalid widget manifest {}: {error}",
                manifest_path.display()
            ),
        )
    })?;

    if manifest.id.is_empty() || manifest.name.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "widget manifest {} has an empty id or name",
                manifest_path.display()
            ),
        ));
    }

    Ok(WidgetManifest {
        descriptor: WidgetDescriptor {
            id: manifest.id,
            name: manifest.name,
        },
        backend: widget_directory.join(manifest.backend),
    })
}

pub fn start_backend(
    manifest: Arc<WidgetManifest>,
    instance_id: InstanceId,
    updates: mpsc::UnboundedSender<ServerToDashboard>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(error) = run_backend(&manifest, &instance_id, &updates).await {
            let _ = updates.send(ServerToDashboard::Error {
                request_id: None,
                error: ErrorData {
                    code: "backend_failed".into(),
                    message: error.to_string(),
                },
            });
        }
    })
}

async fn run_backend(
    manifest: &WidgetManifest,
    instance_id: &str,
    updates: &mpsc::UnboundedSender<ServerToDashboard>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut child = Command::new(&manifest.backend)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("widget backend stdin is unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("widget backend stdout is unavailable")?;
    let mut lines = BufReader::new(stdout).lines();

    let initialize = dashboard_protocol::serialize(ServerToWidget::Initialize {
        instance_id: instance_id.into(),
        widget_id: manifest.descriptor.id.clone(),
    })?;
    stdin.write_all(initialize.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;

    while let Some(line) = lines.next_line().await? {
        match dashboard_protocol::parse::<WidgetToServer>(&line)? {
            WidgetToServer::Ready { widget_id } if widget_id == manifest.descriptor.id => {}
            WidgetToServer::Update {
                instance_id,
                payload,
            } => {
                let _ = updates.send(ServerToDashboard::WidgetMessage {
                    instance_id,
                    payload,
                });
            }
            WidgetToServer::Error { error, .. } => {
                let _ = updates.send(ServerToDashboard::Error {
                    request_id: None,
                    error,
                });
            }
            WidgetToServer::Ready { widget_id } => {
                return Err(format!("backend announced unexpected widget id {widget_id}").into());
            }
        }
    }

    let status = child.wait().await?;
    if !status.success() {
        return Err(format!("widget backend exited with {status}").into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_widget_manifests() {
        let root = std::env::temp_dir().join(format!("scufris-widgets-{}", std::process::id()));
        let cpu = root.join("cpu");
        fs::create_dir_all(&cpu).unwrap();
        fs::write(
            cpu.join("widget.json"),
            r#"{"id":"cpu","name":"CPU","backend":"backend"}"#,
        )
        .unwrap();

        let widgets = discover_widgets(&root).unwrap();

        assert_eq!(widgets.len(), 1);
        assert_eq!(widgets[0].descriptor.id, "cpu");
        assert_eq!(widgets[0].descriptor.name, "CPU");
        assert_eq!(widgets[0].backend, cpu.join("backend"));

        fs::remove_dir_all(root).unwrap();
    }
}
